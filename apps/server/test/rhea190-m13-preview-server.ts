// RHEA-190 m13 public preview (version + update check). Not compiled into the image.
// A preview-only key logs in a bootstrap admin (no OAuth provider needed) so 管理 → 更新,
// GET /api/version and the new-version notice can be checked. DROPIT_COMMIT / DROPIT_INSTALL
// can pretend to be an older Docker build to see the "有新版本可用" state against live Docker Hub.
//   PREVIEW_PORT=15199 PREVIEW_ORIGIN=http://152.53.141.33:15199 PREVIEW_KEY=... DATA_DIR=... npx tsx apps/server/test/rhea190-m13-preview-server.ts
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { setCookie } from 'hono/cookie';
import { createBackend } from '../src/backend.js';
import { loadConfig } from '../src/config.js';
import { ApiError, hash, token } from '../src/domain.js';

const port = Number(process.env.PREVIEW_PORT ?? 15199);
const origin = process.env.PREVIEW_ORIGIN ?? `http://127.0.0.1:${port}`;
const dataDir = process.env.DATA_DIR;
const key = process.env.PREVIEW_KEY ?? '';
if (!dataDir) throw new Error('DATA_DIR is required');
if (key.length < 16) throw new Error('PREVIEW_KEY (>=16 chars) is required');
const staticDir = process.env.STATIC_DIR ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist');
const env: Record<string, string | undefined> = {
  NODE_ENV: 'development',
  PORT: String(port),
  APP_ORIGIN: origin,
  DATA_DIR: dataDir,
  ADMIN_EMAILS: 'preview-admin@example.invalid',
};
for (const name of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) env[name] = process.env[name];
const config = loadConfig(env);
const backend = createBackend({ config });
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

backend.app.get('/__preview/login', (c) => {
  if (!same(c.req.query('key') ?? '', key)) throw new ApiError(403, 'FORBIDDEN');
  const session = token();
  backend.repo.login(
    { provider: 'preview', subject: 'preview-admin', email: 'preview-admin@example.invalid', name: 'Preview Admin' },
    null, config.adminEmails, hash(session), Date.now() + config.sessionMs, Date.now(), { userAgent: c.req.header('user-agent') ?? null, ipSummary: null });
  setCookie(c, 'dropit_session', session, { httpOnly: true, secure: false, sameSite: 'Lax', path: '/', maxAge: Math.floor(config.sessionMs / 1000) });
  return c.redirect(`${origin}/`);
});
backend.app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND' } }, 404));
backend.app.use('*', serveStatic({ root: staticDir }));
backend.app.get('*', serveStatic({ path: resolve(staticDir, 'index.html') }));

await backend.startMaintenance();
const server = serve({ fetch: backend.app.fetch, port, hostname: '0.0.0.0', websocket: backend.websocket }) as Server;
server.requestTimeout = 0;
server.headersTimeout = 30000;
console.log(`PREVIEW_READY ${origin}`);
console.log(`DATA_DIR ${dataDir}`);
