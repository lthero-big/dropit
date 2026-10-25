// Local browser target for RHEA-182. Not compiled into the image.
// Mock OAuth and the pace hook stay on this process.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { createBackend } from '../src/backend.js';
import { loadConfig } from '../src/config.js';
import { ApiError, hash, type Identity } from '../src/domain.js';
import type { OAuthProvider } from '../src/oauth.js';

const port = Number(process.env.ACCEPTANCE_PORT ?? 8794);
const origin = `http://127.0.0.1:${port}`;
const dataDir = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), 'dropit-rhea182-'));
const staticDir = process.env.STATIC_DIR ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist');
const identities = new Map<string, Identity>([
  ['browser-admin', { provider: 'github', subject: 'browser-admin', email: 'admin@example.com', name: 'Browser Admin' }],
  ['browser-guest', { provider: 'github', subject: 'browser-guest', email: 'guest@example.com', name: 'Browser Guest' }],
]);
const challenges: string[] = [];
// Real time keeps moving so Retry-After can elapse. Advance only jumps ahead.
let offset = 0;
let paceMs = 0;
const stats = { current: 0, max: 0, started: 0 };

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
    RATE_GENERAL: process.env.RATE_GENERAL ?? '5000',
    RATE_AUTH: process.env.RATE_AUTH ?? '40',
    RATE_INVITE: process.env.RATE_INVITE ?? '20',
    RATE_UPLOAD: process.env.RATE_UPLOAD ?? '200',
    RATE_ROOM: process.env.RATE_ROOM ?? '30',
    RATE_WINDOW_MS: process.env.RATE_WINDOW_MS ?? '60000',
    MAX_FILE_BYTES: process.env.MAX_FILE_BYTES ?? String(25 * 1024 * 1024),
    USER_QUOTA_BYTES: process.env.USER_QUOTA_BYTES ?? String(1024 ** 3),
    ROOM_MAX_FILE_BYTES: process.env.ROOM_MAX_FILE_BYTES ?? String(5 * 1024 * 1024),
    ROOM_QUOTA_BYTES: process.env.ROOM_QUOTA_BYTES ?? String(50 * 1024 * 1024),
  }),
  providers: { github: provider },
  now: () => Date.now() + offset,
});

function paced(body: ReadableStream<Uint8Array>, pause: number) {
  const reader = body.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
      if (pending.byteLength === 0) {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        pending = next.value;
      }
      const slice = pending.subarray(0, 16 * 1024);
      pending = pending.subarray(slice.byteLength);
      controller.enqueue(slice);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

const upload = backend.service.upload.bind(backend.service);
backend.service.upload = async (space, session, body, filename, mime, expected) => {
  stats.started += 1;
  stats.current += 1;
  stats.max = Math.max(stats.max, stats.current);
  try {
    const stream = paceMs > 0 ? paced(body, paceMs) : body;
    return await upload(space, session, stream, filename, mime, expected);
  } finally {
    stats.current -= 1;
  }
};

backend.app.get('/__mock/authorize', (c) => {
  const state = c.req.query('state') ?? '';
  const code = c.req.query('as') ?? 'browser-admin';
  return c.redirect(`/api/auth/github/callback?${new URLSearchParams({ state, code })}`);
});
backend.app.get('/__mock/stats', (c) => c.json({ ...stats, paceMs, now: Date.now() + offset, dataDir }));
backend.app.post('/__mock/stats/reset', (c) => {
  stats.current = 0;
  stats.max = 0;
  stats.started = 0;
  return c.json({ ok: true });
});
backend.app.post('/__mock/pace', (c) => {
  const ms = Number(c.req.query('ms') ?? '0');
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 10000) throw new ApiError(400, 'INVALID_INPUT');
  paceMs = ms;
  return c.json({ paceMs });
});
backend.app.post('/__mock/advance', (c) => {
  const ms = Number(c.req.query('ms') ?? '0');
  if (!Number.isSafeInteger(ms) || ms < 0) throw new ApiError(400, 'INVALID_INPUT');
  offset += ms;
  return c.json({ now: Date.now() + offset });
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
console.log(`DATA_DIR ${dataDir}`);
