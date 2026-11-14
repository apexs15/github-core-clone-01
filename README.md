# forge — a GitHub-compatible git forge

A GitHub-compatible git forge in TypeScript (Node 22, stdlib only, no dependencies), built for the
make.fun bounty `github-core-clone-01`. One in-memory store drives all four surfaces, so the REST,
GraphQL and MCP views of a repository can never disagree.

## Running

The platform runs `node /bot/main.ts`. `main.ts` is the kit starter's lifecycle, unchanged: it binds
an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, polls `/done`, and exits 0. The token the
server accepts comes from `MAKEFUN_SHOP_TOKEN`.

Locally (development only):

```sh
node --experimental-strip-types serve-local.ts   # listens on 127.0.0.1:<ephemeral>, token "test-token"
```

then, from the kit directory:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:<PORT> --token "test-token" [--perf] [--json]
```

## Surfaces

- `GET /healthz` → `200 {"ok": true}`, no token.
- `GET /api/v3/` → `200`, header `X-Oauth-Scopes: repo, read:org`.
- `/api/v3/...` → GitHub REST v3: repositories, branches, commits, contents, issues, comments,
  labels, pull requests with files and squash merges. Absolute `Link: rel="next"` pagination.
- `POST /api/graphql` → GraphQL v4 (queries, mutations with `issue`/`pullRequest`/`commentEdge`
  payloads, variables, aliases, fragments, batched arrays, cursor pagination, `__type`
  introspection). Unknown fields are a 200 with an `errors` array naming the field.
- `POST /mcp` → MCP over streamable HTTP (2026-07-28 era): `server/discover`, `initialize`,
  `tools/list` (six tools), `tools/call`. Results carry both `structuredContent` and `content[0].text`.
- `/<owner>/<repo>.git/...` → git smart HTTP: info/refs (v0 + v2, honoring `Git-Protocol:
  version=2`), git-upload-pack (v0 + v2 fetches, shallow/deepen, sideband packs), git-receive-pack
  (v0 only, per-ref `ok`/`ng non-fast-forward` report-status). No git binary anywhere: the
  packfile format, pkt-line framing and the object model are implemented in `gitcore.ts`.

## Auth and determinism

Every API call needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is 401.
A repository under another owner is 404, never 403. There is no clock and no randomness in state:
every timestamp is the fixed scenario epoch (2025-01-01T00:00:00Z), request ids are a counter, and
the token owner's login (`adaiversen`) is derived from the contest's fixed scenario seed in
`scenario.ts` — so two runs on the same instance leave the same state.

## Files

| file | what it holds |
| --- | --- |
| `main.ts` | the kit starter's entry ↔ env lifecycle (unchanged) |
| `app.ts` | the HTTP server: routing, auth, body limits, JSON 404s |
| `store.ts` | the whole state: repos, git objects, refs, issues, pulls, merges |
| `gitcore.ts` | SHA-1 object model, pack read/write, pkt-lines, reachability |
| `githttp.ts` | git smart HTTP (info/refs, upload-pack, receive-pack, ls-refs) |
| `rest.ts` | GitHub REST v3 |
| `graphql.ts` | GraphQL v4 parser + executor |
| `mcp.ts` | MCP tools over streamable HTTP |
| `scenario.ts` | the scenario seed → the token owner's identity |
| `serve-local.ts` | development-only local runner (not used by the grader) |

## Local score (kit conformance runner, fresh server, Node 22.23.4)

| run | feature | agent | perf | total | checks |
| --- | --- | --- | --- | --- | --- |
| conformance | 600 | 200 | — | — | 120/120 |
| with `--perf` | 600 | 200 | 177 | **977** | 120/120 |
| with `--perf` (repeat) | 600 | 200 | 175 | **975** | 120/120 |

Per-group: git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20,
mcp 15/15. Perf vs the house reference medians (push 1640.82 ms, clone 266.941 ms, read 2759.715 ms,
write 348.965 ms): push p50 ~536–544 ms (45 pts), clone p50 ~136–140 ms (37 pts), read p50
~658–723 ms (49–50 pts), write p50 ~115–124 ms (44–45 pts). The reference forge itself scores
100/200 perf at its own medians (total 900), so this build is above the house reference on every
measured run.

## License

MIT (see `LICENSE`).
