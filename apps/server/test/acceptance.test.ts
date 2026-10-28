// Independent AC-A–I checks for RHEA-166. Mock OAuth is injected through
// createBackend() only; it is not an HTTP switch and is not in the image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import sharp from 'sharp';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { hash, type Identity } from '../src/domain.js';
import { oauthProviders, type OAuthProvider } from '../src/oauth.js';
import { SqliteRepository } from '../src/repository.js';

const require = createRequire(import.meta.url);

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function cookieValue(response: Response, name: string) {
  return response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`))?.split(';')[0] ?? '';
}

function errorCode(response: Response) {
  const location = response.headers.get('location');
  assert.equal(response.status, 302);
  assert.ok(location);
  const url = new URL(location);
  assert.equal(url.pathname, '/login');
  return url.searchParams.get('error');
}

async function fixture(overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-ac-'));
  let time = Date.now();
  const challenges: string[] = [];
  const identities = new Map<string, Identity>();
  let exchanges = 0;
  const provider: OAuthProvider = {
    authorizationUrl(state, challenge, redirect) {
      challenges.push(challenge);
      const url = new URL('https://mock.example/authorize');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('redirect_uri', redirect);
      return url.href;
    },
    async exchange(code, verifier) {
      exchanges += 1;
      assert.ok(challenges.includes(hash(verifier)), 'PKCE verifier must match the issued S256 challenge');
      const identity = identities.get(code);
      if (!identity) throw new Error('Mock provider refused code');
      return identity;
    },
  };
  const config = {
    ...loadConfig({ NODE_ENV: 'development', PORT: '3000', APP_ORIGIN: 'http://127.0.0.1:3000' }),
    dataDir: directory,
    ...overrides,
  };
  const backend = createBackend({
    config,
    providers: { github: provider },
    now: () => time,
    remoteAddress: (c) => c.req.header('x-test-ip') ?? '127.0.0.1',
  });
  const sessionName = config.production ? '__Host-dropit_session' : 'dropit_session';
  const flowName = config.production ? '__Secure-dropit_oauth' : 'dropit_oauth';
  const request = (path: string, init: RequestInit = {}, cookie = '') => backend.app.request(path, {
    ...init,
    headers: { origin: config.origin, ...(cookie ? { cookie } : {}), ...init.headers },
  });
  const json = (path: string, body: unknown, cookie = '', method = 'POST') => request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, cookie);
  const start = async (invite?: string) => {
    const response = await request(`/api/auth/github${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`);
    assert.equal(response.status, 302);
    const url = new URL(response.headers.get('location') ?? '');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge')?.length, 43);
    return { state: url.searchParams.get('state') ?? '', browser: cookieValue(response, flowName), response, url };
  };
  const finish = async (flow: Awaited<ReturnType<typeof start>>, subject: string, email?: string) => {
    identities.set(subject, { provider: 'github', subject, email: email ?? `${subject}@example.com`, name: subject });
    return request(`/api/auth/github/callback?${new URLSearchParams({ state: flow.state, code: subject })}`, {}, flow.browser);
  };
  const login = async (subject: string, invite?: string, email?: string) => {
    const response = await finish(await start(invite), subject, email);
    return { response, cookie: cookieValue(response, sessionName) };
  };
  const upload = (base: string, cookie: string, bytes: Uint8Array | string, mime = 'application/octet-stream', filename = 'test.bin') =>
    request(`${base}/items/file`, {
      method: 'POST',
      headers: { 'content-type': mime, 'x-file-name': encodeURIComponent(filename) },
      body: typeof bytes === 'string' ? bytes : new Uint8Array(bytes),
    }, cookie);
  return {
    ...backend, request, json, start, finish, login, upload, directory, sessionName, flowName,
    exchanges: () => exchanges,
    advance: (ms: number) => { time += ms; },
    async dispose() { await backend.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function bodyCode(response: Response) {
  const body = await response.json() as { error?: { code?: string } };
  return body.error?.code;
}

test('AC-A1: authorize request carries state and PKCE; mismatched state creates no session', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const flow = await f.start();
  assert.equal(flow.url.origin, 'https://mock.example');
  for (const [query, cookie] of [
    ['code=admin', flow.browser],
    ['state=wrong&code=admin', flow.browser],
    [`state=${flow.state}&code=admin`, 'dropit_oauth=other-browser'],
  ] as const) {
    assert.equal(errorCode(await f.request(`/api/auth/github/callback?${query}`, {}, cookie)), 'OAUTH_STATE_INVALID');
  }
  assert.equal(f.exchanges(), 0);
  assert.equal(f.repo.users().length, 0);
  const ok = await f.finish(flow, 'admin');
  assert.equal(ok.status, 302);
  assert.equal(new URL(ok.headers.get('location') ?? '').pathname, '/');
  assert.match(cookieValue(ok, 'dropit_session'), /^dropit_session=/);
  assert.equal(f.exchanges(), 1);
  assert.equal(errorCode(await f.finish(flow, 'admin')), 'OAUTH_STATE_INVALID');
  assert.equal(f.exchanges(), 1);
  assert.equal(f.repo.users().length, 1);
});

test('AC-A2: session cookie flags, logout, disable and expiry all reject the old cookie', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const admin = await f.login('admin');
  assert.match(admin.response.headers.getSetCookie().join(';'), /HttpOnly/);
  assert.match(admin.response.headers.getSetCookie().join(';'), /SameSite=Lax/);
  const invite = await f.json('/api/admin/invites', { spaceId: (await (await f.request('/api/spaces', {}, admin.cookie)).json()).spaces[0].id, maxUses: 2 }, admin.cookie);
  const created = await invite.json() as { token: string };
  const member = await f.login('member', created.token);
  const me = await (await f.request('/api/me', {}, member.cookie)).json() as { user: { id: string } };
  assert.equal((await f.json(`/api/admin/users/${me.user.id}`, { disabled: true }, admin.cookie, 'PATCH')).status, 204);
  assert.equal((await f.request('/api/me', {}, member.cookie)).status, 401);
  assert.equal(errorCode((await f.login('member')).response), 'USER_DISABLED');
  assert.equal((await f.json(`/api/admin/users/${me.user.id}`, { disabled: false }, admin.cookie, 'PATCH')).status, 204);
  const fresh = await f.login('member');
  assert.equal((await f.request('/api/auth/logout', { method: 'POST' }, fresh.cookie)).status, 204);
  assert.equal((await f.request('/api/me', {}, fresh.cookie)).status, 401);
  f.advance(f.config.sessionMs + 1);
  assert.equal((await f.request('/api/me', {}, admin.cookie)).status, 401);

  const production = await fixture({ production: true, origin: 'https://dropit.example' });
  t.after(() => production.dispose());
  const started = await production.start();
  assert.match(started.response.headers.getSetCookie().join(';'), /Secure/);
  assert.match(started.browser, /^__Secure-dropit_oauth=/);
  const signed = await production.finish(started, 'owner');
  assert.equal(signed.status, 302);
  assert.match(cookieValue(signed, '__Host-dropit_session'), /^__Host-dropit_session=/);
  assert.match(signed.headers.getSetCookie().join(';'), /HttpOnly/);
  assert.match(signed.headers.getSetCookie().join(';'), /SameSite=Lax/);
  assert.match(signed.headers.getSetCookie().join(';'), /Secure/);
});

test('AC-A3/B2/B3: no password, invite page does not create a user, first login is admin, strangers need an invite', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  assert.equal((await f.request('/api/auth/password')).status, 404);
  const open = await f.request('/api/auth/github?invite=not-a-real-token');
  assert.equal(open.status, 302);
  assert.equal(new URL(open.headers.get('location') ?? '').origin, 'https://mock.example');
  const first = await f.finish({
    state: new URL(open.headers.get('location') ?? '').searchParams.get('state') ?? '',
    browser: cookieValue(open, 'dropit_oauth'),
    response: open,
    url: new URL(open.headers.get('location') ?? ''),
  }, 'first');
  assert.equal(new URL(first.headers.get('location') ?? '').pathname, '/');
  const adminCookie = cookieValue(first, 'dropit_session');
  const me = await (await f.request('/api/me', {}, adminCookie)).json() as { user: { id: string; role: string } };
  assert.equal(me.user.role, 'admin');
  assert.equal(errorCode((await f.login('stranger')).response), 'INVITATION_REQUIRED');
  assert.equal(f.repo.users().length, 1);
  const spaces = await (await f.request('/api/spaces', {}, adminCookie)).json() as { spaces: { id: string; ownerId: string }[] };
  assert.equal(spaces.spaces.length, 1);
  assert.equal(spaces.spaces[0].ownerId, me.user.id);
  const before = f.repo.users().length;
  const inviteResponse = await f.json('/api/admin/invites', { spaceId: spaces.spaces[0].id }, adminCookie);
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json() as { token: string };
  assert.equal((await f.request(`/api/invites/${invite.token}`)).status, 200);
  assert.equal(f.repo.users().length, before);
  const member = await f.login('member', invite.token);
  assert.equal(member.response.status, 302);
  const memberMe = await (await f.request('/api/me', {}, member.cookie)).json() as { user: { role: string } };
  assert.equal(memberMe.user.role, 'user');
  const memberSpaces = await (await f.request('/api/spaces', {}, member.cookie)).json() as { spaces: unknown[] };
  assert.equal(memberSpaces.spaces.length, 2);

  const listed = await fixture({ adminEmails: ['owner@example.com'] });
  t.after(() => listed.dispose());
  const bootstrap = await listed.login('bootstrap');
  assert.equal((await (await listed.request('/api/me', {}, bootstrap.cookie)).json() as { user: { role: string } }).user.role, 'admin');
  const owner = await listed.login('owner', undefined, 'owner@example.com');
  assert.equal((await (await listed.request('/api/me', {}, owner.cookie)).json() as { user: { role: string } }).user.role, 'admin');
  assert.equal(errorCode((await listed.login('other')).response), 'INVITATION_REQUIRED');
});

test('AC-A4: OAuth credentials come from env, and there is no enabled mock provider', async () => {
  assert.deepEqual(Object.keys(oauthProviders({})), []);
  const github = oauthProviders({ GITHUB_CLIENT_ID: 'id-only-for-this-test', GITHUB_CLIENT_SECRET: 'secret-only-for-this-test' }).github;
  assert.ok(github);
  assert.equal(new URL(github.authorizationUrl('state', 'challenge', 'http://127.0.0.1/callback')).origin, 'https://github.com');
  const example = await readFile(join(repoRoot, '.env.example'), 'utf8');
  for (const key of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    assert.match(example, new RegExp(`^${key}=$`, 'm'));
  }
  const server = await readFile(join(repoRoot, 'apps/server/src/index.ts'), 'utf8');
  assert.doesNotMatch(server, /mock/i);
});

test('AC-B3: two concurrent first sign-ins create exactly one admin', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-ac-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'dropit.sqlite');
  const setup = new SqliteRepository(path);
  setup.close();
  const loader = require.resolve('tsx');
  const race = (subject: string) => new Promise<{ ok: boolean; role?: string; code?: string }>((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./acceptance-race-child.ts', import.meta.url)), {
      execArgv: ['--import', loader],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, RACE_PATH: path, RACE_SUBJECT: subject, RACE_EMAIL: `${subject}@example.com`, RACE_HASH: hash(subject) },
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!out) reject(new Error(`race child exited ${code}: ${err}`));
      else resolve(JSON.parse(out));
    });
  });
  const results = await Promise.all([race('one'), race('two')]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => result.ok)?.role, 'admin');
  assert.equal(results.find((result) => !result.ok)?.code, 'INVITATION_REQUIRED');
  const check = new SqliteRepository(path);
  try {
    const users = check.users();
    assert.equal(users.length, 1);
    assert.equal(users[0].role, 'admin');
  } finally { check.close(); }
});

test('AC-B1: expired, revoked and concurrent one-use invites cannot over-create accounts', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const admin = await f.login('admin');
  const spaceId = ((await (await f.request('/api/spaces', {}, admin.cookie)).json()) as { spaces: { id: string }[] }).spaces[0].id;
  const onceInvite = await (await f.json('/api/admin/invites', { spaceId, maxUses: 1 }, admin.cookie)).json() as { id: string; token: string };
  const flows = await Promise.all([f.start(onceInvite.token), f.start(onceInvite.token)]);
  const results = await Promise.all([f.finish(flows[0], 'one'), f.finish(flows[1], 'two')]);
  const outcomes = results.map((response) => new URL(response.headers.get('location') ?? '').pathname === '/' ? 'ok' : new URL(response.headers.get('location') ?? '').searchParams.get('error')).sort();
  assert.deepEqual(outcomes, ['INVITE_INVALID', 'ok']);
  assert.equal(f.repo.users().length, 2);
  assert.equal((await f.request(`/api/invites/${onceInvite.token}`)).status, 404);

  const revoked = await (await f.json('/api/admin/invites', { spaceId, maxUses: 3 }, admin.cookie)).json() as { id: string; token: string };
  const revokedFlow = await f.start(revoked.token);
  assert.equal((await f.request(`/api/admin/invites/${revoked.id}`, { method: 'DELETE' }, admin.cookie)).status, 204);
  assert.equal(errorCode(await f.finish(revokedFlow, 'revoked-user')), 'INVITE_INVALID');

  const expired = await (await f.json('/api/admin/invites', { spaceId }, admin.cookie)).json() as { token: string };
  f.advance(25 * 3600000);
  assert.equal(errorCode(await f.request(`/api/auth/github?invite=${expired.token}`)), 'INVITE_INVALID');
  assert.equal(f.repo.users().length, 2);
});

test('AC-B4: a normal member cannot administer invites, users or quotas', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const admin = await f.login('admin');
  const spaceId = ((await (await f.request('/api/spaces', {}, admin.cookie)).json()) as { spaces: { id: string }[] }).spaces[0].id;
  const invite = await (await f.json('/api/admin/invites', { spaceId, maxUses: 2 }, admin.cookie)).json() as { token: string };
  const member = await f.login('member', invite.token);
  for (const path of ['/api/admin/users', '/api/admin/invites', '/api/admin/limits']) {
    assert.equal((await f.request(path, {}, member.cookie)).status, 403);
  }
  assert.equal((await f.json('/api/admin/invites', { spaceId }, member.cookie)).status, 403);
  assert.equal((await f.json('/api/admin/users', { email: 'x@example.com' }, member.cookie)).status, 403);
  const users = await (await f.request('/api/admin/users', {}, admin.cookie)).json() as { users: { usedBytes: number; quotaBytes: number }[] };
  assert.equal(typeof users.users[0].usedBytes, 'number');
  assert.ok(users.users[0].quotaBytes > 0);
});

test('AC-C2: cross-space read, download, retract, file-id guessing and websocket subscribe are denied', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const admin = await f.login('admin');
  const adminSpaces = await (await f.request('/api/spaces', {}, admin.cookie)).json() as { spaces: { id: string }[] };
  const invite = await (await f.json('/api/admin/invites', { spaceId: adminSpaces.spaces[0].id }, admin.cookie)).json() as { token: string };
  const member = await f.login('member', invite.token);
  const memberMe = await (await f.request('/api/me', {}, member.cookie)).json() as { user: { id: string } };
  const spaces = await (await f.request('/api/spaces', {}, member.cookie)).json() as { spaces: { id: string; ownerId: string }[] };
  const privateSpace = spaces.spaces.find((space) => space.ownerId === memberMe.user.id);
  assert.ok(privateSpace);
  const base = `/api/spaces/${privateSpace.id}`;
  const uploaded = await (await f.upload(base, member.cookie, 'private-bytes')).json() as { item: { id: string } };
  for (const path of [base, `${base}/items`, `${base}/items/${uploaded.item.id}/download`, `${base}/items/${uploaded.item.id}/thumbnail`]) {
    const response = await f.request(path, {}, admin.cookie);
    assert.equal(response.status, 404);
    assert.equal(await bodyCode(response), 'NOT_FOUND');
  }
  assert.equal((await f.json(`${base}/items/text`, { text: 'intrusion' }, admin.cookie)).status, 404);
  assert.equal((await f.upload(base, admin.cookie, 'intrusion')).status, 404);
  assert.equal((await f.request(`${base}/items/${uploaded.item.id}`, { method: 'DELETE' }, admin.cookie)).status, 404);
  assert.equal((await f.request(`/api/spaces/${adminSpaces.spaces[0].id}/items/${uploaded.item.id}/download`, {}, admin.cookie)).status, 404);
  const unknown = await f.request('/api/spaces/not-a-space/items', {}, admin.cookie);
  assert.equal(unknown.status, 404);
  assert.equal(await bodyCode(unknown), 'NOT_FOUND');

  const server = serve({ fetch: f.app.fetch, port: 0, hostname: '127.0.0.1', websocket: f.websocket }) as Server;
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${base}/ws`, { origin: f.config.origin, headers: { cookie: admin.cookie } });
  const outcome = await new Promise<string>((resolve) => {
    socket.once('unexpected-response', (_request, response) => resolve(`http:${response.statusCode}`));
    socket.once('close', (code) => resolve(`close:${code}`));
    socket.once('error', (error) => resolve(`error:${error.message}`));
  });
  socket.terminate();
  assert.match(outcome, /404|403|1008/);
});

test('AC-D1/D2/D4: realtime delivery, download, retract, thumbnail, and reconnect snapshot', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const admin = await f.login('admin');
  const spaceId = ((await (await f.request('/api/spaces', {}, admin.cookie)).json()) as { spaces: { id: string }[] }).spaces[0].id;
  const base = `/api/spaces/${spaceId}`;
  const server = serve({ fetch: f.app.fetch, port: 0, hostname: '127.0.0.1', websocket: f.websocket }) as Server;
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${base}/ws`, { origin: f.config.origin, headers: { cookie: admin.cookie } });
  const messages: { type: string; item?: { id: string; text?: string }; items?: { text: string }[] }[] = [];
  const waiters: ((message: (typeof messages)[number]) => void)[] = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as (typeof messages)[number];
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  await once(socket, 'open');
  t.after(() => socket.terminate());
  const next = () => messages.length ? Promise.resolve(messages.shift()!) : new Promise<(typeof messages)[number]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket timed out')), 2000);
    waiters.push((message) => { clearTimeout(timer); resolve(message); });
  });
  let first = await next();
  while (first.type === 'presence') first = await next();
  assert.equal(first.type, 'snapshot');
  const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const started = performance.now();
  const created = await f.json(`${base}/items/text`, { text: payload }, admin.cookie);
  assert.equal(created.status, 201);
  assert.match(created.headers.get('content-type') ?? '', /^application\/json/);
  const item = (await created.json() as { item: { id: string; text: string } }).item;
  assert.equal(item.text, payload);
  let event = await next();
  while (event.type === 'presence') event = await next();
  assert.equal(event.type, 'item.created');
  assert.equal(event.item?.id, item.id);
  assert.ok(performance.now() - started < 1000);

  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const uploaded = await f.upload(base, admin.cookie, png, 'image/png', 'shot.png');
  assert.equal(uploaded.status, 201);
  const file = (await uploaded.json() as { item: { id: string; hasThumbnail: boolean } }).item;
  assert.equal(file.hasThumbnail, true);
  const thumbnail = await f.request(`${base}/items/${file.id}/thumbnail`, {}, admin.cookie);
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
  const download = await f.request(`${base}/items/${file.id}/download`, {}, admin.cookie);
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal((await f.request(`${base}/items/${file.id}`, { method: 'DELETE' }, admin.cookie)).status, 204);
  assert.equal((await f.request(`${base}/items/${file.id}/download`, {}, admin.cookie)).status, 404);
  socket.terminate();
  await once(socket, 'close');
  await f.json(`${base}/items/text`, { text: 'while offline' }, admin.cookie);
  const again = new WebSocket(`ws://127.0.0.1:${address.port}${base}/ws`, { origin: f.config.origin, headers: { cookie: admin.cookie } });
  const snapshot = await new Promise<{ items: { text: string | null }[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reconnect timed out')), 2000);
    again.once('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString())); });
  });
  again.terminate();
  assert.ok(snapshot.items.some((entry) => entry.text === 'while offline'));
});

test('AC-D3/E1/E2: room entropy, no enumeration, uniform miss, stricter limits, expiry cleanup', async (t) => {
  const f = await fixture({ roomMaxFileBytes: 10, roomQuotaBytes: 15, roomRetentionMs: 1000 });
  t.after(() => f.dispose());
  assert.ok(f.config.roomRetentionMs <= 86_400_000);
  assert.ok(f.config.roomMaxFileBytes < f.config.maxFileBytes);
  assert.ok(f.config.roomQuotaBytes < f.config.userQuotaBytes);
  assert.ok(f.config.rateRoom < f.config.rateUpload);
  const created = await f.request('/api/rooms', { method: 'POST' });
  assert.equal(created.status, 201);
  const room = await created.json() as { token: string; expiresAt: number };
  assert.match(room.token, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.ok(room.expiresAt - Date.now() <= f.config.roomRetentionMs + 1000);
  assert.equal((await f.request('/api/rooms')).status, 404);
  const base = `/api/rooms/${room.token}`;
  const missing = await f.request('/api/rooms/not-a-room/items');
  const present = await f.request(`${base}/items`);
  assert.equal(present.status, 200);
  assert.equal(missing.status, 404);
  assert.equal(await bodyCode(missing), 'NOT_FOUND');
  assert.equal((await f.upload(base, '', '12345678901')).status, 413);
  assert.equal((await f.upload(base, '', '12345')).status, 201);
  assert.equal((await f.upload(base, '', '123456789012')).status, 413);
  assert.equal((await readdir(join(f.directory, 'files'))).length, 1);
  f.advance(1001);
  const expired = await f.request(`${base}/items`);
  const unknown = await f.request('/api/rooms/still-not-a-room/items');
  assert.equal(expired.status, unknown.status);
  assert.deepEqual(await expired.json(), await unknown.json());
  await f.service.cleanup();
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
});

test('AC-F1/G6: auth and upload return 429 with Retry-After; untrusted forwarding headers do not split the bucket', async (t) => {
  const f = await fixture({ rateAuth: 2 });
  t.after(() => f.dispose());
  assert.equal((await f.request('/api/auth/github')).status, 302);
  assert.equal((await f.request('/api/auth/github', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 302);
  const denied = await f.request('/api/auth/github', { headers: { 'x-forwarded-for': '203.0.113.10' } });
  assert.equal(denied.status, 429);
  assert.equal(await bodyCode(denied), 'RATE_LIMITED');
  assert.match(denied.headers.get('retry-after') ?? '', /^[1-9][0-9]*$/);

  const trusted = await fixture({ rateAuth: 1, trustProxy: ['loopback'] });
  t.after(() => trusted.dispose());
  assert.equal((await trusted.request('/api/auth/github', { headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 302);
  assert.equal((await trusted.request('/api/auth/github', { headers: { 'x-forwarded-for': '203.0.113.2' } })).status, 302);
  assert.equal((await trusted.request('/api/auth/github', { headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 429);

  const uploads = await fixture({ rateUpload: 1 });
  t.after(() => uploads.dispose());
  const admin = await uploads.login('admin');
  const base = `/api/spaces/${((await (await uploads.request('/api/spaces', {}, admin.cookie)).json()) as { spaces: { id: string }[] }).spaces[0].id}`;
  assert.equal((await uploads.upload(base, admin.cookie, 'a')).status, 201);
  const limited = await uploads.request(`${base}/items/file`, {
    method: 'POST',
    headers: { 'x-test-ip': '203.0.113.50', 'content-type': 'application/octet-stream', 'x-file-name': 'b.bin' },
    body: 'b',
  }, admin.cookie);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('retry-after') ?? '', /^[1-9][0-9]*$/);
});

test('AC-F2: oversize and over-quota uploads return a clear error and leave no partial file', async (t) => {
  const f = await fixture({ maxFileBytes: 20, userQuotaBytes: 25 });
  t.after(() => f.dispose());
  const admin = await f.login('admin');
  const base = `/api/spaces/${((await (await f.request('/api/spaces', {}, admin.cookie)).json()) as { spaces: { id: string }[] }).spaces[0].id}`;
  const tooBig = await f.upload(base, admin.cookie, 'x'.repeat(21));
  assert.equal(tooBig.status, 413);
  assert.equal(await bodyCode(tooBig), 'FILE_TOO_LARGE');
  assert.deepEqual(await readdir(join(f.directory, 'files')), []);
  assert.equal((await f.upload(base, admin.cookie, 'y'.repeat(20))).status, 201);
  const quota = await f.upload(base, admin.cookie, 'z'.repeat(10));
  assert.equal(quota.status, 413);
  assert.equal(await bodyCode(quota), 'QUOTA_EXCEEDED');
  assert.equal((await readdir(join(f.directory, 'files'))).length, 1);
});

test('AC-G1/G4: cross-site writes are rejected and security headers are present', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  for (const origin of ['https://attacker.example', 'null', `${f.config.origin}.evil.example`]) {
    const response = await f.request('/api/rooms', { method: 'POST', headers: { origin } });
    assert.equal(response.status, 403);
    assert.equal(await bodyCode(response), 'ORIGIN_REJECTED');
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal((await f.app.request('/api/rooms', { method: 'POST' })).status, 403);
  const admin = await f.login('admin');
  const spaceId = ((await (await f.request('/api/spaces', {}, admin.cookie)).json()) as { spaces: { id: string }[] }).spaces[0].id;
  const crossed = await f.json(`/api/spaces/${spaceId}/items/text`, { text: 'from elsewhere' }, admin.cookie);
  // json() helper sets the trusted origin; override it.
  const evil = await f.request(`/api/spaces/${spaceId}/items/text`, {
    method: 'POST',
    headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'from elsewhere' }),
  }, admin.cookie);
  assert.equal(evil.status, 403);
  assert.equal(crossed.status, 201);
  const health = await f.request('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
});

test('AC-G3/G5: SVG and HTML are download-only; filenames cannot choose the storage path', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const admin = await f.login('admin');
  const base = `/api/spaces/${((await (await f.request('/api/spaces', {}, admin.cookie)).json()) as { spaces: { id: string }[] }).spaces[0].id}`;
  const hostile = '../..\\..\\etc\\passwd\u0000\r\n.svg';
  for (const [mime, filename, bytes] of [
    ['image/svg+xml', hostile, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['text/html', 'page.html', '<html><script>alert(1)</script></html>'],
    ['video/mp4', 'clip.mp4', '<html><script>alert(1)</script></html>'],
  ] as const) {
    const uploaded = await f.upload(base, admin.cookie, bytes, mime, filename);
    assert.equal(uploaded.status, 201, mime);
    const item = (await uploaded.json() as { item: { id: string; filename: string; hasThumbnail: boolean; fileKey?: string } }).item;
    assert.equal(item.fileKey, undefined);
    assert.equal(item.hasThumbnail, false);
    assert.doesNotMatch(item.filename, /[/\\\u0000\r\n]/);
    assert.equal((await f.request(`${base}/items/${item.id}/thumbnail`, {}, admin.cookie)).status, 404);
    assert.equal((await f.request(`${base}/items/${item.id}/media`, {}, admin.cookie)).status, 404);
    const download = await f.request(`${base}/items/${item.id}/download`, {}, admin.cookie);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.doesNotMatch(download.headers.get('content-disposition') ?? '', /filename="\.\./);
  }
  const names = await readdir(join(f.directory, 'files'));
  assert.ok(names.length >= 3);
  for (const name of names) assert.match(name, /^[0-9a-f-]{36}$/);
});

test('AC-H2/H3/I1: storage and broadcast stay behind interfaces; CI, README and Swiss UI stack are present', async () => {
  const service = await readFile(join(repoRoot, 'apps/server/src/service.ts'), 'utf8');
  assert.match(service, /FileStorage/);
  assert.match(service, /Broadcaster/);
  assert.match(service, /Repository/);
  assert.doesNotMatch(service, /better-sqlite3|DiskFileStorage|MemoryBroadcaster/);
  const ci = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /pnpm lint/);
  assert.match(ci, /pnpm typecheck/);
  assert.match(ci, /pnpm test/);
  assert.match(ci, /pnpm build/);
  assert.match(ci, /docker build/);
  const readme = await readFile(join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /GITHUB_CLIENT_ID/);
  assert.match(readme, /TRUST_PROXY/);
  assert.match(readme, /docker/i);
  const webPackage = JSON.parse(await readFile(join(repoRoot, 'apps/web/package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.match(webPackage.devDependencies.tailwindcss, /^\^4/);
  assert.ok(webPackage.dependencies.sonner);
  assert.ok(webPackage.dependencies.shadcn);
  const css = await readFile(join(repoRoot, 'apps/web/src/index.css'), 'utf8');
  assert.match(css, /@import "tailwindcss"/);
  const app = await readFile(join(repoRoot, 'apps/web/src/App.tsx'), 'utf8');
  assert.match(app, /Toaster/);
  const shell = await readFile(join(repoRoot, 'apps/web/src/components/shell.tsx'), 'utf8');
  assert.match(shell, /md:hidden/);
  assert.match(shell, /setTheme\('dark'\)/);
  const ui = await readdir(join(repoRoot, 'apps/web/src/components/ui'));
  assert.deepEqual(ui.sort(), ['button.tsx', 'dropdown-menu.tsx', 'sonner.tsx']);
  const web = await readFile(join(repoRoot, 'apps/web/src/components/clipboard-board.tsx'), 'utf8');
  assert.doesNotMatch(web, /dangerouslySetInnerHTML/);
  const markdown = await readFile(join(repoRoot, 'apps/web/src/lib/markdown.tsx'), 'utf8');
  assert.doesNotMatch(markdown, /dangerouslySetInnerHTML|javascript:/);
});
