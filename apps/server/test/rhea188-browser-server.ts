// Local browser target for RHEA-188. Not compiled into the image.
// Mock OAuth, the clock offset, and the slow-link throttle stay on this process.
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

const port = Number(process.env.ACCEPTANCE_PORT ?? 8795);
const origin = `http://127.0.0.1:${port}`;
const dataDir = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), 'dropit-rhea188-'));
const staticDir = process.env.STATIC_DIR ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist');
const identities = new Map<string, Identity>([
  ['browser-admin', { provider: 'github', subject: 'browser-admin', email: 'admin@example.com', name: 'Browser Admin' }],
  ['browser-guest', { provider: 'github', subject: 'browser-guest', email: 'guest@example.com', name: 'Browser Guest' }],
]);
const challenges: string[] = [];
// Real time keeps moving so chunk deadlines can elapse. Advance only jumps ahead.
let offset = 0;
let throttleBps = 0;
let completeHoldMs = 0;
let chunkDelayMs = 0;

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
    RATE_GENERAL: process.env.RATE_GENERAL ?? '8000',
    RATE_AUTH: process.env.RATE_AUTH ?? '40',
    RATE_INVITE: process.env.RATE_INVITE ?? '20',
    RATE_UPLOAD: process.env.RATE_UPLOAD ?? '200',
    RATE_ROOM: process.env.RATE_ROOM ?? '40',
    RATE_CHUNK: process.env.RATE_CHUNK ?? '8000',
    RATE_WINDOW_MS: process.env.RATE_WINDOW_MS ?? '60000',
    MAX_FILE_BYTES: process.env.MAX_FILE_BYTES ?? String(25 * 1024 * 1024),
    USER_QUOTA_BYTES: process.env.USER_QUOTA_BYTES ?? String(1024 ** 3),
    ROOM_MAX_FILE_BYTES: process.env.ROOM_MAX_FILE_BYTES ?? String(5 * 1024 * 1024),
    ROOM_QUOTA_BYTES: process.env.ROOM_QUOTA_BYTES ?? String(50 * 1024 * 1024),
    UPLOAD_CHUNK_BYTES: process.env.UPLOAD_CHUNK_BYTES ?? String(256 * 1024),
    UPLOAD_CHUNK_TIMEOUT_MS: process.env.UPLOAD_CHUNK_TIMEOUT_MS ?? '120000',
    CLEANUP_INTERVAL_MS: process.env.CLEANUP_INTERVAL_MS ?? '60000',
  }),
  providers: { github: provider },
  now: () => Date.now() + offset,
});

function throttled(body: ReadableStream<Uint8Array>, bytesPerSecond: number) {
  const reader = body.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let windowStart = Date.now();
  let sent = 0;
  const sliceSize = Math.max(1024, Math.min(16 * 1024, Math.floor(bytesPerSecond / 8)));
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending.byteLength === 0) {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        pending = next.value;
      }
      const elapsed = Date.now() - windowStart;
      if (elapsed >= 1000) {
        windowStart = Date.now();
        sent = 0;
      }
      if (sent >= bytesPerSecond) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(20, 1000 - elapsed)));
        windowStart = Date.now();
        sent = 0;
      }
      const slice = pending.subarray(0, Math.min(sliceSize, bytesPerSecond - sent));
      pending = pending.subarray(slice.byteLength);
      sent += slice.byteLength;
      controller.enqueue(slice);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

const upload = backend.service.upload.bind(backend.service);
backend.service.upload = async (space, session, body, filename, mime, expected, uploadId, signal) => {
  const stream = throttleBps > 0 ? throttled(body, throttleBps) : body;
  if (completeHoldMs > 0 && uploadId) await new Promise((resolve) => setTimeout(resolve, completeHoldMs));
  return upload(space, session, stream, filename, mime, expected, uploadId, signal);
};
const putChunk = backend.service.uploads.put.bind(backend.service.uploads);
backend.service.uploads.put = async (space, session, id, index, body, sha) => {
  if (chunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
  return putChunk(space, session, id, index, body, sha);
};

backend.app.get('/__mock/authorize', (c) => {
  const state = c.req.query('state') ?? '';
  const code = c.req.query('as') ?? 'browser-admin';
  return c.redirect(`/api/auth/github/callback?${new URLSearchParams({ state, code })}`);
});
backend.app.get('/__mock/clock', (c) => c.json({ now: Date.now() + offset, throttleBps, dataDir }));
backend.app.post('/__mock/throttle', (c) => {
  const bps = Number(c.req.query('bps') ?? '0');
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 50_000_000) throw new ApiError(400, 'INVALID_INPUT');
  throttleBps = bps;
  return c.json({ throttleBps });
});
backend.app.post('/__mock/chunk-delay', (c) => {
  const ms = Number(c.req.query('ms') ?? '0');
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 5000) throw new ApiError(400, 'INVALID_INPUT');
  chunkDelayMs = ms;
  return c.json({ chunkDelayMs });
});
backend.app.post('/__mock/complete-hold', (c) => {
  const ms = Number(c.req.query('ms') ?? '0');
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 20000) throw new ApiError(400, 'INVALID_INPUT');
  completeHoldMs = ms;
  return c.json({ completeHoldMs });
});
backend.app.post('/__mock/advance', async (c) => {
  const ms = Number(c.req.query('ms') ?? '0');
  if (!Number.isSafeInteger(ms) || ms < 0) throw new ApiError(400, 'INVALID_INPUT');
  offset += ms;
  if (c.req.query('cleanup') === '1') await backend.service.cleanup();
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
server.requestTimeout = 0;
server.headersTimeout = 30000;
console.log(`ACCEPTANCE_READY ${origin}`);
console.log(`DATA_DIR ${dataDir}`);
console.log(`CHUNK_BYTES ${backend.config.uploadChunkBytes}`);
