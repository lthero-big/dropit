import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { hash, token, type TokenScope } from '../src/domain.js';
import { limitRanges } from '../src/limits.js';

const origin = 'http://localhost:3000';
const chunkSize = 64 * 1024;
async function fixture(overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-uploads-'));
  const config = { ...loadConfig({}), origin, dataDir: directory, uploadChunkBytes: chunkSize, ...overrides };
  let time = Date.now();
  const build = () => createBackend({ config, now: () => time, remoteAddress: () => '127.0.0.1', providers: {} });
  let backend = build();
  function login(name: string) {
    if (backend.repo.users().length) backend.repo.provisionUser({ email: `${name}@example.com`, name, role: 'user', quotaBytes: null, now: time });
    const raw = token();
    const user = backend.repo.login({ provider: 'mock', subject: name, name, email: `${name}@example.com` }, null, [], hash(raw), time + 7 * 86400000, time);
    return { user, cookie: `dropit_session=${raw}`, base: `/api/spaces/${backend.repo.spaces(user.id)[0].id}` };
  }
  const admin = login('admin');
  const member = login('member');
  const request = (path: string, init: RequestInit = {}, cookie = admin.cookie) => backend.app.request(path, {
    ...init, headers: { origin, cookie, ...init.headers },
  });
  const json = (path: string, body: unknown, cookie = admin.cookie, method = 'POST') => request(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, cookie);
  const create = (size: number, base = admin.base, cookie = admin.cookie, mime = 'application/octet-stream', filename = 'data.bin') =>
    json(`${base}/uploads`, { filename, size, mime }, cookie);
  const part = (id: string, index: number | string, body: string | Uint8Array | ReadableStream<Uint8Array>, base = admin.base, cookie = admin.cookie, checksum?: string) =>
    request(`${base}/uploads/${id}/chunks/${index}`, {
      method: 'PUT', body: typeof body === 'string' || body instanceof ReadableStream ? body : new Uint8Array(body),
      headers: { 'content-type': 'application/octet-stream', ...(checksum ? { 'x-chunk-sha256': checksum } : {}) },
      duplex: 'half',
    } as RequestInit, cookie);
  const complete = (id: string, base = admin.base, cookie = admin.cookie) => request(`${base}/uploads/${id}/complete`, { method: 'POST' }, cookie);
  const cancel = (id: string, base = admin.base, cookie = admin.cookie) => request(`${base}/uploads/${id}`, { method: 'DELETE' }, cookie);
  const stored = async () => (await readdir(join(directory, 'files')).catch(() => [] as string[])).sort();
  const pat = (scopes: TokenScope[] = ['read', 'write']) => {
    const raw = token();
    backend.repo.createAccessToken({ id: randomUUID(), userId: admin.user.id, name: 'test', scopes,
      createdAt: time, lastUsedAt: null, expiresAt: null, revoked: 0 }, hash(raw));
    return raw;
  };
  return {
    get backend() { return backend; }, admin, member, directory, config, request, json, create, part, complete, cancel, stored, pat,
    advance(ms: number) { time += ms; },
    async restart() { await backend.close(); backend = build(); },
    async dispose() { await backend.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
async function ok(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function error(response: Response, status: number, code: string) {
  assert.equal(response.status, status, await response.clone().text());
  assert.deepEqual(await response.json(), { error: { code } });
}

test('AC-U1/U3: unordered parallel chunks, duplicate idempotence, SHA-256 and byte-exact HTTP completion', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const bytes = Buffer.concat([Buffer.alloc(chunkSize, 1), Buffer.alloc(chunkSize, 2), Buffer.from('tail')]);
  const created = await ok(await f.create(bytes.length), 201);
  assert.deepEqual(created.received, []);
  assert.equal(created.chunkSize, chunkSize);
  const { uploadId: id } = created;
  const parts = [bytes.subarray(0, chunkSize), bytes.subarray(chunkSize, 2 * chunkSize), bytes.subarray(2 * chunkSize)];
  const responses = await Promise.all([2, 0, 1].map(i => f.part(id, i, parts[i])));
  for (const response of responses) assert.equal(response.status, 204);
  const keys = await f.stored();
  for (const response of await Promise.all([f.part(id, 1, parts[1]), f.part(id, 1, parts[1])])) assert.equal(response.status, 204);
  assert.deepEqual(await f.stored(), keys, 'duplicates leave exactly one persisted copy');
  await error(await f.part(id, 1, Buffer.alloc(chunkSize, 3)), 409, 'CHUNK_CONFLICT');
  await error(await f.part(id, 2, parts[2], f.admin.base, f.admin.cookie, '0'.repeat(64)), 400, 'CHECKSUM_MISMATCH');
  assert.equal((await f.part(id, 2, parts[2], f.admin.base, f.admin.cookie,
    createHash('sha256').update(parts[2]).digest('hex').toUpperCase())).status, 204);
  assert.deepEqual((await ok(await f.request(`${f.admin.base}/uploads/${id}`))).received, [0, 1, 2]);
  const { item } = await ok(await f.complete(id), 201);
  assert.deepEqual(Buffer.from(await (await f.request(`${f.admin.base}/items/${item.id}/download`)).arrayBuffer()), bytes);
  assert.equal((await f.stored()).length, 1, 'all temporary chunks are gone');
  assert.equal((await f.complete(id)).status, 404);
  assert.equal((await f.request(`${f.admin.base}/uploads/${id}`)).status, 404);
});

test('AC-U1/U4: received and reserved quota survive process recreation and old chunk files survive sweeping', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const { uploadId: id } = await ok(await f.create(chunkSize + 3), 201);
  assert.equal((await f.part(id, 0, Buffer.alloc(chunkSize, 7))).status, 204);
  for (const key of await f.stored()) await utimes(join(f.directory, 'files', key), new Date(0), new Date(0));
  const original = await f.stored();
  await f.restart();
  assert.deepEqual(await f.stored(), original);
  assert.equal((await ok(await f.request('/api/me'))).reservedBytes, chunkSize + 3);
  assert.deepEqual((await ok(await f.request(`${f.admin.base}/uploads/${id}`))).received, [0]);
  assert.equal((await f.part(id, 1, 'end')).status, 204);
  const { item } = await ok(await f.complete(id), 201);
  assert.equal(item.size, chunkSize + 3);
  assert.equal((await ok(await f.request('/api/me'))).reservedBytes, 0);
  assert.equal((await f.stored()).length, 1);
});

test('AC-U2: atomic reservations prevent concurrent over-quota creates and legacy/text bypasses', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  assert.equal((await f.json(`/api/admin/users/${f.admin.user.id}`, { quotaBytes: 10 }, f.admin.cookie, 'PATCH')).status, 204);
  const responses = await Promise.all([f.create(7), f.create(7)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 413]);
  const id = (await responses.find(r => r.status === 201)!.json()).uploadId;
  assert.equal((await ok(await f.request('/api/me'))).reservedBytes, 7);
  await error(await f.json(`${f.admin.base}/items/text`, { text: 'four' }), 413, 'QUOTA_EXCEEDED');
  await error(await f.request(`${f.admin.base}/items/file`, { method: 'POST', body: 'four' }), 413, 'QUOTA_EXCEEDED');
  assert.deepEqual(await f.stored(), []);
  assert.equal((await f.cancel(id)).status, 204);
  assert.equal((await ok(await f.json(`${f.admin.base}/items/text`, { text: 'ten bytes!' }), 201)).item.size, 10);
});

test('AC-U2: creation enforces size, item slots, session caps and reservation release', async t => {
  const f = await fixture({ maxItems: 1, maxFileBytes: 10, roomMaxFileBytes: 5 }); t.after(() => f.dispose());
  await error(await f.create(11), 413, 'FILE_TOO_LARGE');
  for (const size of [0, -1, 1.5]) assert.equal((await f.create(size)).status, 400);
  const { uploadId: id } = await ok(await f.create(1), 201);
  await error(await f.create(1), 413, 'ITEM_LIMIT');
  await error(await f.json(`${f.admin.base}/items/text`, { text: 'x' }), 413, 'ITEM_LIMIT');
  assert.equal((await f.cancel(id)).status, 204);
  await ok(await f.json(`${f.admin.base}/items/text`, { text: 'x' }), 201);
  assert.deepEqual(await f.stored(), []);

  const capped = await fixture({ uploadSessionsPerUser: 1, uploadSessionsGlobal: 2 }); t.after(() => capped.dispose());
  const first = await ok(await capped.create(1), 201);
  await error(await capped.create(1), 429, 'UPLOAD_SESSION_LIMIT');
  const second = await ok(await capped.create(1, capped.member.base, capped.member.cookie), 201);
  const room = await ok(await capped.json('/api/rooms', {}), 201);
  await error(await capped.create(1, `/api/rooms/${room.token}`, ''), 429, 'UPLOAD_SESSION_LIMIT');
  assert.equal((await capped.cancel(first.uploadId)).status, 204);
  await ok(await capped.create(1, `/api/rooms/${room.token}`, ''), 201);
  assert.equal((await capped.cancel(second.uploadId, capped.member.base, capped.member.cookie)).status, 204);
});

test('AC-U2/U3: malformed indices, long/short chunks, bad checksums are retryable', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const { uploadId: id } = await ok(await f.create(4), 201);
  for (const index of [-1, 1, '01', '1.5', '9007199254740993']) await error(await f.part(id, index, 'data'), 400, 'INVALID_CHUNK_INDEX');
  await error(await f.part(id, 0, 'abc'), 400, 'CHUNK_SIZE_MISMATCH');
  await error(await f.part(id, 0, 'abcde'), 413, 'FILE_TOO_LARGE');
  await error(await f.part(id, 0, 'data', f.admin.base, f.admin.cookie, 'xyz'), 400, 'INVALID_CHECKSUM');
  await error(await f.part(id, 0, 'data', f.admin.base, f.admin.cookie, '0'.repeat(64)), 400, 'CHECKSUM_MISMATCH');
  assert.deepEqual((await ok(await f.request(`${f.admin.base}/uploads/${id}`))).received, []);
  assert.deepEqual(await f.stored(), []);
  assert.equal((await f.part(id, 0, 'data')).status, 204);
  await ok(await f.complete(id), 201);
});

test('AC-U2: missing chunks and corrupt assembled size destroy the complete session without an item', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const { uploadId: missing } = await ok(await f.create(chunkSize + 1), 201);
  assert.equal((await f.part(missing, 1, 'x')).status, 204);
  await error(await f.complete(missing), 400, 'UPLOAD_INCOMPLETE');
  assert.equal((await f.request(`${f.admin.base}/uploads/${missing}`)).status, 404);
  const { uploadId: corrupt } = await ok(await f.create(4), 201);
  assert.equal((await f.part(corrupt, 0, 'data')).status, 204);
  await writeFile(join(f.directory, 'files', (await f.stored())[0]), 'bad');
  await error(await f.complete(corrupt), 400, 'UPLOAD_INCOMPLETE');
  assert.deepEqual(await f.stored(), []);
  assert.deepEqual((await ok(await f.request(`${f.admin.base}/items`))).items, []);
  assert.equal((await ok(await f.request('/api/me'))).reservedBytes, 0);
});

test('AC-U2/U6: common media pipeline rejects SVG, corrupt/oversized rasters and charges thumbnails atomically', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const oversized = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: 'white' } }).png().toBuffer();
  for (const [bytes, mime] of [
    [Buffer.from('<svg onload="alert(1)"></svg>'), 'image/svg+xml'],
    [Buffer.from('<svg/>'), 'image/png'],
    [Buffer.from('<svg/>'), 'application/octet-stream'],
    [Buffer.from('fake PNG'), 'image/png'],
    [oversized, 'image/png'],
  ] as const) {
    const { uploadId } = await ok(await f.create(bytes.length, f.admin.base, f.admin.cookie, mime), 201);
    for (let i = 0; i < Math.ceil(bytes.length / chunkSize); i++) assert.equal((await f.part(uploadId, i, bytes.subarray(i * chunkSize, (i + 1) * chunkSize))).status, 204);
    await error(await f.complete(uploadId), 415, 'INVALID_IMAGE');
    assert.deepEqual(await f.stored(), []);
  }
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  const { uploadId } = await ok(await f.create(png.length, f.admin.base, f.admin.cookie, 'application/octet-stream', '../a\\bad\r\n.png'), 201);
  assert.equal((await f.part(uploadId, 0, png)).status, 204);
  const { item } = await ok(await f.complete(uploadId), 201);
  assert.equal(item.hasThumbnail, true, 'magic bytes trigger raster validation despite a false MIME');
  assert(!/[\\/\r\n]/.test(item.filename));
  assert.equal((await f.stored()).length, 2);
  assert((await ok(await f.request('/api/me'))).usedBytes > png.length);
  assert.equal((await f.request(`${f.admin.base}/items/${item.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(await f.stored(), []);

  await f.json(`/api/admin/users/${f.admin.user.id}`, { quotaBytes: png.length }, f.admin.cookie, 'PATCH');
  const noRoomForThumbnail = await ok(await f.create(png.length, f.admin.base, f.admin.cookie, 'image/png'), 201);
  assert.equal((await f.part(noRoomForThumbnail.uploadId, 0, png)).status, 204);
  await error(await f.complete(noRoomForThumbnail.uploadId), 413, 'QUOTA_EXCEEDED');
  assert.deepEqual(await f.stored(), []);
  assert.equal((await ok(await f.request('/api/me'))).reservedBytes, 0);
});

test('AC-U3: unknown, cross-user (including shared space) and cross-room ids give the same 404', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const db = new Database(join(f.directory, 'dropit.sqlite'));
  db.prepare('INSERT INTO members (spaceId,userId) VALUES (?,?)').run(f.admin.base.split('/').pop(), f.member.user.id); db.close();
  const { uploadId } = await ok(await f.create(1), 201);
  for (const id of [uploadId, randomUUID(), 'invalid']) {
    await error(await f.request(`${f.admin.base}/uploads/${id}`, {}, f.member.cookie), 404, 'NOT_FOUND');
    await error(await f.part(id, 0, 'x', f.admin.base, f.member.cookie), 404, 'NOT_FOUND');
    await error(await f.complete(id, f.admin.base, f.member.cookie), 404, 'NOT_FOUND');
    await error(await f.cancel(id, f.admin.base, f.member.cookie), 404, 'NOT_FOUND');
  }
  const room = await ok(await f.json('/api/rooms', {}), 201);
  await error(await f.request(`/api/rooms/${room.token}/uploads/${uploadId}`, {}, ''), 404, 'NOT_FOUND');
  assert.equal((await f.cancel(uploadId)).status, 204);
});

test('AC-U1/U3: cookie Origin, independent Bearer scopes and header precedence match existing uploads', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const { uploadId } = await ok(await f.create(1), 201);
  await error(await f.request(`${f.admin.base}/uploads/${uploadId}/chunks/0`, { method: 'PUT', body: 'x', headers: { origin: 'https://evil.example' } }), 403, 'ORIGIN_REJECTED');
  const readOnly = f.pat(['read']);
  await error(await f.request(`${f.admin.base}/uploads/${uploadId}/chunks/0`, { method: 'PUT', body: 'x', headers: { authorization: `Bearer ${readOnly}` } }), 403, 'INSUFFICIENT_SCOPE');
  await error(await f.request(`${f.admin.base}/uploads/${uploadId}`, { headers: { authorization: 'Bearer invalid' } }), 401, 'UNAUTHENTICATED');
  const headers = { authorization: `Bearer ${f.pat()}`, origin: 'https://cli.example' };
  assert.equal((await f.request(`${f.admin.base}/uploads/${uploadId}/chunks/0`, { method: 'PUT', body: 'x', headers })).status, 204);
  await ok(await f.request(`${f.admin.base}/uploads/${uploadId}/complete`, { method: 'POST', headers }), 201);
});

test('AC-U1/U2: rooms support resume and complete with their own size/quota limits', async t => {
  const f = await fixture({ roomMaxFileBytes: 5, roomQuotaBytes: 7 }); t.after(() => f.dispose());
  const room = await ok(await f.json('/api/rooms', {}), 201);
  const base = `/api/rooms/${room.token}`;
  await error(await f.create(6, base, ''), 413, 'FILE_TOO_LARGE');
  const { uploadId } = await ok(await f.create(5, base, ''), 201);
  await error(await f.create(3, base, ''), 413, 'QUOTA_EXCEEDED');
  assert.equal((await f.part(uploadId, 0, 'hello', base, '')).status, 204);
  await f.restart();
  assert.deepEqual((await ok(await f.request(`${base}/uploads/${uploadId}`, {}, ''))).received, [0]);
  const { item } = await ok(await f.complete(uploadId, base, ''), 201);
  assert.equal(item.userId, null);
  assert.equal(await (await f.request(`${base}/items/${item.id}/download`, {}, '')).text(), 'hello');
  assert.equal((await f.stored()).length, 1);
});

test('AC-U2: pending quota also constrains text growth and two concurrent completes produce one item', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  assert.equal((await f.json(`/api/admin/users/${f.admin.user.id}`, { quotaBytes: 10 }, f.admin.cookie, 'PATCH')).status, 204);
  const { item } = await ok(await f.json(`${f.admin.base}/items/text`, { text: 'abc' }), 201);
  const { uploadId } = await ok(await f.create(7), 201);
  await error(await f.json(`${f.admin.base}/items/${item.id}`, { text: 'four' }, f.admin.cookie, 'PATCH'), 413, 'QUOTA_EXCEEDED');
  assert.equal((await f.part(uploadId, 0, '1234567')).status, 204);
  const completes = await Promise.all([f.complete(uploadId), f.complete(uploadId)]);
  assert.deepEqual(completes.map(response => response.status).sort(), [201, 409]);
  assert.equal((await ok(await f.request(`${f.admin.base}/items`))).items.length, 2);
  assert.equal((await f.stored()).length, 1);
  assert.equal((await ok(await f.request('/api/me'))).reservedBytes, 0);
});

test('AC-U4: cancel during assembly cannot resurrect an upload or leave files behind', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const { uploadId } = await ok(await f.create(1), 201);
  assert.equal((await f.part(uploadId, 0, 'x')).status, 204);
  const files = f.backend.files;
  const original = files.write.bind(files);
  let arrived!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  files.write = async (...args) => { arrived(); await gate; return original(...args); };
  const completing = f.complete(uploadId);
  await started;
  const cancelling = f.cancel(uploadId);
  // Reading the next request ensures cancellation has synchronously removed
  // the durable session before assembly is allowed to proceed.
  assert.equal((await f.request(`${f.admin.base}/uploads/${uploadId}`)).status, 404);
  release();
  assert.equal((await cancelling).status, 204);
  assert.equal((await completing).status, 404);
  files.write = original;
  assert.deepEqual(await f.stored(), []);
  assert.deepEqual((await ok(await f.request(`${f.admin.base}/items`))).items, []);
});

test('AC-U4: cancellation, absolute 24h expiry and room expiry clean disk and release reservations', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const one = await ok(await f.create(1), 201);
  assert.equal((await f.part(one.uploadId, 0, 'x')).status, 204);
  assert.equal((await f.cancel(one.uploadId)).status, 204);
  assert.deepEqual(await f.stored(), []);
  const two = await ok(await f.create(1), 201);
  assert.equal((await f.part(two.uploadId, 0, 'x')).status, 204);
  f.advance(23 * 3600000); await f.backend.service.cleanup();
  assert.equal((await f.stored()).length, 1);
  f.advance(3600000); await f.backend.service.cleanup();
  assert.deepEqual(await f.stored(), []);
  assert.equal((await f.request(`${f.admin.base}/uploads/${two.uploadId}`)).status, 404);
  assert.equal((await ok(await f.request('/api/me'))).reservedBytes, 0);
  await ok(await f.json('/api/admin/limits', { roomRetentionMs: 1000 }, f.admin.cookie, 'PATCH'));
  const room = await ok(await f.json('/api/rooms', {}), 201);
  const base = `/api/rooms/${room.token}`;
  const three = await ok(await f.create(1, base, ''), 201);
  assert.equal(three.expiresAt, room.expiresAt);
  assert.equal((await f.part(three.uploadId, 0, 'x', base, '')).status, 204);
  f.advance(1000); await f.backend.service.cleanup();
  assert.deepEqual(await f.stored(), []);
  assert.equal((await f.complete(three.uploadId, base, '')).status, 404);
});

test('AC-U4: disabling a user cleans unfinished space and authenticated room uploads', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const room = await ok(await f.json('/api/rooms', {}), 201);
  const bases = [f.member.base, `/api/rooms/${room.token}`];
  for (const base of bases) {
    const { uploadId } = await ok(await f.create(1, base, f.member.cookie), 201);
    assert.equal((await f.part(uploadId, 0, 'x', base, f.member.cookie)).status, 204);
  }
  assert.equal((await f.json(`/api/admin/users/${f.member.user.id}`, { disabled: true }, f.admin.cookie, 'PATCH')).status, 204);
  assert.deepEqual(await f.stored(), []);
  assert.equal((await f.request(`${bases[0]}/uploads/invalid`, {}, f.member.cookie)).status, 401);
});

test('AC-U4: runtime controls persist, existing chunk size is frozen and completion rechecks current quota', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const first = await ok(await f.create(4), 201);
  const patch = { uploadChunkBytes: 2 * chunkSize, uploadChunksPerSession: 1, uploadChunksPerUser: 2,
    uploadChunksGlobal: 3, uploadSessionsPerUser: 4, uploadSessionsGlobal: 5, uploadChunkTimeoutMs: 10000, rateChunk: 500 };
  await ok(await f.json('/api/admin/limits', patch, f.admin.cookie, 'PATCH'));
  await f.restart();
  for (const [key, value] of Object.entries(patch)) assert.equal((await ok(await f.request('/api/admin/limits')))[key].value, value);
  assert.equal((await ok(await f.request(`${f.admin.base}/uploads/${first.uploadId}`))).chunkSize, chunkSize);
  const next = await ok(await f.create(1), 201);
  assert.equal(next.chunkSize, 2 * chunkSize);
  assert.equal((await f.cancel(next.uploadId)).status, 204);
  assert.equal((await f.part(first.uploadId, 0, 'data')).status, 204);
  assert.equal((await f.json(`/api/admin/users/${f.admin.user.id}`, { quotaBytes: 3 }, f.admin.cookie, 'PATCH')).status, 204);
  await error(await f.complete(first.uploadId), 413, 'QUOTA_EXCEEDED');
  assert.deepEqual(await f.stored(), []);
  assert.equal(Object.keys(limitRanges).length, 23);
});

test('AC-U4: 100 chunks bypass general/token/room-write limits but independent chunk rate still applies', async t => {
  const f = await fixture({ rateGeneral: 40, rateToken: 2, rateUpload: 3, rateRoom: 1, roomMaxFileBytes: 10 * 1024 ** 2 }); t.after(() => f.dispose());
  const room = await ok(await f.json('/api/rooms', {}), 201);
  const headers = { authorization: `Bearer ${f.pat()}`, origin: 'https://cli.example' };
  const created = await ok(await f.request(`/api/rooms/${room.token}/uploads`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ size: 100 * chunkSize, filename: 'many.bin', mime: 'application/octet-stream' }) }), 201);
  const path = `/api/rooms/${room.token}/uploads/${created.uploadId}/chunks`;
  for (let i = 0; i < 100; i++) assert.equal((await f.request(`${path}/${i}`, { method: 'PUT', body: new Uint8Array(chunkSize), headers })).status, 204);
  await ok(await f.json('/api/admin/limits', { rateChunk: 100 }, f.admin.cookie, 'PATCH'));
  const limited = await f.request(`${path}/0`, { method: 'PUT', body: new Uint8Array(chunkSize), headers });
  await error(limited, 429, 'RATE_LIMITED');
  assert(limited.headers.has('retry-after'));
});

async function hold(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const files = f.backend.files;
  const original = files.write.bind(files);
  let arrived!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  files.write = (...args) => { arrived(); return original(...args); };
  const response = f.part(id, 0, body);
  await started;
  files.write = original;
  return { response, finish() { controller.enqueue(new Uint8Array([1])); controller.close(); } };
}

test('AC-U4: session/account/global concurrency caps reject excess work and cancellation aborts partial writes', async t => {
  const f = await fixture({ uploadChunksPerSession: 1, uploadChunksPerUser: 1, uploadChunksGlobal: 2 }); t.after(() => f.dispose());
  const first = await ok(await f.create(1), 201);
  const second = await ok(await f.create(1), 201);
  const stalled = await hold(f, first.uploadId);
  const busy = await f.part(first.uploadId, 0, 'x'); await error(busy, 429, 'CHUNK_BUSY');
  assert(busy.headers.has('retry-after'));
  await error(await f.part(second.uploadId, 0, 'x'), 429, 'CHUNK_BUSY');
  await error(await f.complete(first.uploadId), 409, 'UPLOAD_IN_PROGRESS');
  assert.equal((await f.cancel(first.uploadId)).status, 204);
  assert.equal((await stalled.response).status, 404);
  assert.deepEqual(await f.stored(), []);
  await ok(await f.json('/api/admin/limits', { uploadChunksPerUser: 6, uploadChunksGlobal: 1 }, f.admin.cookie, 'PATCH'));
  const blocked = await hold(f, second.uploadId);
  const other = await ok(await f.create(1, f.member.base, f.member.cookie), 201);
  await error(await f.part(other.uploadId, 0, 'x', f.member.base, f.member.cookie), 429, 'CHUNK_BUSY');
  blocked.finish(); assert.equal((await blocked.response).status, 204);
  assert.equal((await f.part(other.uploadId, 0, 'x', f.member.base, f.member.cookie)).status, 204);
});

test('AC-U5: per-chunk timeout on a real HTTP server frees resources and permits retransmission', async t => {
  const f = await fixture({ uploadChunkTimeoutMs: 20 }); t.after(() => f.dispose());
  const server = serve({ fetch: f.backend.app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { uploadId } = await ok(await f.create(1), 201);
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${f.admin.base}/uploads/${uploadId}/chunks/0`, {
    method: 'PUT', headers: { origin, cookie: f.admin.cookie }, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } }), duplex: 'half',
  } as RequestInit);
  await error(response, 400, 'UPLOAD_TIMEOUT');
  assert.deepEqual(await f.stored(), []);
  assert.equal((await f.part(uploadId, 0, 'x')).status, 204);
  await ok(await f.complete(uploadId), 201);
  const key = (await f.stored())[0];
  assert.equal((await readFile(join(f.directory, 'files', key))).toString(), 'x');
});
