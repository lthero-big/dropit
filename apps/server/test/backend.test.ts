import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import sharp from 'sharp';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { hash, type Identity } from '../src/domain.js';
import type { OAuthProvider } from '../src/oauth.js';

const origin = 'http://localhost:3000';
const cookieValue = (response: Response, name: string) => response.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(';')[0] ?? '';

async function fixture(overrides: Partial<Config> = {}, providerName = 'github') {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-'));
  let time = Date.now();
  const challenges = new Map<string, string>();
  const identities = new Map<string, Identity>();
  let exchanges = 0;
  const provider: OAuthProvider = {
    authorizationUrl(state, challenge, redirect) {
      challenges.set(state, challenge);
      return `https://mock.example/authorize?${new URLSearchParams({ state, code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: redirect })}`;
    },
    async exchange(code, verifier) {
      exchanges++;
      assert([...challenges.values()].includes(hash(verifier)), 'PKCE verifier must match the authorization challenge');
      if (code === 'fail') throw new Error('Mock provider refused code');
      return identities.get(code)!;
    },
  };
  const config = { ...loadConfig({}), dataDir: directory, ...overrides };
  const backend = createBackend({ config, providers: { [providerName]: provider }, now: () => time,
    remoteAddress: c => c.req.header('x-test-ip') ?? '127.0.0.1' });
  const request = (path: string, init: RequestInit = {}, cookie = '') => backend.app.request(path, {
    ...init, headers: { origin, ...(cookie ? { cookie } : {}), ...init.headers },
  });
  const json = (path: string, body: unknown, cookie = '', method = 'POST') => request(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, cookie);
  const start = async (invite?: string) => {
    const response = await request(`/api/auth/${providerName}${invite ? `?invite=${invite}` : ''}`);
    assert.equal(response.status, 302);
    const url = new URL(response.headers.get('location')!);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge')?.length, 43);
    return { state: url.searchParams.get('state')!, browser: cookieValue(response, 'dropit_oauth'), response };
  };
  const finish = async (flow: Awaited<ReturnType<typeof start>>, subject: string) => {
    identities.set(subject, { provider: providerName, subject, email: `${subject}@example.com`, name: subject });
    return request(`/api/auth/${providerName}/callback?${new URLSearchParams({ state: flow.state, code: subject })}`, {}, flow.browser);
  };
  const login = async (subject: string, invite?: string) => {
    const response = await finish(await start(invite), subject);
    return { response, cookie: cookieValue(response, 'dropit_session') };
  };
  const admin = async () => {
    const auth = await login('admin');
    assert.equal(auth.response.status, 302);
    const me = await (await request('/api/me', {}, auth.cookie)).json();
    const { spaces } = await (await request('/api/spaces', {}, auth.cookie)).json();
    return { ...auth, user: me.user, space: spaces[0] };
  };
  const invite = async (cookie: string, spaceId: string, maxUses = 1) => {
    const response = await json('/api/admin/invites', { spaceId, maxUses }, cookie);
    assert.equal(response.status, 201);
    return response.json();
  };
  const upload = (base: string, cookie: string, bytes: Uint8Array | string, mime = 'application/octet-stream', filename = 'test.bin') =>
    request(`${base}/items/file`, { method: 'POST', headers: { 'content-type': mime, 'x-file-name': encodeURIComponent(filename) }, body: bytes }, cookie);
  return { ...backend, request, json, start, finish, login, admin, invite, upload, directory,
    exchanges: () => exchanges, advance: (ms: number) => { time += ms; },
    async dispose() { await backend.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('A1/B2: state and browser binding, PKCE, replay and failed exchange cannot create accounts', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const flow = await f.start();
  for (const [query, cookie] of [
    ['code=admin', flow.browser], [`state=wrong&code=admin`, flow.browser],
    [`state=${flow.state}&code=admin`, 'dropit_oauth=another-browser'],
  ]) assert.equal((await f.request(`/api/auth/github/callback?${query}`, {}, cookie)).status, 400);
  assert.equal(f.exchanges(), 0);
  assert.equal(f.repo.users().length, 0);
  const denied = await f.request(`/api/auth/github/callback?state=${flow.state}&error=access_denied`, {}, flow.browser);
  assert.equal(denied.status, 400);
  assert.equal(f.repo.users().length, 0);
  const successful = await f.login('admin');
  assert.equal(successful.response.status, 302);
  assert.match(successful.response.headers.getSetCookie().join(';'), /HttpOnly/);
  assert.match(successful.response.headers.getSetCookie().join(';'), /SameSite=Lax/);
  assert.equal((await f.finish(flow, 'admin')).status, 400);
  assert.equal(f.repo.users().length, 1);
  assert.equal((await f.request('/api/auth/password')).status, 404);
});

test('A1: OAuth flow expiry is enforced before token exchange', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const flow = await f.start(); f.advance(600001);
  assert.equal((await f.finish(flow, 'admin')).status, 400);
  assert.equal(f.exchanges(), 0);
});

test('B2: failed provider exchange never consumes invitation or creates an account', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id);
  const flow = await f.start(invite.token);
  const response = await f.request(`/api/auth/github/callback?state=${flow.state}&code=fail`, {}, flow.browser);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR' } });
  assert.equal(f.repo.users().length, 1);
  assert.equal(f.repo.invite(hash(invite.token), Date.now())?.uses, 0);
  assert.equal((await f.login('member', invite.token)).response.status, 302);
  assert.equal((await f.request('/api/auth/toString')).status, 404);
});

test('A3/B3: bootstrap admin, invite-only signup, verified ADMIN_EMAILS and independent provider identities', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  assert.equal(admin.user.role, 'admin');
  assert.equal((await f.login('stranger')).response.status, 403);
  assert.equal(f.repo.users().length, 1);
  const invite = await f.invite(admin.cookie, admin.space.id);
  const user = await f.login('member', invite.token);
  assert.equal(user.response.status, 302);
  const me = await (await f.request('/api/me', {}, user.cookie)).json();
  assert.equal(me.user.role, 'user');
  const spaces = await (await f.request('/api/spaces', {}, user.cookie)).json();
  assert.equal(spaces.spaces.length, 2);
  const configured = await fixture({ adminEmails: ['owner@example.com'] }, 'google'); t.after(() => configured.dispose());
  assert.equal((await configured.login('stranger')).response.status, 403);
  const owner = await configured.login('owner');
  assert.equal(owner.response.status, 302);
  assert.equal((await (await configured.request('/api/me', {}, owner.cookie)).json()).user.role, 'admin');
});

test('B1: concurrent one-use invite consumption creates only one account; invalid, revoked, expired invites fail', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id);
  const flows = await Promise.all([f.start(invite.token), f.start(invite.token)]);
  const results = await Promise.all([f.finish(flows[0], 'one'), f.finish(flows[1], 'two')]);
  assert.deepEqual(results.map(r => r.status).sort(), [302, 403]);
  assert.equal(f.repo.users().length, 2);
  assert.equal(f.repo.invites()[0].uses, 1);
  assert.equal((await f.request(`/api/invites/${invite.token}`)).status, 404);
  const revoked = await f.invite(admin.cookie, admin.space.id, 3);
  const revokedFlow = await f.start(revoked.token);
  assert.equal((await f.request(`/api/admin/invites/${revoked.id}`, { method: 'DELETE' }, admin.cookie)).status, 204);
  assert.equal((await f.finish(revokedFlow, 'revoked')).status, 403);
  const expired = await f.invite(admin.cookie, admin.space.id);
  const expiredFlow = await f.start(expired.token);
  f.advance(24 * 3600000 + 1);
  assert.equal((await f.request(`/api/invites/${expired.token}`)).status, 404);
  assert.equal((await f.finish(expiredFlow, 'expired')).status, 400);
  assert.equal(f.repo.users().length, 2);
});

test('B4/A2: admin-only APIs, logout and disable revoke sessions immediately, enable requires fresh login', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id, 2);
  const member = await f.login('member', invite.token);
  const me = await (await f.request('/api/me', {}, member.cookie)).json();
  for (const path of ['/api/admin/users', '/api/admin/invites']) assert.equal((await f.request(path, {}, member.cookie)).status, 403);
  assert.equal((await f.json('/api/admin/invites', { spaceId: admin.space.id }, member.cookie)).status, 403);
  assert.equal((await f.json(`/api/admin/users/${me.user.id}`, { disabled: true }, member.cookie, 'PATCH')).status, 403);
  assert.equal((await f.json(`/api/admin/users/${admin.user.id}`, { disabled: true }, admin.cookie, 'PATCH')).status, 409);
  assert.equal((await f.json(`/api/admin/users/${me.user.id}`, { disabled: true }, admin.cookie, 'PATCH')).status, 204);
  assert.equal((await f.request('/api/me', {}, member.cookie)).status, 401);
  assert.equal((await f.login('member')).response.status, 403);
  assert.equal((await f.json(`/api/admin/users/${me.user.id}`, { disabled: false }, admin.cookie, 'PATCH')).status, 204);
  assert.equal((await f.request('/api/me', {}, member.cookie)).status, 401);
  const fresh = await f.login('member');
  assert.equal((await f.request('/api/auth/logout', { method: 'POST' }, fresh.cookie)).status, 204);
  assert.equal((await f.request('/api/me', {}, fresh.cookie)).status, 401);
  f.advance(f.config.sessionMs + 1);
  assert.equal((await f.request('/api/me', {}, admin.cookie)).status, 401);
});

test('C2: cross-space list, upload, file-ID guessing, download, thumbnail and retract are denied', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id);
  const member = await f.login('member', invite.token);
  const { spaces } = await (await f.request('/api/spaces', {}, member.cookie)).json();
  const privateSpace = spaces.find((space: any) => space.ownerId !== admin.user.id);
  const base = `/api/spaces/${privateSpace.id}`;
  const uploaded = await (await f.upload(base, member.cookie, 'private data')).json();
  for (const path of [base, `${base}/items`, `${base}/items/${uploaded.item.id}/download`, `${base}/items/${uploaded.item.id}/thumbnail`]) {
    assert.equal((await f.request(path, {}, admin.cookie)).status, 404);
  }
  assert.equal((await f.json(`${base}/items/text`, { text: 'intrusion' }, admin.cookie)).status, 404);
  assert.equal((await f.upload(base, admin.cookie, 'intrusion')).status, 404);
  assert.equal((await f.request(`${base}/items/${uploaded.item.id}`, { method: 'DELETE' }, admin.cookie)).status, 404);
  assert.equal((await f.request(`/api/spaces/${admin.space.id}/items/${uploaded.item.id}/download`, {}, admin.cookie)).status, 404);
  assert.equal((await f.request(`${base}/items`)).status, 401);
});

test('D2/G: plain text round trips; raster thumbnail, filename sanitization and safe SVG/HTML downloads', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  const text = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const textResponse = await f.json(`${base}/items/text`, { text }, admin.cookie);
  assert.equal(textResponse.status, 201);
  assert.equal((await textResponse.json()).item.text, text);
  assert.match(textResponse.headers.get('content-type')!, /^application\/json/);
  const png = await sharp({ create: { width: 500, height: 400, channels: 3, background: 'blue' } }).png().toBuffer();
  const response = await f.upload(base, admin.cookie, png, 'image/png', '../..\\bad\u0000\r\n名.png');
  assert.equal(response.status, 201);
  const { item } = await response.json();
  assert.equal(item.hasThumbnail, true);
  assert.doesNotMatch(item.filename, /[\\/\u0000\r\n]/);
  assert.equal(item.fileKey, undefined);
  const thumbnail = await f.request(`${base}/items/${item.id}/thumbnail`, {}, admin.cookie);
  assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
  const metadata = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
  assert.equal(metadata.width, 320);
  assert.equal(metadata.format, 'webp');
  for (const mime of ['image/svg+xml', 'text/html']) {
    const upload = await f.upload(base, admin.cookie, '<svg onload="alert(1)"></svg>', mime, 'untrusted.html');
    assert.equal(upload.status, 201);
    const { item: file } = await upload.json();
    assert.equal(file.hasThumbnail, false);
    assert.equal((await f.request(`${base}/items/${file.id}/thumbnail`, {}, admin.cookie)).status, 404);
    const download = await f.request(`${base}/items/${file.id}/download`, {}, admin.cookie);
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal((await f.upload(base, admin.cookie, '<svg/>', 'image/png')).status, 415);
  const bad = await f.upload(base, admin.cookie, new Uint8Array(), 'image/png');
  assert.equal(bad.status, 400);
  const before = (await readdir(join(f.directory, 'files'))).length;
  assert.equal((await f.request(`${base}/items/${item.id}`, { method: 'DELETE' }, admin.cookie)).status, 204);
  assert.equal((await readdir(join(f.directory, 'files'))).length, before - 2);
  assert.equal((await f.request(`${base}/items/${item.id}/download`, {}, admin.cookie)).status, 404);
});

test('F2: streaming limits ignore false/missing Content-Length; quota races leave no partial files', async t => {
  const f = await fixture({ maxFileBytes: 30, userQuotaBytes: 40, maxTextBytes: 16 }); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  assert.equal((await f.upload(base, admin.cookie, 'x'.repeat(31))).status, 413);
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); controller.enqueue(new Uint8Array(20)); controller.close(); } });
  const streamed = await f.request(`${base}/items/file`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit, admin.cookie);
  assert.equal(streamed.status, 413);
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
  const results = await Promise.all([f.upload(base, admin.cookie, 'a'.repeat(25)), f.upload(base, admin.cookie, 'b'.repeat(25))]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 413]);
  assert.equal((await readdir(join(f.directory, 'files'))).length, 1);
  const me = await (await f.request('/api/me', {}, admin.cookie)).json();
  assert.equal(me.usedBytes, 25);
  assert.equal((await f.json(`${base}/items/text`, { text: 'x'.repeat(17) }, admin.cookie)).status, 413);
  const users = await (await f.request('/api/admin/users', {}, admin.cookie)).json();
  assert.equal(users.users[0].usedBytes, 25);
  assert.equal(users.users[0].quotaBytes, 40);
});

test('D3/E: temporary room capability, uniform unknown responses, strict limits and expiry cleanup', async t => {
  const f = await fixture({ roomMaxFileBytes: 10, roomQuotaBytes: 15 }); t.after(() => f.dispose());
  const response = await f.request('/api/rooms', { method: 'POST' });
  assert.equal(response.status, 201);
  const room = await response.json();
  assert.equal(Buffer.from(room.token, 'base64url').length, 32);
  const base = `/api/rooms/${room.token}`;
  assert.equal((await f.request('/api/rooms')).status, 404);
  assert.equal((await f.request('/api/rooms/guess/items')).status, 404);
  assert.equal((await f.upload(base, '', '12345678901')).status, 413);
  const uploaded = await f.upload(base, '', '1234567890'); assert.equal(uploaded.status, 201);
  assert.equal((await f.upload(base, '', '123456')).status, 413);
  assert.equal((await readdir(join(f.directory, 'files'))).length, 1);
  f.advance(86400001);
  const expired = await f.request(`${base}/items`);
  const unknown = await f.request('/api/rooms/guess/items');
  assert.equal(expired.status, unknown.status);
  assert.deepEqual(await expired.json(), await unknown.json());
  await f.service.cleanup();
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
});

test('D3: expiry makes items inaccessible before cleanup; cleanup recovers old orphan files and deletion failures', async t => {
  const f = await fixture({ retentionMs: 1000 }); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  const { item } = await (await f.upload(base, admin.cookie, 'hello')).json();
  const orphan = await f.files.write(new Blob(['orphan']).stream(), 100);
  f.files.commit(orphan.key);
  await utimes(join(f.directory, 'files', orphan.key), new Date(0), new Date(0));
  f.advance(1001);
  assert.equal((await f.request(`${base}/items/${item.id}/download`, {}, admin.cookie)).status, 404);
  const remove = f.files.remove.bind(f.files);
  f.files.remove = async () => { throw new Error('Disk temporarily unavailable'); };
  await assert.rejects(f.service.cleanup());
  assert.equal(f.repo.garbage().length, 1);
  f.files.remove = remove;
  await f.service.cleanup();
  assert.equal(f.repo.garbage().length, 0);
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
  assert.equal((await (await f.request('/api/me', {}, admin.cookie)).json()).usedBytes, 0);
});

test('F2: interrupted upload and thumbnail quota failure remove every staged file', async t => {
  const f = await fixture({ userQuotaBytes: 20 }); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  let pulls = 0;
  const body = new ReadableStream({ pull(controller) {
    if (++pulls === 1) controller.enqueue(new Uint8Array(10)); else controller.error(new Error('Client disconnected'));
  } });
  const response = await f.request(`${base}/items/file`, { method: 'POST', body, duplex: 'half' } as RequestInit, admin.cookie);
  assert.equal(response.status, 500);
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } }).png().toBuffer();
  assert.equal((await f.upload(base, admin.cookie, image, 'image/png')).status, 413);
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
  assert.equal(f.repo.usage(admin.user.id), 0);
});

test('G1/G4: missing, null and cross-site origins rejected; security headers on success and errors', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  for (const untrusted of ['', 'null', 'https://attacker.example', `${origin}.attacker.example`]) {
    const response = await f.request('/api/rooms', { method: 'POST', headers: { origin: untrusted } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal((await f.app.request('/api/rooms', { method: 'POST' })).status, 403);
  assert.equal((await f.request('/api/rooms', { method: 'POST' })).status, 201);
  assert.equal((await f.request('/healthz')).headers.get('x-content-type-options'), 'nosniff');
});

test('F1/G6: IP and account limits, Retry-After, trusted hop processing and untrusted forwarding headers', async t => {
  const f = await fixture({ rateAuth: 2 }); t.after(() => f.dispose());
  assert.equal((await f.request('/api/auth/github')).status, 302);
  assert.equal((await f.request('/api/auth/github', { headers: { 'x-forwarded-for': '203.0.113.2' } })).status, 302);
  const denied = await f.request('/api/auth/github', { headers: { 'x-forwarded-for': '203.0.113.3' } });
  assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '60');
  f.advance(60001);
  assert.equal((await f.request('/api/auth/github')).status, 302);
  const trusted = await fixture({ rateAuth: 1, trustProxy: ['loopback'] }); t.after(() => trusted.dispose());
  for (const ip of ['203.0.113.1', '203.0.113.2']) {
    assert.equal((await trusted.request('/api/auth/github', { headers: { 'x-forwarded-for': ip } })).status, 302);
  }
  assert.equal((await trusted.request('/api/auth/github', { headers: { 'x-forwarded-for': '8.8.8.8, 203.0.113.2' } })).status, 429);
  const account = await fixture({ rateUpload: 1 }); t.after(() => account.dispose());
  const admin = await account.admin(); const base = `/api/spaces/${admin.space.id}/items/file`;
  assert.equal((await account.request(base, { method: 'POST', body: 'a', headers: { 'x-test-ip': '203.0.113.1' } }, admin.cookie)).status, 201);
  assert.equal((await account.request(base, { method: 'POST', body: 'b', headers: { 'x-test-ip': '203.0.113.2' } }, admin.cookie)).status, 429);
});

async function connect(url: string, cookie = '', socketOrigin = origin) {
  const ws = new WebSocket(url, { origin: socketOrigin, headers: { cookie } });
  const messages: any[] = [];
  const waiters: ((message: any) => void)[] = [];
  ws.on('message', raw => { const message = JSON.parse(raw.toString()); const next = waiters.shift(); if (next) next(message); else messages.push(message); });
  await once(ws, 'open');
  return { ws, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket event timed out')), 2000);
    waiters.push(message => { clearTimeout(timer); resolve(message); });
  }) };
}

test('D1/D4/C2/A2: real WS broadcasts within 1s, reconnect replaces snapshot, denial and immediate revocation', { timeout: 15000 }, async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const server = serve({ fetch: f.app.fetch, port: 0, hostname: '127.0.0.1' });
  f.injectWebSocket(server);
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `/api/spaces/${admin.space.id}`;
  const wsUrl = `ws://127.0.0.1:${address.port}${base}/ws`;
  await assert.rejects(connect(wsUrl), /401/);
  await assert.rejects(connect(wsUrl, admin.cookie, 'https://attacker.example'), /403/);
  const device = await connect(wsUrl, admin.cookie); t.after(() => device.ws.terminate());
  assert.equal((await device.next()).type, 'snapshot');
  const before = performance.now();
  const created = await f.json(`${base}/items/text`, { text: 'real time' }, admin.cookie);
  const { item } = await created.json();
  const event = await device.next();
  assert.equal(event.type, 'item.created'); assert.equal(event.item.id, item.id);
  assert(performance.now() - before < 1000);
  device.ws.terminate();
  await once(device.ws, 'close');
  await f.request(`${base}/items/${item.id}`, { method: 'DELETE' }, admin.cookie);
  await f.json(`${base}/items/text`, { text: 'while offline' }, admin.cookie);
  const reconnected = await connect(wsUrl, admin.cookie); t.after(() => reconnected.ws.terminate());
  const snapshot = await reconnected.next();
  assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0].text, 'while offline');
  const closed = once(reconnected.ws, 'close');
  await f.request('/api/auth/logout', { method: 'POST' }, admin.cookie);
  assert.equal((await closed)[0], 1008);
});

test('C2/E: actual WS cross-space denial and temporary room expiry closes subscribers', { timeout: 10000 }, async t => {
  const f = await fixture({ roomRetentionMs: 1000 }); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id);
  const member = await f.login('member', invite.token);
  const { spaces } = await (await f.request('/api/spaces', {}, member.cookie)).json();
  const privateSpace = spaces.find((space: any) => space.ownerId !== admin.user.id);
  const server = serve({ fetch: f.app.fetch, port: 0, hostname: '127.0.0.1' }); f.injectWebSocket(server);
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert(address && typeof address !== 'string');
  const wsBase = `ws://127.0.0.1:${address.port}`;
  await assert.rejects(connect(`${wsBase}/api/spaces/${privateSpace.id}/ws`, admin.cookie), /404/);
  const memberSocket = await connect(`${wsBase}/api/spaces/${privateSpace.id}/ws`, member.cookie);
  t.after(() => memberSocket.ws.terminate());
  await memberSocket.next();
  const disabledClosed = once(memberSocket.ws, 'close');
  const me = await (await f.request('/api/me', {}, member.cookie)).json();
  await f.json(`/api/admin/users/${me.user.id}`, { disabled: true }, admin.cookie, 'PATCH');
  assert.equal((await disabledClosed)[0], 1008);
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const socket = await connect(`${wsBase}/api/rooms/${room.token}/ws`); t.after(() => socket.ws.terminate());
  assert.equal((await socket.next()).type, 'snapshot');
  const closed = once(socket.ws, 'close'); f.advance(1001); await f.service.cleanup();
  assert.equal((await closed)[0], 1008);
});

test('A2: production cookie has Secure and __Host prefix', async t => {
  const f = await fixture({ production: true, origin: 'https://dropit.example' }); t.after(() => f.dispose());
  const start = await f.app.request('/api/auth/github');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  assert.match(start.headers.getSetCookie().join(';'), /Secure/);
  assert(cookieValue(start, '__Secure-dropit_oauth'));
  // finish() seeds the mock identity; use its browser flow with the production cookie.
  await f.finish({ state: 'invalid', browser: '', response: start }, 'owner');
  const response = await f.app.request(`/api/auth/github/callback?state=${state}&code=owner`, { headers: { cookie: cookieValue(start, '__Secure-dropit_oauth') } });
  assert.equal(response.status, 302);
  assert(cookieValue(response, '__Host-dropit_session'));
  assert.match(response.headers.getSetCookie().join(';'), /Secure/);
});
