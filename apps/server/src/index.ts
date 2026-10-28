import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createBackend } from './backend.js';
import { isAppRoute } from './origin.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
if (process.env.NODE_ENV !== 'production' && existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const backend = createBackend();
const staticDir = process.env.STATIC_DIR?.trim() || resolve(root, 'apps/web/dist');
// API misses remain JSON 404s and never fall through to the SPA.
backend.app.all('/api/*', c => c.json({ error: { code: 'NOT_FOUND' } }, 404));
backend.app.use('*', serveStatic({ root: staticDir }));
// Only the web app's own routes get the app with 200; any other path (for example the removed long room
// links /rooms/<token>) is a 404 that still carries the app, which shows its "page not found" view.
const indexHtml = resolve(staticDir, 'index.html');
backend.app.get('*', async (c, next) => isAppRoute(c.req.path) ? next() : c.html(await readFile(indexHtml, 'utf8').catch(() => 'Not found'), 404));
backend.app.get('*', serveStatic({ path: indexHtml }));

await backend.startMaintenance();
const server = serve({ fetch: backend.app.fetch, port: backend.config.port, hostname: process.env.HOST ?? '0.0.0.0', websocket: backend.websocket }) as Server;
// Body deadlines belong to each chunk. Slow legacy uploads have no total deadline.
server.requestTimeout = 0;
server.headersTimeout = 30000;
console.info(`dropit listening on port ${backend.config.port}`);
// RHEA-190 auth step 1: say which address the Origin check and generated links use.
console.info(`dropit APP_ORIGIN: ${backend.describeOrigin()}`);
for (const warning of backend.originWarnings()) console.warn(`dropit warning: ${warning}`);
// RHEA-190 auth step 2: first run.
if (backend.bootstrappedAdmin) console.info(`dropit: created the first admin ${backend.bootstrappedAdmin} from ADMIN_EMAIL / ADMIN_PASSWORD`);
const firstRunCode = backend.setupCode();
if (firstRunCode) {
  console.info('dropit: no account exists yet. Open /setup in the browser and enter this one-time code to create the first admin:');
  console.info(`dropit setup code: ${firstRunCode}`);
}

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
