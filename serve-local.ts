// Local test runner (development only — the grader runs main.ts, not this file).
//
// Starts the forge on an ephemeral port with the token "test-token" and keeps it up until the
// process is killed, so the kit's conformance runner can dial it:
//
//   ~/workspace/makefun/node22/bin/node --experimental-strip-types serve-local.ts
//   ~/workspace/makefun/node22/bin/node --experimental-strip-types sdk/run.ts \
//     --url http://127.0.0.1:PORT --token "test-token" [--perf] [--json]
//
// The port is printed on stdout. MAKEFUN_SHOP_TOKEN overrides the token when set.

import { createForgeServer } from './app.ts';

const token = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';
const { server } = createForgeServer({ token });
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('the server did not bind a TCP port');
process.stdout.write(`[forge] listening on http://127.0.0.1:${address.port} (token ${token})\n`);
