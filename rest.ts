// GitHub REST v3, the surface the suite exercises: repositories, branches, commits, contents,
// issues, comments, labels, and pull requests with their files and merges. Every reply is JSON
// with a non-empty X-GitHub-Request-Id (a counter, so two runs produce the same ids), and every
// error is `{"message": "..."}` with the status the real API uses.
//
// Auth: every /api/v3 call needs `Authorization: Bearer <token>` where <token> is the token the
// server was started with. A missing or wrong token is 401. A repository name under a different
// owner is 404, never 403 — the suite checks that a stranger's repos do not leak their existence.
// A malformed JSON body is 400. A duplicate repository name is 422.
//
// Pagination: ?per_page (default 30, capped at 100) and ?page; a next page exists exactly when a
// Link header with rel="next" is sent. The suite pages /user/repos at 10 per page and expects at
// least 3 pages for 30 repositories, with no duplicates and every page staying on the same origin.

import { isObjectId, parseCommit } from './gitcore.ts';
import { scenarioIdentity } from './scenario.ts';
import { FORGE_ISO, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export interface RestContext {
  readonly store: Store;
  readonly token: string;
  /** The request's URL path and query, already split. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly method: string;
  readonly body: Buffer;
  readonly authorization: string | null;
  /** The request's origin (scheme + host), for absolute pagination links. */
  readonly origin: string;
}

export interface RestResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

let requestCounter = 0;

/** The next request id: `req-000001`, `req-000002`, … — deterministic across runs. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter).padStart(6, '0')}`;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function error(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

export function notFound(message = 'Not Found'): RestResponse {
  return error(404, message);
}

/** Parse the request body as JSON. Returns null on malformed JSON (the caller answers 400). */
export function parseJsonBody(body: Buffer): unknown | null {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function perPage(query: URLSearchParams): number {
  const raw = Number.parseInt(query.get('per_page') ?? '30', 10);
  if (Number.isNaN(raw) || raw < 1) return 30;
  return Math.min(raw, 100);
}

function pageNumber(query: URLSearchParams): number {
  const raw = Number.parseInt(query.get('page') ?? '1', 10);
  if (Number.isNaN(raw) || raw < 1) return 1;
  return raw;
}

/** Slice `items` to one page and build the Link header (only when a next page exists). The next
 *  link is absolute and stays on the entry's origin, as the suite requires. */
function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string, origin: string): { page: T[]; headers: Record<string, string> } {
  const size = perPage(query);
  const page = pageNumber(query);
  const start = (page - 1) * size;
  const sliced = items.slice(start, start + size);
  const headers: Record<string, string> = {};
  if (start + size < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(size));
    headers.Link = `<${origin}${basePath}?${next.toString()}>; rel="next"`;
  }
  return { page: sliced, headers };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: scenarioIdentity().viewer.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    created_at: pull.createdAt,
  };
}

/** Resolve a repo from the path; a foreign owner is 404, never 403. */
function resolveRepo(ctx: RestContext, owner: string, name: string): { repo: Repo } | { response: RestResponse } {
  if (owner !== ctx.store.ownerLogin()) return { response: notFound() };
  const repo = ctx.store.getRepo(name);
  if (!repo) return { response: notFound() };
  return { repo };
}

function resolveIssue(repo: Repo, numberText: string): Issue | null {
  const number = Number.parseInt(numberText, 10);
  if (Number.isNaN(number)) return null;
  return repo.issues.get(number) ?? null;
}

function resolvePull(repo: Repo, numberText: string): PullRequest | null {
  const number = Number.parseInt(numberText, 10);
  if (Number.isNaN(number)) return null;
  return repo.pulls.get(number) ?? null;
}

/** The REST dispatcher. `segments` is the path after /api/v3/, split on '/'. */
export function handleRest(ctx: RestContext, segments: string[]): RestResponse {
  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (ctx.method !== 'GET') return error(405, 'Method Not Allowed');
    return ok(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
    }, { 'X-Oauth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta — the installed version.
  if (segments.length === 1 && segments[0] === 'meta') {
    if (ctx.method !== 'GET') return error(405, 'Method Not Allowed');
    return ok(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user — the token owner.
  if (segments.length === 1 && segments[0] === 'user') {
    if (ctx.method !== 'GET') return error(405, 'Method Not Allowed');
    const viewer = ctx.store.ownerLogin();
    return ok(200, { login: viewer, id: ctx.store.ownerId(), type: 'User' });
  }

  // POST /user/repos and GET /user/repos.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (ctx.method === 'POST') {
      const body = parseJsonBody(ctx.body);
      if (body === null) return error(400, 'Problems parsing JSON');
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        return error(422, 'Validation Failed: name is required');
      }
      const repo = ctx.store.createRepo(body.name, typeof body.description === 'string' ? body.description : '', body.private === true);
      if (repo === null) return error(422, 'Validation Failed: name already exists on this account');
      return ok(201, repoJson(repo));
    }
    if (ctx.method === 'GET') {
      const repos = ctx.store.listRepos();
      const { page, headers } = paginate(repos.map((repo) => repoJson(repo)), ctx.query, '/api/v3/user/repos', ctx.origin);
      return ok(200, page, headers);
    }
    return error(405, 'Method Not Allowed');
  }

  // /repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const resolved = resolveRepo(ctx, owner, name);
    if ('response' in resolved) return resolved.response;
    const repo = resolved.repo;
    const rest = segments.slice(3);

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (ctx.method === 'GET') return ok(200, repoJson(repo));
      if (ctx.method === 'PATCH') {
        const body = parseJsonBody(ctx.body);
        if (body === null) return error(400, 'Problems parsing JSON');
        if (isRecord(body) && typeof body.description === 'string') repo.description = body.description;
        if (isRecord(body) && typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        return ok(200, repoJson(repo));
      }
      if (ctx.method === 'DELETE') {
        ctx.store.deleteRepo(name);
        return { status: 204, body: null };
      }
      return error(405, 'Method Not Allowed');
    }

    // GET /repos/{owner}/{repo}/branches and /branches/{branch}
    if (rest[0] === 'branches') {
      if (ctx.method !== 'GET') return error(405, 'Method Not Allowed');
      if (rest.length === 1) {
        const branches = ctx.store.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } }));
        const { page, headers } = paginate(branches, ctx.query, `/api/v3/repos/${owner}/${name}/branches`, ctx.origin);
        return ok(200, page, headers);
      }
      const branchName = decodeURIComponent(rest.slice(1).join('/'));
      const tip = ctx.store.resolveRef(repo, branchName);
      if (tip === null) return notFound();
      return ok(200, { name: branchName, commit: { sha: tip } });
    }

    // GET /repos/{owner}/{repo}/commits
    if (rest[0] === 'commits') {
      if (ctx.method !== 'GET') return error(405, 'Method Not Allowed');
      if (rest.length > 1) {
        const sha = decodeURIComponent(rest[1] as string);
        const object = repo.objects.get(sha);
        if (!object || object.type !== 'commit') return notFound();
        const commit = parseCommit(object.data);
        return ok(200, { sha, commit: { message: commit.message.replace(/\n$/, ''), tree: { sha: commit.tree }, author: { name: commit.author } } });
      }
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const commits = ctx.store.listCommits(repo, ref);
      const body = commits.map((sha) => {
        const object = repo.objects.get(sha);
        const commit = object?.type === 'commit' ? parseCommit(object.data) : null;
        return { sha, commit: { message: commit?.message.replace(/\n$/, '') ?? '', tree: { sha: commit?.tree ?? '' } } };
      });
      const { page, headers } = paginate(body, ctx.query, `/api/v3/repos/${owner}/${name}/commits`, ctx.origin);
      return ok(200, page, headers);
    }

    // GET/PUT/DELETE /repos/{owner}/{repo}/contents/{path}
    if (rest[0] === 'contents') {
      const path = decodeURIComponent(rest.slice(1).join('/'));
      if (ctx.method === 'GET') {
        const ref = ctx.query.get('ref') ?? repo.defaultBranch;
        const files = ctx.store.filesAt(repo, ref);
        const blobOid = files.get(path);
        if (blobOid !== undefined) {
          const blob = repo.objects.get(blobOid);
          const content = blob?.type === 'blob' ? blob.data : Buffer.alloc(0);
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: path.split('/').pop() ?? path,
            path,
            content: content.toString('base64'),
            sha: blobOid,
          });
        }
        // A directory: the entries directly under it.
        const prefix = path === '' ? '' : `${path}/`;
        const entries: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        for (const filePath of [...files.keys()].sort()) {
          if (!filePath.startsWith(prefix)) continue;
          const remainder = filePath.slice(prefix.length);
          const first = remainder.split('/')[0] as string;
          if (seen.has(first)) continue;
          seen.add(first);
          const childPath = prefix + first;
          const isDir = remainder.includes('/');
          entries.push({
            type: isDir ? 'dir' : 'file',
            name: first,
            path: childPath,
            sha: isDir ? '' : (files.get(childPath) ?? ''),
            size: isDir ? 0 : (repo.objects.get(files.get(childPath) ?? '')?.data.length ?? 0),
          });
        }
        if (entries.length === 0) return notFound();
        return ok(200, entries);
      }
      if (ctx.method === 'PUT') {
        const body = parseJsonBody(ctx.body);
        if (body === null) return error(400, 'Problems parsing JSON');
        if (!isRecord(body) || typeof body.content !== 'string' || typeof body.message !== 'string') {
          return error(422, 'Validation Failed: content and message are required');
        }
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const content = Buffer.from(body.content, 'base64');
        const existing = ctx.store.blobAt(repo, branch, path);
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing) {
          return error(409, 'Conflict: sha does not match the current file');
        }
        const isUpdate = existing !== null;
        const { commitSha, blobSha } = ctx.store.writeFile(repo, branch, path, content, body.message);
        return ok(isUpdate ? 200 : 201, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, encoding: 'base64' },
          commit: { sha: commitSha, message: body.message },
        });
      }
      if (ctx.method === 'DELETE') {
        const body = parseJsonBody(ctx.body);
        if (body === null) return error(400, 'Problems parsing JSON');
        if (!isRecord(body) || typeof body.message !== 'string' || typeof body.sha !== 'string') {
          return error(422, 'Validation Failed: message and sha are required');
        }
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const existing = ctx.store.blobAt(repo, branch, path);
        if (existing === null) return notFound();
        if (body.sha !== existing) return error(409, 'Conflict: sha does not match the current file');
        const commitSha = ctx.store.deleteFile(repo, branch, path, body.message);
        if (commitSha === null) return notFound();
        return ok(200, { commit: { sha: commitSha, message: body.message } });
      }
      return error(405, 'Method Not Allowed');
    }

    // POST /repos/{owner}/{repo}/git/refs and GET .../git/refs/heads/{branch}
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (ctx.method === 'POST' && rest.length === 2) {
        const body = parseJsonBody(ctx.body);
        if (body === null) return error(400, 'Problems parsing JSON');
        if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
          return error(422, 'Validation Failed: ref and sha are required');
        }
        if (!isObjectId(body.sha) || !repo.objects.has(body.sha)) return error(422, 'Validation Failed: sha is not a known object');
        if (repo.refs.has(body.ref)) return error(422, 'Validation Failed: ref already exists');
        repo.refs.set(body.ref, body.sha);
        return ok(201, { ref: body.ref, object: { sha: body.sha, type: 'commit' } });
      }
      if (ctx.method === 'GET' && rest.length >= 3) {
        // The path after /git/refs/ is the ref name without its "refs/" prefix
        // (e.g. heads/main); the store keys refs by their full name.
        const ref = `refs/${decodeURIComponent(rest.slice(2).join('/'))}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) return notFound();
        return ok(200, { ref, object: { sha: oid, type: 'commit' } });
      }
      return error(405, 'Method Not Allowed');
    }

    // POST /repos/{owner}/{repo}/labels and GET .../labels
    if (rest[0] === 'labels') {
      if (ctx.method === 'POST') {
        const body = parseJsonBody(ctx.body);
        if (body === null) return error(400, 'Problems parsing JSON');
        if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
          return error(422, 'Validation Failed: name is required');
        }
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        const label = { name: body.name, color };
        repo.labels.set(label.name, label);
        return ok(201, label);
      }
      if (ctx.method === 'GET') {
        return ok(200, [...repo.labels.values()]);
      }
      return error(405, 'Method Not Allowed');
    }

    // POST/GET /repos/{owner}/{repo}/issues and /issues/{n}[/comments]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (ctx.method === 'POST') {
          const body = parseJsonBody(ctx.body);
          if (body === null) return error(400, 'Problems parsing JSON');
          if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
            return error(422, 'Validation Failed: title is required');
          }
          const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
          const labels: Array<{ name: string; color: string }> = [];
          for (const name of labelNames) {
            const label = repo.labels.get(name);
            if (!label) return error(422, `Validation Failed: label "${name}" does not exist`);
            labels.push(label);
          }
          const issue = ctx.store.createIssue(repo, body.title, typeof body.body === 'string' ? body.body : '', labels);
          return ok(201, issueJson(repo, issue));
        }
        if (ctx.method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()];
          if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
          else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page, headers } = paginate(issues.map((issue) => issueJson(repo, issue)), ctx.query, `/api/v3/repos/${owner}/${name}/issues`, ctx.origin);
          return ok(200, page, headers);
        }
        return error(405, 'Method Not Allowed');
      }
      const issue = resolveIssue(repo, rest[1] as string);
      if (issue === null) return notFound();
      if (rest.length === 2) {
        if (ctx.method === 'GET') return ok(200, issueJson(repo, issue));
        if (ctx.method === 'PATCH') {
          const body = parseJsonBody(ctx.body);
          if (body === null) return error(400, 'Problems parsing JSON');
          if (isRecord(body) && typeof body.title === 'string') issue.title = body.title;
          if (isRecord(body) && typeof body.body === 'string') issue.body = body.body;
          if (isRecord(body) && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          issue.updatedAt = FORGE_ISO;
          return ok(200, issueJson(repo, issue));
        }
        return error(405, 'Method Not Allowed');
      }
      if (rest[2] === 'comments') {
        if (ctx.method === 'POST') {
          const body = parseJsonBody(ctx.body);
          if (body === null) return error(400, 'Problems parsing JSON');
          if (!isRecord(body) || typeof body.body !== 'string' || body.body === '') {
            return error(422, 'Validation Failed: body is required');
          }
          const comment = ctx.store.createComment(repo, issue, body.body);
          return ok(201, { id: comment.id, body: comment.body, created_at: comment.createdAt });
        }
        if (ctx.method === 'GET') {
          const comments = issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt }));
          const { page, headers } = paginate(comments, ctx.query, `/api/v3/repos/${owner}/${name}/issues/${issue.number}/comments`, ctx.origin);
          return ok(200, page, headers);
        }
        return error(405, 'Method Not Allowed');
      }
      return notFound();
    }

    // POST/GET /repos/{owner}/{repo}/pulls and /pulls/{n}[/files|/merge]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (ctx.method === 'POST') {
          const body = parseJsonBody(ctx.body);
          if (body === null) return error(400, 'Problems parsing JSON');
          if (!isRecord(body) || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
            return error(422, 'Validation Failed: title, head and base are required');
          }
          const headSha = ctx.store.resolveRef(repo, body.head);
          const baseSha = ctx.store.resolveRef(repo, body.base);
          if (headSha === null || baseSha === null) return error(422, 'Validation Failed: head or base does not exist');
          const duplicate = [...repo.pulls.values()].find(
            (pull) => pull.state === 'open' && pull.headRef === body.head && pull.baseRef === body.base,
          );
          if (duplicate) return error(422, 'Validation Failed: a pull request already exists for this head and base');
          const pull = ctx.store.createPull(repo, body.title, typeof body.body === 'string' ? body.body : '', body.head, body.base);
          if (pull === null) return error(422, 'Validation Failed: head or base does not exist');
          return ok(201, pullJson(repo, pull));
        }
        if (ctx.method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
          pulls.sort((a, b) => b.seq - a.seq);
          const { page, headers } = paginate(pulls.map((pull) => pullJson(repo, pull)), ctx.query, `/api/v3/repos/${owner}/${name}/pulls`, ctx.origin);
          return ok(200, page, headers);
        }
        return error(405, 'Method Not Allowed');
      }
      const pull = resolvePull(repo, rest[1] as string);
      if (pull === null) return notFound();
      if (rest.length === 2) {
        if (ctx.method === 'GET') return ok(200, pullJson(repo, pull));
        return error(405, 'Method Not Allowed');
      }
      if (rest[2] === 'files') {
        if (ctx.method !== 'GET') return error(405, 'Method Not Allowed');
        const files = ctx.store.pullFiles(repo, pull);
        const { page, headers } = paginate(files, ctx.query, `/api/v3/repos/${owner}/${name}/pulls/${pull.number}/files`, ctx.origin);
        return ok(200, page, headers);
      }
      if (rest[2] === 'merge') {
        if (ctx.method !== 'PUT') return error(405, 'Method Not Allowed');
        const body = parseJsonBody(ctx.body);
        if (body === null) return error(400, 'Problems parsing JSON');
        const method = isRecord(body) && typeof body.merge_method === 'string' ? body.merge_method : 'merge';
        if (method !== 'merge' && method !== 'squash' && method !== 'rebase') {
          return error(422, 'Validation Failed: merge_method is not supported');
        }
        if (pull.state !== 'open') return error(405, 'Method Not Allowed: pull request is not open');
        if (ctx.store.pullConflicts(repo, pull)) {
          return error(405, 'Method Not Allowed: this pull request has conflicts that must be resolved');
        }
        const mergeSha = ctx.store.mergePull(repo, pull);
        if (mergeSha === null) return error(405, 'Method Not Allowed: pull request cannot be merged');
        return ok(200, { merged: true, sha: mergeSha, message: `Pull Request #${pull.number} merged` });
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}
