import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { createBackend } from './backend.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
if (process.env.NODE_ENV !== 'production' && existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const backend = createBackend();
const staticDir = process.env.STATIC_DIR?.trim() || resolve(root, 'apps/web/dist');
// API misses remain JSON 404s and never fall through to the SPA.
backend.app.all('/api/*', c => c.json({ error: { code: 'NOT_FOUND' } }, 404));
backend.app.use('*', serveStatic({ root: staticDir }));
backend.app.get('*', serveStatic({ path: resolve(staticDir, 'index.html') }));

await backend.startMaintenance();
const server = serve({ fetch: backend.app.fetch, port: backend.config.port, hostname: process.env.HOST ?? '0.0.0.0', websocket: backend.websocket }) as Server;
server.requestTimeout = 120000;
server.headersTimeout = 30000;
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
