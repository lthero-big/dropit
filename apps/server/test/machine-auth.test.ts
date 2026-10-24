import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { hash, token, type AccessToken } from '../src/domain.js';
import { migration1, migration2, migration3, migration4, migration5 } from '../src/migrations.js';
import { SqliteRepository } from '../src/repository.js';

const origin = 'http://localhost:3000';
const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });
type CreatedToken = AccessToken & { token: string };
async function fixture(overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-machine-'));
  let time = Date.now();
  const backend = createBackend({ config: { ...loadConfig({}), origin, dataDir: directory, ...overrides },
    providers: {}, now: () => time, remoteAddress: c => c.req.header('x-test-ip') ?? '203.0.113.42' });
  function login(subject: string) {
    const raw = token();
    if (backend.repo.users().length) backend.repo.provisionUser({ email: `${subject}@example.com`, name: subject, role: 'user', quotaBytes: null, now: time });
    const user = backend.repo.login({ provider: 'mock', subject, email: `${subject}@example.com`, name: subject }, null, [], hash(raw), time + 86400000, time);
    return { user, cookie: `dropit_session=${raw}`, space: backend.repo.spaces(user.id)[0] };
  }
  const admin = login('admin');
  const member = login('member');
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => backend.app.request(path, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const browser = (path: string, method = 'GET', body?: unknown, cookie = member.cookie) => request(path, method, body, { cookie, origin });
  const pat = async (body: Record<string, unknown> = {}, cookie = member.cookie): Promise<CreatedToken> => {
    const response = await browser('/api/tokens', 'POST', { name: 'Test terminal', ...body }, cookie);
    assert.equal(response.status, 201);
    return response.json();
  };
  const device = async (body: Record<string, unknown> = {}) => {
    const response = await request('/api/auth/device/authorize', 'POST', { name: 'My laptop', ...body });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { ...backend, directory, admin, member, request, browser, pat, device, time: () => time,
    advance(ms: number) { time += ms; },
    async dispose() { await backend.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('AC-J1/J2/J7: one-time 256-bit PAT, hashes only, scopes, expiry, last use, metadata and ownership', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const readonly = await f.pat({ scopes: ['read'] });
  assert.equal(Buffer.from(readonly.token, 'base64url').length, 32);
  assert.equal(readonly.expiresAt, f.time() + 90 * 86400000);
  assert.equal(readonly.lastUsedAt, null);
  const forever = await f.pat({ expiresInDays: null });
  assert.equal(forever.expiresAt, null);
  const db = new Database(join(f.directory, 'dropit.sqlite'), { readonly: true });
  try {
    const rows = db.prepare('SELECT * FROM access_tokens').all() as { tokenHash: string }[];
    assert.equal(rows.find(row => row.tokenHash === hash(readonly.token))?.tokenHash, hash(readonly.token));
    assert(!JSON.stringify(rows).includes(readonly.token));
    assert(!JSON.stringify(rows).includes(forever.token));
  } finally { db.close(); }
  f.advance(10);
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(readonly.token))).status, 200);
  const listed = await (await f.browser('/api/tokens')).json();
  assert.equal(listed.tokens.find((entry: AccessToken) => entry.id === readonly.id).lastUsedAt, f.time());
  for (const entry of listed.tokens) { assert.equal(entry.token, undefined); assert.equal(entry.tokenHash, undefined); }
  assert.equal((await f.request(`/api/spaces/${f.member.space.id}/items/text`, 'POST', { text: 'blocked' }, bearer(readonly.token))).status, 403);
  assert.equal((await f.request('/api/rooms', 'POST', undefined, bearer(readonly.token))).status, 403);
  assert.equal((await f.browser(`/api/tokens/${readonly.id}`, 'PATCH', { name: 'Renamed terminal' })).status, 204);
  assert.equal((await (await f.browser('/api/tokens')).json()).tokens.find((entry: AccessToken) => entry.id === readonly.id).name, 'Renamed terminal');
  assert.equal((await f.browser(`/api/tokens/${readonly.id}`, 'DELETE', undefined, f.admin.cookie)).status, 404);
  assert.equal((await f.browser('/api/admin/tokens')).status, 403);
  const all = await (await f.browser('/api/admin/tokens', 'GET', undefined, f.admin.cookie)).json();
  assert.equal(all.tokens.length, 2);
  assert(!JSON.stringify(all).includes(forever.token));
  assert.equal((await (await f.browser(`/api/admin/tokens?userId=${f.admin.user.id}`, 'GET', undefined, f.admin.cookie)).json()).tokens.length, 0);
  assert.equal((await f.browser(`/api/admin/tokens/${readonly.id}`, 'DELETE', undefined, f.admin.cookie)).status, 204);
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(readonly.token))).status, 401);
  const expiring = await f.pat({ expiresInDays: 1 });
  f.advance(86400000);
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(expiring.token))).status, 401);
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(forever.token))).status, 200);
});

test('AC-J2: PAT input validation and write-only scope cannot read or mint credentials', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  for (const body of [{ name: '' }, { name: 'x'.repeat(81) }, { scopes: [] }, { scopes: null }, { scopes: ['admin'] },
    { scopes: ['read', 'read'] }, { expiresInDays: 0 }, { expiresInDays: 1.1 }, { expiresInDays: 3651 }]) {
    assert.equal((await f.browser('/api/tokens', 'POST', { name: 'test', ...body })).status, 400);
  }
  const write = await f.pat({ scopes: ['write'] });
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(write.token))).status, 403);
  assert.equal((await f.request('/api/tokens', 'POST', { name: 'escalation' }, bearer(write.token))).status, 403);
  assert.equal((await f.request('/api/auth/logout', 'POST', undefined, bearer(write.token))).status, 204);
  assert.equal((await f.request('/api/rooms', 'POST', undefined, bearer(write.token))).status, 401);
});

test('AC-J3: browser Origin regression; Bearer wins over a different cookie, invalid auth never falls back', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const pat = await f.pat();
  const path = `/api/spaces/${f.member.space.id}/items/text`;
  for (const untrusted of [undefined, '', 'null', 'https://evil.example', `${origin}.evil.example`]) {
    const headers: Record<string, string> = { cookie: f.member.cookie };
    if (untrusted !== undefined) headers.origin = untrusted;
    assert.equal((await f.request(path, 'POST', { text: 'cookie' }, headers)).status, 403);
    assert.equal((await f.request(path, 'POST', { text: 'machine' }, { ...headers, ...bearer(pat.token) })).status, 201);
  }
  assert.equal((await f.browser(path, 'POST', { text: 'browser' })).status, 201);
  const both = await f.request('/api/me', 'GET', undefined, { cookie: f.admin.cookie, ...bearer(pat.token) });
  assert.equal((await both.json()).user.id, f.member.user.id);
  assert.equal((await f.request(`/api/spaces/${f.admin.space.id}/items`, 'GET', undefined, { cookie: f.admin.cookie, ...bearer(pat.token) })).status, 404);
  for (const authorization of ['Bearer wrong', 'Bearer ' + token(), 'Basic value']) {
    assert.equal((await f.request('/api/me', 'GET', undefined, { cookie: f.admin.cookie, authorization })).status, 401);
    assert.equal((await f.request('/api/rooms', 'POST', undefined, { cookie: f.admin.cookie, origin, authorization })).status, 401);
  }
  assert.equal((await f.request(`/api/spaces/${f.member.space.id}/items?access_token=${pat.token}`)).status, 401);
  assert.equal((await f.request('/api/rooms', 'POST')).status, 403);
  assert.equal((await f.request('/api/auth/device/authorize', 'POST', { name: 'cookie' }, { cookie: f.member.cookie })).status, 403);
  assert.equal((await f.request('/api/auth/device/authorize', 'POST', { name: 'cross-site' }, { origin: 'https://evil.example' })).status, 403);
});

test('AC-J4: shared membership, quotas, write/account limits and independent per-token limits', async t => {
  const f = await fixture({ rateToken: 2 }); t.after(() => f.dispose());
  const one = await f.pat(); const two = await f.pat();
  for (let i = 0; i < 2; i++) assert.equal((await f.request('/api/me', 'GET', undefined, { ...bearer(one.token), 'x-test-ip': `192.0.2.${i}` })).status, 200);
  const limited = await f.request('/api/me', 'GET', undefined, { ...bearer(one.token), 'x-test-ip': '192.0.2.3' });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(two.token))).status, 200);
  assert.equal((await f.browser('/api/me')).status, 200);
  const q = await fixture({ rateUpload: 2, userQuotaBytes: 8 }); t.after(() => q.dispose());
  const q1 = await q.pat(); const q2 = await q.pat(); const path = `/api/spaces/${q.member.space.id}/items/text`;
  assert.equal((await q.request(path, 'POST', { text: '12345678' }, bearer(q1.token))).status, 201);
  assert.equal((await q.request(path, 'POST', { text: 'x' }, bearer(q2.token))).status, 413);
  assert.equal((await q.browser(path, 'POST', { text: 'x' })).status, 429);
  q.advance(60001);
  assert.equal((await q.request(path, 'POST', { text: 'x' }, { ...bearer(q1.token), 'x-test-ip': '192.0.2.1' })).status, 413);
  assert.equal((await q.request(path, 'POST', { text: 'x' }, { ...bearer(q2.token), 'x-test-ip': '192.0.2.2' })).status, 413);
  assert.equal((await q.request(path, 'POST', { text: 'x' }, { ...bearer(q1.token), 'x-test-ip': '192.0.2.3' })).status, 429);
  assert.equal((await q.request(`/api/spaces/${q.admin.space.id}/items`, 'GET', undefined, bearer(q1.token))).status, 404);
  assert.equal((await q.browser(`/api/admin/users/${q.member.user.id}`, 'PATCH', { disabled: true }, q.admin.cookie)).status, 204);
  assert.equal((await q.request('/api/me', 'GET', undefined, bearer(q1.token))).status, 401);
  assert.equal((await q.browser(`/api/admin/users/${q.member.user.id}`, 'PATCH', { disabled: false }, q.admin.cookie)).status, 204);
  assert.equal((await q.request('/api/me', 'GET', undefined, bearer(q2.token))).status, 401);
  const invalid = await fixture({ rateGeneral: 2 }); t.after(() => invalid.dispose());
  for (let i = 0; i < 2; i++) assert.equal((await invalid.request('/api/me', 'GET', undefined, bearer(token()))).status, 401);
  assert.equal((await invalid.request('/api/me', 'GET', undefined, bearer(token()))).status, 429);
});

test('AC-J5/J6: device approval issues one PAT atomically; CLI secret, interval and slow_down', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const d = await f.device({ scopes: ['read'], expiresInDays: null });
  assert.equal(Buffer.from(d.device_code, 'base64url').length, 32);
  assert.match(d.user_code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(d.expires_in, 600); assert.equal(d.interval, 5);
  assert(!d.verification_uri_complete.includes(d.device_code));
  const poll = () => f.request('/api/auth/device/token', 'POST', { device_code: d.device_code });
  f.advance(5000);
  assert.equal((await (await poll()).json()).error, 'authorization_pending');
  assert.deepEqual(await (await poll()).json(), { error: 'slow_down', interval: 10 });
  const query = new URLSearchParams({ user_code: d.user_code, verification_id: d.verification_id });
  const info = await f.browser(`/api/auth/device?${query}`);
  assert.equal(info.status, 200);
  assert.deepEqual(await info.json(), { name: 'My laptop', ipSummary: '203.0.113.0/24', scopes: ['read'],
    expiresAt: f.time() + 595000, tokenExpiresInDays: null });
  assert.equal((await f.browser('/api/auth/device/approve', 'POST', Object.fromEntries(query))).status, 204);
  assert.equal((await f.browser('/api/auth/device/approve', 'POST', Object.fromEntries(query))).status, 404);
  f.advance(10000);
  const results = await Promise.all([poll(), poll()]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  const issued = await results.find(result => result.status === 200)!.json();
  assert.equal(issued.token_type, 'Bearer'); assert.equal(issued.scope, 'read'); assert.equal(issued.expires_in, null);
  assert.equal(issued.token.userId, f.member.user.id);
  assert.equal(issued.token.name, 'My laptop');
  assert.equal(issued.token.token, undefined); assert.equal(issued.token.tokenHash, undefined);
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(issued.access_token))).status, 200);
  assert.equal((await (await poll()).json()).error, 'expired_token');
  assert.equal(f.repo.accessTokens().length, 1);
  assert.equal((await (await f.request('/api/auth/device/token', 'POST', { device_code: d.user_code })).json()).error, 'expired_token');
  const db = new Database(join(f.directory, 'dropit.sqlite'), { readonly: true });
  try {
    const stored = JSON.stringify(db.prepare('SELECT * FROM device_authorizations').all());
    assert(!stored.includes(d.device_code)); assert(!stored.includes(d.user_code.replace('-', '')));
    assert(!stored.includes(issued.access_token));
  } finally { db.close(); }
});

test('AC-J1: machine authentication failures never log raw secrets, including storage failures', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const p = await f.pat(); const d = await f.device();
  const logs: string[] = [];
  const originalLog = console.error;
  const originalSave = f.repo.createAccessToken;
  console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    f.repo.createAccessToken = () => { throw new Error(`${p.token} ${d.device_code}`); };
    assert.equal((await f.browser('/api/tokens', 'POST', { name: 'storage failure' })).status, 500);
    assert.equal((await f.request('/api/me', 'GET', undefined, bearer(token()))).status, 401);
  } finally { console.error = originalLog; f.repo.createAccessToken = originalSave; }
  assert(logs.length > 0);
  assert(!logs.join('\n').includes(p.token));
  assert(!logs.join('\n').includes(d.device_code));
});

test('AC-J5/J6: device denial, expiry, browser-only CSRF and five wrong-code attempts invalidate a flow', async t => {
  const f = await fixture({ rateWindowMs: 1000 }); t.after(() => f.dispose());
  const d = await f.device();
  const body = { user_code: d.user_code, verification_id: d.verification_id };
  assert.equal((await f.request('/api/auth/device/approve', 'POST', body, { origin })).status, 401);
  for (const untrusted of [undefined, 'null', 'https://evil.example']) {
    assert.equal((await f.request('/api/auth/device/approve', 'POST', body, { cookie: f.member.cookie, ...(untrusted ? { origin: untrusted } : {}) })).status, 403);
  }
  const p = await f.pat();
  assert.equal((await f.request('/api/auth/device/approve', 'POST', body, { cookie: f.member.cookie, ...bearer(p.token) })).status, 403);
  assert.equal((await f.browser('/api/auth/device/deny', 'POST', body)).status, 204);
  assert.equal((await (await f.request('/api/auth/device/token', 'POST', { device_code: d.device_code })).json()).error, 'access_denied');
  f.advance(1001);
  const expiring = await f.device();
  f.advance(600000);
  assert.equal((await f.browser('/api/auth/device/approve', 'POST', { user_code: expiring.user_code })).status, 404);
  assert.equal((await (await f.request('/api/auth/device/token', 'POST', { device_code: expiring.device_code })).json()).error, 'expired_token');
  const invalidated = await f.device();
  for (let i = 0; i < 5; i++) {
    f.advance(1001);
    assert.equal((await f.browser('/api/auth/device/approve', 'POST', { user_code: 'ZZZZ-ZZZZ', verification_id: invalidated.verification_id })).status, 404);
  }
  f.advance(1001);
  assert.equal((await f.browser('/api/auth/device/approve', 'POST', { user_code: invalidated.user_code, verification_id: invalidated.verification_id })).status, 404);
  assert.equal((await (await f.request('/api/auth/device/token', 'POST', { device_code: invalidated.device_code })).json()).error, 'access_denied');
  assert.equal(f.repo.accessTokens().length, 1, 'unapproved flows must not create tokens');
});

async function connect(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const messages: any[] = [];
  const waiting: ((message: any) => void)[] = [];
  ws.on('message', raw => { const data = JSON.parse(raw.toString()); const resolve = waiting.shift(); if (resolve) resolve(data); else messages.push(data); });
  await once(ws, 'open');
  return { ws, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket timed out')), 2000);
    waiting.push(data => { clearTimeout(timeout); resolve(data); });
  }) };
}

test('AC-J4/J8: actual Bearer WS, cookie Origin regression, revocation, disable and expiry close 1008', { timeout: 15000 }, async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0, websocket: f.websocket }) as Server;
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/api/spaces/${f.member.space.id}/ws`;
  await assert.rejects(connect(url, { cookie: f.member.cookie }), /403/);
  await assert.rejects(connect(url, { cookie: f.member.cookie, origin: 'https://evil.example' }), /403/);
  await assert.rejects(connect(url, { cookie: f.member.cookie, ...bearer(token()) }), /401/);
  const cookieWs = await connect(url, { cookie: f.member.cookie, origin });
  t.after(() => cookieWs.ws.terminate());
  assert.equal((await cookieWs.next()).type, 'snapshot');
  const p = await f.pat({ scopes: ['read'] });
  const privateSockets: WebSocket[] = [];
  for (const headers of [bearer(p.token), { ...bearer(p.token), origin: 'https://evil.example', cookie: f.admin.cookie }]) {
    const socket = await connect(url, headers); t.after(() => socket.ws.terminate());
    privateSockets.push(socket.ws);
    assert.equal((await socket.next()).type, 'snapshot');
  }
  const room = await (await f.browser('/api/rooms', 'POST')).json();
  const roomUrl = `ws://127.0.0.1:${address.port}/api/rooms/${room.token}/ws`;
  const roomWs = await connect(roomUrl, bearer(p.token)); t.after(() => roomWs.ws.terminate());
  assert.equal((await roomWs.next()).type, 'snapshot');
  const roomClosed = once(roomWs.ws, 'close');
  const privateClosed = privateSockets.map(socket => once(socket, 'close'));
  assert.equal((await f.browser(`/api/tokens/${p.id}`, 'DELETE')).status, 204);
  assert.equal((await roomClosed)[0], 1008);
  for (const closed of await Promise.all(privateClosed)) assert.equal(closed[0], 1008);
  await assert.rejects(connect(url, bearer(p.token)), /401/);
  const write = await f.pat({ scopes: ['write'] });
  await assert.rejects(connect(url, bearer(write.token)), /403/);
  const expiring = await f.pat({ expiresInDays: 1 });
  const expWs = await connect(url, bearer(expiring.token)); t.after(() => expWs.ws.terminate());
  const expClosed = once(expWs.ws, 'close');
  f.advance(86400001); f.events.revalidate();
  assert.equal((await expClosed)[0], 1008);
  // Use the still-live administrator session to disable a newly connected member token.
  f.advance(-86400001);
  const disable = await f.pat();
  const disableWs = await connect(url, bearer(disable.token)); t.after(() => disableWs.ws.terminate());
  const disableClosed = once(disableWs.ws, 'close');
  assert.equal((await f.browser(`/api/admin/users/${f.member.user.id}`, 'PATCH', { disabled: true }, f.admin.cookie)).status, 204);
  assert.equal((await disableClosed)[0], 1008);
});

test('AC-K1: member/room downloads support bounded, open, suffix and unsatisfiable ranges with safe headers', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const p = await f.pat();
  const room = await (await f.request('/api/rooms', 'POST', undefined, bearer(p.token))).json();
  for (const base of [`/api/spaces/${f.member.space.id}`, `/api/rooms/${room.token}`]) {
    const response = await f.app.request(`${base}/items/file`, { method: 'POST', headers: { ...bearer(p.token), 'x-file-name': encodeURIComponent('测试.html') }, body: '0123456789' });
    assert.equal(response.status, 201);
    const { item } = await response.json();
    const path = `${base}/items/${item.id}/download`;
    for (const [range, expected, status, contentRange] of [
      [undefined, '0123456789', 200, null], ['bytes=2-5', '2345', 206, 'bytes 2-5/10'],
      ['bytes=7-', '789', 206, 'bytes 7-9/10'], ['bytes=-3', '789', 206, 'bytes 7-9/10'],
      ['bytes=8-99', '89', 206, 'bytes 8-9/10'], ['bytes=10-', '', 416, 'bytes */10'],
      ['bytes=5-2', '', 416, 'bytes */10'], ['bytes=0-1,4-5', '0123456789', 200, null],
    ] as const) {
      const download = await f.request(path, 'GET', undefined, { ...bearer(p.token), ...(range ? { range } : {}) });
      assert.equal(download.status, status);
      assert.equal(download.headers.get('accept-ranges'), 'bytes');
      assert.equal(download.headers.get('content-range'), contentRange);
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.match(download.headers.get('content-disposition')!, /^attachment;/);
      assert.equal(await download.text(), expected);
    }
    const head = await f.request(path, 'HEAD', undefined, { ...bearer(p.token), range: 'bytes=0-1' });
    assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '2'); assert.equal(await head.text(), '');
    assert.equal((await f.browser(`/api/spaces/${f.admin.space.id}/items/${item.id}/download`, 'GET', undefined, f.admin.cookie)).status, 404);
  }
});

test('AC-K1: one-time public download ranges reuse one ticket and spend exactly one view', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const response = await f.app.request(`/api/spaces/${f.member.space.id}/items/file`, { method: 'POST', headers: { origin, cookie: f.member.cookie }, body: '0123456789' });
  const { item } = await response.json();
  const base = `/api/spaces/${f.member.space.id}`;
  for (const direct of [false, true]) {
    const share = await (await f.browser(`${base}/items/${item.id}/shares`, 'POST', { expiresIn: '1h', maxViews: 1 })).json();
    const path = `/api/s/${share.token}/file`;
    let access: string;
    if (direct) {
      const initial = await f.request(path, 'GET', undefined, { range: 'bytes=0-2' });
      assert.equal(initial.status, 206); assert.equal(await initial.text(), '012');
      access = initial.headers.get('x-share-access')!; assert(access);
      assert.equal(initial.headers.get('content-location'), `${path}?access=${access}`);
    } else access = (await (await f.request(`/api/s/${share.token}`)).json()).access;
    for (const range of ['bytes=3-5', 'bytes=6-', 'bytes=20-']) {
      const download = await f.request(`${path}?access=${access}`, 'GET', undefined, { range });
      assert.equal(download.status, range === 'bytes=20-' ? 416 : 206);
      assert.equal(download.headers.get('accept-ranges'), 'bytes');
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.match(download.headers.get('content-disposition')!, /^attachment;/);
      await download.arrayBuffer();
    }
    assert.equal(f.repo.sharesForItem(item.id).find(s => s.id === share.id)?.views, 1);
    assert.equal((await f.request(path)).status, 404);
    f.advance(600001);
    assert.equal((await f.request(`${path}?access=${access}`)).status, 404);
  }
});

test('schema v5 upgrades to machine auth without losing users, cookies or clips; secrets stay out of SQLite bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-migrate6-')); const path = join(directory, 'dropit.sqlite');
  const db = new Database(path);
  for (const migration of [migration1, migration2, migration3, migration4, migration5]) db.exec(migration);
  db.prepare('INSERT INTO users (id,email,name,role,createdAt) VALUES (?,?,?,?,?)').run('u', 'old@example.com', 'Old', 'user', 1);
  db.prepare('INSERT INTO spaces (id,name,ownerId) VALUES (?,?,?)').run('s', 'Old space', 'u');
  db.prepare('INSERT INTO members VALUES (?,?)').run('s', 'u');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash('existing-cookie'), 'u', 999999);
  db.prepare("INSERT INTO items (id,spaceId,userId,kind,text,size,storedBytes,createdAt,expiresAt) VALUES ('i','s','u','text','kept',4,4,1,999999)").run();
  db.close();
  const repo = new SqliteRepository(path);
  t.after(async () => { repo.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(repo.session(hash('existing-cookie'), 2)?.user.email, 'old@example.com');
  assert.equal(repo.item('i', 2)?.text, 'kept');
  const raw = token();
  repo.createAccessToken({ id: 't', userId: 'u', name: 'Terminal', scopes: ['read'], createdAt: 2, lastUsedAt: null, expiresAt: null, revoked: 0 }, hash(raw));
  assert.equal(repo.tokenSession(hash(raw), 3)?.user.id, 'u');
  assert(!(await readFile(path)).includes(Buffer.from(raw)));
  assert(!(await readFile(`${path}-wal`)).includes(Buffer.from(raw)));
});
