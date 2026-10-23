import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createBackend } from './backend.js';

const backend = createBackend();
const staticDir = process.env.STATIC_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
// API misses remain JSON 404s and never fall through to the SPA.
backend.app.all('/api/*', c => c.json({ error: { code: 'NOT_FOUND' } }, 404));
backend.app.use('*', serveStatic({ root: staticDir }));
backend.app.get('*', serveStatic({ path: resolve(staticDir, 'index.html') }));

await backend.startMaintenance();
const server = serve({ fetch: backend.app.fetch, port: backend.config.port }) as Server;
server.requestTimeout = 120000;
server.headersTimeout = 30000;
backend.injectWebSocket(server);
console.info(`dropit listening on port ${backend.config.port}`);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  backend.events.close();
  server.close(() => { void backend.close().catch(() => { process.exitCode = 1; }); });
  server.closeIdleConnections();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
