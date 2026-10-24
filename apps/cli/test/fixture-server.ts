import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createBackend } from '../../server/src/backend.js';
import { loadConfig } from '../../server/src/config.js';
import { hash, token } from '../../server/src/domain.js';

const directory = await mkdtemp(join(tmpdir(), 'dropit-cli-e2e-'));
const origin = 'http://localhost:3000';
const backend = createBackend({
  config: { ...loadConfig({}), origin, dataDir: directory },
  providers: {},
});
const raw = token();
const now = Date.now();
const user = backend.repo.login(
  { provider: 'mock', subject: 'cli', email: 'cli@example.com', name: 'CLI User' },
  null, [], hash(raw), now + 86_400_000, now,
);
const space = backend.repo.spaces(user.id)[0];
if (!space) throw new Error('missing private space');
const server = serve({
  fetch: backend.app.fetch,
  hostname: '127.0.0.1',
  port: 0,
  websocket: backend.websocket,
}) as Server;
if (!server.listening) await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('missing port');
process.stdout.write(`${JSON.stringify({
  port: address.port,
  origin,
  cookie: `dropit_session=${raw}`,
  spaceId: space.id,
})}\n`);

let stopped = false;
const shutdown = () => {
  if (stopped) return;
  stopped = true;
  server.close(() => {
    void backend.close().finally(() => {
      void rm(directory, { recursive: true, force: true }).finally(() => process.exit(0));
    });
  });
  server.closeIdleConnections();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
