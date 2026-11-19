// Isolated TS baseline vs Rust HTTP/WS comparison for temporary-room chunk sessions.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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

async function protocol(kind) {
  const data = resolve(temp, 'protocol-' + kind);
  await cp(seed, data, { recursive: true });
  const server = await start(kind, data);
  const evidence = {};
  try {
    const alice = await login(server, 'alice@example.test');
    const bob = await login(server, 'bob@example.test');
    const viewer = await login(server, 'viewer@example.test');
    const before = expect(await req(server, '/api/me', { cookie: alice }), 200);
    const bobBefore = expect(await req(server, '/api/me', { cookie: bob }), 200);
    const room = await createRoom(server, alice, { code: 'ROOM01', pin: '1234' });
    const roomId = room.token.split('.')[0];
    const base = `/api/rooms/${room.token}`;
    assert.equal(room.expiresAt > Date.now(), true);
    const other = await createRoom(server, undefined, { code: 'ROOM02' });
    const anon = expect(await createUpload(server, room.token, Buffer.from('anon-bytes'), 'anon.txt', 'text/plain'), 201);
    assert.equal(anon.chunkSize, chunkBytes);
    assert.deepEqual(anon.received, []);
    const anonRow = lookup(data, 'SELECT userId, principal, expiresAt, chunkSize FROM uploads WHERE id=?', anon.uploadId);
    assert.equal(anonRow.userId, null);
    assert.equal(anonRow.principal, 'room:' + roomId);
    assert.equal(anonRow.expiresAt, room.expiresAt);
    assert.equal(anonRow.chunkSize, chunkBytes);
    const signed = expect(await createUpload(server, room.token, Buffer.from('signed-bytes'), '../room\u0000.txt', 'TEXT/PLAIN; charset=utf-8', { cookie: bob }), 201);
    const signedRow = lookup(data, 'SELECT userId, principal, filename FROM uploads WHERE id=?', signed.uploadId);
    assert.equal(signedRow.userId, null);
    assert.equal(signedRow.principal, 'user:' + meta.bob.id);
    assert.equal(/[\\/\u0000]/.test(signedRow.filename), false);
    const reserved = expect(await req(server, '/api/me', { cookie: bob }), 200);
    assert.equal(reserved.reservedBytes, bobBefore.reservedBytes);
    assert.equal(reserved.usedBytes, bobBefore.usedBytes);
    expect(await req(server, `/api/rooms/${room.code}/uploads`, { method: 'POST', json: { filename: 'no.txt', size: 1, mime: 'text/plain' } }), 404, 'NOT_FOUND');
    expect(await req(server, `/api/rooms/${other.token}/uploads/${signed.uploadId}`, { cookie: bob }), 404, 'NOT_FOUND');
    expect(await putChunk(server, other.token, signed.uploadId, 0, Buffer.from('signed-bytes'), { cookie: bob }), 404, 'NOT_FOUND');
    const privateUpload = expect(await req(server, `/api/spaces/${meta.aliceSpace}/uploads`, {
      method: 'POST', cookie: alice, json: { filename: 'private.bin', size: 4, mime: 'application/octet-stream' },
    }), 201);
    expect(await req(server, `${base}/uploads/${privateUpload.uploadId}`), 404, 'NOT_FOUND');
    expect(await req(server, `/api/spaces/${meta.aliceSpace}/uploads/${signed.uploadId}`, { cookie: alice }), 404, 'NOT_FOUND');
    expect(await req(server, `/api/spaces/${meta.aliceSpace}/uploads/${privateUpload.uploadId}`, { method: 'DELETE', cookie: alice }), 204);
    expect(await req(server, `${base}/uploads`, {
      method: 'POST', cookie: alice, origin: null, json: { filename: 'x.bin', size: 1, mime: 'text/plain' },
    }), 403, 'ORIGIN_REJECTED');
    const readPat = expect(await req(server, '/api/tokens', {
      method: 'POST', cookie: alice, json: { name: 'room read', scopes: ['read'] },
    }), 201);
    expect(await createUpload(server, room.token, Buffer.from('x'), 'pat.txt', 'text/plain', { bearer: readPat.token, origin: null }), 403, 'INSUFFICIENT_SCOPE');
    const writePat = expect(await req(server, '/api/tokens', {
      method: 'POST', cookie: alice, json: { name: 'room write', scopes: ['read', 'write'] },
    }), 201);
    expect(await req(server, `/api/rooms/${room.code}/uploads`, {
      method: 'POST', token: writePat.token, origin: null, json: { filename: 'no.txt', size: 1, mime: 'text/plain' },
    }), 404, 'NOT_FOUND');
    const cliBody = Buffer.from('cli-room-bytes');
    const cliCreated = expect(await createUpload(server, room.token, cliBody, 'cli.txt', 'application/octet-stream', {
      bearer: writePat.token, origin: null,
    }), 201);
    expect(await putChunk(server, room.token, cliCreated.uploadId, 0, cliBody, { bearer: writePat.token, origin: null }), 204);
    const cliItem = expect(await complete(server, room.token, cliCreated.uploadId, {
      bearer: writePat.token, origin: null,
      headers: {
        'x-dropit-device': 'cli-roomchunk0001',
        'x-dropit-device-name': encodeURIComponent('room-cli'),
        'x-dropit-device-kind': 'cli',
      },
    }), 201).item;
    assert.equal(cliItem.userId, null);
    assert.equal(cliItem.spaceId, roomId);
    assert.equal(cliItem.filename, 'cli.txt');
    assert.equal(cliItem.mime, 'application/octet-stream');
    assert.deepEqual(cliItem.device, { id: 'cli-roomchunk0001', name: 'room-cli', kind: 'cli' });
    assert.equal(cliItem.group ?? null, null);
    const cliDownload = await req(server, `${base}/items/${cliItem.id}/download`, { token: writePat.token, origin: null });
    expect(cliDownload, 200);
    assert.equal(cliDownload.bytes.equals(cliBody), true);
    const socket = await connect(server, `${base}/ws`);
    assert.equal((await socket.next()).type, 'snapshot');
    await socket.next();
    const webBody = Buffer.from('手机分片');
    const webCreated = expect(await createUpload(server, room.token, webBody, 'mobile.txt', 'text/plain', { cookie: viewer }), 201);
    const status = expect(await req(server, `${base}/uploads/${webCreated.uploadId}`, { cookie: viewer }), 200);
    assert.deepEqual(status.received, []);
    assert.equal(status.size, webBody.length);
    assert.equal(status.chunkSize, chunkBytes);
    const upper = sha256(webBody).toUpperCase();
    expect(await putChunk(server, room.token, webCreated.uploadId, 0, webBody, {
      cookie: viewer, headers: { 'x-chunk-sha256': upper },
    }), 204);
    expect(await putChunk(server, room.token, webCreated.uploadId, 0, webBody, { cookie: viewer }), 204);
    const resumed = expect(await req(server, `${base}/uploads/${webCreated.uploadId}`), 200);
    assert.deepEqual(resumed.received, [0]);
    assert.equal(resumed.expiresAt, webCreated.expiresAt);
    const webItem = expect(await complete(server, room.token, webCreated.uploadId, {
      cookie: viewer,
      headers: {
        'x-dropit-device': 'phone-roomchunk01',
        'x-dropit-device-name': encodeURIComponent('手机'),
        'x-dropit-device-kind': 'phone',
        'x-dropit-group': encodeURIComponent('房间分组'),
      },
    }), 201).item;
    assert.equal(webItem.userId, null);
    assert.equal(webItem.filename, 'mobile.txt');
    assert.deepEqual(webItem.device, { id: 'phone-roomchunk01', name: '手机', kind: 'phone' });
    assert.equal(webItem.group, '房间分组');
    assert.deepEqual(await socket.next(), { type: 'groups', groups: ['房间分组'] });
    const event = await socket.next();
    assert.equal(event.type, 'item.created');
    assert.equal(event.item.id, webItem.id);
    assert.equal(event.item.userId, null);
    assert.equal(event.item.spaceId, roomId);
    socket.ws.close();
    sockets.delete(socket.ws);
    const roomItems = expect(await req(server, `${base}/items`), 200);
    assert.equal(roomItems.items.some(item => item.id === webItem.id && item.userId === null), true);
    const privateItems = expect(await req(server, `/api/spaces/${meta.aliceSpace}/items`, { cookie: alice }), 200);
    assert.equal(privateItems.items.some(item => item.id === webItem.id || item.id === cliItem.id), false);
    const after = expect(await req(server, '/api/me', { cookie: alice }), 200);
    assert.equal(after.reservedBytes, before.reservedBytes);
    assert.equal(after.usedBytes, before.usedBytes);
    const bobAfter = expect(await req(server, '/api/me', { cookie: bob }), 200);
    assert.equal(bobAfter.reservedBytes, 0);
    assert.equal(bobAfter.usedBytes, 0);
    const ranged = await req(server, `${base}/items/${cliItem.id}/download`, { headers: { range: 'bytes=0-2' } });
    expect(ranged, 206);
    assert.equal(ranged.bytes.equals(cliBody.subarray(0, 3)), true);
    expect(await req(server, '/api/rooms/enter', { method: 'POST', json: { code: room.code, pin: 'nope' } }), 403, 'PIN_INVALID');
    expect(await req(server, '/api/rooms/enter', { method: 'POST', json: { code: room.code, pin: 'nope' } }), 429, 'RATE_LIMITED');
    const duringLock = expect(await createUpload(server, room.token, Buffer.from('locked'), 'locked.txt', 'text/plain'), 201);
    expect(await req(server, `${base}/uploads/${duringLock.uploadId}`, { method: 'DELETE' }), 204);
    const changed = expect(await req(server, `${base}/code`, {
      method: 'PUT', json: { deviceKey: room.deviceKey, code: 'NEWCOD' },
    }), 200);
    assert.notEqual(changed.code, room.code);
    expect(await createUpload(server, room.token, Buffer.from('still'), 'still.txt', 'text/plain'), 201);
    expect(await req(server, '/api/rooms/NEWCOD/uploads', { method: 'POST', json: { filename: 'no.txt', size: 1, mime: 'text/plain' } }), 404, 'NOT_FOUND');
    evidence.protocol = {
      anonPrincipal: anonRow.principal.startsWith('room:'),
      signedPrincipal: signedRow.principal.startsWith('user:'),
      userIdNull: cliItem.userId === null && webItem.userId === null,
      cliKind: cliItem.device.kind,
      phoneKind: webItem.device.kind,
      group: webItem.group,
      reservedUnchanged: after.reservedBytes === before.reservedBytes && bobAfter.reservedBytes === 0,
    };
    note(kind + '-protocol', evidence.protocol);
    return evidence;
  } finally {
    await stop(server);
  }
}

async function transfer(kind) {
  const data = resolve(temp, 'transfer-' + kind);
  await cp(seed, data, { recursive: true });
  const server = await start(kind, data);
  try {
    const alice = await login(server, 'alice@example.test');
    const room = await createRoom(server, alice);
    const base = `/api/rooms/${room.token}`;
    const payload = Buffer.concat([Buffer.alloc(chunkBytes, 7), Buffer.from('tail-bytes')]);
    const created = expect(await createUpload(server, room.token, payload, 'parts.bin', 'application/octet-stream'), 201);
    const second = payload.subarray(chunkBytes);
    expect(await putChunk(server, room.token, created.uploadId, 1, second), 204);
    const early = await complete(server, room.token, created.uploadId);
    expect(early, 400, 'UPLOAD_INCOMPLETE');
    expect(await req(server, `${base}/uploads/${created.uploadId}`), 404, 'NOT_FOUND');
    const one = Buffer.from('bounds-body');
    const session = expect(await createUpload(server, room.token, one, 'bounds.bin', 'application/octet-stream'), 201);
    expect(await putChunk(server, room.token, session.uploadId, 1, one), 400, 'INVALID_CHUNK_INDEX');
    expect(await req(server, `${base}/uploads/${session.uploadId}/chunks/01`, {
      method: 'PUT', body: one, headers: { 'content-type': 'application/octet-stream' },
    }), 400, 'INVALID_CHUNK_INDEX');
    expect(await putChunk(server, room.token, session.uploadId, 0, one.subarray(0, 2)), 400, 'CHUNK_SIZE_MISMATCH');
    expect(await putChunk(server, room.token, session.uploadId, 0, Buffer.concat([one, Buffer.from('x')])), 413, 'FILE_TOO_LARGE');
    expect(await req(server, `${base}/uploads/${session.uploadId}/chunks/0`, {
      method: 'PUT', headers: { 'content-length': '0' },
    }), 400, 'EMPTY_FILE');
    expect(await putChunk(server, room.token, session.uploadId, 0, one, { headers: { 'x-chunk-sha256': 'ab' } }), 400, 'INVALID_CHECKSUM');
    expect(await putChunk(server, room.token, session.uploadId, 0, one, { headers: { 'x-chunk-sha256': 'a'.repeat(64) } }), 400, 'CHECKSUM_MISMATCH');
    expect(await putChunk(server, room.token, session.uploadId, 0, one), 204);
    expect(await putChunk(server, room.token, session.uploadId, 0, Buffer.alloc(one.length, 9), { headers: { 'x-chunk-sha256': sha256(Buffer.alloc(one.length, 9)) } }), 409, 'CHUNK_CONFLICT');
    assert.deepEqual(expect(await req(server, `${base}/uploads/${session.uploadId}`), 200).received, [0]);
    const kept = expect(await complete(server, room.token, session.uploadId), 201).item;
    const download = await req(server, `${base}/items/${kept.id}/download`);
    expect(download, 200);
    assert.equal(download.bytes.equals(one), true);
    const image = expect(await createUpload(server, room.token, png, 'dot.png', 'image/png'), 201);
    expect(await putChunk(server, room.token, image.uploadId, 0, png), 204);
    const picture = expect(await complete(server, room.token, image.uploadId), 201).item;
    assert.equal(picture.hasThumbnail, true);
    assert.equal(picture.userId, null);
    const thumb = await req(server, `${base}/items/${picture.id}/thumbnail`);
    expect(thumb, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
    const svgSession = expect(await createUpload(server, room.token, svg, 'pic.svg', 'image/svg+xml'), 201);
    expect(await putChunk(server, room.token, svgSession.uploadId, 0, svg), 204);
    expect(await complete(server, room.token, svgSession.uploadId), 415, 'INVALID_IMAGE');
    expect(await req(server, `${base}/uploads/${svgSession.uploadId}`), 404, 'NOT_FOUND');
    const disguised = Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), Buffer.alloc(8, 1)]);
    const fake = expect(await createUpload(server, room.token, disguised, 'fake.bin', 'application/octet-stream'), 201);
    expect(await putChunk(server, room.token, fake.uploadId, 0, disguised), 204);
    expect(await complete(server, room.token, fake.uploadId), 415, 'INVALID_IMAGE');
    const racedBody = Buffer.from('race-room');
    const raced = expect(await createUpload(server, room.token, racedBody, 'race.bin', 'application/octet-stream'), 201);
    expect(await putChunk(server, room.token, raced.uploadId, 0, racedBody), 204);
    const finishes = await Promise.all([0, 1].map(() => complete(server, room.token, raced.uploadId)));
    assert.deepEqual(finishes.map(response => response.status).sort(), [201, 409]);
    assert.equal(codeOf(finishes.find(response => response.status === 409)), 'UPLOAD_IN_PROGRESS');
    const winner = finishes.find(response => response.status === 201).body.item;
    assert.equal(winner.userId, null);
    assert.equal((await req(server, `${base}/items/${winner.id}/download`)).bytes.equals(racedBody), true);
    const listed = expect(await req(server, `${base}/items`), 200);
    assert.equal(listed.items.filter(item => item.filename === 'race.bin').length, 1);
    expect(await req(server, `${base}/uploads/${raced.uploadId}`), 404, 'NOT_FOUND');
    const cancelBody = Buffer.from('cancel-me');
    const cancelling = expect(await createUpload(server, room.token, cancelBody, 'cancel.bin', 'application/octet-stream'), 201);
    const beforeFiles = await fileNames(data);
    const held = await hold(server, `${base}/uploads/${cancelling.uploadId}/chunks/0`, undefined, cancelBody);
    await delay(120);
    expect(await req(server, `${base}/uploads/${cancelling.uploadId}`, { method: 'DELETE' }), 204);
    held.destroy();
    expect(await req(server, `${base}/uploads/${cancelling.uploadId}`), 404, 'NOT_FOUND');
    assert.deepEqual(await fileNames(data), beforeFiles);
    const dropBody = Buffer.from('drop-me!!');
    const dropping = expect(await createUpload(server, room.token, dropBody, 'drop.bin', 'application/octet-stream'), 201);
    const beforeDrop = await fileNames(data);
    const dropped = await hold(server, `${base}/uploads/${dropping.uploadId}/chunks/0`, undefined, dropBody);
    await delay(120);
    dropped.destroy();
    await delay(50);
    const left = expect(await req(server, `${base}/uploads/${dropping.uploadId}`), 200);
    assert.deepEqual(left.received, []);
    assert.deepEqual(await fileNames(data), beforeDrop);
    expect(await putChunk(server, room.token, dropping.uploadId, 0, dropBody), 204);
    expect(await req(server, `${base}/uploads/${dropping.uploadId}`, { method: 'DELETE' }), 204);
    note(kind + '-transfer', { conflict: 409, race: finishes.map(response => response.status).sort(), svg: 415, cancel: 204 });
  } finally {
    await stop(server);
  }
}

async function lifecycle(kind) {
  const data = resolve(temp, 'life-' + kind);
  await cp(seed, data, { recursive: true });
  let server = await start(kind, data);
  try {
    const alice = await login(server, 'alice@example.test');
    const bob = await login(server, 'bob@example.test');
    const room = await createRoom(server, alice);
    const roomId = room.token.split('.')[0];
    const base = `/api/rooms/${room.token}`;
    const body = Buffer.from('lifecycle');
    const bobUpload = expect(await createUpload(server, room.token, body, 'bob.txt', 'text/plain', { cookie: bob }), 201);
    expect(await putChunk(server, room.token, bobUpload.uploadId, 0, body, { cookie: bob }), 204);
    const anonUpload = expect(await createUpload(server, room.token, body, 'anon-life.txt', 'text/plain'), 201);
    expect(await putChunk(server, room.token, anonUpload.uploadId, 0, body), 204);
    const privateUpload = expect(await req(server, `/api/spaces/${meta.bobSpace}/uploads`, {
      method: 'POST', cookie: bob, json: { filename: 'bob-private.bin', size: 4, mime: 'application/octet-stream' },
    }), 201);
    expect(await req(server, `/api/admin/users/${meta.bob.id}`, { method: 'PATCH', cookie: alice, json: { disabled: true } }), 204);
    expect(await req(server, `${base}/uploads/${bobUpload.uploadId}`), 404, 'NOT_FOUND');
    expect(await req(server, `${base}/uploads/${anonUpload.uploadId}`), 200);
    assert.equal(lookup(data, 'SELECT id FROM uploads WHERE id=?', privateUpload.uploadId), undefined);
    assert.equal(lookup(data, 'SELECT principal FROM uploads WHERE id=?', anonUpload.uploadId).principal, 'room:' + roomId);
    const resume = expect(await createUpload(server, room.token, body, 'resume.txt', 'text/plain'), 201);
    expect(await putChunk(server, room.token, resume.uploadId, 0, body), 204);
    await stop(server);
    server = await start(kind, data);
    const alice2 = await login(server, 'alice@example.test');
    const resumed = expect(await req(server, `${base}/uploads/${resume.uploadId}`), 200);
    assert.deepEqual(resumed.received, [0]);
    const resumedItem = expect(await complete(server, room.token, resume.uploadId), 201).item;
    assert.equal(resumedItem.userId, null);
    assert.equal((await req(server, `${base}/items/${resumedItem.id}/download`)).bytes.equals(body), true);
    const closing = expect(await createUpload(server, room.token, body, 'close.txt', 'text/plain'), 201);
    expect(await putChunk(server, room.token, closing.uploadId, 0, body), 204);
    expect(await req(server, `/api/admin/rooms/${roomId}/close`, { method: 'POST', cookie: alice2 }), 204);
    expect(await req(server, `${base}/uploads/${closing.uploadId}`), 404, 'NOT_FOUND');
    expect(await complete(server, room.token, closing.uploadId), 404, 'NOT_FOUND');
    assert.equal(lookup(data, 'SELECT id FROM uploads WHERE id=?', closing.uploadId).id, closing.uploadId);
    expect(await req(server, `/api/admin/rooms/${roomId}/reopen`, { method: 'POST', cookie: alice2 }), 204);
    assert.deepEqual(expect(await req(server, `${base}/uploads/${closing.uploadId}`), 200).received, [0]);
    const reopened = expect(await complete(server, room.token, closing.uploadId), 201).item;
    assert.equal(reopened.spaceId, roomId);
    assert.equal(reopened.userId, null);
    assert.equal(lookup(data, 'SELECT id FROM items WHERE id=? AND spaceId=?', reopened.id, meta.aliceSpace), undefined);
    const deleting = expect(await createUpload(server, room.token, body, 'gone.txt', 'text/plain'), 201);
    const held = await hold(server, `${base}/uploads/${deleting.uploadId}/chunks/0`, undefined, body);
    await delay(120);
    expect(await req(server, `/api/admin/rooms/${roomId}`, { method: 'DELETE', cookie: alice2 }), 204);
    held.destroy();
    await delay(50);
    assert.equal(lookup(data, 'SELECT id FROM uploads WHERE spaceId=?', roomId), undefined);
    assert.equal(lookup(data, 'SELECT id FROM items WHERE id=?', reopened.id), undefined);
    assert.equal(lookup(data, 'SELECT spaceId FROM items WHERE spaceId=?', meta.aliceSpace).spaceId, meta.aliceSpace);
    note(kind + '-lifecycle', { disableKeepsAnon: true, restart: resumed.received, closeKeepsRow: true, delete: 204 });
  } finally {
    await stop(server);
  }
}

async function expiry(kind) {
  const data = resolve(temp, 'expire-' + kind);
  await cp(seed, data, { recursive: true });
  const extra = kind === 'rust' ? { DROPIT_SWEEP_ON_SPACES: '1', DROPIT_SWEEP_OLDER_THAN: '1' } : {};
  let server = await start(kind, data, extra);
  try {
    const alice = await login(server, 'alice@example.test');
    const room = await createRoom(server, alice);
    const body = Buffer.from('expire-me');
    const created = expect(await createUpload(server, room.token, body, 'expire.txt', 'text/plain'), 201);
    expect(await putChunk(server, room.token, created.uploadId, 0, body), 204);
    const key = lookup(data, 'SELECT key FROM upload_chunks WHERE uploadId=?', created.uploadId).key;
    assert.equal((await fileNames(data)).includes(key), true);
    await stop(server);
    sql(data, 'UPDATE uploads SET expiresAt=1 WHERE id=?', created.uploadId);
    server = await start(kind, data, extra);
    const alice2 = await login(server, 'alice@example.test');
    if (kind === 'rust') expect(await req(server, '/api/spaces', { cookie: alice2 }), 200);
    expect(await req(server, `/api/rooms/${room.token}/uploads/${created.uploadId}`), 404, 'NOT_FOUND');
    assert.equal(lookup(data, 'SELECT id FROM uploads WHERE id=?', created.uploadId), undefined);
    assert.equal((await fileNames(data)).includes(key), false);
    assert.equal(lookup(data, 'SELECT count(*) AS n FROM garbage').n, 0);
    const room2 = await createRoom(server, alice2, { code: 'EXPIRE' });
    const spaced = expect(await createUpload(server, room2.token, body, 'space.txt', 'text/plain'), 201);
    expect(await putChunk(server, room2.token, spaced.uploadId, 0, body), 204);
    const spaceKey = lookup(data, 'SELECT key FROM upload_chunks WHERE uploadId=?', spaced.uploadId).key;
    await stop(server);
    sql(data, 'UPDATE spaces SET expiresAt=1 WHERE id=?', room2.token.split('.')[0]);
    server = await start(kind, data, extra);
    const alice3 = await login(server, 'alice@example.test');
    if (kind === 'rust') expect(await req(server, '/api/spaces', { cookie: alice3 }), 200);
    assert.equal(lookup(data, 'SELECT id FROM uploads WHERE id=?', spaced.uploadId), undefined);
    assert.equal((await fileNames(data)).includes(spaceKey), false);
    assert.equal(lookup(data, 'SELECT count(*) AS n FROM garbage').n, 0);
    note(kind + '-expiry', { own: true, space: true, garbage: 0 });
  } finally {
    await stop(server);
  }
}

async function limits(kind) {
  const quota = png.length;
  const data = resolve(temp, 'limits-' + kind);
  await cp(seed, data, { recursive: true });
  const server = await start(kind, data, {
    ROOM_QUOTA_BYTES: String(quota),
    ROOM_MAX_FILE_BYTES: '4096',
    MAX_FILE_BYTES: '8192',
    USER_QUOTA_BYTES: '1048576',
  });
  try {
    const alice = await login(server, 'alice@example.test');
    const before = expect(await req(server, '/api/me', { cookie: alice }), 200);
    const room = await createRoom(server, alice);
    expect(await req(server, `/api/rooms/${room.token}/uploads`, {
      method: 'POST', json: { filename: 'big.bin', size: 4097, mime: 'application/octet-stream' },
    }), 413, 'FILE_TOO_LARGE');
    expect(await req(server, `/api/rooms/${room.token}/uploads`, {
      method: 'POST', json: { filename: 'over.bin', size: quota + 1, mime: 'application/octet-stream' },
    }), 413, 'QUOTA_EXCEEDED');
    const created = expect(await createUpload(server, room.token, png, 'tight.png', 'image/png'), 201);
    expect(await putChunk(server, room.token, created.uploadId, 0, png), 204);
    expect(await complete(server, room.token, created.uploadId), 413, 'QUOTA_EXCEEDED');
    expect(await req(server, `/api/rooms/${room.token}/uploads/${created.uploadId}`), 404, 'NOT_FOUND');
    assert.equal(lookup(data, 'SELECT count(*) AS n FROM items WHERE spaceId=?', room.token.split('.')[0]).n, 0);
    const me = expect(await req(server, '/api/me', { cookie: alice }), 200);
    assert.equal(me.reservedBytes, before.reservedBytes);
    assert.equal(me.usedBytes, before.usedBytes);
    note(kind + '-quota', { file: 413, quota: 413, thumb: 413, me: 0 });
  } finally {
    await stop(server);
  }
}

async function itemCaps(kind, maxItems, existing, label) {
  const data = resolve(temp, label + '-' + kind);
  await cp(seed, data, { recursive: true });
  let server = await start(kind, data, { MAX_ITEMS: String(maxItems) });
  try {
    await login(server, 'alice@example.test');
    const room = await createRoom(server, undefined);
    const roomId = room.token.split('.')[0];
    await stop(server);
    const now = Date.now();
    const db = openDb(data, false);
    const insert = db.prepare('INSERT INTO items (id,spaceId,kind,text,size,storedBytes,createdAt,expiresAt,updatedAt,pinned,tags) VALUES (?,?,\'text\',\'x\',1,1,?,?,?,0,\'[]\')');
    for (let index = 0; index < existing; index++) insert.run(randomUUID(), roomId, now, now + 86400000, now);
    db.close();
    server = await start(kind, data, { MAX_ITEMS: String(maxItems) });
    const first = await createUpload(server, room.token, Buffer.from('cap'), 'cap.txt', 'text/plain');
    if (existing >= Math.min(100, maxItems)) {
      expect(first, 413, 'ITEM_LIMIT');
      note(kind + '-' + label, { create: 413 });
      return;
    }
    expect(first, 201);
    expect(await createUpload(server, room.token, Buffer.from('cap2'), 'cap2.txt', 'text/plain'), 413, 'ITEM_LIMIT');
    note(kind + '-' + label, { first: 201, second: 413 });
  } finally {
    await stop(server);
  }
}

async function sessionCap(kind) {
  const data = resolve(temp, 'sessions-' + kind);
  await cp(seed, data, { recursive: true });
  const server = await start(kind, data, { UPLOAD_SESSIONS_PER_USER: '1' });
  try {
    const alice = await login(server, 'alice@example.test');
    const roomA = await createRoom(server, alice, { code: 'SESA01' });
    const roomB = await createRoom(server, undefined, { code: 'SESB02' });
    expect(await createUpload(server, roomA.token, Buffer.from('a'), 'a.txt', 'text/plain', { cookie: alice }), 201);
    expect(await createUpload(server, roomB.token, Buffer.from('b'), 'b.txt', 'text/plain', { cookie: alice }), 429, 'UPLOAD_SESSION_LIMIT');
    expect(await req(server, `/api/spaces/${meta.aliceSpace}/uploads`, {
      method: 'POST', cookie: alice, json: { filename: 'private.bin', size: 4, mime: 'application/octet-stream' },
    }), 429, 'UPLOAD_SESSION_LIMIT');
    expect(await createUpload(server, roomA.token, Buffer.from('anon'), 'anon.txt', 'text/plain'), 201);
    expect(await createUpload(server, roomB.token, Buffer.from('anonb'), 'anonb.txt', 'text/plain'), 201);
    expect(await createUpload(server, roomA.token, Buffer.from('anon2'), 'anon2.txt', 'text/plain'), 429, 'UPLOAD_SESSION_LIMIT');
    note(kind + '-sessions', { sharedPrincipal: 429, anonSeparate: 201 });
  } finally {
    await stop(server);
  }
}

async function chunkBusy(kind) {
  const data = resolve(temp, 'busy-' + kind);
  await cp(seed, data, { recursive: true });
  const server = await start(kind, data, { UPLOAD_CHUNKS_PER_SESSION: '1' });
  try {
    const room = await createRoom(server);
    const body = Buffer.from('busy-body');
    const created = expect(await createUpload(server, room.token, body, 'busy.bin', 'application/octet-stream'), 201);
    const held = await hold(server, `/api/rooms/${room.token}/uploads/${created.uploadId}/chunks/0`, undefined, body);
    await delay(150);
    const busy = await putChunk(server, room.token, created.uploadId, 0, body);
    expect(busy, 429, 'CHUNK_BUSY');
    assert.equal(busy.headers.get('retry-after'), '1');
    held.destroy();
    await delay(50);
    expect(await putChunk(server, room.token, created.uploadId, 0, body), 204);
    note(kind + '-busy', { status: 429, retryAfter: '1' });
  } finally {
    await stop(server);
  }
}

async function chunkRate(kind) {
  const data = resolve(temp, 'rate-' + kind);
  await cp(seed, data, { recursive: true });
  const server = await start(kind, data, {
    RATE_GENERAL: '40', RATE_AUTH: '10', RATE_INVITE: '5', RATE_UPLOAD: '3', RATE_ROOM: '1',
    RATE_TOKEN: '2', RATE_CHUNK: '100',
  });
  try {
    const alice = await login(server, 'alice@example.test');
    const room = await createRoom(server, alice);
    const pat = expect(await req(server, '/api/tokens', {
      method: 'POST', cookie: alice, json: { name: 'chunk rate', scopes: ['read', 'write'] },
    }), 201);
    const body = Buffer.from('rate');
    const created = expect(await createUpload(server, room.token, body, 'rate.bin', 'application/octet-stream', {
      bearer: pat.token, origin: null,
    }), 201);
    let last = 0;
    for (let index = 0; index < 100; index++) {
      const put = await putChunk(server, room.token, created.uploadId, 0, body, { bearer: pat.token, origin: null });
      assert.equal(put.status, 204, kind + ' chunk ' + index + ' ' + JSON.stringify(put.body));
      last = put.status;
    }
    const blocked = await putChunk(server, room.token, created.uploadId, 0, body, { bearer: pat.token, origin: null });
    expect(blocked, 429, 'RATE_LIMITED');
    const second = await createUpload(server, room.token, body, 'rate2.bin', 'application/octet-stream', {
      bearer: pat.token, origin: null,
    });
    expect(second, 429, 'RATE_LIMITED');
    note(kind + '-rate', { chunks: last, overflow: 429, secondCreate: 429 });
  } finally {
    await stop(server);
  }
}

async function compare(name, run) {
  const ts = await run('ts');
  const rust = await run('rust');
  if (ts && rust) assert.deepEqual(rust, ts, name + ' evidence diverged');
  console.log('PASS ' + name);
}


async function reviewProbe(kind) {
  const data = resolve(temp, 'review-' + kind);
  await cp(seed, data, { recursive: true });
  const server = await start(kind, data, { ROOM_QUOTA_BYTES: String(png.length) });
  const held = [];
  try {
    const room = await createRoom(server);
    const base = `/api/rooms/${room.token}`;
    const roomId = room.token.split('.')[0];
    const body = Buffer.from('capacity');
    const upload = expect(await createUpload(server, room.token, body, 'capacity.txt', 'text/plain'), 201);
    expect(await putChunk(server, room.token, upload.uploadId, 0, body), 204);
    for (let i = 0; i < 4; i++) {
      const url = new URL(server.url);
      const socket = netConnect(url.port, url.hostname);
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write(`POST ${base}/items/file HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${origin}\r\nContent-Type: application/octet-stream\r\nX-File-Name: held.bin\r\nContent-Length: 64\r\n\r\nx`);
      held.push(socket);
    }
    await delay(250);
    const fifth = await req(server, `${base}/items/file`, { method: 'POST', body: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'fifth.bin' } });
    assert.equal(fifth.status, 429, 'four held legacy uploads must occupy all slots');
    const capacity = await complete(server, room.token, upload.uploadId);
    note(kind + '-review-capacity', { saturation: fifth.status, complete: capacity.status, code: codeOf(capacity) });
    assert.equal(lookup(data, 'SELECT id FROM uploads WHERE id=?', upload.uploadId), undefined, 'UPLOAD_BUSY must delete the session');
    for (const socket of held) socket.destroy();
    await delay(150);

    const groupRoom = await createRoom(server);
    const groupBase = `/api/rooms/${groupRoom.token}`;
    const picture = expect(await createUpload(server, groupRoom.token, png, 'quota.png', 'image/png'), 201);
    expect(await putChunk(server, groupRoom.token, picture.uploadId, 0, png), 204);
    const watch = await connect(server, `${groupBase}/ws`);
    await watch.next(); await watch.next();
    const groupEvents = [];
    watch.ws.on('message', bytes => groupEvents.push(JSON.parse(bytes)));
    const failure = await complete(server, groupRoom.token, picture.uploadId, { headers: { 'x-dropit-group': 'failed-group' } });
    assert.equal(failure.status, 413);
    const state = expect(await req(server, `${groupBase}/items`), 200);
    await delay(150);
    note(kind + '-review-failed-group', { status: failure.status, persisted: lookup(data, 'SELECT name FROM item_groups WHERE spaceId=? AND name=?', groupRoom.token.split('.')[0], 'failed-group')?.name ?? null, groupsEvents: groupEvents.filter(e => e.type === 'groups'), items: state.items.length });
    watch.ws.terminate();
  } finally {
    for (const socket of held) socket.destroy();
    await stop(server);
  }
}

async function snapshotProbe(kind) {
  const data = resolve(temp, 'snapshot-' + kind);
  await cp(seed, data, { recursive: true });
  const server = await start(kind, data);
  try {
    const room = await createRoom(server);
    const body = Buffer.from('snapshot-race');
    const upload = expect(await createUpload(server, room.token, body, 'snapshot-race.txt', 'text/plain'), 201);
    expect(await putChunk(server, room.token, upload.uploadId, 0, body), 204);
    const db = openDb(data, false);
    const insert = db.prepare('INSERT INTO garbage (key) VALUES (?)');
    db.transaction(() => { for (let i = 0; i < 1000; i++) insert.run(randomUUID()); })();
    db.close();
    const completed = complete(server, room.token, upload.uploadId);
    let row;
    for (let i = 0; i < 1000; i++) {
      row = lookup(data, 'SELECT id FROM items WHERE filename=?', 'snapshot-race.txt');
      if (row) break;
      await delay(5);
    }
    assert.ok(row, 'complete must commit item');
    const watch = await connect(server, `/api/rooms/${room.token}/ws`);
    const snapshot = await watch.next();
    assert.equal(snapshot.type, 'snapshot');
    const events = [];
    watch.ws.on('message', bytes => events.push(JSON.parse(bytes)));
    const retracted = req(server, `/api/rooms/${room.token}/items/${row.id}`, { method: 'DELETE' });
    expect(await completed, 201);
    expect(await retracted, 204);
    await delay(150);
    note(kind + '-review-snapshot', { containsCommittedItem: snapshot.items.some(item => item.id === row.id), duplicateCreatedEvents: events.filter(event => event.type === 'item.created' && event.item.id === row.id).length, events: events.filter(event => ['item.created', 'item.deleted'].includes(event.type)).map(event => event.type), persistedAfterRetract: !!lookup(data, 'SELECT id FROM items WHERE id=?', row.id) });
    watch.ws.terminate();
  } finally { await stop(server); }
}

try {
  reference = await prepare();
  seed = resolve(temp, 'seed');
  meta = await fixture(seed, { referenceRoot: reference });
  for (const kind of ['ts', 'rust']) {
    await reviewProbe(kind);
    await snapshotProbe(kind);
  }
} finally {
  for (const child of processes) child.kill('SIGKILL');
  for (const ws of sockets) ws.terminate();
  await rm(temp, { recursive: true, force: true });
}
