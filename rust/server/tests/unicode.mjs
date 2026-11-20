// RHEA-245: strict TS/Rust Unicode parity without normalizing UTF-16 strings.
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
  ['private-use', String.raw`{"text":"\ue000\ud800\uf8ff"}`, '\ue000\ud800\uf8ff'],
  ['literal-and-surrogate', String.raw`{"text":"\\ud800\ud800�"}`, '\\ud800\ud800�'],
  ['duplicate-escaped-key', String.raw`{"te\u0078t":"first","text":"last"}`, 'last'],
  ['distinct-key', String.raw`{"text":"normal","text\ud800":"ignored","text�":"also ignored"}`, 'normal'],
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
  return { status: response.status, body: wire ? JSON.parse(wire) : null, wire, headers: response.headers };
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
  const socket = new WebSocket(server.url.replace('http:', 'ws:') + base + '/ws', { origin, headers: cookie ? { cookie } : {} });
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
  'private-use': 'EE8080EDA080EFA3BF', 'literal-and-surrogate': '5C7564383030EDA080EFBFBD',
};
const stored = (name, text) => Buffer.from(sqliteHex[name] ?? Buffer.from(text).toString('hex'), 'hex').toString('utf8');
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

async function metadataFlow(server, data, base, cookie, m, ws, roomBase, roomId) {
  const state = { items: [], users: [], facts: [], groups: ['r���x', 'g���x', 'g���x', 'label���x'] };
  const write = async (path, raw, method, status, session = cookie) => {
    const response = await request(server, path, { method, raw, cookie: session });
    expect(response, status); return response;
  };
  const eventItem = async (response, type = 'item.updated') => {
    const event = await ws.next(); assert.equal(event.body.type, type);
    assert.deepEqual(event.body.item, response.body.item);
  };
  const created = await write(base + '/items/text', String.raw`{"text":"group boundary","group":"g\ud800x"}`, 'POST', 201);
  assert.equal(created.body.item.group, 'g\ud800x'); await eventItem(created, 'item.created');
  const first = read(data, 'SELECT hex(groupName) AS hex FROM items WHERE id=?', created.body.item.id)[0];
  assert.equal(first.hex, '67EDA08078');
  state.items.push({ base, id: created.body.item.id, group: 'g���x', tags: [] });
  state.facts.push({ case: 'text-group', immediate: created.body.item.group, hex: first.hex });
  const group = await write(base + '/groups', String.raw`{"name":"g\udc00x"}`, 'POST', 201);
  assert.deepEqual(group.body.groups, ['历史分组', 'g���x', 'g���x']);
  assert.equal(read(data, "SELECT count(*) AS n FROM item_groups WHERE hex(name)='67EDB08078'")[0].n, 1);

  const rawTags = String.raw`{"tags":["tag\ud800x","#tag\ud800x","\udc00","�","\ue000"]}`;
  const tags = ['tag\ud800x', '\udc00', '�', '\ue000'];
  const labeled = await write(`${base}/items/${m.existing.id}/labels`, rawTags, 'PATCH', 200);
  assert.deepEqual(labeled.body.item.tags, tags); await eventItem(labeled);
  const storedTags = read(data, 'SELECT tags FROM items WHERE id=?', m.existing.id)[0].tags;
  assert.equal(storedTags, JSON.stringify(tags));
  state.facts.push({ case: 'tags', tags, storedTags });
  for (const invalid of [String.raw`{"tags":["\u0000"]}`, '{"tags":["' + String.raw`\ud800`.repeat(25) + '"]}', String.raw`{"group":"g\u0085x"}`]) {
    expect(await request(server, `${base}/items/${m.existing.id}/labels`, { method: 'PATCH', cookie, raw: invalid }), 400,
      invalid.includes('group') ? 'INVALID_GROUP' : 'INVALID_INPUT');
  }
  const rename = await write(base + '/groups/' + encodeURIComponent('历史分组'), String.raw`{"name":"r\udc00x"}`, 'PATCH', 200);
  assert.ok(rename.body.groups.includes('r���x'));
  const renamed = await ws.next(); assert.equal(renamed.body.type, 'item.updated');
  assert.equal(renamed.body.item.group, 'r���x'); assert.deepEqual(renamed.body.item.tags, tags);
  const relabeled = await write(`${base}/items/${m.existing.id}/labels`, String.raw`{"group":"label\ud800x"}`, 'PATCH', 200);
  assert.equal(relabeled.body.item.group, 'label\ud800x'); await eventItem(relabeled);
  state.items.push({ base, id: m.existing.id, group: 'label���x', tags });
  // Omitted group uses the TS-read replacement string, which cannot name the
  // original WTF-8 group. Preserve the resulting error rather than fixing TS.
  expect(await request(server, `${base}/items/${m.existing.id}/labels`, { method: 'PATCH', cookie, raw: '{"pinned":true}' }), 404, 'GROUP_NOT_FOUND');
  const share = await write(`${base}/items/${m.existing.id}/shares`, '{"expiresIn":"never"}', 'POST', 201);
  const publicItem = await request(server, '/api/s/' + share.body.token); expect(publicItem, 200);
  assert.deepEqual(publicItem.body.item.tags, tags);
  const managed = await request(server, '/api/shares', { cookie }); expect(managed, 200);
  state.share = share.body.token; state.shareTags = tags;

  for (const [id, name, hex, readName] of [[m.bob.id, 'Bob\ud800x', '426F62EDA08078', 'Bob���x'], [m.alice.id, 'Alice\udc00x', '416C696365EDB08078', 'Alice���x']]) {
    await write('/api/admin/users/' + id, JSON.stringify({ name }), 'PATCH', 204);
    assert.equal(read(data, 'SELECT hex(name) AS hex FROM users WHERE id=?', id)[0].hex, hex);
    state.users.push({ id, name: readName }); state.facts.push({ case: 'user-name', immediate: name, hex, readName });
  }
  for (const raw of [String.raw`{"email":"unicode-invalid@example.test","name":"Invalid","role":"user\ud800"}`, '{"email":"unicode-invalid@example.test","name":"Invalid","role":null}']) {
    expect(await request(server, '/api/admin/users', { method: 'POST', cookie, raw }), 400, 'INVALID_INPUT');
  }
  const provision = await write('/api/admin/users', String.raw`{"email":"unicode-new@example.test","name":"New\ud800x"}`, 'POST', 201);
  assert.equal(provision.body.name, 'New\ud800x');
  state.users.push({ id: provision.body.id, name: 'New���x' });
  await write('/api/admin/registration', '{"policy":"open"}', 'PUT', 200);
  const registration = await write('/api/auth/password/register', JSON.stringify({ email: 'unicode-register@example.test', name: 'Reg\udc00x', password: 'Password-\ud800-1234' }), 'POST', 201);
  assert.equal(registration.body.user.name, 'Reg\udc00x');
  state.users.push({ id: registration.body.user.id, name: 'Reg���x' });
  // Node crypto replaces a lone UTF-16 unit once, unlike SQLite's three-byte read.
  expect(await request(server, '/api/auth/password/login', { method: 'POST', raw: JSON.stringify({ email: 'unicode-register@example.test', password: 'Password-�-1234' }) }), 200);
  const token = await write('/api/tokens', String.raw`{"name":"PAT\ud800x"}`, 'POST', 201);
  assert.equal(token.body.name, 'PAT\ud800x');
  await write('/api/tokens/' + token.body.id, String.raw`{"name":"PAT\udc00x"}`, 'PATCH', 204);
  state.token = token.body.id;
  const upload = await write(base + '/uploads', String.raw`{"filename":"file\ud800.txt","size":4,"mime":"text/plain"}`, 'POST', 201);
  const fileRow = read(data, 'SELECT filename,hex(filename) AS hex FROM uploads WHERE id=?', upload.body.uploadId)[0];
  assert.equal(fileRow.hex, '66696C65EDA0802E747874');
  const uploadRead = await request(server, base + '/uploads/' + upload.body.uploadId, { cookie }); expect(uploadRead, 200);
  assert.equal(fileRow.filename, 'file���.txt');
  assert.equal('filename' in uploadRead.body, false);
  expect(await request(server, base + '/uploads/' + upload.body.uploadId, { cookie, method: 'DELETE' }), 204);
  state.facts.push({ case: 'upload-filename', hex: fileRow.hex, readName: fileRow.filename });
  const roomSocket = connect(server, roomBase); assert.equal((await roomSocket.next()).body.type, 'snapshot');
  const roomLabels = await write(`${roomBase}/items/${roomId}/labels`, String.raw`{"group":"room\ud800x","tags":["room\udc00"]}`, 'PATCH', 200, null);
  assert.equal(roomLabels.body.item.group, 'room\ud800x'); assert.deepEqual(roomLabels.body.item.tags, ['room\udc00']);
  assert.deepEqual((await roomSocket.next()).body.item, roomLabels.body.item); roomSocket.socket.terminate();
  state.items.push({ base: roomBase, id: roomId, group: 'room���x', tags: ['room\udc00'] });
  return state;
}

async function inspectMetadata(server, base, cookie, state) {
  for (const scope of new Set(state.items.map(item => item.base))) {
    const snapshot = await request(server, scope + '/items', { cookie: scope === base ? cookie : undefined }); expect(snapshot, 200);
    const ws = connect(server, scope, scope === base ? cookie : undefined), live = await ws.next();
    for (const { id, group, tags } of state.items.filter(item => item.base === scope)) {
      for (const value of [snapshot.body, live.body]) {
        const item = value.items.find(item => item.id === id);
        assert.equal(item.group, group); assert.deepEqual(item.tags, tags); checks++;
      }
    }
    if (scope === base) assert.deepEqual(snapshot.body.groups, state.groups);
    ws.socket.terminate();
  }
  const users = await request(server, '/api/admin/users', { cookie }); expect(users, 200);
  for (const expected of state.users) assert.equal(users.body.users.find(user => user.id === expected.id).name, expected.name);
  for (const path of ['/api/me', '/api/spaces', base + '/members']) expect(await request(server, path, { cookie }), 200);
  const tokens = await request(server, '/api/tokens', { cookie }); expect(tokens, 200);
  assert.equal(tokens.body.tokens.find(token => token.id === state.token).name, 'PAT���x');
  const shared = await request(server, '/api/s/' + state.share); expect(shared, 200); assert.deepEqual(shared.body.item.tags, state.shareTags);
}

async function run(kind, seed, m) {
  const data = resolve(temporary, kind); await cp(seed, data, { recursive: true });
  let server = await start(kind, data);
  const base = `/api/spaces/${m.aliceSpace}`, path = base + '/items/text';
  const cookie = 'dropit_session=' + m.oldCookie;
  const expected = new Map(), rows = [];
  let roomBase, roomExpected;
  try {
    const ws = connect(server, base, cookie);
    assert.equal((await ws.next()).body.type, 'snapshot');
    for (const [name, raw, text] of cases) {
      const parsed = JSON.parse(raw);
      assert.equal(parsed.text, text, name + ': independent expected UTF-16 value');
      const response = await request(server, path, { method: 'POST', cookie, raw });
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
    {
      expect(edited, 200); assert.equal(edited.body.item.text, 'edit\ud800尾');
      const event = await ws.next(); assert.equal(event.body.type, 'item.updated');
      assert.deepEqual(event.body.item, edited.body.item);
      const [row] = read(data, 'SELECT text,hex(CAST(text AS BLOB)) AS hex,size,storedBytes FROM items WHERE id=?', m.existing.id);
      assert.equal(row.hex, sqliteHex.edit); assert.equal(row.text, stored('edit', 'edit\ud800尾'));
      expected.set(m.existing.id, { text: row.text, size: row.size });
    }
    rows.push({ name: 'edit', status: edited.status, responseTextToken: textToken(edited.wire),
      sqlite: read(data, 'SELECT text,hex(CAST(text AS BLOB)) AS hex,size,storedBytes FROM items WHERE id=?', m.existing.id)[0] });

    // Login must ignore unused surrogate values after validating JSON syntax.
    const loginRaw = JSON.stringify({ email: m.alice.email, password: PASSWORD }).slice(0, -1) + String.raw`,"ignored":{"a":"\ud800"}}`;
    const login = await request(server, '/api/auth/password/login', { method: 'POST', raw: loginRaw });
    expect(login, 200);
    rows.push({ name: 'login-ignored', status: login.status });

    const room = await request(server, '/api/rooms', { method: 'POST', raw: '{}' });
    expect(room, 201); roomBase = '/api/rooms/' + room.body.token;
    const roomSocket = connect(server, roomBase);
    assert.equal((await roomSocket.next()).body.type, 'snapshot');
    const created = await request(server, roomBase + '/items/text', { method: 'POST', raw: String.raw`{"text":"a\ud800b"}` });
    expect(created, 201); assert.equal(created.body.item.text, 'a\ud800b');
    const roomCreatedEvent = await roomSocket.next();
    assert.deepEqual(roomCreatedEvent.body.item, created.body.item);
    assert.equal(textToken(roomCreatedEvent.wire), String.raw`"a\ud800b"`);
    const roomEdited = await request(server, roomBase + '/items/' + created.body.item.id, { method: 'PATCH', raw: editRaw });
    expect(roomEdited, 200); assert.equal(roomEdited.body.item.text, 'edit\ud800尾');
    assert.deepEqual((await roomSocket.next()).body.item, roomEdited.body.item);
    const [roomRow] = read(data, 'SELECT text,hex(CAST(text AS BLOB)) AS hex,size,storedBytes FROM items WHERE id=?', created.body.item.id);
    assert.equal(roomRow.hex, sqliteHex.edit); assert.equal(roomRow.size, 10); assert.equal(roomRow.storedBytes, 10);
    roomExpected = new Map([[created.body.item.id, { text: stored('edit', 'edit\ud800尾'), size: 10 }]]);
    rows.push({ name: 'room-create-edit', status: roomEdited.status, sqlite: roomRow });
    roomSocket.socket.terminate();
    await inspect(server, roomBase, undefined, roomExpected);

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
    const metadata = await metadataFlow(server, data, base, cookie, m, ws, roomBase, created.body.item.id);
    ws.socket.terminate();
    await inspect(server, base, cookie, expected);
    await inspectMetadata(server, base, cookie, metadata);
    await stop(server);
    server = await start(kind, data);
    await inspect(server, base, cookie, expected);
    await inspect(server, roomBase, undefined, roomExpected);
    await inspectMetadata(server, base, cookie, metadata);
    await stop(server);
    // Restart the other real implementation on the original database, without
    // exporting/importing strings through JS or changing the stored schema.
    server = await start(kind === 'ts' ? 'rust' : 'ts', data);
    await inspect(server, base, cookie, expected);
    await inspect(server, roomBase, undefined, roomExpected);
    await inspectMetadata(server, base, cookie, metadata);
    const crossRead = { kind: kind === 'ts' ? 'rust' : 'ts', status: 200, wsSnapshot: true };
    return { kind, rows, metadata: metadata.facts, persistedItems: expected.size, sameProcessGetAndWs: true, restartedGetAndWs: true, crossRead };
  } finally { await stop(server); }
}

try {
  reference = await prepareReference();
  const seed = resolve(temporary, 'seed'), m = await fixture(seed, { referenceRoot: reference });
  const ts = await run('ts', seed, m), candidate = await run('rust', seed, m);
  const report = { baseline, cases: cases.length, malformed: malformed.length, checks, ts, rust: candidate };
  if (process.env.UNICODE_REPORT) await writeFile(resolve(process.env.UNICODE_REPORT), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`PASS Unicode TS/Rust parity: ${checks} HTTP/state checks`);
} finally {
  for (const socket of sockets) socket.terminate();
  for (const child of [...children]) await stop({ child });
  await rm(temporary, { recursive: true, force: true });
}
