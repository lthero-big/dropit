import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fixture, PASSWORD, NORMALIZED_PASSWORD } from './fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68';
// The reference must not silently replace the agreed TS behavior.
assert.equal(execFileSync('git', ['diff', baseline, '--', 'apps/server/src', 'pnpm-lock.yaml'], { cwd: root, encoding: 'utf8' }), '');
const require = createRequire(resolve(root, 'apps/server/package.json'));
const Sqlite = require('better-sqlite3');
const rust = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const temporary = await mkdtemp(resolve(root, 'rust/server/data/compat-'));
const processes = new Set();
let checks = 0;

async function start(kind, data, options = {}) {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const origin = options.APP_ORIGIN ?? 'http://dropit.test';
  const child = spawn(kind === 'rust' ? rust : process.execPath,
    kind === 'rust' ? [] : [resolve(root, 'apps/server/dist/index.js')], {
      cwd: root,
      env: {
        PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port),
        APP_ORIGIN: origin, UPDATE_CHECK: '0', RATE_GENERAL: '10000', RATE_AUTH: '1000',
        RATE_UPLOAD: '100', ...options,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  processes.add(child);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(kind + ' exited\n' + output);
    if (output.includes('dropit listening on port ')) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/healthz', { signal: AbortSignal.timeout(1000) });
        await response.text();
        if (response.status === 200) return { child, url: 'http://127.0.0.1:' + port, origin };
      } catch {
        // The TS entry point logs before Node's listening callback.
      }
    }
    await delay(25);
  }
  throw new Error(kind + ' failed readiness\n' + output);
}

async function stop(server, signal = 'SIGTERM') {
  const { child } = server;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill(signal);
    await exited;
  }
  processes.delete(child);
}

async function request(server, path, { method = 'GET', cookie, json, headers = {}, raw, origin = server.origin } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  if (origin) requestHeaders.origin = origin;
  if (json !== undefined) requestHeaders['content-type'] ??= 'application/json';
  const response = await fetch(server.url + path, {
    method, headers: requestHeaders, body: json !== undefined ? JSON.stringify(json) : raw, redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let body = text;
  if (response.headers.get('content-type')?.startsWith('application/json')) body = JSON.parse(text);
  const relevant = {};
  for (const key of ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options',
    'x-frame-options', 'referrer-policy', 'permissions-policy', 'strict-transport-security',
    'www-authenticate', 'retry-after', 'set-cookie']) {
    if (response.headers.has(key)) relevant[key] = response.headers.get(key);
  }
  checks++;
  return { status: response.status, headers: relevant, body };
}

function expectCode(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.error?.code, code);
}

async function login(server, email = 'alice@example.test', options = {}) {
  const response = await request(server, '/api/auth/password/login', {
    method: 'POST', json: { email, password: NORMALIZED_PASSWORD, ...options },
  });
  assert.equal(response.status, 200);
  const cookie = response.headers['set-cookie']?.split(';')[0];
  assert.match(cookie, /^(?:__Host-)?dropit_session=[A-Za-z0-9_-]{43}$/);
  return { response, cookie };
}

/** Seed IDs/text, headers and all other JSON remain exact. */
function normalize(value, ids = new Map()) {
  if (Array.isArray(value)) return value.map(item => normalize(item, ids));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, value]) => {
    if (key === 'set-cookie') return [key, value.replace(/=[A-Za-z0-9_-]{43};/, '=<session>;')];
    if (key === 'serverTime') return [key, '<clock>'];
    if (['createdAt', 'updatedAt', 'expiresAt'].includes(key) && value !== null && ids.has(value)) return [key, ids.get(value)];
    if (key === 'id' && ids.has(value)) return [key, ids.get(value)];
    return [key, normalize(value, ids)];
  }));
}

async function mainFlow(kind, seed, metadata) {
  const data = resolve(temporary, kind);
  await cp(seed, data, { recursive: true });
  let server = await start(kind, data);
  const transcript = [];
  const record = response => { transcript.push(response); return response; };
  const space = '/api/spaces/' + metadata.aliceSpace;
  const oldCookie = 'dropit_session=' + metadata.oldCookie;
  try {
    assert.equal(record(await request(server, '/healthz')).status, 200);
    expectCode(record(await request(server, '/api/me')), 401, 'UNAUTHENTICATED');
    expectCode(record(await request(server, space)), 401, 'UNAUTHENTICATED');
    expectCode(record(await request(server, '/api/me', { cookie: 'dropit_session=expired-session' })), 401, 'UNAUTHENTICATED');
    expectCode(record(await request(server, '/api/me', { cookie: oldCookie, headers: { authorization: 'invalid' } })), 401, 'UNAUTHENTICATED');
    record(await request(server, '/api/me', { cookie: oldCookie }));

    const loginPath = '/api/auth/password/login';
    for (const json of [
      { email: 'alice@example.test', password: 'wrong-password' },
      { email: 'missing@example.test', password: 'wrong-password' },
    ]) expectCode(record(await request(server, loginPath, { method: 'POST', json })), 401, 'INVALID_CREDENTIALS');
    expectCode(record(await request(server, loginPath, { method: 'POST', json: { email: 'disabled@example.test', password: PASSWORD } })), 403, 'USER_DISABLED');
    for (const json of [{}, [], null, { email: 'alice@example.test', password: '' }, { email: 'alice@example.test', password: '🔐'.repeat(129) }]) {
      const response = record(await request(server, loginPath, { method: 'POST', raw: JSON.stringify(json), headers: { 'content-type': 'application/json' } }));
      expectCode(response, 400, Array.isArray(json) || json === null ? 'INVALID_JSON' : 'INVALID_INPUT');
    }
    expectCode(record(await request(server, loginPath, { method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' } })), 400, 'JSON_REQUIRED');
    expectCode(record(await request(server, loginPath, { method: 'POST', raw: '{', headers: { 'content-type': 'application/json' } })), 400, 'INVALID_JSON');
    expectCode(record(await request(server, loginPath, { method: 'POST', json: { email: 'alice@example.test', password: PASSWORD, pad: 'x'.repeat(5000) } })), 413, 'BODY_TOO_LARGE');
    expectCode(record(await request(server, loginPath, { method: 'POST', json: {}, origin: 'http://evil.test' })), 403, 'ORIGIN_REJECTED');
    expectCode(record(await request(server, loginPath, { method: 'POST', json: {}, origin: '' })), 403, 'ORIGIN_REJECTED');
    expectCode(record(await request(server, loginPath, { method: 'POST', json: { email: 'alice@example.test', password: PASSWORD, invite: 'invalid' } })), 403, 'INVITE_INVALID');

    const alice = await login(server, '  ALICE@EXAMPLE.TEST  ');
    record(alice.response);
    record(await request(server, '/api/me', { cookie: alice.cookie }));
    record(await request(server, '/api/spaces', { cookie: alice.cookie }));
    record(await request(server, space, { cookie: alice.cookie }));
    const initial = record(await request(server, space + '/items', { cookie: alice.cookie }));
    assert.deepEqual(initial.body.items, [metadata.existing]);
    const bob = await login(server, 'bob@example.test');
    record(bob.response);
    for (const path of [space, space + '/items', space + '/items/text']) {
      expectCode(record(await request(server, path, { cookie: bob.cookie, ...(path.endsWith('/text') ? { method: 'POST', json: { text: 'denied' } } : {}) })), 404, 'NOT_FOUND');
    }
    const viewer = await login(server, 'viewer@example.test', { invite: metadata.invite });
    record(viewer.response);
    assert.equal(record(await request(server, space + '/items', { cookie: viewer.cookie })).status, 200);
    expectCode(record(await request(server, space + '/items/text', { cookie: viewer.cookie, method: 'POST', json: { text: 'denied' } })), 403, 'READ_ONLY');
    const temporaryUser = await login(server, 'temporary@example.test');
    record(temporaryUser.response);
    record(await request(server, '/api/me', { cookie: temporaryUser.cookie }));
    expectCode(record(await request(server, '/api/spaces', { cookie: temporaryUser.cookie })), 403, 'PASSWORD_CHANGE_REQUIRED');
    record((await login(server, 'pending@example.test')).response);
    expectCode(record(await request(server, space + '/items/text', { cookie: alice.cookie, method: 'POST', json: { text: ' \n \uFEFF' } })), 400, 'EMPTY_TEXT');
    expectCode(record(await request(server, space + '/items/text', { cookie: alice.cookie, method: 'POST', json: { text: '🦀'.repeat(16385) } })), 413, 'TEXT_TOO_LARGE');
    expectCode(record(await request(server, space + '/items/text', { cookie: alice.cookie, method: 'POST', json: { text: 'x', group: '全部' } })), 400, 'INVALID_GROUP');

    const content = 'Rust/TS Unicode 文本 e\u0301 🦀\u0000\n<script>alert(1)</script>';
    const created = record(await request(server, space + '/items/text', {
      cookie: alice.cookie, method: 'POST', json: { text: content, group: ' 新\u3000分组 ' },
      headers: { 'x-dropit-device': 'compat-device', 'x-dropit-device-name': encodeURIComponent('🦀 设备'), 'x-dropit-device-kind': 'cli' },
    }));
    assert.equal(created.status, 201);
    const item = created.body.item;
    assert.match(item.id, /^[0-9a-f-]{36}$/);
    assert.equal(item.text, content);
    assert.equal(item.size, Buffer.byteLength(content));
    assert.equal(item.createdAt, item.updatedAt);
    assert.equal(item.expiresAt - item.createdAt, 168 * 3600000);
    assert.equal(item.userId, metadata.alice.id);
    const listed = record(await request(server, space + '/items', { cookie: alice.cookie }));
    assert.deepEqual(listed.body.items.find(candidate => candidate.id === item.id), item);

    // Real abrupt termination tests SQLite WAL recovery and existing session cookies.
    await stop(server, 'SIGKILL');
    server = await start(kind, data);
    record(await request(server, '/api/me', { cookie: alice.cookie }));
    const persisted = record(await request(server, space + '/items', { cookie: alice.cookie }));
    assert.deepEqual(persisted.body.items.find(candidate => candidate.id === item.id), item);
    const signedOut = record(await request(server, '/api/auth/logout', { cookie: alice.cookie, method: 'POST' }));
    assert.equal(signedOut.status, 204);
    assert.equal(signedOut.body, '');
    expectCode(record(await request(server, '/api/me', { cookie: alice.cookie })), 401, 'UNAUTHENTICATED');
    expectCode(record(await request(server, '/api/auth/logout', { cookie: alice.cookie, method: 'POST' })), 401, 'UNAUTHENTICATED');
    expectCode(record(await request(server, '/api/no-such-route', { cookie: oldCookie })), 404, 'NOT_FOUND');

    const ids = new Map([[item.id, '<new-item>'], [item.createdAt, '<created>'], [item.expiresAt, '<expiry>']]);
    return { transcript: normalize(transcript, ids), item, data, cookie: oldCookie, newCookie: bob.cookie };
  } finally {
    await stop(server);
  }
}

async function smallScenario(name, fixtureOptions, serverOptions, run) {
  const seed = resolve(temporary, name + '-seed');
  const metadata = await fixture(seed, fixtureOptions);
  const results = [];
  for (const kind of ['ts', 'rust']) {
    const data = resolve(temporary, name + '-' + kind);
    await cp(seed, data, { recursive: true });
    const server = await start(kind, data, serverOptions);
    try {
      results.push(normalize(await run(server, metadata)));
    } finally {
      await stop(server);
    }
  }
  assert.deepEqual(results[1], results[0], name);
  console.log('PASS ' + name);
}

try {
  const seed = resolve(temporary, 'seed');
  const metadata = await fixture(seed);
  const reference = await mainFlow('ts', seed, metadata);
  const actual = await mainFlow('rust', seed, metadata);
  assert.deepEqual(actual.transcript, reference.transcript);
  console.log('PASS HTTP behavior, TS hashes/data, NFKC, auth isolation, Unicode, abrupt restart, logout (' + actual.transcript.length + ' responses per server)');

  // TS reads Rust writes/sessions. Rust then continues TS writes/sessions.
  let server = await start('ts', actual.data);
  let tsCookie;
  try {
    const snapshot = await request(server, '/api/spaces/' + metadata.aliceSpace + '/items', { cookie: actual.cookie });
    assert.deepEqual(snapshot.body.items.find(item => item.id === actual.item.id), actual.item);
    assert.equal((await request(server, '/api/me', { cookie: actual.newCookie })).status, 200);
    tsCookie = (await login(server)).cookie;
    assert.equal((await request(server, '/api/spaces/' + metadata.aliceSpace + '/items/text', { cookie: tsCookie, method: 'POST', json: { text: 'TS after Rust' } })).status, 201);
  } finally {
    await stop(server);
  }
  server = await start('rust', actual.data);
  try {
    const snapshot = await request(server, '/api/spaces/' + metadata.aliceSpace + '/items', { cookie: tsCookie });
    assert(snapshot.body.items.some(item => item.text === 'TS after Rust'));
  } finally {
    await stop(server);
  }
  const db = new Sqlite(resolve(actual.data, 'dropit.sqlite'));
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 19);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    const session = db.prepare('SELECT * FROM sessions WHERE userId=? AND userAgent IS NOT NULL').get(metadata.alice.id);
    assert(session.id && session.createdAt && session.lastSeenAt && session.ipSummary);
  } finally {
    db.close();
  }
  console.log('PASS bidirectional TS/Rust database, session and item compatibility; schema 19 and foreign keys');

  await smallScenario('quota concurrent writes', { quota: 160 }, {}, async (server, metadata) => {
    const { cookie } = await login(server);
    const path = '/api/spaces/' + metadata.aliceSpace + '/items/text';
    const results = await Promise.all(Array.from({ length: 8 }, () => request(server, path, { cookie, method: 'POST', json: { text: 'x'.repeat(70) } })));
    assert.equal(results.filter(response => response.status === 201).length, 1);
    const failures = results.filter(response => response.status !== 201);
    for (const response of failures) expectCode(response, 413, 'QUOTA_EXCEEDED');
    return failures;
  });
  await smallScenario('item capacity', { itemLimit: 1 }, {}, async (server, metadata) => {
    const { cookie } = await login(server);
    const response = await request(server, '/api/spaces/' + metadata.aliceSpace + '/items/text', { cookie, method: 'POST', json: { text: 'denied', group: 'capacity group' } });
    expectCode(response, 413, 'ITEM_LIMIT');
    const snapshot = await request(server, '/api/spaces/' + metadata.aliceSpace + '/items', { cookie });
    assert(snapshot.body.groups.includes('capacity group'));
    return response;
  });
  await smallScenario('production secure cookies', {}, { NODE_ENV: 'production', APP_ORIGIN: 'https://dropit.test' }, async server => {
    const { response, cookie } = await login(server);
    assert(cookie.startsWith('__Host-dropit_session='));
    assert(response.headers['set-cookie'].includes('; Secure;'));
    return [response, await request(server, '/api/auth/logout', { cookie, method: 'POST' })];
  });
  await smallScenario('trusted proxy origin', {}, { APP_ORIGIN: '', TRUST_PROXY: 'loopback' }, async server => {
    const response = await request(server, '/api/auth/password/login', { method: 'POST', json: { email: 'alice@example.test', password: PASSWORD },
      origin: 'https://forwarded.test', headers: { 'x-forwarded-host': 'forwarded.test', 'x-forwarded-proto': 'https' } });
    assert.equal(response.status, 200);
    return response;
  });
  await smallScenario('auth rate limit', {}, { RATE_AUTH: '2' }, async server => {
    const responses = [];
    for (let i = 0; i < 3; i++) responses.push(await request(server, '/api/auth/password/login', { method: 'POST', json: { email: 'alice@example.test', password: 'wrong' } }));
    expectCode(responses[2], 429, 'RATE_LIMITED');
    assert(Number(responses[2].headers['retry-after']) >= 1);
    responses[2].headers['retry-after'] = '<positive-seconds>';
    return responses;
  });
  await smallScenario('session expiry', { sessionMs: 1 }, {}, async server => {
    const { cookie } = await login(server);
    await delay(10);
    const response = await request(server, '/api/me', { cookie });
    expectCode(response, 401, 'UNAUTHENTICATED');
    return response;
  });
  console.log('PASS ' + checks + ' real HTTP responses checked');
} finally {
  for (const child of processes) await stop({ child });
  await rm(temporary, { recursive: true, force: true });
}
