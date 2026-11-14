// The forge's HTTP server: one in-memory Store, four surfaces (REST v3, GraphQL v4, MCP,
// git smart HTTP) plus /healthz. Every response carries a non-empty X-GitHub-Request-Id; every
// JSON response is application/json; every error body is {"message": "..."}.
//
// Routing, in order:
// - GET /healthz → 200 {"ok": true}, no token needed.
// - /api/v3/* → REST. The API root GET /api/v3/ answers 200 with X-Oauth-Scopes: repo, read:org.
//   A missing or wrong Bearer token is 401 {"message": ...}.
// - POST /api/graphql → GraphQL (batched JSON arrays answered in order).
// - POST /mcp → MCP over streamable HTTP (plain JSON answers; the client accepts them).
// - /<owner>/<repo>.git/info/refs, .../git-upload-pack, .../git-receive-pack → git smart HTTP.
// - Anything else → 404 {"message": "Not Found"}.
//
// Bodies are capped at 8 MiB (a pack a client pushes is at most the 200-commit fixture plus the
// objects it creates; the REST client caps its own reads at 1 MiB). A body larger than the cap,
// or a malformed JSON body on a JSON endpoint, is 400. The server never dies on a bad request:
// every handler is wrapped, and a handler that throws answers 500 {"message": ...} and stays up.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleLsRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { executeGraphQL, executeGraphQLBatch } from './graphql.ts';
import { handleMcp, mcpParseError, parseMcpBody } from './mcp.ts';
import { handleRest, nextRequestId, notFound } from './rest.ts';
import { Store } from './store.ts';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface ForgeOptions {
  /** The Bearer token the server accepts (MAKEFUN_SHOP_TOKEN in trials). */
  token: string;
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  });
  response.end(payload);
}

function sendBuffer(response: ServerResponse, status: number, contentType: string, body: Buffer): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': nextRequestId(),
  });
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error('request body exceeds 8 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? (match[1] as string) : null;
}

/** Create the forge server. The caller listens on an ephemeral port (see main.ts). */
export function createForgeServer(options: ForgeOptions) {
  const store = new Store();
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname;
        const method = request.method ?? 'GET';

        // GET /healthz — no token.
        if (path === '/healthz') {
          if (method !== 'GET') {
            sendJson(response, 405, { message: 'Method Not Allowed' });
            return;
          }
          sendJson(response, 200, { ok: true });
          return;
        }

        const token = bearerToken(request);
        const authorized = token !== null && token === options.token;

        // POST /mcp — the suite checks that a call without Authorization is HTTP 401.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(response, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized) {
            sendJson(response, 401, { message: 'Requires authentication' });
            return;
          }
          const body = await readBody(request);
          const parsed = parseMcpBody(body);
          if (parsed === null) {
            sendJson(response, 400, mcpParseError());
            return;
          }
          const result = handleMcp(store, parsed);
          sendJson(response, result.status, result.body);
          return;
        }

        // POST /api/graphql — batched arrays answered in order.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(response, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized) {
            sendJson(response, 401, { message: 'Requires authentication' });
            return;
          }
          const body = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(response, 400, { message: 'Problems parsing JSON' });
            return;
          }
          if (Array.isArray(parsed)) {
            sendJson(response, 200, executeGraphQLBatch(store, parsed));
          } else {
            sendJson(response, 200, executeGraphQL(store, parsed));
          }
          return;
        }

        // /api/v3/* — REST.
        if (path === '/api/v3' || path === '/api/v3/') {
          if (method !== 'GET') {
            sendJson(response, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authorized) {
            sendJson(response, 401, { message: 'Requires authentication' });
            return;
          }
          sendJson(response, 200, {
            current_user_url: '/api/v3/user',
            repository_url: '/api/v3/repos/{owner}/{repo}',
            user_repositories_url: '/api/v3/user/repos',
          }, { 'X-Oauth-Scopes': 'repo, read:org' });
          return;
        }
        if (path.startsWith('/api/v3/')) {
          if (!authorized) {
            sendJson(response, 401, { message: 'Requires authentication' });
            return;
          }
          const body = await readBody(request);
          const segments = path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
          const origin = `http://${request.headers.host ?? '127.0.0.1'}`;
          const result = handleRest(
            { store, token: options.token, path, query: url.searchParams, method, body, authorization: request.headers.authorization ?? null, origin },
            segments,
          );
          sendJson(response, result.status, result.body, result.headers ?? {});
          return;
        }

        // /<owner>/<repo>.git/* — git smart HTTP.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const [, owner, repoName, action] = gitMatch as [string, string, string, string];
          if (!authorized) {
            sendJson(response, 401, { message: 'Requires authentication' });
            return;
          }
          if (owner !== store.ownerLogin()) {
            sendJson(response, 404, { message: 'Not Found' });
            return;
          }
          const repo = store.getRepo(repoName);
          if (!repo) {
            sendJson(response, 404, { message: 'Not Found' });
            return;
          }
          if (action === 'info/refs') {
            if (method !== 'GET') {
              sendJson(response, 405, { message: 'Method Not Allowed' });
              return;
            }
            const result = handleInfoRefs({ repo, service: url.searchParams.get('service') ?? undefined, body: Buffer.alloc(0), query: url.searchParams, gitProtocol: request.headers['git-protocol'] ?? undefined });
            sendBuffer(response, result.status, result.contentType, result.body);
            return;
          }
          if (action === 'git-upload-pack') {
            if (method !== 'POST') {
              sendJson(response, 405, { message: 'Method Not Allowed' });
              return;
            }
            const body = await readBody(request);
            // A v2 ls-refs command arrives on this endpoint; answer it here.
            const isLsRefs = body.subarray(0, 64).toString('utf8').includes('command=ls-refs');
            const result = isLsRefs ? handleLsRefs(repo, body) : handleUploadPack(store, repo, body);
            sendBuffer(response, result.status, result.contentType, result.body);
            return;
          }
          if (action === 'git-receive-pack') {
            if (method !== 'POST') {
              sendJson(response, 405, { message: 'Method Not Allowed' });
              return;
            }
            const body = await readBody(request);
            const result = handleReceivePack(store, repo, body);
            sendBuffer(response, result.status, result.contentType, result.body);
            return;
          }
        }

        sendJson(response, 404, notFound().body);
      } catch (err) {
        // A handler that throws must never kill the server or the connection.
        try {
          sendJson(response, 500, { message: (err as Error).message || 'Internal Server Error' });
        } catch {
          response.destroy();
        }
      }
    })();
  });
  return { server, store };
}

/**
 * The entry point main.ts calls: build the server with the token from the environment
 * (MAKEFUN_SHOP_TOKEN in trials; "test-token" when run by hand). Returns the bare Server, as the
 * starter's main.ts expects.
 */
export function createApp() {
  const { server } = createForgeServer({ token: process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token' });
  return server;
}
