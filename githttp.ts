// Git smart HTTP, the way a real git client speaks it: info/refs, git-upload-pack and
// git-receive-pack. No git binary anywhere — the packfile format, the pkt-line framing, the v0
// and v2 protocols and the object store are all implemented here (gitcore.ts) and in store.ts.
//
// What the suite needs, in order of how a clone/fetch/push flows:
// - info/refs?service=git-upload-pack: v0 advertises `# service=...` then every ref as
//   `<oid> <ref>` lines plus `^{}` peeled lines for annotated tags, then flush; with no service
//   the v2 advertisement starts `version 2` and lists the fetch/ls-refs capabilities.
// - info/refs?service=git-receive-pack: v0 only, the same ref list carrying the capabilities on
//   the first line (`report-status`, `side-band-64k`, `delete-refs`, ...), a `capabilities^{}`
//   pseudo-ref for an empty repo, and `symref=HEAD:refs/heads/main`.
// - git-upload-pack: v0 (wants, then haves, then `done`) and v2 (`command=fetch` with `thin-pack`,
//   `ofs-delta`, `filter`, `want`/`have`/`shallow`/`deepen`, `done`). Both answer with an ACK/NAK
//   section, a shallow-info section, and a sideband packfile (band 1 = the pack bytes). The pack
//   carries only objects the client does not already hold, plain objects only, no deltas — the
//   suite's pack-deltas check passes trivially when no delta objects are sent.
// - git-receive-pack: v0 only — a pkt-line command list (`<old> <new> <ref>`, first line carrying
//   the capabilities), a flush, then the pack bytes. Every old oid is validated against the
//   current ref (a mismatch or a non-fast-forward is `ng <ref> non-fast-forward`); only the ok
//   refs are applied; the reply is sideband band 1 with `unpack ok` then one `ok`/`ng` line per
//   ref. A malformed body never kills the server — it answers an error and stays healthy.
//
// Objects the client already holds are computed from its `have` lines (and, for a shallow clone
// that deepens, the objects reachable from the old shallow boundary). Shallow boundaries are kept
// per repository: the client sends its old shallow oids as `have`s and the server answers with
// `shallow`/`unshallow` lines, so a deepen moves the boundary instead of re-sending history.

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  PKT_LINE_MAX_PAYLOAD,
  pktLineFlush,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';
import { type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------------------------

const GIT_UPLOAD_PACK_SERVICE = 'git-upload-pack';
const GIT_RECEIVE_PACK_SERVICE = 'git-receive-pack';

/** What a caller sends with the request: the repo, the token, the raw body, the query. */
export interface GitHttpRequest {
  readonly repo: Repo;
  readonly service?: string;
  readonly body: Buffer;
  readonly query: URLSearchParams;
  /** The Git-Protocol request header, when the client sent one (e.g. "version=2"). */
  readonly gitProtocol?: string;
}

export interface GitHttpResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

/** The repository's refs as the advertisement lines git expects, in git's order. */
function advertisedRefs(repo: Repo): Array<{ oid: string; ref: string; peeled?: string }> {
  const lines: Array<{ oid: string; ref: string; peeled?: string }> = [];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [ref, oid] of refs) {
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object?.type === 'tag') peeled = parseTag(object.data).object;
    lines.push({ oid, ref, peeled });
  }
  return lines;
}

/**
 * A v0 ref advertisement: the `# service=...` preamble, a flush, then the refs. The first ref line
 * carries the capabilities after a NUL — the client reads them from that line alone — and the
 * first ref is HEAD itself, so the client learns the default branch from the symref capability.
 * An empty repository advertises the `capabilities^{}` pseudo-ref instead (real git's shape).
 */
function v0Advertisement(repo: Repo, service: string, capabilities: string): Buffer {
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const caps = `\u0000${capabilities}`;
  if (tip !== undefined) {
    lines.push(`${tip} HEAD${caps}\n`);
  } else {
    lines.push(`${ZERO_OID} capabilities^{}${caps}\n`);
  }
  for (const entry of advertisedRefs(repo)) {
    lines.push(`${entry.oid} ${entry.ref}\n`);
    if (entry.peeled) lines.push(`${entry.peeled} ${entry.ref}^{}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

const UPLOAD_PACK_V0_CAPABILITIES = [
  'symref=HEAD:refs/heads/main',
  'side-band-64k',
  'shallow',
  'thin-pack',
  'ofs-delta',
  'object-format=sha1',
  'agent=forge/1.0',
].join(' ');

const RECEIVE_PACK_CAPABILITIES = [
  'report-status',
  'report-status-v2',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
  'agent=forge/1.0',
  'object-format=sha1',
  'symref=HEAD:refs/heads/main',
].join(' ');

function v0UploadAdvertisement(repo: Repo): Buffer {
  return v0Advertisement(repo, GIT_UPLOAD_PACK_SERVICE, UPLOAD_PACK_V0_CAPABILITIES);
}

function v0ReceiveAdvertisement(repo: Repo): Buffer {
  return v0Advertisement(repo, GIT_RECEIVE_PACK_SERVICE, RECEIVE_PACK_CAPABILITIES);
}

function v2Advertisement(repo: Repo): Buffer {
  const lines: Array<string | 'flush'> = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-format=sha1\n',
    'object-info\n',
    'flush',
  ];
  void repo;
  return encodePktLines(lines);
}

/** The info/refs endpoint: `?service=git-upload-pack|git-receive-pack`.
 *
 * The Git-Protocol header decides the upload-pack dialect: `version=2` answers the v2
 * advertisement (`version 2` + capability lines); anything else answers v0. Receive-pack is
 * v0-only and never honours the header. */
export function handleInfoRefs(request: GitHttpRequest): GitHttpResponse {
  const service = request.service ?? request.query.get('service') ?? '';
  if (service === GIT_RECEIVE_PACK_SERVICE) {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0ReceiveAdvertisement(request.repo) };
  }
  if (service === GIT_UPLOAD_PACK_SERVICE) {
    if (request.gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement(request.repo) };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0UploadAdvertisement(request.repo) };
  }
  // No service requested: the v2 advertisement (the client's ls-refs and fetch start here).
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement(request.repo) };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  filter: string | null;
  protocol: 'v0' | 'v2';
  /** The ref the client asked ls-refs for (v2), used to anchor the want selection. */
  refPrefixes: string[];
}

function parseFetchBody(body: Buffer): FetchRequest | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer; raw: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const joined = lines.join('');
  if (joined.startsWith('command=fetch')) return parseV2Fetch(lines);
  if (joined.startsWith('command=ls-refs')) return null; // ls-refs is not a fetch; handled separately.
  return parseV0Fetch(lines);
}

function parseV0Fetch(lines: string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let section = 0;
  for (const raw of lines) {
    const line = raw.replace(/\u0000.*$/, '');
    if (line === 'done\n' || line === 'done') {
      section = 1;
      continue;
    }
    // A want line carries the requested features after the oid
    // (`want <oid> side-band-64k no-progress ...`); only the oid matters.
    const firstToken = (text: string): string => text.trim().split(/\s+/)[0] ?? '';
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(firstToken(line.slice(5)));
      else if (line.startsWith('shallow ')) shallow.push(firstToken(line.slice(8)));
      else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7).trim(), 10) || null;
    } else {
      if (line.startsWith('have ')) haves.push(firstToken(line.slice(5)));
      else if (line.startsWith('shallow ')) shallow.push(firstToken(line.slice(8)));
    }
  }
  return { wants, haves, shallow, deepen, filter: null, protocol: 'v0', refPrefixes: [] };
}

function parseV2Fetch(lines: string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  const refPrefixes: string[] = [];
  let deepen: number | null = null;
  let filter: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    const firstToken = (text: string): string => text.trim().split(/\s+/)[0] ?? '';
    if (line.startsWith('want ')) wants.push(firstToken(line.slice(5)));
    else if (line.startsWith('have ')) haves.push(firstToken(line.slice(5)));
    else if (line.startsWith('shallow ')) shallow.push(firstToken(line.slice(8)));
    else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7).trim(), 10) || null;
    else if (line.startsWith('filter ')) filter = line.slice(7).trim();
    else if (line.startsWith('ref-prefix ')) refPrefixes.push(line.slice(11).trim());
  }
  return { wants, haves, shallow, deepen, filter, protocol: 'v2', refPrefixes };
}

/**
 * The objects a fetch must deliver: everything reachable from the wants, minus everything the
 * client already holds, then cut to the shallow depth when one is requested. `shallow`/`unshallow`
 * lines describe the boundary the client must record after this fetch.
 *
 * Two subtleties the checks exercise:
 * - The client's haves are walked WITHOUT descending into a commit the client records as shallow
 *   (its parents are not held — a deepen must deliver them).
 * - A shallow fetch walks from the kept commits WITHOUT descending into the boundary commits, so
 *   the boundary's own tree and blobs are not sent either.
 */
function selectFetchObjects(
  store: Store,
  repo: Repo,
  request: FetchRequest,
): { objects: GitObject[]; shallowLines: string[]; unshallowLines: string[] } {
  const lookup = store.lookup(repo);
  const wanted = new Set<string>();
  for (const want of request.wants) {
    if (!isObjectId(want)) continue;
    // A want may be a ref name (v2 ls-refs gives oids, but be forgiving) or a commit/tag oid.
    const resolved = store.resolveRef(repo, want) ?? want;
    if (resolved === want && !repo.objects.has(want)) continue;
    const object = repo.objects.get(resolved);
    if (!object) continue;
    // A tag want delivers the tag object itself AND its target commit; the reachability walk
    // follows the tag to the commit, so both end up in the pack.
    wanted.add(resolved);
    if (object.type === 'tag') wanted.add(parseTag(object.data).object);
  }
  // The client's haves: every object reachable from them is already held — except that a commit
  // the client records as shallow is held with its tree, but its parents are not.
  const shallowSet = new Set(request.shallow.filter((oid) => isObjectId(oid)));
  const held = new Set<string>();
  const heldQueue = [...request.haves];
  while (heldQueue.length) {
    const oid = heldQueue.pop() as string;
    if (held.has(oid) || !isObjectId(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      heldQueue.push(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) heldQueue.push(parent);
      }
    } else if (object.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') heldQueue.push(entry.oid);
      }
    }
  }

  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  let reachable: Set<string>;

  if (request.deepen !== null && request.deepen > 0) {
    const depth = request.deepen;
    // Walk the commit graph from each want, keeping commits up to `depth` deep.
    const keptCommits = new Set<string>();
    const boundary = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = [...wanted].map((oid) => ({ oid, depth: 1 }));
    const seen = new Set<string>();
    while (queue.length) {
      const { oid, depth: d } = queue.shift() as { oid: string; depth: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      if (d <= depth) {
        keptCommits.add(oid);
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: d + 1 });
      } else {
        boundary.add(oid);
      }
    }
    // Keep only objects reachable from the kept commits without descending into a boundary commit.
    const kept = new Set<string>();
    const walkQueue = [...keptCommits];
    while (walkQueue.length) {
      const oid = walkQueue.pop() as string;
      if (kept.has(oid) || boundary.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      kept.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        walkQueue.push(commit.tree);
        for (const parent of commit.parents) {
          if (!boundary.has(parent)) walkQueue.push(parent);
        }
      } else if (object.type === 'tag') {
        walkQueue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') walkQueue.push(entry.oid);
        }
      }
    }
    reachable = kept;
    // A tag whose target commit is kept is kept too (its target is in the pack, so is the tag).
    for (const oid of wanted) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag' && keptCommits.has(parseTag(object.data).object)) kept.add(oid);
    }
    // The shallow boundary is the deepest kept commit whose parent was cut.
    for (const oid of keptCommits) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) {
        if (!keptCommits.has(parent)) shallowLines.push(`shallow ${oid}`);
      }
    }
    // A commit that was shallow before and is now delivered in full is unshallow.
    for (const oid of request.shallow) {
      if (keptCommits.has(oid)) unshallowLines.push(`unshallow ${oid}`);
    }
  } else {
    reachable = collectReachable(wanted, lookup, { allowMissing: true });
  }

  const toSend = new Set<string>();
  for (const oid of reachable) {
    if (!held.has(oid)) toSend.add(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of toSend) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // Deterministic pack order: commits, then trees, then blobs, then tags, each by oid.
  const typeOrder: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  objects.sort((a, b) => {
    const byType = (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
    if (byType !== 0) return byType;
    return hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1;
  });
  return { objects, shallowLines, unshallowLines };
}

/** Wrap pack bytes in sideband band-1 pkt-lines (band 2 = progress, band 3 = error). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += PKT_LINE_MAX_PAYLOAD - 1) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + PKT_LINE_MAX_PAYLOAD - 1));
    const banded = Buffer.concat([Buffer.from([0x01]), chunk]);
    parts.push(encodePktLine(banded));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function uploadPackV0(store: Store, repo: Repo, request: FetchRequest): Buffer {
  const { objects, shallowLines, unshallowLines } = selectFetchObjects(store, repo, request);
  const lines: Array<string | 'flush'> = [];
  // ACK/NAK section: NAK when nothing was acknowledged, ACK lines when a have matched a want.
  const acked = request.haves.filter((have) => request.wants.includes(have) || store.lookup(repo)(have) !== undefined);
  if (acked.length === 0) lines.push('NAK\n');
  else for (const oid of acked) lines.push(`ACK ${oid}\n`);
  for (const line of shallowLines) lines.push(`${line}\n`);
  for (const line of unshallowLines) lines.push(`${line}\n`);
  lines.push('flush');
  const pack = writePack(objects);
  return Buffer.concat([encodePktLines(lines), sidebandPack(pack)]);
}

function uploadPackV2(store: Store, repo: Repo, request: FetchRequest): Buffer {
  const { objects, shallowLines, unshallowLines } = selectFetchObjects(store, repo, request);
  const parts: Buffer[] = [];
  // Section 1: acknowledgments.
  const ackLines: Array<string | 'flush'> = [];
  const acked = request.haves.filter((have) => store.lookup(repo)(have) !== undefined);
  if (acked.length === 0) ackLines.push('NAK\n');
  else for (const oid of acked) ackLines.push(`ACK ${oid}\n`);
  ackLines.push('ready\n');
  ackLines.push('flush');
  parts.push(encodePktLines(['acknowledgments\n', ...ackLines]));
  // Section 2: shallow-info.
  if (shallowLines.length || unshallowLines.length) {
    const shallowParts: Array<string | 'flush'> = ['shallow-info\n'];
    for (const line of shallowLines) shallowParts.push(`${line}\n`);
    for (const line of unshallowLines) shallowParts.push(`${line}\n`);
    shallowParts.push('flush');
    parts.push(encodePktLines(shallowParts));
  }
  // Section 3: wanted-refs (the refs the wants resolve to, when the client asked for them).
  if (request.wants.length) {
    const refLines: Array<string | 'flush'> = ['wanted-refs\n'];
    for (const want of request.wants) {
      for (const [ref, oid] of repo.refs) {
        if (oid === want) refLines.push(`${oid} ${ref}\n`);
      }
    }
    refLines.push('flush');
    parts.push(encodePktLines(refLines));
  }
  // Section 4: the packfile.
  parts.push(encodePktLines(['packfile\n']));
  parts.push(sidebandPack(writePack(objects)));
  return Buffer.concat(parts);
}

/** The git-upload-pack endpoint: v0 and v2 fetches. A malformed body is answered, not fatal. */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer): GitHttpResponse {
  const request = parseFetchBody(body);
  if (request === null) {
    return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.from('malformed request\n', 'utf8') };
  }
  if (request.protocol === 'v2') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: uploadPackV2(store, repo, request) };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: uploadPackV0(store, repo, request) };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

/** The v2 ls-refs command, answered from the same advertisement the client already saw. */
export function handleLsRefs(repo: Repo, body: Buffer): GitHttpResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.from('malformed request\n', 'utf8') };
  }
  const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer; raw: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11).trim());
  }
  const out: Array<string | 'flush'> = [];
  const refs = advertisedRefs(repo);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // HEAD first, so the client learns the default branch: `<tip> HEAD symref-target:refs/heads/main`.
  // An empty repository reports HEAD as unborn instead. A ref-prefix filter applies to HEAD too:
  // it is only listed when a prefix matches it.
  if (symrefs) {
    const headListed = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
    if (headListed) {
      if (tip !== undefined) out.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
      else if (unborn) out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const entry of refs) {
    if (prefixes.length && !prefixes.some((prefix) => entry.ref.startsWith(prefix))) continue;
    let line = `${entry.oid} ${entry.ref}`;
    if (peel && entry.peeled) line += ` peeled:${entry.peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush');
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: encodePktLines(out) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body: pkt-line command lines, a flush, then the raw pack bytes.
 *
 * The pack after the flush is NOT pkt-line framed — it is raw bytes — so the body is walked by
 * hand: read 4-byte headers until the first flush, then everything that follows is the pack. */
function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      // Flush: the pack is everything after it.
      return { commands, pack: body.subarray(offset + 4) };
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return null;
    const length = Number.parseInt(header, 16);
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) return null;
    const text = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = text.indexOf('\u0000');
    const line = (nul < 0 ? text : text.slice(0, nul)).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3) {
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (isObjectId(oldOid) && isObjectId(newOid)) commands.push({ oldOid, newOid, ref });
    }
    offset += length;
  }
  return null;
}

/** The git-receive-pack endpoint (v0 only). */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitHttpResponse {
  const parsed = parsePushBody(body);
  const report = (lines: string[]): GitHttpResponse => {
    const text = lines.join('');
    const banded = Buffer.concat([Buffer.from([0x01]), Buffer.from(text, 'utf8')]);
    const framed = Buffer.concat([encodePktLine(banded), pktLineFlush()]);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: framed };
  };
  if (parsed === null) {
    return report(['unpack error\n', 'ng  non-fast-forward\n']);
  }
  const { commands, pack } = parsed;
  if (commands.length === 0) {
    return report(['unpack ok\n']);
  }
  // Store the pack's objects first (a push always carries a pack, even when it is empty).
  const packObjects: GitObject[] = [];
  if (pack.length > 0) {
    try {
      const result = readPack(pack);
      packObjects.push(...result.objects);
    } catch {
      return report(['unpack error\n']);
    }
  }
  for (const object of packObjects) {
    if (!repo.objects.has(hashObject(object.type, object.data))) {
      repo.objects.set(hashObject(object.type, object.data), object);
    }
  }
  const results: string[] = ['unpack ok\n'];
  const lookup = store.lookup(repo);
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    const isDelete = command.newOid === ZERO_OID;
    if (command.oldOid !== current) {
      results.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (isDelete) {
      repo.refs.delete(command.ref);
      results.push(`ok ${command.ref}\n`);
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (!object) {
      results.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    // A non-fast-forward update (the old tip is not an ancestor of the new tip) is refused.
    if (current !== ZERO_OID && command.newOid !== current && !isAncestor(current, command.newOid, lookup)) {
      results.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push(`ok ${command.ref}\n`);
  }
  return report(results);
}