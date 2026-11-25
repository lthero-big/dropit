// Real fixed-history HTTP/WS comparisons; works without checkout dist.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fixture, PASSWORD } from './fixture.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68';
const rust = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const temp = await mkdtemp(resolve(root, 'rust/server/data/rooms-sharing-'));
const processes = new Set(), sockets = new Set();
let reference, Sqlite, WebSocket, sharp, checks = 0;
async function prepare() {
  const dir = resolve(temp, 'reference'); await mkdir(dir);
  execFileSync('tar', ['-x', '-C', dir], { input: execFileSync('git', ['archive', baseline, '--', 'apps/server', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], { cwd: root, maxBuffer: 16 << 20 }) });
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@dropit/server...'], { cwd: dir, stdio: 'pipe' });
  execFileSync('pnpm', ['--filter', '@dropit/server', 'build'], { cwd: dir, stdio: 'pipe' });
  const require = createRequire(resolve(dir, 'apps/server/package.json'));
  Sqlite = require('better-sqlite3'); WebSocket = require('ws'); sharp = require('sharp'); return dir;
}
async function start(kind, data, extra = {}) {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(kind === 'rust' ? rust : process.execPath, kind === 'rust' ? [] : [resolve(reference, 'apps/server/dist/index.js')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: 'http://dropit.test', UPDATE_CHECK: '0', RATE_GENERAL: '10000', RATE_AUTH: '1000', RATE_UPLOAD: '1000', RATE_ROOM: '500', RATE_INVITE: '1000', PIN_LOCK_FAILURES: '2', ...extra },
  });
  processes.add(child); let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const server = { child, url: `http://127.0.0.1:${port}`, data };
  for (let i = 0; i < 400; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${kind} exited: ${output}`);
    if (output.includes('dropit listening on port ')) {
      try { const r = await fetch(server.url + '/healthz', { signal: AbortSignal.timeout(1000) }); await r.text(); if (r.ok) return server; } catch { /* startup */ }
    }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`${kind} readiness failed: ${output}`);
}
async function stop(s) {
  if (s.child.exitCode === null && s.child.signalCode === null) { const end = once(s.child, 'exit'); s.child.kill('SIGTERM'); await end; }
  processes.delete(s.child);
}
async function req(s, path, { method = 'GET', cookie, token, json, body, headers = {}, origin = 'http://dropit.test' } = {}) {
  headers = { ...headers }; if (origin !== null) headers.origin = origin;
  if (cookie) headers.cookie = cookie; if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const r = await fetch(s.url + path, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const bytes = Buffer.from(await r.arrayBuffer()); const text=bytes.toString('utf8'); checks++;
  return { status: r.status, headers: r.headers, bytes, body: r.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text };
}
function sql(data, statement, ...args) { const db = new Sqlite(resolve(data, 'dropit.sqlite')); try { return db.prepare(statement).run(...args); } finally { db.close(); } }
function lookup(data, statement, ...args) { const db = new Sqlite(resolve(data, 'dropit.sqlite'), { readonly: true }); try { return db.prepare(statement).get(...args); } finally { db.close(); } }
function expect(r, status, code) { assert.equal(r.status, status, JSON.stringify(r.body)); if (code) assert.equal(r.body?.error?.code, code); return r.body; }
async function login(s, email) { const r = await req(s, '/api/auth/password/login', { method: 'POST', json: { email, password: PASSWORD } }); expect(r, 200); return r.headers.get('set-cookie').split(';')[0]; }
async function connect(s, path, cookie, token) {
  const ws = new WebSocket(s.url.replace('http:', 'ws:') + path, { origin: 'http://dropit.test', headers: { ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  sockets.add(ws); const queue = [], waiters = [];
  ws.on('message', bytes => { const value = JSON.parse(bytes); if (waiters.length) waiters.shift()(value); else queue.push(value); });
  await once(ws, 'open');
  return { ws, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS event timeout')), 5000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  }) };
}
async function closed(ws) { const timer = setTimeout(() => ws.terminate(), 5000); try { const [code] = await once(ws, 'close'); assert.equal(code, 1008); checks++; } finally { clearTimeout(timer); sockets.delete(ws); } }
async function flow(kind, seed, m) {
  const data = resolve(temp, kind); await cp(seed, data, { recursive: true }); const s = await start(kind, data);
  const transcript = [], names = new Map(); let serial = 0;
  const bind = (value, name) => { if (value != null) names.set(String(value), `<${name}>`); };
  const normalize = (value, key = '') => {
    if (value === null) return value;
    if (typeof value === 'number') return /At$|serverTime|lockedFor/.test(key) ? '<clock>' : value;
    if (typeof value === 'string') { if (names.has(value)) return names.get(value); for (const [raw, name] of names) if (raw.length >= 6) value = value.replaceAll(raw, name); return value; }
    if (Array.isArray(value)) return value.map(item => normalize(item));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, key)]));
  };
  async function check(label, path, opts, status, code, name) {
    const r = await req(s, path, opts); expect(r, status, code);
    if (name) for (const key of ['id', 'token', 'access', 'code']) if (r.body[key]) bind(r.body[key], `${name}-${key}`);
    if (r.body.item?.id) bind(r.body.item.id, `${label}-item-id`);
    transcript.push([label, r.status, normalize(r.body), r.headers.get('cache-control'), r.headers.get('content-type')]); return r.body;
  }
  const create = (label, path, json, cookie, name = `created-${serial++}`) => check(label, path, { method: 'POST', json, cookie }, 201, null, name);
  try {
    const alice = await login(s, 'alice@example.test'), bob = await login(s, 'bob@example.test'), viewer = await login(s, 'viewer@example.test'); const base = `/api/spaces/${m.aliceSpace}`;
    await check('signed out', `${base}/members`, {}, 401, 'UNAUTHENTICATED');
    await check('cross account', `${base}/members`, { cookie: bob }, 404, 'NOT_FOUND');
    await check('viewer admin', `${base}/members`, { cookie: viewer }, 403, 'FORBIDDEN');
    await check('owner members', `${base}/members`, { cookie: alice }, 200);
    for (const maxUses of ['2', 0, 101, 1.2, false]) await check('invalid uses', `${base}/invites`, { method: 'POST', cookie: alice, json: { maxUses } }, 400, 'INVALID_INPUT');
    const inv = await create('invite', `${base}/invites`, { maxUses: 3 }, alice, 'invite');
    await check('public invite', `/api/invites/${inv.token}`, {}, 200);
    await check('accept', `/api/invites/${inv.token}/accept`, { method: 'POST', cookie: bob }, 200);
    await check('idempotent accept', `/api/invites/${inv.token}/accept`, { method: 'POST', cookie: bob }, 200);
    await check('invite listing', `${base}/invites`, { cookie: alice }, 200);
    await check('viewer write', `${base}/items/text`, { method: 'POST', json: { text: 'no' }, cookie: bob }, 403, 'READ_ONLY');
    await check('editor promotion', `${base}/members/${m.bob.id}`, { method: 'PATCH', json: { role: 'editor' }, cookie: alice }, 200);
    const editorItem=(await create('editor write', `${base}/items/text`, { text: 'editor text' }, bob)).item;
    const editorShare=await create('editor share', `${base}/items/${editorItem.id}/shares`, {expiresIn:'never'},bob);
    await check('editor manage owner', `${base}/items/${m.existing.id}/shares`, { method: 'POST', json: { expiresIn: 'never' }, cookie: bob }, 403, 'FORBIDDEN');
    const socket = await connect(s, `${base}/ws`, bob); await socket.next(); const revoked = closed(socket.ws);
    await check('remove member', `${base}/members/${m.bob.id}`, { method: 'DELETE', cookie: alice }, 204); await revoked;
    await check('creator loses source copy', `/api/shares/${editorShare.id}/link`,{cookie:bob},404,'NOT_FOUND');
    await check('creator history purges invisible source','/api/shares',{cookie:bob},200);
    await check('removed member read', `${base}/items`, { cookie: bob }, 404, 'NOT_FOUND');
    await check('owner cannot leave', `${base}/membership`, { method: 'DELETE', cookie: alice }, 409, 'OWNER_CANNOT_LEAVE');
    await check('viewer leaves', `${base}/membership`, { method: 'DELETE', cookie: viewer }, 204);
    await check('revoke invite', `${base}/invites/${inv.id}`, { method: 'DELETE', cookie: alice }, 204);
    await check('revoked invite', `/api/invites/${inv.token}`, {}, 404, 'NOT_FOUND');
    sql(data, 'UPDATE users SET inviteLimit=0 WHERE id=?', m.bob.id);
    await check('invite disabled', `/api/spaces/${m.bobSpace}/invites`, { method: 'POST', json: {}, cookie: bob }, 403, 'INVITES_DISABLED');
    const onceInvite = await create('single invite', `${base}/invites`, { maxUses: 1, role: 'editor' }, alice);
    const joins = await Promise.all([bob, viewer].map(cookie => req(s, `/api/invites/${onceInvite.token}/accept`, { method: 'POST', cookie })));
    assert.deepEqual(joins.map(r => r.status).sort(), [200, 403]); assert.equal(lookup(data, 'SELECT uses FROM invites WHERE id=?', onceInvite.id).uses, 1);
    await check('disabled user', `${base}/members`, { cookie: 'dropit_session=disabled-session' }, 401, 'UNAUTHENTICATED');
    const key = 'k'.repeat(43);
    const room = await create('room', '/api/rooms', { deviceKey: key, code: 'ABCDEF', pin: '１２３４' }, alice, 'room'); const roomBase = `/api/rooms/${room.token}`;
    const roomId = room.token.split('.')[0]; bind(roomId, 'room-space-id');
    await check('reuse room', '/api/rooms', { method: 'POST', json: { deviceKey: key }, cookie: alice }, 200);
    await check('room info', roomBase, {}, 200);
    await check('code not capability', `/api/rooms/${room.code}`, {}, 404, 'NOT_FOUND');
    const enter = pin => ({ method: 'POST', json: { code: room.code, ...(pin ? { pin } : {}) } });
    await check('PIN required', '/api/rooms/enter', enter(), 401, 'PIN_REQUIRED');
    await check('wrong PIN', '/api/rooms/enter', enter('wrong'), 403, 'PIN_INVALID');
    await check('lock threshold', '/api/rooms/enter', enter('wrong'), 429, 'RATE_LIMITED');
    await check('correct PIN locked', '/api/rooms/enter', enter('1234'), 429, 'RATE_LIMITED');
    await check('locked room metadata', '/api/admin/rooms', { cookie: alice }, 200);
    await check('admin unlock', `/api/admin/rooms/${roomId}/unlock`, { method: 'POST', cookie: alice }, 204);
    await check('normalized PIN', '/api/rooms/enter', enter('1234'), 200);
    await check('remove PIN', `${roomBase}/code`, { method: 'PUT', json: { deviceKey: key, pin: '' } }, 200);
    await check('random code', `${roomBase}/code`, { method: 'PUT', json: { deviceKey: key, code: '' } }, 200, null, 'new-code');
    await check('old code invalid', '/api/rooms/enter', { method: 'POST', json: { code: 'ABCDEF' } }, 404, 'NOT_FOUND');
    await check('custom change', `${roomBase}/code`, { method: 'PUT', json: { deviceKey: key, code: 'ABC123' } }, 200);
    await check('wrong owner key', `${roomBase}/code`, { method: 'PUT', json: { deviceKey: 'x'.repeat(43), code: 'ABC321' } }, 403, 'FORBIDDEN');
    const roomSocket = await connect(s, `${roomBase}/ws`); assert.equal((await roomSocket.next()).type, 'snapshot'); await roomSocket.next();
    const roomItem = (await create('room text', `${roomBase}/items/text`, { text: 'room secret', group: '房间分组' })).item;
    assert.deepEqual(await roomSocket.next(), { type: 'groups', groups: ['房间分组'] });
    const event = await roomSocket.next(); assert.equal(event.type,'item.created'); assert.equal(event.item.id, roomItem.id);
    const roomFile = (await check('room file', `${roomBase}/items/file`, { method: 'POST', body: 'room bytes', headers: { 'content-type': 'text/plain', 'x-file-name': 'room.txt' } }, 201)).item;
    await check('room file Range', `${roomBase}/items/${roomFile.id}/download`, { headers: { range: 'bytes=1-3' } }, 206);
    const png=await sharp({create:{width:32,height:16,channels:3,background:'red'}}).png().toBuffer();
    const image=expect(await req(s,`${roomBase}/items/file`,{method:'POST',headers:{'content-type':'image/png','x-file-name':'image.png'},body:png}),201).item;
    const imageShare=expect(await req(s,`${roomBase}/items/${image.id}/shares`,{method:'POST',json:{expiresIn:'never',maxViews:1}}),201);
    const imageView=expect(await req(s,`/api/s/${imageShare.token}`),200);
    for(const path of [`${roomBase}/items/${image.id}/thumbnail`,`${roomBase}/items/${image.id}/preview`,`/api/s/${imageShare.token}/thumbnail?access=${imageView.access}`,`/api/s/${imageShare.token}/preview?access=${imageView.access}`]) {
      const response=await req(s,path); expect(response,200); assert.equal(response.headers.get('content-type'),'image/webp');
      const dimensions=await sharp(response.bytes).metadata(); assert.equal(dimensions.width,32); assert.equal(dimensions.height,16);
      if(path.startsWith('/api/s/')) assert.equal(response.headers.get('cache-control'),'no-store');
    }
    const roomPat = await create('room PAT', '/api/tokens', { name: 'room socket', scopes: ['read', 'write'] }, alice);
    const patSocket = await connect(s, `${roomBase}/ws`, undefined, roomPat.token); await patSocket.next();
    const patClosed = closed(patSocket.ws);
    await check('revoke room PAT', `/api/tokens/${roomPat.id}`, { method: 'DELETE', cookie: alice }, 204); await patClosed;
    const roomShare = await create('room share', `${roomBase}/items/${roomItem.id}/shares`, { expiresIn: '1d', maxViews: 2 }, alice);
    await check('open room share', `/api/s/${roomShare.token}`, {}, 200, null, 'room-open');
    const roomClosed = closed(roomSocket.ws);
    await check('close room', `/api/admin/rooms/${roomId}/close`, { method: 'POST', cookie: alice }, 204); await roomClosed;
    await check('closed room', roomBase, {}, 404, 'NOT_FOUND');
    await check('restore room', `/api/admin/rooms/${roomId}/reopen`, { method: 'POST', cookie: alice }, 204);
    await check('restored room', roomBase, {}, 200);
    await check('revoke room share', `${roomBase}/shares/${roomShare.id}`, { method: 'DELETE' }, 204);
    await check('revoked room share', `/api/s/${roomShare.token}`, {}, 404, 'NOT_FOUND');
    const expiringSocket = await connect(s, `${roomBase}/ws`); await expiringSocket.next();
    const expiresClosed = closed(expiringSocket.ws);
    sql(data, 'UPDATE spaces SET expiresAt=1 WHERE id=?', roomId);
    await check('expired room', roomBase, {}, 404, 'NOT_FOUND'); await expiresClosed;
    await check('expired code', '/api/rooms/enter', { method: 'POST', json: { code: 'ABC123' } }, 404, 'NOT_FOUND');
    const replacement=await create('reclaim expired binding', '/api/rooms', { deviceKey: key, code: 'ABC123' }, undefined, 'replacement');
    await check('admin delete room', `/api/admin/rooms/${replacement.token.split('.')[0]}`, { method:'DELETE',cookie:alice },204);
    await check('deleted room', `/api/rooms/${replacement.token}`, {},404,'NOT_FOUND');
    const item = (await create('private text', `${base}/items/text`, { text: 'shared\n   text' }, alice)).item;
    const share = await create('share', `${base}/items/${item.id}/shares`, { expiresIn: 'never', maxViews: 1 }, alice);
    const opened = await check('open share', `/api/s/${share.token}`, {}, 200, null, 'opened');
    await check('exhausted', `/api/s/${share.token}`, {}, 404, 'NOT_FOUND');
    await check('exhausted copy', `/api/shares/${share.id}/link`, { cookie: alice }, 404, 'NOT_FOUND');
    const empty = { hours: [], days: [], months: [], views: [] };
    await check('presets signed out', '/api/me/share-presets', {}, 401, 'UNAUTHENTICATED');
    await check('presets put signed out', '/api/me/share-presets', { method: 'PUT', json: { days: [], views: [] } }, 401, 'UNAUTHENTICATED');
    await check('presets empty', '/api/me/share-presets', { cookie: alice }, 200);
    sql(data, 'INSERT INTO app_settings (key,value,updatedAt,updatedBy) VALUES (?,?,?,?)', `sharePresets:${m.alice.id}`, JSON.stringify({ days: [14], views: [50] }), Date.now(), m.alice.id);
    await check('legacy presets', '/api/me/share-presets', { cookie: alice }, 200);
    const expected = { hours: [2, 6], days: [3, 30], months: [1, 2], views: [20, 200] };
    await check('save presets', '/api/me/share-presets', { method: 'PUT', cookie: alice, json: { hours: [6, 2, 6], days: [30, 3, 30], months: [2, 1, 2], views: [200, 20, 200] } }, 200);
    assert.deepEqual(JSON.parse(lookup(data, 'SELECT value FROM app_settings WHERE key=?', `sharePresets:${m.alice.id}`).value), expected);
    await check('member presets isolated', '/api/me/share-presets', { cookie: bob }, 200);
    await check('member save presets', '/api/me/share-presets', { method: 'PUT', cookie: bob, json: { days: [14], views: [50] } }, 200);
    await check('owner presets unchanged', '/api/me/share-presets', { cookie: alice }, 200);
    await check('viewer presets empty', '/api/me/share-presets', { cookie: viewer }, 200);
    for (const invalid of [
      {}, { days: '3', views: [] }, { days: [0], views: [] }, { days: [3651], views: [] },
      { days: [1.5], views: [] }, { days: ['3'], views: [] }, { days: [], views: [-1] },
      { days: [], views: [1000001] }, { days: [], views: [2.5] }, { days: Array(21).fill(2), views: [] },
      { ...empty, hours: [87601] }, { ...empty, hours: [0] }, { ...empty, hours: [1.5] },
      { ...empty, months: [122] }, { ...empty, months: [-1] }, { ...empty, months: [1.5] },
      { ...empty, hours: null }, { ...empty, months: '1' },
      { ...empty, hours: Array.from({ length: 10 }, (_, i) => i + 2), days: Array.from({ length: 10 }, (_, i) => i + 2), months: [2] },
    ]) await check('invalid presets', '/api/me/share-presets', { method: 'PUT', cookie: alice, json: invalid }, 400, 'INVALID_INPUT');
    await check('presets unchanged after invalid', '/api/me/share-presets', { cookie: alice }, 200);
    if (kind === 'rust') {
      // RHEA-270: read-scoped PAT may read share presets; writes and managed shares require account scope.
      expect(await req(s, '/api/me/share-presets', { token: m.pat }), 200);
      expect(await req(s, '/api/me/share-presets', { method: 'PUT', token: m.pat, json: empty }), 403, 'INSUFFICIENT_SCOPE');
    } else {
      expect(await req(s, '/api/me/share-presets', { token: m.pat }), 403, 'BROWSER_SESSION_REQUIRED');
      expect(await req(s, '/api/me/share-presets', { method: 'PUT', token: m.pat, json: empty }), 403, 'BROWSER_SESSION_REQUIRED');
    }
    await check('clear presets', '/api/me/share-presets', { method: 'PUT', cookie: alice, json: { days: [], views: [] } }, 200);
    await check('presets cleared', '/api/me/share-presets', { cookie: alice }, 200);
    const rawPresets = [
      ['decimal integer', '{"hours":[2.0],"days":[1.0],"months":[1.0],"views":[20.0]}', { hours: [2], days: [1], months: [1], views: [20] }],
      ['exponent integer', '{"hours":[2e0],"days":[1e0],"months":[1e0],"views":[2e1]}', { hours: [2], days: [1], months: [1], views: [20] }],
      ['rounded integer', '{"hours":[],"days":[1.0000000000000001],"months":[],"views":[20]}', { hours: [], days: [1], months: [], views: [20] }],
      ['fraction', '{"hours":[1.5],"days":[],"months":[],"views":[]}', null],
      ['unsafe integer', '{"hours":[],"days":[],"months":[],"views":[9007199254740992]}', null],
    ];
    for (const [label, body, saved] of rawPresets) {
      const result = await req(s, '/api/me/share-presets', { method: 'PUT', cookie: alice, body, headers: { 'content-type': 'application/json' } });
      expect(result, saved ? 200 : 400, saved ? undefined : 'INVALID_INPUT');
      if (saved) assert.deepEqual(result.body, saved, label);
      transcript.push([label, result.status, normalize(result.body), result.headers.get('cache-control'), result.headers.get('content-type')]);
    }
    const shareScopeCode = kind === 'rust' ? 'INSUFFICIENT_SCOPE' : 'BROWSER_SESSION_REQUIRED';
    expect(await req(s, '/api/shares', { token: m.pat }), 403, shareScopeCode);
    expect(await req(s, `/api/shares/${share.id}/revoke`, { method: 'POST', token: m.pat }), 403, shareScopeCode);
    expect(await req(s, `/api/shares/${share.id}`, { method: 'DELETE', token: m.pat }), 403, shareScopeCode);
    await check('invalid cursor', '/api/shares?cursor=invalid', { cookie: alice }, 400, 'INVALID_INPUT');
    const expiring = await create('expiring share', `${base}/items/${item.id}/shares`, { expiresIn: '1h' }, alice);
    sql(data, 'UPDATE shares SET expiresAt=1 WHERE id=?', expiring.id);
    await check('expired share', `/api/s/${expiring.token}`, {}, 404, 'NOT_FOUND');
    const file = (await check('file upload', `${base}/items/file`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-file-name': 'test.txt' }, cookie: alice, body: '0123456789' }, 201)).item;
    const fs = await create('file share', `${base}/items/${file.id}/shares`, { expiresIn: 'never', maxViews: 1 }, alice);
    await check('file copy', `/api/shares/${fs.id}/link`, { cookie: alice }, 200);
    await check('foreign copy', `/api/shares/${fs.id}/link`, { cookie: bob }, 404, 'NOT_FOUND');
    const direct = await req(s, `/d/${fs.token}`, { headers: { range: 'bytes=0-1' } }); expect(direct, 206); assert.equal(direct.body, '01');
    const access = direct.headers.get('x-share-access'); assert.ok(access); assert.equal(direct.headers.get('content-location'), `/api/s/${fs.token}/file?access=${access}`);
    await check('ticket range', `/api/s/${fs.token}/file?access=${access}`, { headers: { range: 'bytes=2-4' } }, 206);
    await check('wrong ticket exhausted', `/api/s/${fs.token}/file?access=wrong`, {}, 404, 'NOT_FOUND');
    sql(data, 'UPDATE shares SET downloadTicketExpiresAt=1 WHERE id=?', fs.id);
    await check('expired ticket exhausted', `/api/s/${fs.token}/file?access=${access}`, {}, 404, 'NOT_FOUND');
    const live = await create('copyable share', `${base}/items/${item.id}/shares`, { expiresIn: 'never' }, alice);
    await check('history', '/api/shares', { cookie: alice }, 200);
    await check('revoke', `/api/shares/${live.id}/revoke`, { method: 'POST', cookie: alice }, 204);
    await check('revoked link', `/api/s/${live.token}`, {}, 404, 'NOT_FOUND');
    await check('purge revoked', `/api/shares/${live.id}`, { method: 'DELETE', cookie: alice }, 204);
    await check('source retract', `${base}/items/${item.id}`, { method: 'DELETE', cookie: alice }, 204);
    await check('missing source copy', `/api/shares/${share.id}/link`, { cookie: alice }, 404, 'NOT_FOUND');
    await check('missing source', `/api/s/${share.token}/file?access=${opened.access}`, {}, 404, 'NOT_FOUND');
    const race = await create('concurrent share', `${base}/items/${file.id}/shares`, { expiresIn: 'never', maxViews: 1 }, alice);
    const visits = await Promise.all([1, 2].map(() => req(s, `/api/s/${race.token}`))); assert.deepEqual(visits.map(r => r.status).sort(), [200, 404]);
    assert.equal(lookup(data, 'SELECT views FROM shares WHERE id=?', race.id).views, 1);
    console.log(`PASS ${kind}: ${transcript.length} space/room/share HTTP cases, concurrent views/invites and real WS revoke`);
    return transcript;
  } finally { for (const ws of sockets) ws.terminate(); sockets.clear(); await stop(s); }
}
async function interop(creator, reader, seed, m) {
  const data = resolve(temp, `${creator}-to-${reader}`); await cp(seed, data, { recursive: true }); let s = await start(creator, data);
  try {
    const cookie = await login(s, 'alice@example.test');
    const room = expect(await req(s, '/api/rooms', { method: 'POST', json: { deviceKey: 'z'.repeat(43), code: 'InterOp', pin: '1234' } }), 201);
    const item = expect(await req(s, `/api/spaces/${m.aliceSpace}/items/text`, { method: 'POST', cookie, json: { text: 'cross implementation' } }), 201).item;
    const share = expect(await req(s, `/api/spaces/${m.aliceSpace}/items/${item.id}/shares`, { method: 'POST', cookie, json: { expiresIn: 'never' } }), 201);
    const inv = expect(await req(s, `/api/spaces/${m.aliceSpace}/invites`, { method: 'POST', cookie, json: { role: 'editor' } }), 201);
    const presets = { hours: [2], days: [14], months: [1], views: [20] };
    expect(await req(s, '/api/me/share-presets', { method: 'PUT', cookie, json: presets }), 200);
    await stop(s); s = await start(reader, data);
    expect(await req(s, `/api/rooms/${room.token}`), 200);
    assert.equal(expect(await req(s, '/api/rooms/enter', { method: 'POST', json: { code: room.code, pin: '1234' } }), 200).token, room.token);
    assert.equal(expect(await req(s, `/api/s/${share.token}`), 200).item.text, 'cross implementation');
    assert.equal(expect(await req(s, `/api/shares/${share.id}/link`, { cookie }), 200).url, share.url);
    expect(await req(s, `/api/invites/${inv.token}/accept`, { method: 'POST', cookie: await login(s, 'bob@example.test') }), 200);
    assert.deepEqual(expect(await req(s, '/api/me/share-presets', { cookie }), 200), presets);
    console.log(`PASS ${creator} -> ${reader}: persisted room/PIN, share/copy token, cookie, invite, share presets`);
  } finally { await stop(s); }
}
async function rateCases(kind,seed) {
  const data=resolve(temp,`rate-${kind}`); await cp(seed,data,{recursive:true});
  let server=await start(kind,data,{RATE_AUTH:'2'});
  try {
    const room=expect(await req(server,'/api/rooms',{method:'POST',json:{code:'rate00'}}),201);
    for(let n=0;n<4;n++) expect(await req(server,'/api/rooms/enter',{method:'POST',json:{code:room.code}}),200);
    for(let n=0;n<2;n++) expect(await req(server,'/api/rooms/enter',{method:'POST',json:{code:'missing'}}),404,'NOT_FOUND');
    const blocked=await req(server,'/api/rooms/enter',{method:'POST',json:{code:room.code}}); expect(blocked,429,'RATE_LIMITED'); assert.ok(Number(blocked.headers.get('retry-after'))>0);
    for(let n=0;n<2;n++) expect(await req(server,'/api/s/noLink'),404,'NOT_FOUND');
    expect(await req(server,'/api/s/noLink'),429,'RATE_LIMITED');
  } finally {await stop(server);}
  for(const suffix of ['file','thumbnail','preview','media','direct']) {
    server=await start(kind,data,{RATE_AUTH:'2'});
    try {
      const path=suffix==='direct'?'/d/noLink':`/api/s/noLink/${suffix}`;
      for(let i=0;i<2;i++) expect(await req(server,path),404,'NOT_FOUND');
      expect(await req(server,path),429,'RATE_LIMITED');
    } finally {await stop(server);}
  }
  server=await start(kind,data,{RATE_AUTH:'2'});
  try {
    expect(await req(server,'/api/rooms',{method:'POST',json:{code:'taken0'}}),201);
    const key='r'.repeat(43);
    expect(await req(server,'/api/rooms',{method:'POST',json:{deviceKey:key,code:'owned0'}}),201);
    for(let n=0;n<2;n++) expect(await req(server,'/api/rooms',{method:'POST',json:{deviceKey:key,code:'taken0'}}),409,'CODE_TAKEN');
    expect(await req(server,'/api/rooms',{method:'POST',json:{deviceKey:key,code:'taken0'}}),429,'RATE_LIMITED');
  } finally {await stop(server);}
  server=await start(kind,data,{RATE_UPLOAD:'4',RATE_ROOM:'2'});
  try {
    const room=expect(await req(server,'/api/rooms',{method:'POST',json:{code:'rate01'}}),201);
    for(let n=0;n<4;n++) expect(await req(server,`/api/rooms/${room.token}`),200);
    expect(await req(server,`/api/rooms/${room.token}`),429,'RATE_LIMITED');
  } finally {await stop(server);}
  server=await start(kind,data,{RATE_UPLOAD:'3',RATE_ROOM:'2'});
  try {
    const cookie = await login(server, 'alice@example.test');
    for (let n = 0; n < 3; n++) expect(await req(server, '/api/me/share-presets', { method: 'PUT', cookie, json: { days: [], views: [] } }), 200);
    const limited = await req(server, '/api/me/share-presets', { method: 'PUT', cookie, json: { days: [1], views: [] } });
    expect(limited, 429, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.deepEqual(expect(await req(server, '/api/me/share-presets', { cookie }), 200), { hours: [], days: [], months: [], views: [] });
    console.log(`PASS ${kind}: success-free guessing, wrong guesses, public shares, room access and preset save rate limits`);
  } finally {await stop(server);}
}

try {
  reference = await prepare(); const seed = resolve(temp, 'seed'); const meta = await fixture(seed, { referenceRoot: reference });
  const { createHash } = await import('node:crypto'); meta.pat = 'P'.repeat(43);
  sql(seed, 'INSERT INTO access_tokens (id,tokenHash,userId,name,scopes,createdAt,revoked) VALUES (?,?,?,?,?,?,0)', 'fixture-pat', createHash('sha256').update(meta.pat).digest('base64url'), meta.alice.id, 'fixture', '["read","write"]', Date.now());
  sql(seed, 'INSERT INTO sessions (sessionHash,userId,expiresAt,id) VALUES (?,?,?,?)', createHash('sha256').update('disabled-session').digest('base64url'), meta.disabled.id, Date.now()+60000, 'disabled-session-id');
  const ts = await flow('ts', seed, meta); const actual = await flow('rust', seed, meta); assert.deepEqual(actual, ts);
  await rateCases('ts',seed); await rateCases('rust',seed);
  await interop('ts', 'rust', seed, meta); await interop('rust', 'ts', seed, meta);
  console.log(`PASS ${checks} real HTTP/WS checks against fixed TS ${baseline} and Rust`);
} finally { for (const ws of sockets) ws.terminate(); for (const child of processes) await stop({ child }); await rm(temp, { recursive: true, force: true }); }
