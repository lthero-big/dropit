import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import sharp from 'sharp';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { ApiError, hash, type Identity } from '../src/domain.js';
import { migration1, migration2, migration3, migration4, migration5, migration6, migration7, migration8, migration9 } from '../src/migrations.js';
import type { OAuthProvider } from '../src/oauth.js';
import { parseByteRange, sniffMedia } from '../src/media.js';
import { SqliteRepository } from '../src/repository.js';

const origin = 'http://localhost:3000';
const cookieValue = (response: Response, name: string) => response.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(';')[0] ?? '';
function oauthError(response: Response) {
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location')!);
  assert.equal(`${location.origin}${location.pathname}`, `${origin}/login`);
  return location.searchParams.get('error');
}

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
  const config = { ...loadConfig({}), origin, dataDir: directory, ...overrides };
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
  const finish = async (flow: Awaited<ReturnType<typeof start>>, subject: string, email?: string) => {
    identities.set(subject, { provider: providerName, subject, email: email ?? `${subject}@example.com`, name: subject });
    return request(`/api/auth/${providerName}/callback?${new URLSearchParams({ state: flow.state, code: subject })}`, {}, flow.browser);
  };
  const login = async (subject: string, invite?: string, email?: string) => {
    const response = await finish(await start(invite), subject, email);
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
    request(`${base}/items/file`, { method: 'POST', headers: { 'content-type': mime, 'x-file-name': encodeURIComponent(filename) }, body: typeof bytes === 'string' ? bytes : new Uint8Array(bytes) }, cookie);
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
  ]) assert.equal(oauthError(await f.request(`/api/auth/github/callback?${query}`, {}, cookie)), 'OAUTH_STATE_INVALID');
  assert.equal(f.exchanges(), 0);
  assert.equal(f.repo.users().length, 0);
  const denied = await f.request(`/api/auth/github/callback?state=${flow.state}&error=access_denied`, {}, flow.browser);
  assert.equal(oauthError(denied), 'OAUTH_DENIED');
  assert.equal(denied.headers.get('location')!.includes('access_denied'), false);
  assert.equal(f.repo.users().length, 0);
  const successful = await f.login('admin');
  assert.equal(successful.response.status, 302);
  assert.equal(new URL(successful.response.headers.get('location')!).pathname, '/');
  assert.match(successful.response.headers.getSetCookie().join(';'), /HttpOnly/);
  assert.match(successful.response.headers.getSetCookie().join(';'), /SameSite=Lax/);
  assert.equal(oauthError(await f.finish(flow, 'admin')), 'OAUTH_STATE_INVALID');
  assert.equal(f.repo.users().length, 1);
  assert.equal((await f.request('/api/auth/password')).status, 404);
});

test('A1: OAuth flow expiry is enforced before token exchange', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const flow = await f.start(); f.advance(600001);
  assert.equal(oauthError(await f.finish(flow, 'admin')), 'OAUTH_STATE_INVALID');
  assert.equal(f.exchanges(), 0);
});

test('B2: failed provider exchange never consumes invitation or creates an account', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id);
  const flow = await f.start(invite.token);
  const response = await f.request(`/api/auth/github/callback?state=${flow.state}&code=fail`, {}, flow.browser);
  assert.equal(oauthError(response), 'INTERNAL_ERROR');
  assert.equal(response.headers.get('location')!.includes('refused'), false);
  assert.equal(f.repo.users().length, 1);
  assert.equal(f.repo.invite(hash(invite.token), Date.now())?.uses, 0);
  assert.equal((await f.login('member', invite.token)).response.status, 302);
  assert.equal((await f.request('/api/auth/toString')).status, 404);
});

test('A3/B3: bootstrap admin, invite-only signup, verified ADMIN_EMAILS and independent provider identities', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  assert.equal(admin.user.role, 'admin');
  assert.equal(oauthError((await f.login('stranger')).response), 'INVITATION_REQUIRED');
  assert.equal(f.repo.users().length, 1);
  const invite = await f.invite(admin.cookie, admin.space.id);
  const user = await f.login('member', invite.token);
  assert.equal(user.response.status, 302);
  const me = await (await f.request('/api/me', {}, user.cookie)).json();
  assert.equal(me.user.role, 'user');
  const spaces = await (await f.request('/api/spaces', {}, user.cookie)).json();
  assert.equal(spaces.spaces.length, 2);
  const configured = await fixture({ adminEmails: ['owner@example.com'] }, 'google'); t.after(() => configured.dispose());
  const first = await configured.login('stranger');
  assert.equal(first.response.status, 302);
  assert.equal((await (await configured.request('/api/me', {}, first.cookie)).json()).user.role, 'admin');
  assert.equal(oauthError((await configured.login('other')).response), 'INVITATION_REQUIRED');
  const owner = await configured.login('owner');
  assert.equal(owner.response.status, 302);
  assert.equal((await (await configured.request('/api/me', {}, owner.cookie)).json()).user.role, 'admin');
});

test('first sign-in is admin with ADMIN_EMAILS unset or set, and a bad invite does not block an empty database', async t => {
  const open = await fixture(); t.after(() => open.dispose());
  const started = await open.request('/api/auth/github?invite=not-a-real-token');
  assert.equal(started.status, 302);
  assert.equal(new URL(started.headers.get('location')!).origin, 'https://mock.example');
  const done = await open.finish({
    state: new URL(started.headers.get('location')!).searchParams.get('state')!,
    browser: cookieValue(started, 'dropit_oauth'),
    response: started,
  }, 'first');
  assert.equal(done.status, 302);
  assert.equal(new URL(done.headers.get('location')!).pathname, '/');
  const cookie = cookieValue(done, 'dropit_session');
  assert.equal((await (await open.request('/api/me', {}, cookie)).json()).user.role, 'admin');
  assert.equal(oauthError((await open.login('second')).response), 'INVITATION_REQUIRED');
  assert.equal(open.repo.users().length, 1);

  const listed = await fixture({ adminEmails: ['later@example.com'] }); t.after(() => listed.dispose());
  const bootstrap = listed.repo.login(
    { provider: 'github', subject: 'bootstrap', email: 'bootstrap@example.com', name: 'bootstrap' },
    hash('missing-invite'), [], hash('bootstrap-session'), Date.now() + 60_000, Date.now());
  assert.equal(bootstrap.role, 'admin');
  assert.equal(oauthError((await listed.login('second')).response), 'INVITATION_REQUIRED');
  const later = await listed.login('later', undefined, 'later@example.com');
  assert.equal(later.response.status, 302);
  assert.equal((await (await listed.request('/api/me', {}, later.cookie)).json()).user.role, 'admin');
  assert.equal(listed.repo.users().filter(user => user.role === 'admin').length, 2);
});

test('two concurrent first sign-ins create exactly one admin', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'dropit.sqlite');
  const setup = new SqliteRepository(path);
  setup.close();
  const race = (subject: string) => new Promise<{ ok: boolean; role?: string; code?: string }>((resolve, reject) => {
    const worker = new Worker(new URL('./first-user-race.bootstrap.mjs', import.meta.url), {
      workerData: { path, subject, email: `${subject}@example.com`, admins: [], sessionHash: hash(subject) },
    });
    let settled = false;
    worker.on('message', (message) => { settled = true; resolve(message); });
    worker.on('error', reject);
    worker.on('exit', (code) => { if (!settled) reject(new Error(`race worker exited ${code}`)); });
  });
  const results = await Promise.all([race('one'), race('two')]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => result.ok)?.role, 'admin');
  assert.equal(results.find(result => !result.ok)?.code, 'INVITATION_REQUIRED');
  const check = new SqliteRepository(path);
  try {
    const users = check.users();
    assert.equal(users.length, 1);
    assert.equal(users[0].role, 'admin');
  } finally { check.close(); }
});

test('B1: concurrent one-use invite consumption creates only one account; invalid, revoked, expired invites fail', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id);
  const flows = await Promise.all([f.start(invite.token), f.start(invite.token)]);
  const results = await Promise.all([f.finish(flows[0], 'one'), f.finish(flows[1], 'two')]);
  assert.deepEqual(results.map(r => r.status).sort(), [302, 302]);
  assert.deepEqual(results.map(r => new URL(r.headers.get('location')!).pathname === '/' ? 'ok' : new URL(r.headers.get('location')!).searchParams.get('error')).sort(), ['INVITE_INVALID', 'ok']);
  assert.equal(f.repo.users().length, 2);
  assert.equal(f.repo.invites()[0].uses, 1);
  assert.equal((await f.request(`/api/invites/${invite.token}`)).status, 404);
  const revoked = await f.invite(admin.cookie, admin.space.id, 3);
  const revokedFlow = await f.start(revoked.token);
  assert.equal((await f.request(`/api/admin/invites/${revoked.id}`, { method: 'DELETE' }, admin.cookie)).status, 204);
  assert.equal(oauthError(await f.finish(revokedFlow, 'revoked')), 'INVITE_INVALID');
  const expired = await f.invite(admin.cookie, admin.space.id);
  const expiredFlow = await f.start(expired.token);
  f.advance(24 * 3600000 + 1);
  assert.equal((await f.request(`/api/invites/${expired.token}`)).status, 404);
  // The 10-minute OAuth flow expires before the 24-hour invite, so the callback reports state first.
  assert.equal(oauthError(await f.finish(expiredFlow, 'expired')), 'OAUTH_STATE_INVALID');
  assert.equal(f.repo.users().length, 2);
  assert.equal(oauthError(await f.request('/api/auth/github?invite=not-a-real-token')), 'INVITE_INVALID');
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
  assert.equal(oauthError((await f.login('member')).response), 'USER_DISABLED');
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
  for (const path of [base, `${base}/items`, `${base}/items/${uploaded.item.id}/download`, `${base}/items/${uploaded.item.id}/thumbnail`, `${base}/items/${uploaded.item.id}/preview`, `${base}/items/${uploaded.item.id}/media`]) {
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
  // eslint-disable-next-line no-control-regex -- explicitly verify filename control characters are removed
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
    assert.equal((await f.request(`${base}/items/${file.id}/media`, {}, admin.cookie)).status, 404);
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

test('D1/D3: a disconnected subscriber cannot roll back committed files or block other subscribers', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  f.events.subscribe(admin.space.id, { send() { throw new Error('Disconnected'); }, close() { throw new Error('Disconnected'); } }, () => true);
  const received: string[] = [];
  f.events.subscribe(admin.space.id, { send(data) { received.push(data); }, close() {} }, () => true);
  const response = await f.upload(base, admin.cookie, 'persist me');
  assert.equal(response.status, 201);
  const { item } = await response.json();
  assert.equal(JSON.parse(received[0]).item.id, item.id);
  assert.equal((await readdir(join(f.directory, 'files'))).length, 1);
  assert.equal(await (await f.request(`${base}/items/${item.id}/download`, {}, admin.cookie)).text(), 'persist me');
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
  const server = serve({ fetch: f.app.fetch, port: 0, hostname: '127.0.0.1', websocket: f.websocket }) as Server;
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `/api/spaces/${admin.space.id}`;
  const wsUrl = `ws://127.0.0.1:${address.port}${base}/ws`;
  await assert.rejects(connect(wsUrl), /401/);
  await assert.rejects(connect(wsUrl, admin.cookie, 'https://attacker.example'), /403/);
  const device = await connect(wsUrl, admin.cookie); t.after(() => device.ws.terminate());
  assert.equal((await device.next()).type, 'snapshot');
  assert.deepEqual(await device.next(), { type: 'presence', devices: 1 });
  const other = await connect(wsUrl, admin.cookie); t.after(() => other.ws.terminate());
  assert.equal((await other.next()).type, 'snapshot');
  assert.deepEqual(await other.next(), { type: 'presence', devices: 2 });
  assert.deepEqual(await device.next(), { type: 'presence', devices: 2 });
  other.ws.close();
  await once(other.ws, 'close');
  assert.deepEqual(await device.next(), { type: 'presence', devices: 1 });
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
  const server = serve({ fetch: f.app.fetch, port: 0, hostname: '127.0.0.1', websocket: f.websocket }) as Server;
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

test('admin pre-provisions a user that the first verified login binds', async t => {
  const f = await fixture({ userQuotaBytes: 100 }); t.after(() => f.dispose());
  const admin = await f.admin();
  assert.equal((await f.json('/api/admin/users', { email: 'not-an-email' }, admin.cookie)).status, 400);
  assert.equal((await f.json('/api/admin/users', { email: 'admin@example.com' }, admin.cookie)).status, 409);
  assert.equal((await f.json(`/api/admin/users/${admin.user.id}`, {}, admin.cookie, 'PATCH')).status, 400);
  const createdResponse = await f.json('/api/admin/users', { email: 'guest@example.com', name: 'Guest', role: 'user', quotaBytes: 10 }, admin.cookie);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.pending, 1);
  assert.equal(created.quotaBytes, 10);
  assert.equal(created.quotaOverride, 10);
  assert.equal(f.repo.spaces(created.id).length, 1);
  const blockedResponse = await f.json('/api/admin/users', { email: 'blocked@example.com' }, admin.cookie);
  const blockedUser = await blockedResponse.json();
  assert.equal((await f.json(`/api/admin/users/${blockedUser.id}`, { disabled: true }, admin.cookie, 'PATCH')).status, 204);
  const blocked = await f.login('blocked', undefined, 'blocked@example.com');
  assert.equal(oauthError(blocked.response), 'USER_DISABLED');
  assert.equal(f.repo.users().length, 3);

  const claimed = await f.login('guest');
  assert.equal(claimed.response.status, 302);
  const guestMe = await (await f.request('/api/me', {}, claimed.cookie)).json();
  assert.equal(guestMe.user.id, created.id);
  assert.equal(guestMe.user.pending, 0);
  assert.equal(guestMe.quotaBytes, 10);
  const spaces = await (await f.request('/api/spaces', {}, claimed.cookie)).json();
  assert.equal(spaces.spaces.length, 1);
  assert.equal(f.repo.users().length, 3);
  const other = await f.login('other', undefined, 'guest@example.com');
  // RHEA-190 m11: a second identity for a claimed email is told to bind it, never a duplicate account.
  assert.equal(oauthError(other.response), 'ACCOUNT_EXISTS');
  assert.equal(f.repo.users().length, 3);

  const base = `/api/spaces/${spaces.spaces[0].id}`;
  assert.equal((await f.json(`${base}/items/text`, { text: '12345678901' }, claimed.cookie)).status, 413);
  assert.equal((await f.json(`${base}/items/text`, { text: '1234567890' }, claimed.cookie)).status, 201);
  assert.equal((await f.json(`/api/spaces/${admin.space.id}/items/text`, { text: '12345678901' }, admin.cookie)).status, 201);
  assert.equal((await f.json(`/api/admin/users/${created.id}`, { quotaBytes: null }, admin.cookie, 'PATCH')).status, 204);
  assert.equal((await (await f.request('/api/me', {}, claimed.cookie)).json()).quotaBytes, 100);
  assert.equal((await f.json(`${base}/items/text`, { text: '12345678901' }, claimed.cookie)).status, 201);
  assert.equal((await f.json('/api/admin/users', { email: 'nope@example.com' }, claimed.cookie)).status, 403);
  assert.equal((await f.request('/api/admin/limits', {}, claimed.cookie)).status, 403);
  const limits = await (await f.request('/api/admin/limits', {}, admin.cookie)).json();
  assert.equal(limits.userQuotaBytes.value, 100);
  assert.equal('adminEmails' in limits, false);
  assert.equal('dataDir' in limits, false);
  assert.equal((await f.request('/api/admin/users/missing/logout', { method: 'POST' }, admin.cookie)).status, 404);
  assert.equal((await f.json('/api/admin/users/missing', { name: 'No' }, admin.cookie, 'PATCH')).status, 404);

  assert.equal((await f.json(`/api/admin/users/${created.id}`, { role: 'admin', name: 'Guest 2' }, admin.cookie, 'PATCH')).status, 204);
  assert.equal((await f.json(`/api/admin/users/${admin.user.id}`, { role: 'user' }, admin.cookie, 'PATCH')).status, 204);
  assert.equal((await f.json(`/api/admin/users/${created.id}`, { role: 'user' }, claimed.cookie, 'PATCH')).status, 409);
  assert.equal((await f.request(`/api/admin/users/${created.id}/logout`, { method: 'POST' }, claimed.cookie)).status, 204);
  assert.equal((await f.request('/api/me', {}, claimed.cookie)).status, 401);
  assert.equal(f.repo.users().find(user => user.id === created.id)?.disabled, 0);
  assert.equal((await f.login('guest')).response.status, 302);
});

test('ADMIN_EMAILS pre-provision is stored as admin and claimed by that mailbox', async t => {
  const f = await fixture({ adminEmails: ['owner@example.com', 'boss@example.com'] }); t.after(() => f.dispose());
  const owner = await f.login('owner');
  assert.equal(owner.response.status, 302);
  const response = await f.json('/api/admin/users', { email: 'Boss@Example.com', role: 'user' }, owner.cookie);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.email, 'boss@example.com');
  assert.equal(body.role, 'admin');
  assert.equal(body.pending, 1);
  const claimed = await f.login('boss');
  assert.equal(claimed.response.status, 302);
  const me = await (await f.request('/api/me', {}, claimed.cookie)).json();
  assert.equal(me.user.id, body.id);
  assert.equal(me.user.role, 'admin');
  assert.equal(me.user.pending, 0);
});

test('text edits keep the item, sync, and enforce author and quota', async t => {
  const f = await fixture({ userQuotaBytes: 20 }); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id);
  const member = await f.login('member', invite.token);
  const me = await (await f.request('/api/me', {}, member.cookie)).json();
  const base = `/api/spaces/${admin.space.id}`;
  const received: string[] = [];
  f.events.subscribe(admin.space.id, { send(data) { received.push(data); }, close() {} }, () => true);
  const createdResponse = await f.json(`${base}/items/text`, { text: 'hello' }, member.cookie);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.item.updatedAt, created.item.createdAt);
  f.advance(1000);
  const edited = await f.json(`${base}/items/${created.item.id}`, { text: 'hello!' }, member.cookie, 'PATCH');
  assert.equal(edited.status, 200);
  const body = await edited.json();
  assert.equal(body.item.id, created.item.id);
  assert.equal(body.item.text, 'hello!');
  assert.equal(body.item.size, Buffer.byteLength('hello!'));
  assert.equal(body.item.createdAt, created.item.createdAt);
  assert.equal(body.item.expiresAt, created.item.expiresAt);
  assert.equal(body.item.updatedAt, created.item.updatedAt + 1000);
  const event = JSON.parse(received.at(-1)!);
  assert.equal(event.type, 'item.updated');
  assert.equal(event.item.text, 'hello!');
  const grown = await f.json(`${base}/items/${created.item.id}`, { text: 'x'.repeat(21) }, member.cookie, 'PATCH');
  assert.equal(grown.status, 413);
  assert.equal((await grown.json()).error.code, 'QUOTA_EXCEEDED');
  assert.equal((await (await f.request(`${base}/items`, {}, member.cookie)).json()).items.find((item: { id: string }) => item.id === created.item.id).text, 'hello!');
  const shrunk = await f.json(`${base}/items/${created.item.id}`, { text: 'ok' }, member.cookie, 'PATCH');
  assert.equal(shrunk.status, 200);
  const empty = await f.json(`${base}/items/${created.item.id}`, { text: '   ' }, member.cookie, 'PATCH');
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'EMPTY_TEXT');
  const uploaded = await (await f.upload(base, member.cookie, 'abcd')).json();
  const fileEdit = await f.json(`${base}/items/${uploaded.item.id}`, { text: 'nope' }, member.cookie, 'PATCH');
  assert.equal(fileEdit.status, 400);
  assert.equal((await fileEdit.json()).error.code, 'INVALID_INPUT');
  const forbidden = await f.json(`${base}/items/${created.item.id}`, { text: 'rewritten' }, admin.cookie, 'PATCH');
  assert.equal(forbidden.status, 403);
  const { spaces } = await (await f.request('/api/spaces', {}, member.cookie)).json();
  const privateSpace = spaces.find((space: { ownerId: string }) => space.ownerId === me.user.id);
  assert.equal((await f.json(`/api/spaces/${privateSpace.id}/items/${created.item.id}`, { text: 'no' }, member.cookie, 'PATCH')).status, 404);
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const roomItem = await (await f.json(`/api/rooms/${room.token}/items/text`, { text: 'room' })).json();
  const roomEdit = await f.json(`/api/rooms/${room.token}/items/${roomItem.item.id}`, { text: 'room edited' }, '', 'PATCH');
  assert.equal(roomEdit.status, 200);
  assert.equal((await roomEdit.json()).item.text, 'room edited');
});

test('share links enforce token, expiry, revocation, view limits and owner-only management', async t => {
  const f = await fixture({ rateAuth: 1000 }); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id, 2);
  const member = await f.login('member', invite.token);
  const other = await f.login('other', invite.token);
  const base = `/api/spaces/${admin.space.id}`;
  const created = await (await f.json(`${base}/items/text`, { text: 'secret clip' }, member.cookie)).json();
  const itemId = created.item.id as string;
  assert.equal((await f.request(`${base}/items/${itemId}/shares`)).status, 401);
  assert.equal((await f.json(`${base}/items/${itemId}/shares`, { expiresIn: '1d', maxViews: 1 }, other.cookie)).status, 403);
  assert.equal((await f.request(`${base}/items/${itemId}/shares`, {}, other.cookie)).status, 403);
  assert.equal((await f.json(`${base}/items/${itemId}/shares`, { expiresIn: '2h' }, member.cookie)).status, 400);
  assert.equal((await f.json(`${base}/items/${itemId}/shares`, { expiresIn: '1h', maxViews: 0 }, member.cookie)).status, 400);
  assert.equal((await f.json(`${base}/items/missing/shares`, { expiresIn: '1h' }, member.cookie)).status, 404);

  const createdShare = await f.json(`${base}/items/${itemId}/shares`, { expiresIn: '1h', maxViews: 2 }, member.cookie);
  assert.equal(createdShare.status, 201);
  const share = await createdShare.json();
  assert.equal(Buffer.from(share.token, 'base64url').length, 32);
  assert.equal(share.url, `${origin}/s/${share.token}`);
  assert.equal(share.maxViews, 2);
  const listed = await (await f.request(`${base}/items/${itemId}/shares`, {}, member.cookie)).json();
  assert.equal(listed.shares.length, 1);
  assert.equal('token' in listed.shares[0], false);
  assert.equal(JSON.stringify(listed).includes(share.token), false);
  const ownerList = await (await f.request(`${base}/items/${itemId}/shares`, {}, admin.cookie)).json();
  assert.equal(ownerList.shares.length, 1);

  const first = await f.request(`/api/s/${share.token}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const firstBody = await first.json();
  assert.equal(firstBody.item.text, 'secret clip');
  assert.equal(firstBody.item.userId, undefined);
  assert.equal(firstBody.item.id, undefined);
  assert.equal(firstBody.views, 1);
  assert.equal((await (await f.request(`/api/s/${share.token}`)).json()).views, 2);
  const exhausted = await f.request(`/api/s/${share.token}`);
  const unknown = await f.request(`/api/s/${'a'.repeat(43)}`);
  const malformed = await f.request('/api/s/short');
  assert.equal(exhausted.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(malformed.status, 404);
  const exhaustedBody = await exhausted.json();
  assert.deepEqual(exhaustedBody, await unknown.json());
  assert.deepEqual(exhaustedBody, { error: { code: 'NOT_FOUND' } });

  const hour = await (await f.json(`${base}/items/${itemId}/shares`, { expiresIn: '1h' }, member.cookie)).json();
  f.advance(3600001);
  assert.equal((await f.request(`/api/s/${hour.token}`)).status, 404);
  const day = await (await f.json(`${base}/items/${itemId}/shares`, { expiresIn: '1d', maxViews: null }, admin.cookie)).json();
  assert.equal((await f.request(`/api/s/${day.token}`)).status, 200);
  assert.equal((await f.request(`${base}/shares/${day.id}`, { method: 'DELETE' }, other.cookie)).status, 403);
  assert.equal((await f.request(`${base}/shares/${day.id}`, { method: 'DELETE' }, admin.cookie)).status, 204);
  const revoked = await f.request(`/api/s/${day.token}`);
  assert.equal(revoked.status, 404);
  assert.deepEqual(await revoked.json(), { error: { code: 'NOT_FOUND' } });
  await f.service.cleanup();
  assert.equal((await (await f.request(`${base}/items/${itemId}/shares`, {}, admin.cookie)).json()).shares.some((row: { id: string }) => row.id === day.id), false);

  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const uploaded = await (await f.upload(base, member.cookie, png, 'image/png', 'shot.png')).json();
  const fileShare = await (await f.json(`${base}/items/${uploaded.item.id}/shares`, { expiresIn: '7d', maxViews: 1 }, member.cookie)).json();
  const opened = await (await f.request(`/api/s/${fileShare.token}`)).json();
  assert.equal(opened.item.filename, 'shot.png');
  assert.equal(opened.item.hasThumbnail, true);
  assert.equal(opened.item.text, null);
  const download = await f.request(`/api/s/${fileShare.token}/file?access=${opened.access}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal(Buffer.compare(Buffer.from(await download.arrayBuffer()), png), 0);
  const thumb = await f.request(`/api/s/${fileShare.token}/thumbnail?access=${opened.access}`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/webp');
  assert.equal((await f.request(`/api/s/${fileShare.token}`)).status, 404);
  f.advance(600001);
  assert.equal((await f.request(`/api/s/${fileShare.token}/file?access=${opened.access}`)).status, 404);
  assert.equal((await f.request(`/api/s/${fileShare.token}/file`)).status, 404);

  const directShare = await (await f.json(`${base}/items/${uploaded.item.id}/shares`, { expiresIn: 'never', maxViews: 1 }, member.cookie)).json();
  const direct = await f.request(`/api/s/${directShare.token}/file`);
  assert.equal(direct.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await direct.arrayBuffer()), png), 0);
  assert.equal((await f.request(`/api/s/${directShare.token}/file`)).status, 404);
  assert.equal((await f.request(`/api/s/${directShare.token}`)).status, 404);

  const lasting = await (await f.json(`${base}/items/${itemId}/shares`, { expiresIn: 'never' }, member.cookie)).json();
  assert.equal((await f.request(`/api/s/${lasting.token}`)).status, 200);
  assert.equal((await f.request(`${base}/items/${itemId}`, { method: 'DELETE' }, member.cookie)).status, 204);
  assert.equal((await f.request(`/api/s/${lasting.token}`)).status, 404);
  assert.equal((await f.request(`${base}/items/${itemId}/shares`, {}, member.cookie)).status, 404);

  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const roomItem = await (await f.json(`/api/rooms/${room.token}/items/text`, { text: 'room secret' })).json();
  const roomShare = await f.json(`/api/rooms/${room.token}/items/${roomItem.item.id}/shares`, { expiresIn: '1d', maxViews: 5 });
  assert.equal(roomShare.status, 201);
  const roomBody = await roomShare.json();
  assert.equal((await (await f.request(`/api/s/${roomBody.token}`)).json()).item.text, 'room secret');
  assert.equal((await f.request(`/api/rooms/${room.token}/shares/${roomBody.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await f.request(`/api/s/${roomBody.token}`)).status, 404);
});

test('media preview uses sniffed bytes and range, and HTML stays download-only', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const base = `/api/spaces/${admin.space.id}`;
  const mp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 20]),
    Buffer.from('ftypisom'),
    Buffer.alloc(4),
    Buffer.from('isomclip-bytes!!'),
  ]);
  const uploaded = await (await f.upload(base, admin.cookie, mp4, 'text/html', 'clip.mp4')).json();
  const media = await f.request(`${base}/items/${uploaded.item.id}/media`, {}, admin.cookie);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'video/mp4');
  assert.match(media.headers.get('content-disposition') ?? '', /^inline;/);
  assert.equal(media.headers.get('accept-ranges'), 'bytes');
  assert.equal(media.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.compare(Buffer.from(await media.arrayBuffer()), mp4), 0);
  const partial = await f.request(`${base}/items/${uploaded.item.id}/media`, { headers: { range: 'bytes=0-3' } }, admin.cookie);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 0-3/${mp4.length}`);
  assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), mp4.subarray(0, 4).toString());
  assert.equal((await f.request(`${base}/items/${uploaded.item.id}/media`, { headers: { range: `bytes=${mp4.length}-` } }, admin.cookie)).status, 416);

  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const evil = await (await f.upload(base, admin.cookie, html, 'video/mp4', 'evil.mp4')).json();
  assert.equal((await f.request(`${base}/items/${evil.item.id}/media`, {}, admin.cookie)).status, 404);
  const download = await f.request(`${base}/items/${evil.item.id}/download`, {}, admin.cookie);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);

  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);
  assert.equal(sniffMedia(wav)?.contentType, 'audio/wav');
  assert.equal(sniffMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(sniffMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.deepEqual(parseByteRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.equal(parseByteRange('not-a-range', 10), null);

  const share = await (await f.json(`${base}/items/${uploaded.item.id}/shares`, { expiresIn: '1d', maxViews: 2 }, admin.cookie)).json();
  const opened = await (await f.request(`/api/s/${share.token}`)).json();
  const shared = await f.request(`/api/s/${share.token}/media?access=${opened.access}`, { headers: { range: 'bytes=-4' } });
  assert.equal(shared.status, 206);
  assert.equal(shared.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await shared.arrayBuffer()).toString(), mp4.subarray(mp4.length - 4).toString());
  const again = await (await f.request(`/api/s/${share.token}`)).json();
  assert.equal(again.views, 2);
  assert.equal((await f.request(`${base}/items/${uploaded.item.id}/media`)).status, 401);
});

test('tags and pins sync, validate, and keep creation time', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id, 2);
  const member = await f.login('member', invite.token);
  const other = await f.login('other', invite.token);
  const base = `/api/spaces/${admin.space.id}`;
  const received: string[] = [];
  f.events.subscribe(admin.space.id, { send(data) { received.push(data); }, close() {} }, () => true);
  const older = await (await f.json(`${base}/items/text`, { text: 'older' }, member.cookie)).json();
  assert.equal(older.item.pinned, false);
  assert.deepEqual(older.item.tags, []);
  f.advance(1000);
  const newer = await (await f.json(`${base}/items/text`, { text: 'newer' }, member.cookie)).json();
  assert.equal(newer.item.text, 'newer');
  let snapshot = await (await f.request(`${base}/items`, {}, member.cookie)).json();
  assert.deepEqual(snapshot.items.map((item: { text: string }) => item.text), ['newer', 'older']);

  const tagged = await f.json(`${base}/items/${older.item.id}/labels`, { tags: [' #上线 ', '上线', '运维'] }, member.cookie, 'PATCH');
  assert.equal(tagged.status, 200);
  const taggedBody = await tagged.json();
  assert.deepEqual(taggedBody.item.tags, ['上线', '运维']);
  assert.equal(taggedBody.item.pinned, false);
  assert.equal(taggedBody.item.createdAt, older.item.createdAt);
  assert.equal(taggedBody.item.updatedAt, older.item.updatedAt);
  assert.equal(taggedBody.item.text, 'older');

  const pinned = await f.json(`${base}/items/${older.item.id}/labels`, { pinned: true }, member.cookie, 'PATCH');
  assert.equal(pinned.status, 200);
  const pinnedBody = await pinned.json();
  assert.equal(pinnedBody.item.pinned, true);
  assert.deepEqual(pinnedBody.item.tags, ['上线', '运维']);
  const event = JSON.parse(received.at(-1)!);
  assert.equal(event.type, 'item.updated');
  assert.equal(event.item.id, older.item.id);
  assert.equal(event.item.pinned, true);
  assert.deepEqual(event.item.tags, ['上线', '运维']);
  snapshot = await (await f.request(`${base}/items`, {}, member.cookie)).json();
  assert.deepEqual(snapshot.items.map((item: { text: string }) => item.text), ['older', 'newer']);

  const removed = await f.json(`${base}/items/${older.item.id}/labels`, { tags: ['运维'] }, member.cookie, 'PATCH');
  assert.deepEqual((await removed.json()).item.tags, ['运维']);
  assert.equal((await f.json(`${base}/items/${older.item.id}/labels`, { tags: ['has space'] }, member.cookie, 'PATCH')).status, 400);
  assert.equal((await f.json(`${base}/items/${older.item.id}/labels`, { tags: ['x'.repeat(25)] }, member.cookie, 'PATCH')).status, 400);
  assert.equal((await f.json(`${base}/items/${older.item.id}/labels`, { tags: ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'] }, member.cookie, 'PATCH')).status, 400);
  assert.equal((await f.json(`${base}/items/${older.item.id}/labels`, {}, member.cookie, 'PATCH')).status, 400);
  assert.equal((await f.json(`${base}/items/${older.item.id}/labels`, { pinned: 'yes' }, member.cookie, 'PATCH')).status, 400);
  assert.equal((await (await f.request(`${base}/items`, {}, member.cookie)).json()).items.find((item: { id: string }) => item.id === older.item.id).tags.length, 1);
  assert.equal((await f.json(`${base}/items/${older.item.id}/labels`, { tags: [] }, other.cookie, 'PATCH')).status, 403);
  assert.equal((await f.json(`${base}/items/${older.item.id}/labels`, { pinned: false }, admin.cookie, 'PATCH')).status, 200);

  const uploaded = await (await f.upload(base, member.cookie, 'file-body', 'application/octet-stream', 'notes.txt')).json();
  const fileLabels = await f.json(`${base}/items/${uploaded.item.id}/labels`, { tags: ['附件'], pinned: true }, member.cookie, 'PATCH');
  assert.equal(fileLabels.status, 200);
  assert.equal((await fileLabels.json()).item.pinned, true);

  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const roomItem = await (await f.json(`/api/rooms/${room.token}/items/text`, { text: 'room' })).json();
  const roomLabels = await f.json(`/api/rooms/${room.token}/items/${roomItem.item.id}/labels`, { pinned: true, tags: ['#房间'] }, '', 'PATCH');
  assert.equal(roomLabels.status, 200);
  const roomBody = await roomLabels.json();
  assert.equal(roomBody.item.pinned, true);
  assert.deepEqual(roomBody.item.tags, ['房间']);
  const roomList = await (await f.request(`/api/rooms/${room.token}/items`)).json();
  assert.equal(roomList.items[0].pinned, true);
});

test('AC-S1/S3: raster previews preserve aspect, never enlarge, strip metadata and leave Item/quota unchanged', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  for (const format of ['jpeg', 'png', 'webp', 'gif', 'avif'] as const) {
    const bytes = await sharp({ create: { width: 48, height: 24, channels: 3, background: 'blue' } }).toFormat(format).toBuffer();
    const upload = await f.upload(base, admin.cookie, bytes, `image/${format}`);
    assert.equal(upload.status, 201);
    const { item } = await upload.json();
    const quota = f.repo.usage(admin.user.id);
    const files = await readdir(join(f.directory, 'files'));
    const preview = await f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/webp');
    assert.equal(preview.headers.get('content-disposition'), 'inline');
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(preview.headers.get('cache-control'), 'private, max-age=60');
    const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 48);
    assert.equal(metadata.height, 24);
    assert.equal(f.repo.usage(admin.user.id), quota);
    assert.deepEqual(await readdir(join(f.directory, 'files')), files);
    const snapshot = await (await f.request(`${base}/items`, {}, admin.cookie)).json();
    assert.deepEqual(snapshot.items.find((entry: { id: string }) => entry.id === item.id), item);
  }
  const large = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: 'red' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  assert((await sharp(large).metadata()).exif);
  const { item } = await (await f.upload(base, admin.cookie, large, 'image/jpeg')).json();
  const preview = await f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie);
  const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.height, 2048);
  for (const field of ['exif', 'icc', 'iptc', 'xmp', 'orientation'] as const) assert.equal(metadata[field], undefined);
  f.advance(f.config.retentionMs - 2500);
  assert.equal((await f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie)).headers.get('cache-control'), 'private, max-age=2');
});

test('AC-S1: animated GIF preview contains only the first frame', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  const pixels = Buffer.alloc(32 * 32 * 3);
  for (let pixel = 0; pixel < 32 * 32; pixel++) pixels[pixel * 3 + (pixel < 32 * 16 ? 0 : 2)] = 255;
  const gif = await sharp(pixels, { raw: { width: 32, height: 32, channels: 3, pageHeight: 16 } }).gif({ delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 2);
  const { item } = await (await f.upload(base, admin.cookie, gif, 'image/gif')).json();
  const preview = await f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie);
  assert.equal(preview.status, 200);
  const output = Buffer.from(await preview.arrayBuffer());
  const metadata = await sharp(output, { animated: true }).metadata();
  assert.equal(metadata.width, 32);
  assert.equal(metadata.height, 16);
  assert((metadata.pages ?? 1) === 1);
  const { data } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  assert(data[0] > 240 && data[2] < 15, 'first frame must be red, not the blue second frame');
});

test('AC-S4: preview requires membership or the correct unexpired room capability', async t => {
  const f = await fixture({ roomRetentionMs: 1000 }); t.after(() => f.dispose());
  const admin = await f.admin();
  const invite = await f.invite(admin.cookie, admin.space.id);
  const member = await f.login('member', invite.token);
  const { spaces } = await (await f.request('/api/spaces', {}, member.cookie)).json();
  const privateSpace = spaces.find((space: { ownerId: string }) => space.ownerId !== admin.user.id);
  const base = `/api/spaces/${privateSpace.id}`;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();
  const { item } = await (await f.upload(base, member.cookie, png, 'image/png')).json();
  assert.equal((await f.request(`${base}/items/${item.id}/preview`, {}, member.cookie)).status, 200);
  assert.equal((await f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie)).status, 404);
  assert.equal((await f.request(`${base}/items/${item.id}/preview`)).status, 401);
  assert.equal((await f.request(`/api/spaces/${admin.space.id}/items/${item.id}/preview`, {}, admin.cookie)).status, 404);
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const other = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const roomBase = `/api/rooms/${room.token}`;
  const uploaded = await (await f.upload(roomBase, '', png, 'image/png')).json();
  assert.equal((await f.request(`${roomBase}/items/${uploaded.item.id}/preview`)).status, 200);
  assert.equal((await f.request(`/api/rooms/${other.token}/items/${uploaded.item.id}/preview`)).status, 404);
  f.advance(1001);
  assert.equal((await f.request(`${roomBase}/items/${uploaded.item.id}/preview`)).status, 404);
});

test('AC-S4: share previews reuse access and enforce views, ticket expiry, link expiry and revocation', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();
  const { item } = await (await f.upload(base, admin.cookie, png, 'image/png')).json();
  const share = async (expiresIn = 'never', maxViews: number | null = 1) =>
    (await f.json(`${base}/items/${item.id}/shares`, { expiresIn, maxViews }, admin.cookie)).json();
  const once = await share();
  const opened = await (await f.request(`/api/s/${once.token}`)).json();
  for (let request = 0; request < 2; request++) {
    const preview = await f.request(`/api/s/${once.token}/preview?access=${opened.access}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    assert.equal(preview.headers.get('content-type'), 'image/webp');
    assert.equal(preview.headers.get('content-disposition'), 'inline');
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal(f.repo.sharesForItem(item.id).find(row => row.id === once.id)?.views, 1);
  assert.equal((await f.request(`/api/s/${once.token}/preview`)).status, 404);
  assert.equal((await f.request(`/api/s/${once.token}/preview?access=wrong`)).status, 404);
  f.advance(600001);
  assert.equal((await f.request(`/api/s/${once.token}/preview?access=${opened.access}`)).status, 404);
  const direct = await share();
  assert.equal((await f.request(`/api/s/${direct.token}/preview`)).status, 200);
  assert.equal((await f.request(`/api/s/${direct.token}/preview`)).status, 404);
  const revoked = await share();
  const revokedAccess = (await (await f.request(`/api/s/${revoked.token}`)).json()).access;
  assert.equal((await f.request(`${base}/shares/${revoked.id}`, { method: 'DELETE' }, admin.cookie)).status, 204);
  assert.equal((await f.request(`/api/s/${revoked.token}/preview?access=${revokedAccess}`)).status, 404);
  const expiring = await share('1h', null);
  f.advance(3600000 - 1);
  const expiringAccess = (await (await f.request(`/api/s/${expiring.token}`)).json()).access;
  f.advance(2);
  assert.equal((await f.request(`/api/s/${expiring.token}/preview?access=${expiringAccess}`)).status, 404);
  const lasting = await share('never', null);
  const lastingAccess = (await (await f.request(`/api/s/${lasting.token}`)).json()).access;
  await f.request(`${base}/items/${item.id}`, { method: 'DELETE' }, admin.cookie);
  const removed = await f.request(`/api/s/${lasting.token}/preview?access=${lastingAccess}`);
  assert.equal(removed.status, 404);
  assert.deepEqual(await removed.json(), { error: { code: 'NOT_FOUND' } });
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
});

test('AC-S4: preview rejects SVG, HTML, nonimages, corruption and excessive decoded pixels', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
  for (const [bytes, mime] of [[svg, 'image/svg+xml'], ['<script>alert(1)</script>', 'text/html'], ['not an image', 'application/octet-stream']]) {
    const { item } = await (await f.upload(base, admin.cookie, bytes, mime)).json();
    const preview = await f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie);
    assert.equal(preview.status, 404);
    assert.equal(preview.headers.get('content-disposition'), null);
    assert.deepEqual(await preview.json(), { error: { code: 'NOT_FOUND' } });
  }
  const text = await (await f.json(`${base}/items/text`, { text: 'text' }, admin.cookie)).json();
  assert.equal((await f.request(`${base}/items/${text.item.id}/preview`, {}, admin.cookie)).status, 404);
  for (const bytes of [svg, '<html>fake</html>', 'broken PNG']) {
    const response = await f.upload(base, admin.cookie, bytes, 'image/png');
    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), { error: { code: 'INVALID_IMAGE' } });
  }
  const oversized = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: 'red' } }).png().toBuffer();
  assert.equal((await f.upload(base, admin.cookie, oversized, 'image/png')).status, 415);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();
  const { item } = await (await f.upload(base, admin.cookie, png, 'image/png')).json();
  const bytes = f.files.bytes.bind(f.files);
  for (const invalid of [Buffer.from(svg), Buffer.from('corrupt /private/path'), oversized]) {
    f.files.bytes = async () => invalid;
    const preview = await f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie);
    assert.equal(preview.status, 415);
    assert.deepEqual(await preview.json(), { error: { code: 'INVALID_IMAGE' } });
    assert.equal(preview.headers.get('content-disposition'), null);
  }
  f.files.bytes = bytes;
  assert.equal((await f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie)).status, 200);
});

test('AC-S2/S4: on-demand previews leave no cache after retraction/expiry/cleanup, including in-flight generation', { timeout: 10000 }, async t => {
  const f = await fixture({ retentionMs: 1000 }); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();
  const { item } = await (await f.upload(base, admin.cookie, png, 'image/png')).json();
  assert.equal((await f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie)).status, 200);
  const read = f.files.bytes.bind(f.files);
  let started!: () => void; let release!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.files.bytes = async key => { const result = await read(key); started(); await blocked; return result; };
  const pending = f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie);
  await reading;
  try {
    assert.equal((await f.request(`${base}/items/${item.id}`, { method: 'DELETE' }, admin.cookie)).status, 204);
  } finally { release(); }
  assert.equal((await pending).status, 404);
  f.files.bytes = read;
  assert.equal((await f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie)).status, 404);
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
  const second = await (await f.upload(base, admin.cookie, png, 'image/png')).json();
  assert.equal((await f.request(`${base}/items/${second.item.id}/preview`, {}, admin.cookie)).status, 200);
  assert.equal((await readdir(join(f.directory, 'files'))).length, 2);
  f.advance(1001);
  assert.equal((await f.request(`${base}/items/${second.item.id}/preview`, {}, admin.cookie)).status, 404);
  await f.service.cleanup();
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
  assert.equal(f.repo.usage(admin.user.id), 0);
});

test('AC-S2/S4: all preview routes share a two-generation cap and release slots after failures', { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();
  const { item } = await (await f.upload(base, admin.cookie, png, 'image/png')).json();
  const share = await (await f.json(`${base}/items/${item.id}/shares`, { expiresIn: 'never' }, admin.cookie)).json();
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const roomItem = await (await f.upload(`/api/rooms/${room.token}`, '', png, 'image/png')).json();
  const read = f.files.bytes.bind(f.files);
  let reads = 0; let started!: () => void; let release!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const brokenKey = f.repo.item(item.id, Date.now())!.fileKey;
  f.files.bytes = async key => {
    if (++reads === 2) started();
    await blocked;
    return key === brokenKey ? Buffer.from('broken') : read(key);
  };
  const member = f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie);
  const anonymous = f.request(`/api/rooms/${room.token}/items/${roomItem.item.id}/preview`);
  await reading;
  try {
    const busy = await f.request(`/api/s/${share.token}/preview`);
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get('retry-after'), '1');
    assert.deepEqual(await busy.json(), { error: { code: 'PREVIEW_BUSY' } });
    assert.equal(reads, 2);
  } finally { release(); }
  assert.equal((await member).status, 415);
  assert.equal((await anonymous).status, 200);
  f.files.bytes = read;
  const responses = await Promise.all([
    f.request(`${base}/items/${item.id}/preview`, {}, admin.cookie),
    f.request(`/api/s/${share.token}/preview`),
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
});

test('AC-S1: preview inherits the thumbnail share and room rate limits', async t => {
  const f = await fixture({ rateUpload: 2, rateAuth: 1000 }); t.after(() => f.dispose());
  const admin = await f.admin(); const base = `/api/spaces/${admin.space.id}`;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();
  const { item } = await (await f.upload(base, admin.cookie, png, 'image/png')).json();
  const share = await (await f.json(`${base}/items/${item.id}/shares`, { expiresIn: 'never' }, admin.cookie)).json();
  assert.equal((await f.request(`/api/s/${share.token}/thumbnail`)).status, 200);
  assert.equal((await f.request(`/api/s/${share.token}/preview`)).status, 200);
  const limited = await f.request(`/api/s/${share.token}/preview`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.deepEqual(await limited.json(), { error: { code: 'RATE_LIMITED' } });
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const roomBase = `/api/rooms/${room.token}`;
  const roomItem = await (await f.upload(roomBase, '', png, 'image/png')).json();
  assert.equal((await f.request(`${roomBase}/items/${roomItem.item.id}/preview`)).status, 200);
  assert.equal((await f.request(`${roomBase}/items/${roomItem.item.id}/preview`)).status, 429);
});

test('schema v3 migrates share links without dropping items', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-mig4-'));
  const path = join(directory, 'dropit.sqlite');
  const db = new Database(path);
  db.exec(migration1);
  db.exec(migration2);
  db.exec(migration3);
  db.prepare('INSERT INTO users (id,email,name,role,disabled,createdAt) VALUES (?,?,?,?,?,?)').run('u', 'old@example.com', 'Old', 'user', 0, 1);
  db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES (?,?,?,?,?)').run('s', 'Private space', 'u', null, null);
  db.prepare(`INSERT INTO items (id,spaceId,userId,kind,text,filename,mime,size,storedBytes,fileKey,thumbnailKey,createdAt,expiresAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('i', 's', 'u', 'text', 'kept', null, null, 4, 4, null, null, 50, 9_999_999_999_999, 50);
  db.close();
  const repo = new SqliteRepository(path);
  t.after(async () => {
    repo.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(repo.item('i', Date.now())?.text, 'kept');
  repo.createShare({
    id: 'share', tokenHash: 'hash', itemId: 'i', spaceId: 's', createdBy: 'u', expiresAt: null,
    maxViews: 1, views: 0, revoked: 0, createdAt: 50, downloadTicketHash: null, downloadTicketExpiresAt: null,
  });
  assert.equal(repo.sharesForItem('i')[0]?.maxViews, 1);
  assert.equal(repo.shareById('share')?.userId, 'u');
});

test('schema v1 migrates without dropping users', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-mig-'));
  const path = join(directory, 'dropit.sqlite');
  const db = new Database(path);
  db.exec(migration1);
  db.prepare('INSERT INTO users (id,email,name,role,disabled,createdAt) VALUES (?,?,?,?,?,?)').run('u', 'old@example.com', 'Old', 'user', 0, 1);
  db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES (?,?,?,?,?)').run('s', 'Private space', 'u', null, null);
  db.prepare(`INSERT INTO items (id,spaceId,userId,kind,text,filename,mime,size,storedBytes,fileKey,thumbnailKey,createdAt,expiresAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('i', 's', 'u', 'text', 'old text', null, null, 8, 8, null, null, 50, 9_999_999_999_999);
  db.close();
  const repo = new SqliteRepository(path);
  t.after(async () => {
    repo.close();
    await rm(directory, { recursive: true, force: true });
  });
  const users = repo.users();
  assert.equal(users.length, 1);
  assert.equal(users[0]?.email, 'old@example.com');
  assert.equal(users[0]?.pending, 0);
  assert.equal(users[0]?.quotaBytes, null);
  const migrated = repo.item('i', Date.now());
  assert.equal(migrated?.text, 'old text');
  assert.equal(migrated?.createdAt, 50);
  assert.equal(migrated?.updatedAt, 50);
  assert.equal(migrated?.pinned, 0);
  assert.deepEqual(migrated?.tags, []);
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

test('an aborted or short upload leaves no file and does not consume quota', { timeout: 15000 }, async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const space = f.repo.space(admin.space.id);
  assert.ok(space);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('short'));
    controller.close();
  } });
  await assert.rejects(
    () => f.service.upload(space, undefined, body, 'short.bin', 'application/octet-stream', 64),
    (error: unknown) => error instanceof ApiError && error.status === 400 && error.code === 'UPLOAD_INCOMPLETE',
  );
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
  assert.equal(f.repo.usage(admin.user.id), 0);
  assert.equal(f.repo.items(admin.space.id, Date.now()).length, 0);

  const server = serve({ fetch: f.app.fetch, port: 0, hostname: '127.0.0.1', websocket: f.websocket }) as Server;
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port: address.port, method: 'POST',
      path: `/api/spaces/${admin.space.id}/items/file`,
      headers: {
        origin, cookie: admin.cookie, 'content-type': 'application/octet-stream',
        'content-length': String(1024 * 1024), 'x-file-name': encodeURIComponent('cut.bin'),
      },
    }, (res) => { res.resume(); res.on('end', () => resolve()); });
    req.on('error', () => resolve());
    req.write(Buffer.alloc(64 * 1024, 7));
    setTimeout(() => req.destroy(), 30);
  });
  let idle = 0;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && idle < 5) {
    const leftover = (await readdir(join(f.directory, 'files'))).length > 0
      || f.repo.usage(admin.user.id) !== 0
      || f.repo.items(admin.space.id, Date.now()).length !== 0;
    idle = leftover ? 0 : idle + 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(idle >= 5, true);
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
  assert.equal(f.repo.usage(admin.user.id), 0);
});

test('RHEA-190 step 5: demo groups are created, assigned, renamed, deleted and synced', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const base = `/api/spaces/${admin.space.id}`;
  const received: any[] = [];
  f.events.subscribe(admin.space.id, { send(data) { received.push(JSON.parse(data)); }, close() {} }, () => true);

  assert.deepEqual(await (await f.request(`${base}/groups`, {}, admin.cookie)).json(), { groups: [] });
  const plain = await (await f.json(`${base}/items/text`, { text: 'no group' }, admin.cookie)).json();
  assert.equal(plain.item.group, null);
  assert.equal(plain.item.device, null);

  const created = await f.json(`${base}/groups`, { name: ' 工作 ' }, admin.cookie);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { groups: ['工作'] });
  assert.deepEqual(received.at(-1), { type: 'groups', groups: ['工作'] });
  assert.equal((await f.json(`${base}/groups`, { name: '工作' }, admin.cookie)).status, 409);
  for (const name of ['', '全部', '未分组', 'x'.repeat(25), 'a\u0007b', 42]) {
    const bad = await f.json(`${base}/groups`, { name }, admin.cookie);
    assert.equal(bad.status, 400, String(name));
    assert.equal((await bad.json()).error.code, 'INVALID_GROUP');
  }

  // Posting into a group that does not exist yet creates it (in order).
  const inGroup = await (await f.json(`${base}/items/text`, { text: 'grocery', group: '生活' }, admin.cookie)).json();
  assert.equal(inGroup.item.group, '生活');
  assert.deepEqual((await (await f.request(`${base}/groups`, {}, admin.cookie)).json()).groups, ['工作', '生活']);
  const file = await (await f.request(`${base}/items/file`, { method: 'POST', headers: {
    'content-type': 'text/plain', 'x-file-name': 'a.txt', 'x-dropit-group': encodeURIComponent('工作') }, body: 'file' }, admin.cookie)).json();
  assert.equal(file.item.group, '工作');

  const moved = await f.json(`${base}/items/${plain.item.id}/labels`, { group: '工作' }, admin.cookie, 'PATCH');
  assert.equal(moved.status, 200);
  const movedBody = await moved.json();
  assert.equal(movedBody.item.group, '工作');
  assert.equal(movedBody.item.createdAt, plain.item.createdAt);
  assert.equal((await f.json(`${base}/items/${plain.item.id}/labels`, { group: 3 }, admin.cookie, 'PATCH')).status, 400);
  let snapshot = await (await f.request(`${base}/items`, {}, admin.cookie)).json();
  assert.deepEqual(snapshot.groups, ['工作', '生活']);
  assert.equal(snapshot.items.find((item: { id: string }) => item.id === plain.item.id).group, '工作');

  const renamed = await f.json(`${base}/groups/${encodeURIComponent('工作')}`, { name: '项目' }, admin.cookie, 'PATCH');
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), { groups: ['项目', '生活'] });
  const renameEvents = received.filter(event => event.type === 'item.updated' && event.item.group === '项目');
  assert.deepEqual(renameEvents.map(event => event.item.id).sort(), [plain.item.id, file.item.id].sort());
  assert.equal((await f.json(`${base}/groups/${encodeURIComponent('生活')}`, { name: '项目' }, admin.cookie, 'PATCH')).status, 409);
  assert.equal((await f.json(`${base}/groups/nope`, { name: 'x' }, admin.cookie, 'PATCH')).status, 404);

  const deleted = await f.request(`${base}/groups/${encodeURIComponent('项目')}`, { method: 'DELETE' }, admin.cookie);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { groups: ['生活'] });
  snapshot = await (await f.request(`${base}/items`, {}, admin.cookie)).json();
  assert.equal(snapshot.items.find((item: { id: string }) => item.id === plain.item.id).group, null);
  assert.equal(snapshot.items.find((item: { id: string }) => item.id === inGroup.item.id).group, '生活');
  const ungroup = await f.json(`${base}/items/${inGroup.item.id}/labels`, { group: null }, admin.cookie, 'PATCH');
  assert.equal((await ungroup.json()).item.group, null);

  // Rooms get the same API; other spaces cannot see these groups.
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  assert.equal((await f.json(`/api/rooms/${room.token}/groups`, { name: '临时' })).status, 201);
  assert.deepEqual((await (await f.request(`/api/rooms/${room.token}/items`)).json()).groups, ['临时']);
  assert.deepEqual((await (await f.request(`${base}/groups`, {}, admin.cookie)).json()).groups, ['生活']);
  const other = await f.login('outsider');
  assert.ok([401, 403].includes((await f.request(`${base}/groups`, {}, other.cookie)).status));
});

test('RHEA-190 step 5: group limit per space', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const base = `/api/spaces/${admin.space.id}`;
  for (let index = 0; index < 24; index++) assert.equal((await f.json(`${base}/groups`, { name: `g${index}` }, admin.cookie)).status, 201);
  const over = await f.json(`${base}/groups`, { name: 'one more' }, admin.cookie);
  assert.equal(over.status, 409);
  assert.equal((await over.json()).error.code, 'GROUP_LIMIT');
});

test('RHEA-190 step 5: items remember the sending device and presence names peers', { timeout: 15000 }, async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const admin = await f.admin();
  const base = `/api/spaces/${admin.space.id}`;
  const deviceHeaders = { 'x-dropit-device': 'dev-mac-123', 'x-dropit-device-name': encodeURIComponent('Mac · Chrome'), 'x-dropit-device-kind': 'mac' };
  const text = await (await f.request(`${base}/items/text`, { method: 'POST', headers: { 'content-type': 'application/json', ...deviceHeaders },
    body: JSON.stringify({ text: 'from mac' }) }, admin.cookie)).json();
  assert.deepEqual(text.item.device, { id: 'dev-mac-123', name: 'Mac · Chrome', kind: 'mac' });
  const file = await (await f.request(`${base}/items/file`, { method: 'POST', headers: {
    'content-type': 'text/plain', 'x-file-name': 'a.txt', 'x-dropit-device': 'phone-0001', 'x-dropit-device-name': 'iPhone', 'x-dropit-device-kind': 'phone' },
    body: 'hello' }, admin.cookie)).json();
  assert.deepEqual(file.item.device, { id: 'phone-0001', name: 'iPhone', kind: 'phone' });
  // Malformed identity is ignored rather than rejected; unknown kinds fall back to pc.
  const bad = await (await f.request(`${base}/items/text`, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-dropit-device': 'no spaces allowed', 'x-dropit-device-name': 'x' }, body: JSON.stringify({ text: 'anon' }) }, admin.cookie)).json();
  assert.equal(bad.item.device, null);
  const odd = await (await f.request(`${base}/items/text`, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-dropit-device': 'toaster-1', 'x-dropit-device-kind': 'toaster' }, body: JSON.stringify({ text: 'odd' }) }, admin.cookie)).json();
  assert.deepEqual(odd.item.device, { id: 'toaster-1', name: '未命名设备', kind: 'pc' });

  // Chunked uploads carry the identity on complete.
  const session = await (await f.json(`${base}/uploads`, { filename: 'c.bin', size: 4, mime: 'application/octet-stream' }, admin.cookie)).json();
  assert.equal((await f.request(`${base}/uploads/${session.uploadId}/chunks/0`, { method: 'PUT', body: 'abcd' }, admin.cookie)).status, 204);
  const completed = await (await f.request(`${base}/uploads/${session.uploadId}/complete`, { method: 'POST', headers: { ...deviceHeaders, 'x-dropit-group': encodeURIComponent('相册') } }, admin.cookie)).json();
  assert.equal(completed.item.device.name, 'Mac · Chrome');
  assert.equal(completed.item.group, '相册');

  const snapshot = await (await f.request(`${base}/items`, {}, admin.cookie)).json();
  assert.equal(snapshot.items.find((item: { id: string }) => item.id === text.item.id).device.kind, 'mac');
  // Device identity never leaks through a public share.
  const share = await (await f.json(`${base}/items/${text.item.id}/shares`, { expiresIn: '1h' }, admin.cookie)).json();
  const shared = await (await f.request(`/api/s/${share.token}`)).json();
  assert.equal(JSON.stringify(shared).includes('dev-mac-123'), false);

  const server = serve({ fetch: f.app.fetch, port: 0, hostname: '127.0.0.1', websocket: f.websocket }) as Server;
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert(address && typeof address !== 'string');
  const wsUrl = `ws://127.0.0.1:${address.port}${base}/ws`;
  const mac = await connect(`${wsUrl}?${new URLSearchParams({ device: 'dev-mac-123', name: 'Mac · Chrome', kind: 'mac' })}`, admin.cookie);
  t.after(() => mac.ws.terminate());
  assert.equal((await mac.next()).type, 'snapshot');
  assert.deepEqual(await mac.next(), { type: 'presence', devices: 1, peers: [{ id: 'dev-mac-123', name: 'Mac · Chrome', kind: 'mac' }] });
  const legacy = await connect(wsUrl, admin.cookie); t.after(() => legacy.ws.terminate());
  assert.equal((await legacy.next()).type, 'snapshot');
  assert.deepEqual(await legacy.next(), { type: 'presence', devices: 2, peers: [{ id: 'dev-mac-123', name: 'Mac · Chrome', kind: 'mac' }], others: 1 });
  // A second tab of the same browser is another socket but the same device, not an `other` (RHEA-190 m12).
  const macTab = await connect(`${wsUrl}?${new URLSearchParams({ device: 'dev-mac-123', name: 'Mac · Chrome', kind: 'mac' })}`, admin.cookie);
  assert.equal((await macTab.next()).type, 'snapshot');
  assert.deepEqual(await macTab.next(), { type: 'presence', devices: 3, peers: [{ id: 'dev-mac-123', name: 'Mac · Chrome', kind: 'mac' }], others: 1 });
  macTab.ws.close();
  await once(macTab.ws, 'close');
  let settled = await legacy.next();
  while (settled.devices !== 2) settled = await legacy.next();
  const phone = await connect(`${wsUrl}?${new URLSearchParams({ device: 'phone-0001', name: 'iPhone', kind: 'phone' })}`, admin.cookie);
  t.after(() => phone.ws.terminate());
  assert.equal((await phone.next()).type, 'snapshot');
  const three = await phone.next();
  assert.equal(three.devices, 3);
  assert.deepEqual(three.peers.map((peer: { id: string }) => peer.id), ['dev-mac-123', 'phone-0001']);
  mac.ws.close();
  await once(mac.ws, 'close');
  let event = await phone.next();
  while (event.devices !== 2) event = await phone.next();
  assert.deepEqual(event.peers, [{ id: 'phone-0001', name: 'iPhone', kind: 'phone' }]);
});

test('RHEA-190 step 5: migration 9 keeps existing items ungrouped with no device', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-m9-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'db.sqlite');
  const db = new Database(path);
  for (const migration of [migration1, migration2, migration3, migration4, migration5, migration6, migration7, migration8]) db.exec(migration);
  assert.equal(db.pragma('user_version', { simple: true }), 8);
  db.prepare("INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES ('s1','room',NULL,NULL,'rh')").run();
  db.prepare(`INSERT INTO items (id,spaceId,userId,kind,text,size,storedBytes,createdAt,expiresAt,updatedAt)
    VALUES ('i1','s1',NULL,'text','legacy',6,6,1,9999999999999,1)`).run();
  db.close();
  const repo = new SqliteRepository(path);
  t.after(() => repo.close());
  const [item] = repo.items('s1', 2);
  assert.equal(item.text, 'legacy');
  assert.equal(item.group, null);
  assert.equal(item.device, null);
  assert.deepEqual(repo.groups('s1'), []);
  repo.createGroup('s1', '旧组', 3, 24);
  assert.equal(repo.updateLabels('i1', { group: '旧组' }, 4).group, '旧组');
  assert.throws(() => repo.updateLabels('i1', { group: '没有' }, 4), /GROUP_NOT_FOUND/);
});

test('RHEA-190 step 7: one live temporary room per browser key', async t => {
  const f = await fixture({ rateRoom: 2 }); t.after(() => f.dispose());
  const key = 'k'.repeat(43);
  const first = await f.json('/api/rooms', { deviceKey: key });
  assert.equal(first.status, 201);
  const room = await first.json();
  assert.equal(room.reused, false);
  assert.equal(Buffer.from(room.token, 'base64url').length, 32);
  // clicking 临时房间 again from the same browser re-enters the same live room,
  // and doing so does not spend the room-create rate limit
  for (let i = 0; i < 5; i++) {
    const again = await f.json('/api/rooms', { deviceKey: key });
    assert.equal(again.status, 200);
    const body = await again.json();
    assert.equal(body.token, room.token);
    assert.equal(body.expiresAt, room.expiresAt);
    assert.equal(body.reused, true);
  }
  assert.equal((await f.request(`/api/rooms/${room.token}`)).status, 200);
  // another browser gets its own room
  const other = await f.json('/api/rooms', { deviceKey: 'o'.repeat(43) });
  assert.equal(other.status, 201);
  assert.notEqual((await other.json()).token, room.token);
  // malformed keys are rejected; keyless requests still mint an unbound room
  for (const bad of ['short', 'x'.repeat(129), 'has space'.padEnd(40, 'x'), 42]) {
    assert.equal((await f.json('/api/rooms', { deviceKey: bad })).status, 400);
  }
  // the room list never leaks the binding
  const user = await f.admin();
  const spaces = await (await f.request('/api/spaces', {}, user.cookie)).json();
  assert.ok(spaces.spaces.every((space: Record<string, unknown>) => !('deviceHash' in space)));
  // only after the old room expires does the same browser get a new one
  f.advance(86400001);
  assert.equal((await f.request(`/api/rooms/${room.token}`)).status, 404);
  const fresh = await f.json('/api/rooms', { deviceKey: key });
  assert.equal(fresh.status, 201);
  const next = await fresh.json();
  assert.notEqual(next.token, room.token);
  assert.equal((await f.json('/api/rooms', { deviceKey: key })).status, 200);
  assert.equal((await (await f.json('/api/rooms', { deviceKey: key })).json()).token, next.token);
});

test('RHEA-190 step 7: migration 10 adds the per-browser room binding to old databases', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-m10-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'db.sqlite');
  const db = new Database(path);
  for (const migration of [migration1, migration2, migration3, migration4, migration5, migration6, migration7, migration8, migration9]) db.exec(migration);
  assert.equal(db.pragma('user_version', { simple: true }), 9);
  db.prepare("INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES ('s1','room',NULL,9999999999999,'rh')").run();
  db.close();
  const repo = new SqliteRepository(path);
  t.after(() => repo.close());
  assert.equal(repo.room('rh', 1)?.id, 's1');
  assert.equal(repo.deviceRoom('dh', 1), undefined);
  repo.createRoom({ id: 's2', name: 'Temporary room', ownerId: null, expiresAt: 9999999999999, roomHash: 'rh2' }, 'dh');
  assert.equal(repo.deviceRoom('dh', 1)?.id, 's2');
  assert.equal(repo.deviceRoom('dh', 9999999999999), undefined);
  const check = new Database(path, { readonly: true });
  t.after(() => check.close());
  assert.equal(check.pragma('user_version', { simple: true }), 13);
});
