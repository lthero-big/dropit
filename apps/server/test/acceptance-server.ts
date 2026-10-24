// Local browser target only. Not compiled into the image (tsconfig rootDir is src,
// and Docker ignores test files). Mock OAuth stays on this process.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createBackend } from '../src/backend.js';
import { loadConfig } from '../src/config.js';
import { hash, type Identity } from '../src/domain.js';
import type { OAuthProvider } from '../src/oauth.js';

const port = Number(process.env.ACCEPTANCE_PORT ?? 8791);
const origin = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'dropit-browser-'));
const staticDir = process.env.STATIC_DIR ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist');
const identities = new Map<string, Identity>([
  ['browser-admin', { provider: 'github', subject: 'browser-admin', email: 'admin@example.com', name: 'Browser Admin' }],
]);
let challenges: string[] = [];
const provider: OAuthProvider = {
  authorizationUrl(state, challenge) {
    challenges.push(challenge);
    const url = new URL('/__mock/authorize', origin);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    return url.href;
  },
  async exchange(code, verifier) {
    if (!challenges.includes(hash(verifier))) throw new Error('PKCE mismatch');
    const identity = identities.get(code);
    if (!identity) throw new Error('Unknown mock subject');
    return identity;
  },
};
const backend = createBackend({
  config: loadConfig({
    NODE_ENV: 'development',
    PORT: String(port),
    APP_ORIGIN: origin,
    DATA_DIR: dataDir,
    RATE_GENERAL: '400',
    RATE_AUTH: '40',
    RATE_INVITE: '20',
    RATE_UPLOAD: '80',
    RATE_ROOM: '30',
  }),
  providers: { github: provider },
});
backend.app.get('/__mock/authorize', (c) => {
  const state = c.req.query('state') ?? '';
  return c.redirect(`/api/auth/github/callback?${new URLSearchParams({ state, code: 'browser-admin' })}`);
});
backend.app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND' } }, 404));
backend.app.use('*', serveStatic({ root: staticDir }));
backend.app.get('*', serveStatic({ path: resolve(staticDir, 'index.html') }));
await backend.startMaintenance();
const server = serve({
  fetch: backend.app.fetch,
  port,
  hostname: '127.0.0.1',
  websocket: backend.websocket,
}) as Server;
server.requestTimeout = 120000;
console.log(`ACCEPTANCE_READY ${origin}`);
