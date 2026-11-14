// The forge's whole state, in memory. One Store per process; the trial runs one process, so
// there is no cross-process state to reconcile. Everything is deterministic: no clock, no random
// ids — counters and the fixed scenario epoch order every creation.
//
// A repository holds its git objects (a Map from oid to {type, data}), its refs (a Map from full
// ref name to oid), and its GitHub resources (issues, pull requests, labels, comments). The
// contents API and the pull-request diff/merge work directly on the git objects, so the REST,
// GraphQL and MCP views of one repository can never disagree: they read the same trees.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  walkCommits,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';
import { SCENARIO_EPOCH_SEC, scenarioIdentity } from './scenario.ts';

/** The fixed timestamp every commit this forge creates carries (deterministic, no clock). */
export const FORGE_EPOCH_SEC = SCENARIO_EPOCH_SEC;
/** The fixed ISO timestamp every created_at/updated_at/merged_at carries. */
export const FORGE_ISO = '2025-01-01T00:00:00Z';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  /** The REST numeric id (globally unique, stable). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  /** Creation order inside the repository (sorts created asc/desc). */
  seq: number;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
}

export interface Repo {
  /** The numeric database id (globally unique, stable). */
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Creation order across repositories (the /user/repos list order). */
  seq: number;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextIssueNumber: number;
  nextPullNumber: number;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function viewerIdentity(): string {
  const viewer = scenarioIdentity().viewer;
  return `${viewer.name} <${viewer.email}>`;
}

/** A line diff: additions/deletions between two texts (common prefix/suffix, then the middle). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

/** The files (path → blob oid) of a tree, recursively. */
function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix: string, out: Map<string, string>): void {
  const tree = objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, entry.oid);
  }
}

/** Build a tree object from a path → blob map, creating intermediate trees. Returns the root oid. */
function buildTreeFromFiles(objects: Map<string, GitObject>, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      entries.push({ mode: '100644', name, oid });
    }
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!objects.has(oid)) objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private nextSeq = 1;

  /** The token owner's login (the scenario viewer). */
  ownerLogin(): string {
    return scenarioIdentity().viewer.login;
  }

  ownerId(): number {
    return scenarioIdentity().viewer.id;
  }

  private allocId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private allocSeq(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const repo: Repo = {
      id: this.allocId(),
      name,
      owner: this.ownerLogin(),
      description,
      isPrivate,
      defaultBranch: 'main',
      seq: this.allocSeq(),
      createdAt: FORGE_ISO,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  /** All repositories in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a branch name, a full ref, or a commit oid to a commit oid (or null). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (object && object.type === 'commit') return ref;
      return null;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) {
      const object = repo.objects.get(tag);
      if (object?.type === 'tag') return parseTag(object.data).object;
      return tag;
    }
    return null;
  }

  /** The branches of a repo: [{name, sha}], default branch first, then the rest sorted. */
  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!ref.startsWith('refs/heads/')) continue;
      out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
    }
    out.sort((a, b) => (a.name === repo.defaultBranch ? -1 : b.name === repo.defaultBranch ? 1 : a.name < b.name ? -1 : 1));
    return out;
  }

  /** The commits reachable from `ref`, newest first (first-parent walk order). */
  listCommits(repo: Repo, ref: string): string[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    return walkCommits([tip], this.lookup(repo));
  }

  // ---------------------------------------------------------------- contents

  /** The files of the tree at `ref` (or an empty map when the ref has no commit). */
  filesAt(repo: Repo, ref: string): Map<string, string> {
    const out = new Map<string, string>();
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return out;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return out;
    flattenTree(repo.objects, parseCommit(commit.data).tree, '', out);
    return out;
  }

  /** The blob oid of `path` at `ref`, or null. */
  blobAt(repo: Repo, ref: string, path: string): string | null {
    return this.filesAt(repo, ref).get(path) ?? null;
  }

  /**
   * Write one file on `branch` (creating the branch's first commit when it has no tip) and return
   * the new commit oid plus the blob oid. `message` is stored with one trailing "\n", as git does.
   */
  writeFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
    const blobSha = this.putObject(repo, 'blob', content);
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    const files = tip === null ? new Map<string, string>() : this.filesAt(repo, ref);
    files.set(path, blobSha);
    const treeOid = buildTreeFromFiles(repo.objects, files);
    const storedMessage = message.endsWith('\n') ? message : `${message}\n`;
    const identity = viewerIdentity();
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === null ? [] : [tip],
      message: storedMessage,
      author: identity,
      committer: identity,
      timestamp: FORGE_EPOCH_SEC,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete one file on `branch`; returns the new commit oid, or null when the file is absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    if (tip === null) return null;
    const files = this.filesAt(repo, ref);
    if (!files.has(path)) return null;
    files.delete(path);
    const treeOid = buildTreeFromFiles(repo.objects, files);
    const storedMessage = message.endsWith('\n') ? message : `${message}\n`;
    const identity = viewerIdentity();
    const commitData = buildCommit({
      tree: treeOid,
      parents: [tip],
      message: storedMessage,
      author: identity,
      committer: identity,
      timestamp: FORGE_EPOCH_SEC,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      id: this.allocId(),
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: this.allocSeq(),
      createdAt: FORGE_ISO,
      updatedAt: FORGE_ISO,
      comments: [],
    };
    repo.nextIssueNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: this.allocId(), body, createdAt: FORGE_ISO };
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | null {
    const headSha = this.resolveRef(repo, headRef);
    const baseSha = this.resolveRef(repo, baseRef);
    if (headSha === null || baseSha === null) return null;
    const pull: PullRequest = {
      id: this.allocId(),
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: this.allocSeq(),
      createdAt: FORGE_ISO,
    };
    repo.nextPullNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The files changed between the pull's base and head tips (two-way tree diff). The diff is
   *  between the stored headSha/baseSha trees (the tips at creation), not the branch names, so a
   *  branch moving after the pull was opened does not rewrite its diff. */
  pullFiles(repo: Repo, pull: PullRequest): FileDiff[] {
    const baseTreeFiles = new Map<string, string>();
    const headTreeFiles = new Map<string, string>();
    const baseCommit = repo.objects.get(pull.baseSha);
    const headCommit = repo.objects.get(pull.headSha);
    if (baseCommit?.type === 'commit') flattenTree(repo.objects, parseCommit(baseCommit.data).tree, '', baseTreeFiles);
    if (headCommit?.type === 'commit') flattenTree(repo.objects, parseCommit(headCommit.data).tree, '', headTreeFiles);
    const diffs: FileDiff[] = [];
    const paths = new Set([...baseTreeFiles.keys(), ...headTreeFiles.keys()]);
    for (const path of [...paths].sort()) {
      const baseOid = baseTreeFiles.get(path);
      const headOid = headTreeFiles.get(path);
      if (baseOid === headOid) continue;
      if (baseOid === undefined && headOid !== undefined) {
        const blob = repo.objects.get(headOid);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const lines = text === '' ? 0 : text.split('\n').length;
        diffs.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (headOid === undefined && baseOid !== undefined) {
        const blob = repo.objects.get(baseOid);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const lines = text === '' ? 0 : text.split('\n').length;
        diffs.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (baseOid !== undefined && headOid !== undefined) {
        const baseBlob = repo.objects.get(baseOid);
        const headBlob = repo.objects.get(headOid);
        const oldText = baseBlob?.type === 'blob' ? baseBlob.data.toString('utf8') : '';
        const newText = headBlob?.type === 'blob' ? headBlob.data.toString('utf8') : '';
        const { additions, deletions } = lineDiff(oldText, newText);
        diffs.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return diffs;
  }

  /** Whether merging `pull` now would conflict (both sides changed the same file differently). */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    const baseTip = this.resolveRef(repo, pull.baseRef);
    if (baseTip === null) return true;
    const base = mergeBase(pull.headSha, baseTip, this.lookup(repo));
    if (base === null) return true;
    const ancestorFiles = new Map<string, string>();
    const ancestorCommit = repo.objects.get(base);
    if (ancestorCommit?.type === 'commit') flattenTree(repo.objects, parseCommit(ancestorCommit.data).tree, '', ancestorFiles);
    const headFiles = new Map<string, string>();
    const headCommit = repo.objects.get(pull.headSha);
    if (headCommit?.type === 'commit') flattenTree(repo.objects, parseCommit(headCommit.data).tree, '', headFiles);
    const currentFiles = this.filesAt(repo, pull.baseRef);
    const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFiles.get(path);
      const head = headFiles.get(path);
      const current = currentFiles.get(path);
      if (head === ancestor) continue;
      if (current === ancestor) continue;
      if (current === head) continue;
      return true;
    }
    return false;
  }

  /**
   * Squash-merge `pull` onto its base branch. Returns the merge commit oid, or null on conflict
   * (or when the pull is not open). The merge commit has one parent (the base tip) and the tree
   * the head's changes applied to the base tree.
   */
  mergePull(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflicts(repo, pull)) return null;
    const baseTip = this.resolveRef(repo, pull.baseRef);
    if (baseTip === null) return null;
    const base = mergeBase(pull.headSha, baseTip, this.lookup(repo));
    if (base === null) return null;
    const ancestorFiles = new Map<string, string>();
    const ancestorCommit = repo.objects.get(base);
    if (ancestorCommit?.type === 'commit') flattenTree(repo.objects, parseCommit(ancestorCommit.data).tree, '', ancestorFiles);
    const headFiles = new Map<string, string>();
    const headCommit = repo.objects.get(pull.headSha);
    if (headCommit?.type === 'commit') flattenTree(repo.objects, parseCommit(headCommit.data).tree, '', headFiles);
    const merged = this.filesAt(repo, pull.baseRef);
    for (const [path, oid] of headFiles) merged.set(path, oid);
    for (const path of ancestorFiles.keys()) {
      if (!headFiles.has(path)) merged.delete(path);
    }
    const treeOid = buildTreeFromFiles(repo.objects, merged);
    const identity = viewerIdentity();
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n`,
      author: identity,
      committer: identity,
      timestamp: FORGE_EPOCH_SEC,
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FORGE_ISO;
    pull.mergeCommitSha = mergeSha;
    return mergeSha;
  }

  /** Every object reachable from a ref tip (for clone/fetch selection). */
  reachableFrom(repo: Repo, tips: readonly string[]): Set<string> {
    return collectReachable(tips, this.lookup(repo), { allowMissing: true });
  }

  /** True when `ancestor` is reachable from `tip`. */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    return isAncestor(ancestor, tip, this.lookup(repo));
  }
}
