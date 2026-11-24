// Isolated TS baseline vs Rust HTTP/WS comparison for temporary-room chunk sessions.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect as netConnect, createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fixture, PASSWORD } from './fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68';
const rustBin = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
const chunkBytes = 64 * 1024;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const origin = 'http://dropit.test';
await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const temp = await mkdtemp(resolve(root, 'rust/server/data/room-chunks-'));
const processes = new Set();
const sockets = new Set();
let reference;
let Sqlite;
let WebSocket;
let checks = 0;
let seed;
let meta;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function note(label, detail) {
  console.log('EVIDENCE ' + label + ' ' + JSON.stringify(detail));
}

async function prepare() {
  const directory = resolve(temp, 'reference');
  await mkdir(directory);
  const archive = execFileSync('git', ['archive', baseline, '--',
    'apps/server', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@dropit/server...'],
    { cwd: directory, stdio: 'pipe' });
  execFileSync('pnpm', ['--filter', '@dropit/server', 'build'], { cwd: directory, stdio: 'pipe' });
  const require = createRequire(resolve(directory, 'apps/server/package.json'));
  Sqlite = require('better-sqlite3');
  WebSocket = require('ws');
  console.log('PASS room-chunk reference built from ' + baseline);
  return directory;
}

async function start(kind, data, extra = {}) {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((ok, reject) => listener.close(error => error ? reject(error) : ok()));
  const child = spawn(kind === 'rust' ? rustBin : process.execPath,
    kind === 'rust' ? [] : [resolve(reference, 'apps/server/dist/index.js')], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port),
        APP_ORIGIN: origin, UPDATE_CHECK: '0',
        RATE_GENERAL: '10000', RATE_AUTH: '1000', RATE_INVITE: '100', RATE_UPLOAD: '1000', RATE_ROOM: '500',
        RATE_TOKEN: '200', RATE_CHUNK: '2000', PIN_LOCK_FAILURES: '2',
        UPLOAD_CHUNK_BYTES: String(chunkBytes),
        MAX_FILE_BYTES: String(2 * 1024 * 1024),
        ROOM_MAX_FILE_BYTES: String(512 * 1024),
        ROOM_QUOTA_BYTES: String(1024 * 1024),
        USER_QUOTA_BYTES: String(8 * 1024 * 1024),
        ...extra,
      },
    });
  processes.add(child);
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const server = { kind, child, url: `http://127.0.0.1:${port}`, data, output: '' };
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(kind + ' exited\n' + output);
    if (output.includes('dropit listening on port ')) {
      try {
        const response = await fetch(server.url + '/healthz', { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.ok) {
          server.output = output;
          return server;
        }
      } catch { /* startup */ }
    }
    await delay(25);
  }
  throw new Error(kind + ' readiness failed\n' + output);
}

async function stop(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = once(server.child, 'exit');
  server.child.kill('SIGTERM');
  await Promise.race([exited, delay(2000)]);
  if (server.child.exitCode === null) {
    server.child.kill('SIGKILL');
    await Promise.race([exited, delay(1000)]);
  }
  processes.delete(server.child);
}

async function req(server, path, { method = 'GET', cookie, token, json, body, headers = {}, origin: requestOrigin = origin } = {}) {
  const requestHeaders = { ...headers };
  if (requestOrigin !== null) requestHeaders.origin = requestOrigin;
  if (cookie) requestHeaders.cookie = cookie;
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (json !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const response = await fetch(server.url + path, {
    method, headers: requestHeaders, body, redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
  checks++;
  let parsed = text;
  if (response.headers.get('content-type')?.includes('application/json') && text) parsed = JSON.parse(text);
  return { status: response.status, headers: response.headers, bytes, body: parsed };
}

function expect(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body?.error?.code, code);
  return response.body;
}
function codeOf(response) {
  return response.body?.error?.code ?? null;
}
function openDb(data, readonly) {
  return new Sqlite(resolve(data, 'dropit.sqlite'), { readonly, fileMustExist: true, timeout: 5000 });
}
function lookup(data, statement, ...args) {
  const db = openDb(data, true);
  try { return db.prepare(statement).get(...args); }
  finally { db.close(); }
}
function sql(data, statement, ...args) {
  const db = openDb(data, false);
  try { return db.prepare(statement).run(...args); }
  finally { db.close(); }
}
function freshDeviceKey() {
  return (randomUUID().replaceAll('-', '') + 'roomdevicekey').slice(0, 43);
}
async function fileNames(data) {
  try {
    return (await readdir(resolve(data, 'files'))).filter(name => /^[0-9a-f-]{36}$/.test(name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function login(server, email) {
  const response = await req(server, '/api/auth/password/login', {
    method: 'POST', json: { email, password: PASSWORD },
  });
  expect(response, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
async function connect(server, path, cookie, token) {
  const ws = new WebSocket(server.url.replace('http:', 'ws:') + path, {
    origin, headers: { ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  sockets.add(ws);
  const queue = [];
  const waiters = [];
  ws.on('message', bytes => {
    const value = JSON.parse(bytes.toString());
    if (waiters.length) waiters.shift()(value);
    else queue.push(value);
  });
  await once(ws, 'open');
  return {
    ws,
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolveNext, reject) => {
      const timer = setTimeout(() => reject(new Error('WS event timeout')), 5000);
      waiters.push(value => { clearTimeout(timer); resolveNext(value); });
    }),
    drain: () => queue.splice(0, queue.length),
  };
}
function hold(server, path, cookie, bytes, extraLength = 100000) {
  return new Promise((resolveHold, reject) => {
    const url = new URL(server.url);
    const socket = netConnect(url.port, url.hostname, () => {
      socket.write(
        'PUT ' + path + ' HTTP/1.1\r\nHost: ' + url.host + '\r\nOrigin: ' + origin + '\r\n' +
        (cookie ? 'Cookie: ' + cookie + '\r\n' : '') +
        'Content-Length: ' + (bytes.length + extraLength) + '\r\n\r\n' + bytes.toString('latin1'),
      );
      resolveHold(socket);
    });
    socket.on('error', () => {});
    socket.setTimeout(5000, () => reject(new Error('held upload socket hung')));
  });
}
async function createRoom(server, cookie, extra = {}) {
  const deviceKey = extra.deviceKey ?? freshDeviceKey();
  const response = await req(server, '/api/rooms', {
    method: 'POST', cookie, json: { ...extra, deviceKey },
  });
  expect(response, 201);
  return { ...response.body, deviceKey };
}
async function createUpload(server, token, bytes, filename, mime, { cookie, bearer, headers, origin: requestOrigin } = {}) {
  return req(server, `/api/rooms/${token}/uploads`, {
    method: 'POST', cookie, token: bearer, origin: requestOrigin,
    json: { filename, size: bytes.length, mime }, headers,
  });
}
async function putChunk(server, token, id, index, bytes, { cookie, bearer, headers = {}, origin: requestOrigin } = {}) {
  return req(server, `/api/rooms/${token}/uploads/${id}/chunks/${index}`, {
    method: 'PUT', cookie, token: bearer, origin: requestOrigin, body: bytes,
    headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256(bytes), ...headers },
  });
}
async function complete(server, token, id, { cookie, bearer, headers, origin: requestOrigin } = {}) {
  return req(server, `/api/rooms/${token}/uploads/${id}/complete`, {
    method: 'POST', cookie, token: bearer, origin: requestOrigin, headers,
  });
}

async function cleanupState(data, room) {
  return {
    uploadRows: lookup(data, 'SELECT count(*) AS n FROM uploads').n,
    chunkRows: lookup(data, 'SELECT count(*) AS n FROM upload_chunks').n,
    garbageRows: lookup(data, 'SELECT count(*) AS n FROM garbage').n,
    filesRemaining: (await fileNames(data)).length,
    reservedBytes: lookup(data, 'SELECT coalesce(sum(size),0) AS n FROM uploads WHERE spaceId=?', room.token.split('.')[0]).n,
    storedBytes: lookup(data, 'SELECT coalesce(sum(storedBytes),0) AS n FROM items WHERE spaceId=?', room.token.split('.')[0]).n,
  };
}

async function cleanupPaths(kind) {
  const data = resolve(temp, 'paths-' + kind);
  await cp(seed, data, { recursive: true });
  const server = await start(kind, data, { CLEANUP_INTERVAL_MS: '86400000' });
  try {
    const room = await createRoom(server);
    const base = `/api/rooms/${room.token}`;
    const cookie = 'dropit_session=' + meta.oldCookie;
    const before = expect(await req(server, '/api/me', { cookie }), 200);
    const empty = { uploadRows: 0, chunkRows: 0, garbageRows: 0, filesRemaining: 0, reservedBytes: 0, storedBytes: 0 };
    const results = [];
    const cases = [
      ['svg', svg, 'image/svg+xml', 415, 'INVALID_IMAGE'],
      ['bad-raster', Buffer.from('not a PNG'), 'image/png', 415, 'INVALID_IMAGE'],
      ['incomplete', Buffer.alloc(chunkBytes + 1, 7), 'application/octet-stream', 400, 'UPLOAD_INCOMPLETE'],
      ['cancel', Buffer.from('cancel'), 'text/plain', 204, null],
      // A real EISDIR during removal must not replace UPLOAD_INCOMPLETE.
      ['cleanup-io', Buffer.alloc(chunkBytes + 1, 8), 'application/octet-stream', 400, 'UPLOAD_INCOMPLETE'],
      // With every chunk present, reading that directory fails instead (500).
      ['assembly-io', Buffer.from('read failure'), 'text/plain', 500, 'INTERNAL_ERROR'],
    ];
    for (const [label, bytes, mime, status, code] of cases) {
      const upload = expect(await createUpload(server, room.token, bytes, label, mime, { cookie }), 201);
      assert.equal((await cleanupState(data, room)).reservedBytes, bytes.length);
      expect(await putChunk(server, room.token, upload.uploadId, 0, bytes.subarray(0, chunkBytes)), 204);
      let blocked;
      if (label.endsWith('-io')) {
        const key = lookup(data, 'SELECT key FROM upload_chunks WHERE uploadId=?', upload.uploadId).key;
        blocked = resolve(data, 'files', key);
        await rm(blocked);
        await mkdir(blocked); // unlink fails even when the fixture runs as root.
        await writeFile(resolve(blocked, 'blocker'), 'real filesystem failure');
      }
      const response = label === 'cancel'
        ? await req(server, `${base}/uploads/${upload.uploadId}`, { method: 'DELETE' })
        : await complete(server, room.token, upload.uploadId);
      expect(response, status, code);
      expect(await req(server, `${base}/uploads/${upload.uploadId}`), 404, 'NOT_FOUND');
      const state = await cleanupState(data, room);
      assert.deepEqual(state, { ...empty, ...(blocked ? { garbageRows: 1, filesRemaining: 1 } : {}) }, label);
      results.push({ label, status: response.status, code: codeOf(response), ...state });
      if (blocked) {
        // SQL queue survives the failed unlink; repair only our fixture and
        // explicitly trigger another flush, without waiting for maintenance.
        await rm(blocked, { recursive: true });
        const retry = expect(await createUpload(server, room.token, Buffer.from('retry'), 'retry', 'text/plain'), 201);
        expect(await req(server, `${base}/uploads/${retry.uploadId}`, { method: 'DELETE' }), 204);
        assert.deepEqual(await cleanupState(data, room), empty, label + ' retry');
      }
    }
    // More than four failed completes above, then a successful complete and a
    // legacy upload: leaked shared permits fail this sequence with UPLOAD_BUSY.
    const ok = Buffer.from('permit released');
    const upload = expect(await createUpload(server, room.token, ok, 'ok.txt', 'text/plain'), 201);
    expect(await putChunk(server, room.token, upload.uploadId, 0, ok), 204);
    const item = expect(await complete(server, room.token, upload.uploadId), 201).item;
    expect(await req(server, `${base}/items/${item.id}`, { method: 'DELETE' }), 204);
    expect(await req(server, `${base}/items/file`, { method: 'POST', body: ok,
      headers: { 'content-type': 'text/plain', 'x-file-name': 'legacy.txt' } }), 201);
    const after = expect(await req(server, '/api/me', { cookie }), 200);
    assert.equal(after.reservedBytes, before.reservedBytes);
    assert.equal(after.usedBytes, before.usedBytes);
    note(kind + '-cleanup-paths', results);
    return results;
  } finally { await stop(server); }
}

async function roomFilenames(kind) {
  const data = resolve(temp, 'filenames-' + kind);
  await cp(seed, data, { recursive: true });
  const server = await start(kind, data, { CLEANUP_INTERVAL_MS: '86400000' });
  try {
    const room = await createRoom(server);
    const results = [];
    for (const filename of ['file\ud800.txt', 'x'.repeat(179) + '😀suffix', 'a\ud800\u0000\udc00.txt']) {
      const bytes = Buffer.from('name');
      const upload = expect(await createUpload(server, room.token, bytes, filename, 'text/plain'), 201);
      const row = lookup(data, 'SELECT filename,hex(filename) AS hex FROM uploads WHERE id=?', upload.uploadId);
      expect(await putChunk(server, room.token, upload.uploadId, 0, bytes), 204);
      const item = expect(await complete(server, room.token, upload.uploadId), 201).item;
      const read = expect(await req(server, `/api/rooms/${room.token}/items`), 200).items.find(value => value.id === item.id);
      assert.equal(item.filename, read.filename);
      results.push({ input: filename, hex: row.hex, stored: row.filename, immediate: item.filename, read: read.filename });
    }
    note(kind + '-room-filenames', results);
    return results;
  } finally { await stop(server); }
}

try {
  reference = await prepare();
  seed = resolve(temp, 'seed');
  meta = await fixture(seed, { referenceRoot: reference });
  const outcomes = {};
  for (const kind of ['ts', 'rust']) {
    const data = resolve(temp, 'cleanup-' + kind);
    await cp(seed, data, { recursive: true });
    const server = await start(kind, data, {
      ROOM_QUOTA_BYTES: String(png.length),
      CLEANUP_INTERVAL_MS: '86400000',
    });
    try {
      const room = await createRoom(server);
      for (let attempt = 0; attempt < 5; attempt++) {
        const created = expect(await createUpload(server, room.token, png, 'quota.png', 'image/png'), 201);
        expect(await putChunk(server, room.token, created.uploadId, 0, png), 204);
        const before = await fileNames(data);
        assert.equal(before.length, 1);
        const response = await complete(server, room.token, created.uploadId);
        expect(response, 413, 'QUOTA_EXCEEDED');
        outcomes[kind] = {
          status: response.status,
          code: codeOf(response),
          uploadRows: lookup(data, 'SELECT count(*) AS n FROM uploads').n,
          chunkRows: lookup(data, 'SELECT count(*) AS n FROM upload_chunks').n,
          garbageRows: lookup(data, 'SELECT count(*) AS n FROM garbage').n,
          filesRemaining: (await fileNames(data)).length,
        };
        assert.equal((await cleanupState(data, room)).reservedBytes, 0);
        assert.equal((await cleanupState(data, room)).storedBytes, 0);
        assert.equal(outcomes[kind].filesRemaining, 0);
        assert.equal(outcomes[kind].garbageRows, 0);
      }
      note(kind + '-failed-complete-cleanup', outcomes[kind]);
      const recovered = Buffer.from('ok');
      const retry = expect(await createUpload(server, room.token, recovered, 'ok.txt', 'text/plain'), 201);
      expect(await putChunk(server, room.token, retry.uploadId, 0, recovered), 204);
      expect(await complete(server, room.token, retry.uploadId), 201);

    } finally { await stop(server); }
  }
  assert.deepEqual(outcomes.rust, outcomes.ts, 'failed complete must flush its chunk garbage before returning');
  assert.deepEqual(await cleanupPaths('rust'), await cleanupPaths('ts'));
  assert.deepEqual(await roomFilenames('rust'), await roomFilenames('ts'));
  console.log('PASS strict cleanup paths, I/O retry, permits, quota and room Unicode filenames');
} finally {
  for (const child of processes) child.kill('SIGKILL');
  for (const ws of sockets) ws.terminate();
  await rm(temp, { recursive: true, force: true });
}
