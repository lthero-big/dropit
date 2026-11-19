// Real fixed-history TS/Rust HTTP/WS comparisons on isolated schema-19 data.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, PASSWORD } from './fixture.mjs';

const root = resolve(import.meta.dirname, '../../..');
const baseline = '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68';
const rust = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
const origin = 'http://dropit.test';
await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const temporary = await mkdtemp(resolve(root, 'rust/server/data/labels-'));
const children = new Set(), sockets = new Set();
let reference, WebSocket, Sqlite, checks = 0;

async function prepareReference() {
  const directory = resolve(temporary, 'reference');
  await mkdir(directory);
  const archive = execFileSync('git', ['archive', baseline, '--', 'apps/server', 'apps/cli', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], { cwd: root, maxBuffer: 16 << 20 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@dropit/server...', '--filter', '@lthero-big/dropit-cli...'], { cwd: directory, stdio: 'pipe' });
  for (const pkg of ['@dropit/server', '@lthero-big/dropit-cli']) execFileSync('pnpm', ['--filter', pkg, 'build'], { cwd: directory, stdio: 'pipe' });
  const require = createRequire(resolve(directory, 'apps/server/package.json'));
  WebSocket = require('ws'); Sqlite = require('better-sqlite3');
  return directory;
}

async function start(kind, data) {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(kind === 'rust' ? rust : process.execPath, kind === 'rust' ? [] : [resolve(reference, 'apps/server/dist/index.js')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin,
      UPDATE_CHECK: '0', RATE_GENERAL: '10000', RATE_AUTH: '1000', RATE_UPLOAD: '1000', RATE_ROOM: '500', RATE_INVITE: '1000',
    },
  });
  children.add(child); let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${kind} exited\n${output}`);
    if (output.includes('dropit listening on port ')) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
        await health.text();
        if (health.status === 200) return { child, url: `http://127.0.0.1:${port}`, data };
      } catch { /* startup */ }
    }
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

async function request(server, path, { method = 'GET', cookie, token, json, raw, headers = {} } = {}) {
  headers = { origin, ...headers };
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(server.url + path, {
    method, headers, body: json === undefined ? raw : JSON.stringify(json), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text(); checks++;
  return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : text };
}
function expect(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body?.error?.code, code);
  return response.body;
}
async function login(server, email) {
  const response = await request(server, '/api/auth/password/login', { method: 'POST', json: { email, password: PASSWORD } });
  expect(response, 200); return response.headers.get('set-cookie').split(';')[0];
}
function sql(data, query, ...params) {
  const db = new Sqlite(resolve(data, 'dropit.sqlite'));
  try { return db.prepare(query).run(...params); } finally { db.close(); }
}
function read(data, query, ...params) {
  const db = new Sqlite(resolve(data, 'dropit.sqlite'));
  try { return db.prepare(query).all(...params); } finally { db.close(); }
}
function connect(server, path, cookie) {
  const socket = new WebSocket(server.url.replace('http:', 'ws:') + path, { origin, headers: cookie ? { cookie } : {} });
  sockets.add(socket);
  const queue = [], waiters = [];
  socket.on('message', bytes => {
    const message = JSON.parse(String(bytes));
    if (message.type === 'presence') return;
    if (waiters.length) waiters.shift()(message); else queue.push(message);
  });
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket event timeout')), 5000);
    waiters.push(message => { clearTimeout(timer); resolve(message); });
  });
  return { socket, next };
}
async function cli(server, token, args) {
  const child = spawn(process.execPath, [resolve(reference, 'apps/cli/dist/index.js'), ...args], {
    cwd: root, env: { PATH: process.env.PATH, DROPIT_URL: server.url, DROPIT_TOKEN: token, DROPIT_CONFIG: resolve(temporary, 'cli-config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const [code] = await once(child, 'exit'); children.delete(child);
  assert.equal(code, 0, stderr); return stdout;
}

async function run(kind, seed, m) {
  const data = resolve(temporary, kind); await cp(seed, data, { recursive: true });
  const server = await start(kind, data), transcript = [], ids = new Map();
  const normalize = (value, key = '') => {
    if (value === null) return null;
    if (typeof value === 'number') return /At$|serverTime/.test(key) ? '<clock>' : value;
    if (typeof value === 'string') return ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(entry => normalize(entry));
    if (typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, normalize(entry, name)]));
  };
  const check = async (label, path, opts, status = 200, code) => {
    const response = await request(server, path, opts); expect(response, status, code);
    if (response.body.item?.id && !ids.has(response.body.item.id)) ids.set(response.body.item.id, `<${label}-item>`);
    transcript.push([label, response.status, normalize(response.body), response.headers.get('cache-control'), response.headers.get('content-type')]);
    return response.body;
  };
  const base = `/api/spaces/${m.aliceSpace}`, id = m.existing.id;
  const alice = await login(server, m.alice.email), bob = await login(server, m.bob.email), viewer = await login(server, m.viewer.email);
  const socket = connect(server, `${base}/ws`, alice);
  try {
    const snapshot = await socket.next(); assert.equal(snapshot.type, 'snapshot');
    const event = async (type, fields) => { const value = await socket.next(); assert.equal(value.type, type); if (fields) assert.deepEqual(value, fields); checks++; return value; };
    const patch = (json, cookie = alice) => ({ method: 'PATCH', cookie, json });
    await check('existing groups', `${base}/groups`, { cookie: alice });
    await check('viewer groups', `${base}/groups`, { cookie: viewer });
    await check('signed out', `${base}/groups`, {}, 401, 'UNAUTHENTICATED');
    await check('cross space', `/api/spaces/${m.bobSpace}/groups`, { cookie: alice }, 404, 'NOT_FOUND');
    for (const path of [`${base}/groups`, `${base}/groups/missing`, `${base}/items/${id}`, `${base}/items/${id}/labels`]) {
      await check('viewer malformed write', path, { method: path.endsWith('/groups') ? 'POST' : 'PATCH', cookie: viewer, json: {} }, 403, 'READ_ONLY');
    }
    for (const name of [null, 3, '', '全部', '未分组', 'x'.repeat(25), '\u0085', '\u007f', 'a\u0000']) {
      await check('invalid name', `${base}/groups`, { method: 'POST', cookie: alice, json: { name } }, 400, 'INVALID_GROUP');
    }
    for (const [raw, name] of [[' 工作 ', '工作'], ['e\u0301\u3000笔记', 'é 笔记'], ['a/b', 'a/b']]) {
      const result = await check('create '+name, `${base}/groups`, { method: 'POST', cookie: alice, json: { name: raw } }, 201);
      await event('groups', { type: 'groups', ...result });
    }
    await check('duplicate normalized name', `${base}/groups`, { method: 'POST', cookie: alice, json: { name: 'é 笔记' } }, 409, 'GROUP_EXISTS');
    await check('missing rename', `${base}/groups/missing`, patch({ name: '新' }), 404, 'GROUP_NOT_FOUND');
    await check('missing delete', `${base}/groups/missing`, { method: 'DELETE', cookie: alice }, 404, 'GROUP_NOT_FOUND');
    const noOp = await check('same rename', `${base}/groups/a%2Fb`, patch({ name: 'a/b' })); await event('groups', { type: 'groups', ...noOp });
    await check('rename conflict', `${base}/groups/a%2Fb`, patch({ name: '工作' }), 409, 'GROUP_EXISTS');
    for (const tags of [null, 'tag', [1], Array(9).fill('x'), [''], ['#'], ['a,b'], ['a b'], ['\u007f'], ['\u0000'], ['x'.repeat(25)]]) {
      await check('invalid tags', `${base}/items/${id}/labels`, patch({ tags }), 400, 'INVALID_INPUT');
    }
    for (const json of [{}, { ignored: true }, { pinned: 1 }, { pinned: null }]) await check('invalid labels', `${base}/items/${id}/labels`, patch(json), 400, 'INVALID_INPUT');
    await check('invalid group type', `${base}/items/${id}/labels`, patch({ group: [] }), 400, 'INVALID_GROUP');
    const labeled = (await check('labels', `${base}/items/${id}/labels`, patch({ pinned: true, tags: [' #重要 ', '重要', '##待办', '\u0085'], group: '工作' }))).item;
    assert.deepEqual(labeled.tags, ['重要', '待办', '\u0085']);
    assert.equal(labeled.updatedAt, m.existing.updatedAt); assert.equal(labeled.createdAt, m.existing.createdAt);
    await event('item.updated', { type: 'item.updated', item: labeled });
    for (const json of [{}, { text: '' }, { text: null }]) await check('invalid edit', `${base}/items/${id}`, patch(json), 400, 'INVALID_INPUT');
    await check('blank edit', `${base}/items/${id}`, patch({ text: ' \n\ufeff' }), 400, 'EMPTY_TEXT');
    await check('oversize edit', `${base}/items/${id}`, patch({ text: '🦀'.repeat(16385) }), 413, 'TEXT_TOO_LARGE');
    const text = 'owner edited\n纯文本 <script>alert(1)</script>\u0000🦀';
    const edited = (await check('edit', `${base}/items/${id}`, patch({ text }))).item;
    assert.equal(edited.text, text); assert.equal(edited.size, Buffer.byteLength(text));
    assert.equal(edited.createdAt, m.existing.createdAt); assert.equal(edited.expiresAt, m.existing.expiresAt);
    assert.ok(edited.updatedAt >= m.existing.updatedAt); assert.equal(edited.group, '工作');
    await event('item.updated', { type: 'item.updated', item: edited });
    // Separate fields compose under concurrent requests, including broadcasts.
    const parallel = await Promise.all([{ tags: ['并发'] }, { group: '并发组' }, { pinned: false }].map(json => request(server, `${base}/items/${id}/labels`, patch(json))));
    parallel.forEach(response => expect(response, 200));
    for (let n = 0; n < 4; n++) { const message = await socket.next(); assert.ok(['groups', 'item.updated'].includes(message.type)); }
    const concurrent = expect(await request(server, `${base}/items`, { cookie: alice }), 200).items.find(item => item.id === id);
    assert.deepEqual([concurrent.tags, concurrent.group, concurrent.pinned], [['并发'], '并发组', false]);
    const invite = expect(await request(server, `${base}/invites`, { method: 'POST', cookie: alice, json: { maxUses: 2, role: 'editor' } }), 201);
    expect(await request(server, `/api/invites/${invite.token}/accept`, { method: 'POST', cookie: bob }), 200);
    const bobItem = expect(await request(server, `${base}/items/text`, { method: 'POST', cookie: bob, json: { text: 'editor item', group: '工作' } }), 201).item;
    await event('item.created');
    await check('editor own edit', `${base}/items/${bobItem.id}`, patch({ text: 'editor edited' }, bob)); await event('item.updated');
    await check('owner cannot rewrite editor', `${base}/items/${bobItem.id}`, patch({ text: 'overwrite' }), 403, 'FORBIDDEN');
    await check('editor cannot edit owner', `${base}/items/${id}`, patch({ text: 'overwrite' }, bob), 403, 'FORBIDDEN');
    await check('editor label owner', `${base}/items/${id}/labels`, patch({ tags: [] }, bob), 403, 'FORBIDDEN');
    await check('owner labels editor', `${base}/items/${bobItem.id}/labels`, patch({ tags: ['owner'] })); await event('item.updated');
    for (const [method, path, json] of [['PATCH', `${base}/items/missing`, { text: 'x' }], ['PATCH', `${base}/items/missing/labels`, { tags: [] }]]) await check('missing item', path, { method, cookie: alice, json }, 404, 'NOT_FOUND');
    const rename = await check('rename with items', `${base}/groups/${encodeURIComponent('工作')}`, patch({ name: '归档' })); await event('groups', { type: 'groups', ...rename });
    assert.equal((await event('item.updated')).item.group, '归档');
    const deleted = await check('delete with items', `${base}/groups/${encodeURIComponent('归档')}`, { method: 'DELETE', cookie: alice }); await event('groups', { type: 'groups', ...deleted });
    assert.equal((await event('item.updated')).item.group, null);
    // Group order is position/createdAt/name, and renames keep their position.
    const order = await check('ordered groups', `${base}/groups`, { cookie: alice });
    assert.deepEqual(order.groups, ['历史分组', 'é 笔记', 'a/b', '并发组']);
    const rawFile = await request(server, `${base}/items/file`, { method: 'POST', cookie: alice, raw: 'file bytes', headers: { 'content-type': 'text/plain', 'x-file-name': 'file.txt' } });
    const file = expect(rawFile, 201).item; await event('item.created');
    await check('file edit rejected', `${base}/items/${file.id}`, patch({ text: 'x' }), 400, 'INVALID_INPUT');
    await check('file labels', `${base}/items/${file.id}/labels`, patch({ tags: ['文件'] })); await event('item.updated');
    expect(await request(server, `${base}/items/${file.id}`, { method: 'DELETE', cookie: alice }), 204); await event('item.deleted');
    await check('retracted labels', `${base}/items/${file.id}/labels`, patch({ tags: [] }), 404, 'NOT_FOUND');
    const expired = expect(await request(server, `${base}/items/text`, { method: 'POST', cookie: alice, json: { text: 'expire' } }), 201).item; await event('item.created');
    sql(data, 'UPDATE items SET expiresAt=1 WHERE id=?', expired.id);
    await check('expired edit', `${base}/items/${expired.id}`, patch({ text: 'x' }), 404, 'NOT_FOUND');
    // Growth counts reservations, while shrink is allowed after quota is lowered.
    const usage = expect(await request(server, '/api/me', { cookie: alice }), 200).usedBytes;
    sql(data, 'UPDATE users SET quotaBytes=? WHERE id=?', usage + 10, m.alice.id);
    const reservation = expect(await request(server, `${base}/uploads`, { method: 'POST', cookie: alice, json: { filename: 'reserve.txt', mime: 'text/plain', size: 10 } }), 201);
    await check('reserved quota growth', `${base}/items/${id}`, patch({ text: text+'x' }), 413, 'QUOTA_EXCEEDED');
    sql(data, 'UPDATE users SET quotaBytes=1 WHERE id=?', m.alice.id);
    await check('overquota shrink', `${base}/items/${id}`, patch({ text: 'x' })); await event('item.updated');
    expect(await request(server, `${base}/uploads/${reservation.uploadId}`, { method: 'DELETE', cookie: alice }), 204);
    sql(data, 'UPDATE users SET quotaBytes=NULL WHERE id=?', m.alice.id);
    const token = expect(await request(server, '/api/tokens', { method: 'POST', cookie: alice, json: { name: 'CLI labels', scopes: ['read','write'] } }), 201).token;
    expect(await request(server, `${base}/items/${id}`, { method: 'PATCH', token, json: { text: 'CLI sees edited text' } }), 200); await event('item.updated');
    const cliItems = JSON.parse(await cli(server, token, ['ls', '--space', m.aliceSpace, '--json'])).items;
    assert.equal(cliItems.find(item => item.id === id).text, 'CLI sees edited text');
    assert.deepEqual(cliItems.find(item => item.id === id).tags, ['并发']);
    assert.equal(await cli(server, token, ['get', id]), 'CLI sees edited text');
    const { Client } = await import(pathToFileURL(resolve(reference, 'apps/cli/dist/client.js')));
    const { applyWatch, createWatchState } = await import(pathToFileURL(resolve(reference, 'apps/cli/dist/watch.js')));
    const client = new Client(server.url, token), controller = new AbortController();
    const watch = await client.connectWatch({ kind: 'space', id: m.aliceSpace }, controller.signal);
    try {
      const messages = watch.messages[Symbol.asyncIterator](), state = createWatchState();
      applyWatch(state, JSON.parse((await messages.next()).value));
      expect(await request(server, `${base}/items/${id}`, { method: 'PATCH', token, json: { text: 'watch updated' } }), 200);
      await event('item.updated');
      while (state.items.get(id)?.text !== 'watch updated') applyWatch(state, JSON.parse((await messages.next()).value));
      assert.equal(state.items.get(id).group, '并发组');
    } finally { watch.close(); controller.abort(); }
    const readToken = expect(await request(server, '/api/tokens', { method: 'POST', cookie: alice, json: { name: 'read', scopes: ['read'] } }), 201).token;
    await check('PAT read only', `${base}/items/${id}/labels`, { method: 'PATCH', token: readToken, json: { tags: [] } }, 403, 'INSUFFICIENT_SCOPE');
    // A group creation before a rejected author check is a persisted TS side effect.
    sql(data, 'UPDATE users SET disabled=1 WHERE id=?', m.bob.id);
    await check('disabled author', `${base}/items/${bobItem.id}/labels`, patch({ group: '保留空组' }), 403, 'FORBIDDEN');
    await event('groups');
    sql(data, 'UPDATE users SET disabled=0 WHERE id=?', m.bob.id);
    const room = expect(await request(server, '/api/rooms', { method: 'POST', cookie: alice, json: {} }), 201);
    const roomBase = `/api/rooms/${encodeURIComponent(room.token)}`;
    const roomItem = expect(await request(server, `${roomBase}/items/text`, { method: 'POST', json: { text: 'room text', group: '临时' } }), 201).item;
    const roomSocket = connect(server, `${roomBase}/ws`);
    assert.equal((await roomSocket.next()).type, 'snapshot');
    try {
      const roomEdit = expect(await request(server, `${roomBase}/items/${roomItem.id}`, { method: 'PATCH', json: { text: 'room edited' } }), 200).item;
      assert.deepEqual(await roomSocket.next(), { type: 'item.updated', item: roomEdit });
      expect(await request(server, `${roomBase}/items/${roomItem.id}/labels`, { method: 'PATCH', json: { tags: ['房间'], group: '新房间组' } }), 200);
      assert.equal((await roomSocket.next()).type, 'groups'); assert.equal((await roomSocket.next()).type, 'item.updated');
      const roomRename = expect(await request(server, `${roomBase}/groups/${encodeURIComponent('新房间组')}`, { method: 'PATCH', json: { name: '完成' } }), 200);
      assert.deepEqual(await roomSocket.next(), { type: 'groups', ...roomRename });
      assert.equal((await roomSocket.next()).item.group, '完成');
      expect(await request(server, `${roomBase}/groups/${encodeURIComponent('完成')}`, { method: 'DELETE' }), 200);
      assert.equal((await roomSocket.next()).type, 'groups'); assert.equal((await roomSocket.next()).item.group, null);
    } finally { roomSocket.socket.close(); }
    // Two text growths compete for the same remaining quota atomically.
    const growthItems = [];
    for (const text of ['left', 'right']) growthItems.push(expect(await request(server, `${base}/items/text`, { method: 'POST', cookie: alice, json: { text } }), 201).item);
    const used = expect(await request(server, '/api/me', { cookie: alice }), 200).usedBytes;
    sql(data, 'UPDATE users SET quotaBytes=? WHERE id=?', used + 70, m.alice.id);
    const growths = await Promise.all(growthItems.map(item => request(server, `${base}/items/${item.id}`, patch({ text: 'x'.repeat(64) }))));
    assert.deepEqual(growths.map(response => response.status).sort(), [200, 413]);
    sql(data, 'UPDATE users SET quotaBytes=NULL WHERE id=?', m.alice.id);
    // Concurrent group creation has one winner and maintains the 24-group cap.
    const namesBefore = expect(await request(server, `${base}/groups`, { cookie: alice }), 200).groups;
    const copies = await Promise.all(Array.from({ length: 4 }, () => request(server, `${base}/groups`, { method: 'POST', cookie: alice, json: { name: 'race' } })));
    assert.deepEqual(copies.map(response => response.status).sort(), [201,409,409,409]);
    for (let n = namesBefore.length + 1; n < 24; n++) expect(await request(server, `${base}/groups`, { method: 'POST', cookie: alice, json: { name: 'g'+n } }), 201);
    await check('group cap', `${base}/groups`, { method: 'POST', cookie: alice, json: { name: 'overflow' } }, 409, 'GROUP_LIMIT');
    // Historical rows and writes must be readable by the other implementation.
    const storedGroups = read(data, 'SELECT name FROM item_groups WHERE spaceId=? ORDER BY position, createdAt, name', m.aliceSpace);
    storedGroups.reverse().forEach((group, position) => sql(data, 'UPDATE item_groups SET position=? WHERE spaceId=? AND name=?', position, m.aliceSpace, group.name));
    assert.deepEqual(expect(await request(server, `${base}/groups`, { cookie: alice }), 200).groups, storedGroups.map(group => group.name));
    const state = expect(await request(server, `${base}/items`, { cookie: alice }), 200);
    return { transcript, data, state, cookie: alice };
  } finally { socket.socket.close(); await stop(server); }
}

try {
  reference = await prepareReference();
  const seed = resolve(temporary, 'seed'), metadata = await fixture(seed, { referenceRoot: reference });
  const ts = await run('ts', seed, metadata), actual = await run('rust', seed, metadata);
  assert.deepEqual(actual.transcript, ts.transcript);
  for (const [kind, source] of [['ts', actual], ['rust', ts]]) {
    const server = await start(kind, source.data);
    try {
      const state = expect(await request(server, `/api/spaces/${metadata.aliceSpace}/items`, { cookie: source.cookie }), 200);
      assert.deepEqual(state.items, source.state.items); assert.deepEqual(state.groups, source.state.groups);
      const row = read(source.data, 'PRAGMA user_version'); assert.equal(row[0].user_version, 19);
      assert.deepEqual(read(source.data, 'PRAGMA foreign_key_check'), []);
    } finally { await stop(server); }
  }
  console.log(`PASS ${checks} HTTP/WS checks: editing, labels, ordered groups, roles/PAT, concurrency/quota, retract/expiry, CLI and TS↔Rust schema-19 restart`);
} finally {
  for (const socket of sockets) socket.terminate();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  await rm(temporary, { recursive: true, force: true });
}
