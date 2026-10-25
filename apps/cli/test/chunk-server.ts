import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createBackend } from '../../server/src/backend.js';
import { loadConfig } from '../../server/src/config.js';
import { hash, token } from '../../server/src/domain.js';

const CHUNK = 64 * 1024;
const directory = await mkdtemp(join(tmpdir(), 'dropit-cli-chunk-'));
const origin = 'http://localhost:3000';
const backend = createBackend({
  config: loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: directory,
    APP_ORIGIN: origin,
    UPLOAD_CHUNK_BYTES: String(CHUNK),
  }),
  providers: {},
});
const raw = token();
const now = Date.now();
const user = backend.repo.login(
  { provider: 'mock', subject: 'chunk', email: 'chunk@example.com', name: 'Chunk User' },
  null, [], hash(raw), now + 86_400_000, now,
);
const space = backend.repo.spaces(user.id)[0];
if (!space) throw new Error('missing private space');

const gate = { holdFrom: Number.POSITIVE_INFINITY, drop: false, delayMs: 0, delayRanges: false };
const stats = {
  inflight: 0, maxInflight: 0, chunkPuts: 0, creates: 0, deletes: 0, committed: 0,
  rangeInflight: 0, maxRange: 0, ranges: [] as string[],
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function resetStats(): void {
  gate.holdFrom = Number.POSITIVE_INFINITY;
  gate.drop = false;
  gate.delayMs = 0;
  gate.delayRanges = false;
  stats.inflight = 0;
  stats.maxInflight = 0;
  stats.chunkPuts = 0;
  stats.creates = 0;
  stats.deletes = 0;
  stats.committed = 0;
  stats.rangeInflight = 0;
  stats.maxRange = 0;
  stats.ranges = [];
}

const server = serve({
  fetch: async (request, env) => {
    const url = new URL(request.url);
    if (url.pathname === '/__test/stats' && request.method === 'GET') {
      return Response.json({ ...stats, holdFrom: gate.holdFrom, drop: gate.drop });
    }
    if (url.pathname === '/__test/control' && request.method === 'POST') {
      const body = await request.json() as {
        reset?: boolean; holdFrom?: number | 'off'; drop?: boolean; delayMs?: number; delayRanges?: boolean;
      };
      if (body.reset) resetStats();
      if (body.holdFrom === 'off') gate.holdFrom = Number.POSITIVE_INFINITY;
      else if (typeof body.holdFrom === 'number') gate.holdFrom = body.holdFrom;
      if (typeof body.drop === 'boolean') gate.drop = body.drop;
      if (typeof body.delayMs === 'number') gate.delayMs = body.delayMs;
      if (typeof body.delayRanges === 'boolean') gate.delayRanges = body.delayRanges;
      return Response.json({ ok: true });
    }
    const chunkMatch = request.method === 'PUT' ? /\/uploads\/[^/]+\/chunks\/(\d+)$/.exec(url.pathname) : null;
    if (chunkMatch) {
      const index = Number(chunkMatch[1]);
      stats.chunkPuts += 1;
      stats.inflight += 1;
      stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
      try {
        if (gate.delayMs > 0) await delay(gate.delayMs);
        while (index >= gate.holdFrom && !gate.drop) await delay(20);
        if (gate.drop && index >= gate.holdFrom) return new Response(null, { status: 499 });
        const response = await backend.app.fetch(request, env);
        if (response.status === 204) stats.committed += 1;
        return response;
      } catch {
        return new Response(null, { status: 500 });
      } finally {
        stats.inflight -= 1;
      }
    }
    if (request.method === 'POST' && url.pathname.endsWith('/uploads')) stats.creates += 1;
    if (request.method === 'DELETE' && /\/uploads\/[^/]+$/.test(url.pathname)) stats.deletes += 1;
    if (request.method === 'GET' && url.pathname.endsWith('/download')) {
      const range = request.headers.get('range');
      if (range) {
        stats.ranges.push(range);
        stats.rangeInflight += 1;
        stats.maxRange = Math.max(stats.maxRange, stats.rangeInflight);
      }
      try {
        if (range && gate.delayRanges) await delay(80);
        return await backend.app.fetch(request, env);
      } finally {
        if (range) stats.rangeInflight -= 1;
      }
    }
    return backend.app.fetch(request, env);
  },
  hostname: '127.0.0.1',
  port: 0,
}) as Server;
if (!server.listening) await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('missing port');

const cookie = `dropit_session=${raw}`;
const minted = await backend.app.request('/api/tokens', {
  method: 'POST',
  headers: { cookie, origin, 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ name: 'chunk-test' }),
});
const issued = await minted.json() as { token?: string };
if (minted.status !== 201 || !issued.token) throw new Error(`mint failed: ${minted.status}`);
process.stdout.write(`${JSON.stringify({
  port: address.port,
  origin,
  cookie,
  spaceId: space.id,
  token: issued.token,
})}\n`);

let stopped = false;
const shutdown = () => {
  if (stopped) return;
  stopped = true;
  gate.drop = true;
  gate.holdFrom = Number.POSITIVE_INFINITY;
  server.close(() => {
    void backend.close().finally(() => {
      void rm(directory, { recursive: true, force: true }).finally(() => process.exit(0));
    });
  });
  server.closeIdleConnections?.();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
