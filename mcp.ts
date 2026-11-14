// MCP over streamable HTTP (the 2026-07-28 era): the server answers `server/discover` with its
// supported versions, and the modern initialize handshake. tools/list exposes the six tools the
// suite needs; tools/call runs them against the same Store the REST and GraphQL views read, so a
// repository or issue created through MCP is the same object over REST.
//
// Wire rules the suite checks: every request carries an `MCP-Protocol-Version` header and a
// `_meta` object with the protocol version; tools/list is byte-identical on repeat calls; an
// unknown tool is JSON-RPC -32602 or -32601, never an HTTP 500; a non-JSON body is HTTP 400 with
// JSON-RPC -32700; missing required arguments are isError:true or JSON-RPC -32602; concurrent
// calls keep their own ids; tools/call without Authorization is HTTP 401. Every tool result
// carries BOTH structuredContent (the object) and content[0].text (the same object as a JSON
// string) — the checks parse structuredContent first, then the text.

import { type PullRequest, type Repo, type Store } from './store.ts';

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: string[];
  };
}

const TOOLS: readonly McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The branch with the changes.' },
        base: { type: 'string', description: 'The branch the changes are merged into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
  };
}

function issueJson(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: Array<{ name: string }> }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name })),
    repository: `${repo.owner}/${repo.name}`,
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
    repository: `${repo.owner}/${repo.name}`,
  };
}

function toolResult(id: unknown, structured: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
    },
  };
}

function toolError(id: unknown, message: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{ type: 'text', text: message }],
      structuredContent: { error: message },
      isError: true,
    },
  };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

type McpRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Execute one MCP request (already parsed from JSON) against the store. */
export function handleMcp(store: Store, request: McpRequest): { status: number; body: Record<string, unknown> } {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: 'forge', version: '1.0.0' },
          protocolVersion: '2026-07-28',
        },
      },
    };
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: 'forge', version: '1.0.0' },
        },
      },
    };
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }

  if (method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }

  if (method === 'tools/list') {
    // Byte-identical on repeat calls: a fixed array, built once, in the same order.
    return {
      status: 200,
      body: { jsonrpc: '2.0', id, result: { tools: TOOLS } },
    };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${name}`) };
    }
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return { status: 200, body: toolError(id, `Missing required argument: ${required}`) };
      }
    }
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const repoName = typeof args.repo === 'string' ? args.repo : '';

    const resolveRepo = (): Repo | null => {
      if (owner !== store.ownerLogin()) return null;
      return store.getRepo(repoName) ?? null;
    };

    if (name === 'create_repo') {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      const repo = store.createRepo(repoNameArg, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (repo === null) return { status: 200, body: toolError(id, `Repository "${repoNameArg}" already exists`) };
      return { status: 200, body: toolResult(id, repoJson(repo)) };
    }

    if (name === 'get_repo') {
      const repo = resolveRepo();
      if (!repo) return { status: 200, body: toolError(id, `Repository "${owner}/${repoName}" not found`) };
      return { status: 200, body: toolResult(id, repoJson(repo)) };
    }

    if (name === 'create_issue') {
      const repo = resolveRepo();
      if (!repo) return { status: 200, body: toolError(id, `Repository "${owner}/${repoName}" not found`) };
      const issue = store.createIssue(repo, typeof args.title === 'string' ? args.title : '', typeof args.body === 'string' ? args.body : '', []);
      return { status: 200, body: toolResult(id, issueJson(repo, issue)) };
    }

    if (name === 'list_issues') {
      const repo = resolveRepo();
      if (!repo) return { status: 200, body: toolError(id, `Repository "${owner}/${repoName}" not found`) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.seq - a.seq);
      return { status: 200, body: toolResult(id, { issues: issues.map((issue) => issueJson(repo, issue)) }) };
    }

    if (name === 'create_pull_request') {
      const repo = resolveRepo();
      if (!repo) return { status: 200, body: toolError(id, `Repository "${owner}/${repoName}" not found`) };
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const pull = store.createPull(repo, typeof args.title === 'string' ? args.title : '', '', head, base);
      if (pull === null) return { status: 200, body: toolError(id, `Head "${head}" or base "${base}" does not exist`) };
      return { status: 200, body: toolResult(id, pullJson(repo, pull)) };
    }

    if (name === 'merge_pull_request') {
      const repo = resolveRepo();
      if (!repo) return { status: 200, body: toolError(id, `Repository "${owner}/${repoName}" not found`) };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.get(number);
      if (!pull) return { status: 200, body: toolError(id, `Pull request #${number} not found`) };
      if (pull.state !== 'open') return { status: 200, body: toolError(id, `Pull request #${number} is not open`) };
      if (store.pullConflicts(repo, pull)) return { status: 200, body: toolError(id, `Pull request #${number} has conflicts`) };
      const mergeSha = store.mergePull(repo, pull);
      if (mergeSha === null) return { status: 200, body: toolError(id, `Pull request #${number} cannot be merged`) };
      return { status: 200, body: toolResult(id, pullJson(repo, pull)) };
    }
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

/** Parse an MCP request body. Returns null when the body is not JSON (the caller answers 400/-32700). */
export function parseMcpBody(body: Buffer): McpRequest | null {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!isRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function mcpParseError(): Record<string, unknown> {
  return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
}
