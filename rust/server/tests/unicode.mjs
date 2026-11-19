// RHEA-245: characterize the fixed TS oracle without normalizing UTF-16 strings.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, PASSWORD } from './fixture.mjs';

const root = resolve(import.meta.dirname, '../../..');
const baseline = '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68';
const requireParity = process.argv.includes('--require-parity');
const rust = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
const origin = 'http://dropit.test';
await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const temporary = await mkdtemp(resolve(root, 'rust/server/data/unicode-'));
const children = new Set(), sockets = new Set();
let reference, Sqlite, WebSocket;
let checks = 0;

// String.raw keeps the HTTP input's literal backslash-u bytes. The expected
// values below are separate JS UTF-16 strings, never used to encode that input.
const cases = [
  ['high', String.raw`{"text":"a\ud800b"}`, 'a\ud800b'],
  ['low', String.raw`{"text":"a\udc00b"}`, 'a\udc00b'],
  ['pair', String.raw`{"text":"a\ud83d\ude00b"}`, 'a😀b'],
  ['mixed', String.raw`{"text":"中文😀\ud800\n尾"}`, '中文😀\ud800\n尾'],
  ['high-high', String.raw`{"text":"\ud800\ud801"}`, '\ud800\ud801'],
  ['low-low', String.raw`{"text":"\udc00\udc01"}`, '\udc00\udc01'],
  ['reversed', String.raw`{"text":"\udc00\ud800"}`, '\udc00\ud800'],
  ['high-high-low', String.raw`{"text":"\ud800\ud83d\ude00"}`, '\ud800😀'],
  ['pair-low', String.raw`{"text":"\ud83d\ude00\udc00"}`, '😀\udc00'],
  ['uppercase', String.raw`{"text":"a\uD800b"}`, 'a\ud800b'],
  ['escaped-backslash', String.raw`{"text":"a\\ud800b"}`, 'a\\ud800b'],
  ['quote-and-backslash', String.raw`{"text":"\"\\\ud800\tend"}`, '"\\\ud800\tend'],
  ['unicode-escape', String.raw`{"text":"\u0061\u4e2d\ud83d\ude00"}`, 'a中😀'],
  ['replacement-literal', '{"text":"a�b"}', 'a�b'],
  ['ignored', String.raw`{"text":"normal","ignored":"\ud800"}`, 'normal'],
  ['nested', String.raw`{"text":"normal","ignored":{"a":["\udc00",{"b":"\ud800"}]}}`, 'normal'],
  ['ignored-key', String.raw`{"text":"normal","\ud800":"ignored"}`, 'normal'],
  ['duplicate-last-normal', String.raw`{"text":"\ud800","text":"last"}`, 'last'],
  ['duplicate-last-high', String.raw`{"text":"first","text":"\ud800"}`, '\ud800'],
];
const malformed = [
  '{', String.raw`{"text":"\ud80"}`, String.raw`{"text":"\ud800\uZZZZ"}`,
  String.raw`{"text":"\ud800\q"}`, '{"text":"unterminated}',
  '{"text":"literal\nnewline"}', '{"text":"x",}', '{"text":"x"} trailing',
  String.raw`{"text":\ud800}`, '{"text":"x"/*comment*/}',
];

async function prepareReference() {
  const directory = resolve(temporary, 'reference');
  await mkdir(directory);
  const archive = execFileSync('git', ['archive', baseline, '--',
    'apps/server', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], { cwd: root, maxBuffer: 16 << 20 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@dropit/server...'], { cwd: directory, stdio: 'pipe' });
  execFileSync('pnpm', ['--filter', '@dropit/server', 'build'], { cwd: directory, stdio: 'pipe' });
  const require = createRequire(resolve(directory, 'apps/server/package.json'));
  Sqlite = require('better-sqlite3'); WebSocket = require('ws');
  return directory;
}

async function start(kind, data) {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(kind === 'rust' ? rust : process.execPath,
    kind === 'rust' ? [] : [resolve(reference, 'apps/server/dist/index.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
        PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port),
        APP_ORIGIN: origin, UPDATE_CHECK: 'false', RATE_GENERAL: '10000', RATE_AUTH: '1000', RATE_UPLOAD: '1000',
      },
    });
  children.add(child); let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${kind} exited\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      await response.text();
      if (response.status === 200) return { child, url: `http://127.0.0.1:${port}`, data };
    } catch { /* wait for the child's own loopback listener */ }
    await delay(25);
  }
  throw new Error(`${kind} readiness failed\n${output}`);
}

async function stop(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    const exited = once(server.child, 'exit'); server.child.kill('SIGTERM'); await exited;
  }
  children.delete(server.child);
}

async function request(server, path, { raw, method = 'GET', cookie, headers = {} } = {}) {
  const bytes = raw === undefined ? undefined : Buffer.from(raw, 'utf8');
  if (bytes) assert.equal(bytes.toString('utf8'), raw, 'HTTP fixture must survive UTF-8 encoding unchanged');
  const response = await fetch(server.url + path, {
    method, headers: { origin, ...(cookie ? { cookie } : {}), ...(bytes ? { 'content-type': 'application/json' } : {}), ...headers },
    body: bytes, signal: AbortSignal.timeout(15000),
  });
  const wire = await response.text(); checks++;
  return { status: response.status, body: JSON.parse(wire), wire, headers: response.headers };
}

function expect(response, status, code) {
  assert.equal(response.status, status, response.wire);
  if (code) assert.equal(response.body.error?.code, code);
}

function read(data, query, ...params) {
  const db = new Sqlite(resolve(data, 'dropit.sqlite'), { readonly: true });
  try { return db.prepare(query).all(...params); } finally { db.close(); }
}

function connect(server, base, cookie) {
  const socket = new WebSocket(server.url.replace('http:', 'ws:') + base + '/ws', { origin, headers: { cookie } });
  sockets.add(socket); const queue = [], waiters = [];
  socket.on('message', bytes => {
    const wire = String(bytes), body = JSON.parse(wire);
    if (body.type === 'presence' || body.type === 'groups') return;
    const message = { body, wire };
    if (waiters.length) waiters.shift()(message); else queue.push(message);
  });
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  return {
    socket,
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket timeout')), 10000);
      waiters.push(message => { clearTimeout(timer); resolve(message); });
    }),
  };
}

const units = text => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i).toString(16).padStart(4, '0'));
// Golden bytes measured from the fixed TS process, not Buffer.from(JSString):
// better-sqlite3/V8 stores a lone code unit as its invalid three-byte UTF-8 form.
const sqliteHex = {
  high: '61EDA08062', low: '61EDB08062', mixed: 'E4B8ADE69687F09F9880EDA0800AE5B0BE',
  'high-high': 'EDA080EDA081', 'low-low': 'EDB080EDB081', reversed: 'EDB080EDA080',
  'high-high-low': 'EDA080F09F9880', 'pair-low': 'F09F9880EDB080', uppercase: '61EDA08062',
  'quote-and-backslash': '225CEDA08009656E64', 'duplicate-last-high': 'EDA080',
  edit: '65646974EDA080E5B0BE',
};
const stored = (name, text) => Buffer.from(sqliteHex[name] ?? Buffer.from(text).toString('hex'), 'hex').toString('utf8');
const wellFormed = value => typeof value === 'string' ? value.isWellFormed() :
  value && typeof value === 'object' ? Object.entries(value).every(([key, entry]) => key.isWellFormed() && wellFormed(entry)) : true;
// Extract only the JSON string token, keeping escaping visible and exact.
const textToken = wire => wire.match(/"text":("(?:[^"\\]|\\.)*")/)?.[1];

async function inspect(server, base, cookie, expected) {
  const response = await request(server, base + '/items', { cookie }); expect(response, 200);
  for (const [id, { text, size }] of expected) {
    const item = response.body.items.find(item => item.id === id);
    assert.equal(item?.text, text); assert.equal(item.size, size); checks++;
  }
  const ws = connect(server, base, cookie), snapshot = await ws.next();
  assert.equal(snapshot.body.type, 'snapshot');
  for (const [id, { text }] of expected) {
    assert.equal(snapshot.body.items.find(item => item.id === id)?.text, text); checks++;
  }
  ws.socket.terminate();
}

async function run(kind, seed, m) {
  const data = resolve(temporary, kind); await cp(seed, data, { recursive: true });
  let server = await start(kind, data);
  const base = `/api/spaces/${m.aliceSpace}`, path = base + '/items/text';
  const cookie = 'dropit_session=' + m.oldCookie;
  const expected = new Map(), rows = [], gaps = [];
  try {
    const ws = connect(server, base, cookie);
    assert.equal((await ws.next()).body.type, 'snapshot');
    for (const [name, raw, text] of cases) {
      const parsed = JSON.parse(raw);
      assert.equal(parsed.text, text, name + ': independent expected UTF-16 value');
      const hasSurrogate = !wellFormed(parsed) || name === 'duplicate-last-normal';
      const response = await request(server, path, { method: 'POST', cookie, raw });
      if (kind === 'rust' && hasSurrogate && !requireParity) {
        expect(response, 400, 'INVALID_JSON');
        rows.push({ name, requestHex: Buffer.from(raw).toString('hex'), status: response.status, error: response.body });
        gaps.push(name); continue;
      }
      expect(response, 201);
      const item = response.body.item, event = await ws.next();
      assert.equal(item.text, text, name + ': immediate response');
      assert.equal(item.size, Buffer.byteLength(text));
      assert.equal(textToken(response.wire), JSON.stringify(text), name + ': wire escaping');
      assert.equal(event.body.type, 'item.created');
      assert.deepEqual(event.body.item, item);
      assert.equal(textToken(event.wire), JSON.stringify(text), name + ': WS escaping');
      const [row] = read(data, 'SELECT text,hex(CAST(text AS BLOB)) AS hex,size,storedBytes FROM items WHERE id=?', item.id);
      assert.equal(row.text, stored(name, text), name + ': SQLite string');
      assert.equal(row.hex, sqliteHex[name] ?? Buffer.from(text, 'utf8').toString('hex').toUpperCase(), name + ': SQLite bytes');
      assert.equal(row.size, Buffer.byteLength(text)); assert.equal(row.storedBytes, row.size);
      expected.set(item.id, { text: stored(name, text), size: item.size });
      rows.push({ name, requestHex: Buffer.from(raw).toString('hex'), status: response.status,
        responseTextToken: textToken(response.wire), eventTextToken: textToken(event.wire), responseUnits: units(item.text), sqlite: row });
      await inspect(server, base, cookie, new Map([[item.id, expected.get(item.id)]]));
    }
    // Editing returns/broadcasts the original JS string too, not SQLite's value.
    const editRaw = String.raw`{"text":"edit\ud800尾"}`;
    const edited = await request(server, `${base}/items/${m.existing.id}`, { method: 'PATCH', cookie, raw: editRaw });
    if (kind === 'ts' || requireParity) {
      expect(edited, 200); assert.equal(edited.body.item.text, 'edit\ud800尾');
      const event = await ws.next(); assert.equal(event.body.type, 'item.updated');
      assert.deepEqual(event.body.item, edited.body.item);
      const [row] = read(data, 'SELECT text,hex(CAST(text AS BLOB)) AS hex,size,storedBytes FROM items WHERE id=?', m.existing.id);
      assert.equal(row.hex, sqliteHex.edit); assert.equal(row.text, stored('edit', 'edit\ud800尾'));
      expected.set(m.existing.id, { text: row.text, size: row.size });
    } else { expect(edited, 400, 'INVALID_JSON'); gaps.push('edit'); }
    rows.push({ name: 'edit', status: edited.status, responseTextToken: textToken(edited.wire),
      sqlite: read(data, 'SELECT text,hex(CAST(text AS BLOB)) AS hex,size,storedBytes FROM items WHERE id=?', m.existing.id)[0] });

    // The same shared parser also rejects ignored surrogate values during login.
    const loginRaw = JSON.stringify({ email: m.alice.email, password: PASSWORD }).slice(0, -1) + String.raw`,"ignored":{"a":"\ud800"}}`;
    const login = await request(server, '/api/auth/password/login', { method: 'POST', raw: loginRaw });
    expect(login, kind === 'ts' || requireParity ? 200 : 400, kind === 'ts' || requireParity ? undefined : 'INVALID_JSON');
    if (kind === 'rust' && !requireParity) gaps.push('login-ignored');
    rows.push({ name: 'login-ignored', status: login.status });

    const before = read(data, 'SELECT count(*) AS n FROM items')[0].n;
    for (const raw of malformed) expect(await request(server, path, { method: 'POST', cookie, raw }), 400, 'INVALID_JSON');
    for (const raw of ['null', '[]', '1', '"text"']) expect(await request(server, path, { method: 'POST', cookie, raw }), 400, 'INVALID_JSON');
    expect(await request(server, path, { method: 'POST', cookie, raw: '{"text":null}' }), 400, 'INVALID_INPUT');
    expect(await request(server, path, { method: 'POST', cookie, raw: '{"text":" "}' }), 400, 'EMPTY_TEXT');
    const invalid = String.raw`{"text":"a\ud800b"}`;
    expect(await request(server, path, { method: 'POST', raw: invalid }), 401, 'UNAUTHENTICATED');
    expect(await request(server, `/api/spaces/${m.bobSpace}/items/text`, { method: 'POST', cookie, raw: invalid }), 404, 'NOT_FOUND');
    const viewerLogin = await request(server, '/api/auth/password/login', { method: 'POST', raw: JSON.stringify({ email: m.viewer.email, password: PASSWORD }) });
    expect(viewerLogin, 200);
    expect(await request(server, path, { method: 'POST', cookie: viewerLogin.headers.get('set-cookie').split(';')[0], raw: invalid }), 403, 'READ_ONLY');
    expect(await request(server, path, { method: 'POST', cookie, raw: invalid, headers: { origin: 'http://evil.test' } }), 403, 'ORIGIN_REJECTED');
    expect(await request(server, path, { method: 'POST', cookie, raw: invalid, headers: { 'content-type': 'text/plain' } }), 400, 'JSON_REQUIRED');
    expect(await request(server, path, { method: 'POST', cookie, raw: '{"text":"' + 'x'.repeat(65537) + '"}' }), 413, 'TEXT_TOO_LARGE');
    expect(await request(server, path, { method: 'POST', cookie, raw: '{"text":"' + 'x'.repeat(65536 * 6 + 1024) + '"}' }), 413, 'BODY_TOO_LARGE');
    assert.equal(read(data, 'SELECT count(*) AS n FROM items')[0].n, before, 'errors must not insert rows');
    ws.socket.terminate();
    await inspect(server, base, cookie, expected);
    await stop(server);
    server = await start(kind, data);
    await inspect(server, base, cookie, expected);
    await stop(server);
    // Restart the other real implementation on the original database, without
    // exporting/importing strings through JS or changing the stored schema.
    server = await start(kind === 'ts' ? 'rust' : 'ts', data);
    let crossRead;
    if (kind === 'ts' && !requireParity) {
      const response = await request(server, base + '/items', { cookie });
      expect(response, 500, 'INTERNAL_ERROR');
      const ws = connect(server, base, cookie);
      const [code, reason] = await Promise.race([
        once(ws.socket, 'close'),
        delay(10000, undefined, { ref: false }).then(() => { throw new Error('Expected legacy-data WS close'); }),
      ]);
      assert.equal(code, 1011); assert.equal(String(reason), 'Snapshot unavailable');
      crossRead = { kind: 'rust', status: response.status, body: response.body, wsClose: { code, reason: String(reason) } };
    } else {
      await inspect(server, base, cookie, expected);
      crossRead = { kind: kind === 'ts' ? 'rust' : 'ts', status: 200, wsSnapshot: true };
    }
    return { kind, rows, gaps, persistedItems: expected.size, sameProcessGetAndWs: true, restartedGetAndWs: true, crossRead };
  } finally { await stop(server); }
}

try {
  reference = await prepareReference();
  const seed = resolve(temporary, 'seed'), m = await fixture(seed, { referenceRoot: reference });
  const ts = await run('ts', seed, m), candidate = await run('rust', seed, m);
  const report = { baseline, cases: cases.length, malformed: malformed.length, checks, ts, rust: candidate };
  if (process.env.UNICODE_REPORT) await writeFile(resolve(process.env.UNICODE_REPORT), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (requireParity) {
    assert.equal(ts.crossRead.status, 200, 'Rust must read TS-written Unicode data and deliver its WS snapshot');
    assert.deepEqual(candidate.gaps, [], 'Unresolved TS/Rust Unicode compatibility gaps (see README)');
  }
  console.log(`PASS Unicode characterization: ${checks} checks; ${candidate.gaps.length} explicitly unresolved parity cases`);
} finally {
  for (const socket of sockets) socket.terminate();
  for (const child of [...children]) await stop({ child });
  await rm(temporary, { recursive: true, force: true });
}
