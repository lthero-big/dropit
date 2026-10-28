import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Identity } from '../src/domain.js';
import type { OAuthProvider } from '../src/oauth.js';
import { hashPassword, sameSetupCode, verifyPassword } from '../src/password.js';
import { runAdminCli } from '../src/admin-cli.js';

// RHEA-190 auth step 2: email + password, first-run /setup, password changes, resets and registration policy.
const SITE = 'http://dropit.lan:8787';
const cookieFrom = (response: Response) => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

async function setup(overrides: Partial<Config> = {}, directory?: string) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), 'dropit-pw-'));
  const identities = new Map<string, Identity>();
  const provider: OAuthProvider = {
    authorizationUrl(state, _challenge, redirect) { return `https://mock.example/authorize?${new URLSearchParams({ state, redirect_uri: redirect })}`; },
    async exchange(code) { return identities.get(code)!; },
  };
  const config = { ...loadConfig({}), dataDir: dir, ...overrides };
  const backend = createBackend({ config, providers: { github: provider }, remoteAddress: c => c.req.header('x-test-peer') ?? '203.0.113.9' });
  const request = (path: string, init: { method?: string; cookie?: string; body?: unknown; peer?: string; bearer?: string } = {}) => {
    const headers: Record<string, string> = { host: 'dropit.lan:8787', origin: SITE };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.peer) headers['x-test-peer'] = init.peer;
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return backend.app.request(`${SITE}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const oauth = async (subject: string, invite?: string) => {
    identities.set(subject, { provider: 'github', subject, email: `${subject}@example.com`, name: subject });
    const start = await backend.app.request(`${SITE}/api/auth/github${invite ? `?invite=${invite}` : ''}`, { headers: { host: 'dropit.lan:8787' } });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const done = await backend.app.request(`${SITE}/api/auth/github/callback?${new URLSearchParams({ state, code: subject })}`,
      { headers: { host: 'dropit.lan:8787', cookie: cookieFrom(start) } });
    return { response: done, cookie: cookieFrom(done) };
  };
  const passwordLogin = (email: string, password: string, peer?: string) =>
    request('/api/auth/password/login', { method: 'POST', body: { email, password }, peer });
  const firstAdmin = async (email = 'owner@example.com', password = 'correct horse battery') => {
    const created = await request('/api/setup', { method: 'POST', body: { code: backend.setupCode(), email, name: 'Owner', password } });
    assert.equal(created.status, 201);
    return cookieFrom(created);
  };
  return { backend, request, oauth, passwordLogin, firstAdmin, dir,
    async close(keep = false) { await backend.close(); if (!keep) await rm(dir, { recursive: true, force: true }); } };
}

test('password hashes are salted scrypt and verify in constant time', async () => {
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(a, b);
  assert.ok(await verifyPassword('correct horse battery', a));
  assert.ok(!await verifyPassword('correct horse batterY', a));
  assert.ok(!await verifyPassword('anything', null));
  assert.ok(!await verifyPassword('anything', 'garbage'));
  assert.ok(sameSetupCode('abcd-efgh', 'ABCDEFGH'));
  assert.ok(sameSetupCode(' ABCD EFGH ', 'ABCD-EFGH'));
  assert.ok(!sameSetupCode('ABCD-EFGX', 'ABCD-EFGH'));
  assert.ok(!sameSetupCode(undefined, 'ABCD-EFGH'));
});

test('first run: /setup requires the one-time code from the log and creates exactly one admin', async t => {
  const f = await setup();
  t.after(() => f.close());
  const code = f.backend.setupCode();
  assert.match(code!, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.deepEqual(await (await f.request('/api/auth/providers')).json(), { providers: ['github'], password: true, registration: 'invite', setupRequired: true });
  assert.equal((await (await f.request('/api/setup')).json()).required, true);
  const body = { email: 'owner@example.com', name: 'Owner', password: 'correct horse battery' };
  assert.equal((await f.request('/api/setup', { method: 'POST', body })).status, 403);
  const wrong = await f.request('/api/setup', { method: 'POST', body: { ...body, code: 'AAAA-AAAA' } });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error.code, 'SETUP_CODE_INVALID');
  assert.equal((await f.request('/api/setup', { method: 'POST', body: { ...body, code, password: 'short' } })).status, 400);
  // Register / password login are not a back door while the instance is uninitialised.
  assert.equal((await f.request('/api/auth/password/register', { method: 'POST', body })).status, 409);
  const created = await f.request('/api/setup', { method: 'POST', body: { ...body, code: code!.toLowerCase() } });
  assert.equal(created.status, 201);
  const cookie = cookieFrom(created);
  const me = await (await f.request('/api/me', { cookie })).json();
  assert.equal(me.user.role, 'admin');
  assert.equal(me.hasPassword, true);
  assert.equal(me.mustChangePassword, false);
  assert.equal(f.backend.setupCode(), null);
  const again = await f.request('/api/setup', { method: 'POST', body: { ...body, email: 'second@example.com', code } });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, 'SETUP_DONE');
  assert.equal((await (await f.request('/api/setup')).json()).required, false);
  assert.equal(f.backend.repo.userCount(), 1);
});

test('first run: wrong setup codes are rate limited', async t => {
  const f = await setup({ rateAuth: 3 });
  t.after(() => f.close());
  const body = { code: 'AAAA-AAAA', email: 'owner@example.com', password: 'correct horse battery' };
  for (let i = 0; i < 3; i += 1) assert.equal((await f.request('/api/setup', { method: 'POST', body })).status, 403);
  const limited = await f.request('/api/setup', { method: 'POST', body: { ...body, code: f.backend.setupCode() } });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  // Rotating addresses still hits the global budget.
  for (let i = 0; i < 12; i += 1) await f.request('/api/setup', { method: 'POST', body, peer: `198.51.100.${i}` });
  assert.equal((await f.request('/api/setup', { method: 'POST', body: { ...body, code: f.backend.setupCode() }, peer: '198.51.100.200' })).status, 429);
});

test('env bootstrap: ADMIN_EMAIL + ADMIN_PASSWORD create the first admin and skip /setup', async t => {
  const env = { ADMIN_EMAIL: 'Boss@Example.com', ADMIN_PASSWORD: 'bootstrap-secret-1' };
  const f = await setup({ adminEmail: loadConfig(env).adminEmail, adminPassword: loadConfig(env).adminPassword });
  assert.equal(f.backend.bootstrappedAdmin, 'boss@example.com');
  assert.equal(f.backend.setupCode(), null);
  assert.equal((await (await f.request('/api/setup')).json()).required, false);
  const login = await f.passwordLogin('boss@example.com', 'bootstrap-secret-1');
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.role, 'admin');
  // A restart with the variables still set (or changed) does not touch the existing account.
  await f.backend.close();
  const g = await setup({ adminEmail: 'other@example.com', adminPassword: 'different-secret' }, f.dir);
  t.after(() => g.close());
  assert.equal(g.backend.bootstrappedAdmin, null);
  assert.equal(g.backend.repo.userCount(), 1);
  assert.equal((await g.passwordLogin('boss@example.com', 'bootstrap-secret-1')).status, 200);
  assert.equal((await g.passwordLogin('other@example.com', 'different-secret')).status, 401);
  assert.throws(() => loadConfig({ ADMIN_EMAIL: 'boss@example.com' }), /ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'short' }), /ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ ADMIN_EMAIL: 'not-an-email', ADMIN_PASSWORD: 'long enough pw' }), /ADMIN_EMAIL/);
});

test('password login: success, uniform bad credentials, disabled accounts and rate limit', async t => {
  const f = await setup({ rateAuth: 5 });
  t.after(() => f.close());
  await f.firstAdmin();
  const ok = await f.passwordLogin('OWNER@example.com', 'correct horse battery');
  assert.equal(ok.status, 200);
  const cookie = cookieFrom(ok);
  assert.match(cookie, /dropit_session=/);
  assert.equal((await (await f.request('/api/me', { cookie })).json()).user.email, 'owner@example.com');
  const bad = await f.passwordLogin('owner@example.com', 'wrong password!!', '198.51.100.1');
  const unknown = await f.passwordLogin('nobody@example.com', 'wrong password!!', '198.51.100.1');
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await bad.json(), await unknown.json());
  // Per-IP budget …
  for (let i = 0; i < 3; i += 1) await f.passwordLogin('nobody@example.com', 'x', '198.51.100.1');
  const limited = await f.passwordLogin('owner@example.com', 'correct horse battery', '198.51.100.1');
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  // … and a per-account budget that rotating addresses cannot dodge.
  for (let i = 0; i < 5; i += 1) await f.passwordLogin('target@example.com', 'guess', `198.51.100.${10 + i}`);
  assert.equal((await f.passwordLogin('target@example.com', 'guess', '198.51.100.99')).status, 429);
});

test('change password: requires the current one, signs other browsers out; OAuth-only users can add one', async t => {
  const f = await setup();
  t.after(() => f.close());
  const first = await f.firstAdmin();
  const second = cookieFrom(await f.passwordLogin('owner@example.com', 'correct horse battery'));
  const change = (cookie: string, body: unknown) => f.request('/api/me/password', { method: 'PUT', cookie, body });
  const missing = await change(first, { newPassword: 'a brand new secret' });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'CURRENT_PASSWORD_INVALID');
  assert.equal((await change(first, { currentPassword: 'nope', newPassword: 'a brand new secret' })).status, 400);
  assert.equal((await change(first, { currentPassword: 'correct horse battery', newPassword: 'short' })).status, 400);
  assert.equal((await (await change(first, { currentPassword: 'correct horse battery', newPassword: 'correct horse battery' })).json()).error.code, 'PASSWORD_UNCHANGED');
  const changed = await change(first, { currentPassword: 'correct horse battery', newPassword: 'a brand new secret' });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).revokedSessions, 1);
  assert.equal((await f.request('/api/me', { cookie: first })).status, 200);
  assert.equal((await f.request('/api/me', { cookie: second })).status, 401);
  assert.equal((await f.passwordLogin('owner@example.com', 'correct horse battery')).status, 401);
  assert.equal((await f.passwordLogin('owner@example.com', 'a brand new secret')).status, 200);

  // OAuth-only member (open registration so no invite is needed).
  await f.request('/api/admin/registration', { method: 'PUT', cookie: first, body: { policy: 'open' } });
  const member = await f.oauth('octo');
  assert.equal(member.response.status, 302);
  assert.equal((await (await f.request('/api/me', { cookie: member.cookie })).json()).hasPassword, false);
  assert.equal((await change(member.cookie, { newPassword: 'member password 1' })).status, 200);
  assert.equal((await (await f.request('/api/me', { cookie: member.cookie })).json()).hasPassword, true);
  assert.equal((await f.passwordLogin('octo@example.com', 'member password 1')).status, 200);
  // With a password the OAuth identity can now be unlinked (it is no longer the only way in).
  assert.equal((await f.request('/api/me/identities/github', { method: 'DELETE', cookie: member.cookie })).status, 204);
  assert.equal((await f.passwordLogin('octo@example.com', 'member password 1')).status, 200);
});

test('admin reset: temporary password shown once, sessions revoked, change forced at next sign-in', async t => {
  const f = await setup();
  t.after(() => f.close());
  const admin = await f.firstAdmin();
  await f.request('/api/admin/registration', { method: 'PUT', cookie: admin, body: { policy: 'open' } });
  const registered = await f.request('/api/auth/password/register', { method: 'POST', body: { email: 'mem@example.com', name: 'Mem', password: 'member secret 1' } });
  assert.equal(registered.status, 201);
  const memberCookie = cookieFrom(registered);
  const users = (await (await f.request('/api/admin/users', { cookie: admin })).json()).users;
  const member = users.find((user: { email: string }) => user.email === 'mem@example.com');
  assert.equal(member.hasPassword, true);
  assert.equal(member.role, 'user');
  assert.equal((await f.request(`/api/admin/users/${member.id}/password`, { method: 'POST', cookie: memberCookie })).status, 403);
  const reset = await f.request(`/api/admin/users/${member.id}/password`, { method: 'POST', cookie: admin });
  assert.equal(reset.status, 200);
  const { temporaryPassword } = await reset.json();
  assert.match(temporaryPassword, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal((await f.request('/api/me', { cookie: memberCookie })).status, 401);
  assert.equal((await f.passwordLogin('mem@example.com', 'member secret 1')).status, 401);
  const temp = await f.passwordLogin('mem@example.com', temporaryPassword);
  assert.equal(temp.status, 200);
  assert.equal((await temp.json()).mustChangePassword, true);
  const cookie = cookieFrom(temp);
  const me = await (await f.request('/api/me', { cookie })).json();
  assert.equal(me.mustChangePassword, true);
  const blocked = await f.request('/api/rooms', { cookie });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await f.request('/api/me/password', { method: 'PUT', cookie, body: { currentPassword: temporaryPassword, newPassword: 'my own secret 2' } })).status, 200);
  assert.equal((await (await f.request('/api/me', { cookie })).json()).mustChangePassword, false);
  assert.notEqual((await f.request('/api/rooms', { cookie })).status, 403);
  // Admin can also pre-create an account with a temporary password.
  const created = await f.request('/api/admin/users', { method: 'POST', cookie: admin, body: { email: 'new@example.com', name: 'New', role: 'user', temporaryPassword: true } });
  assert.equal(created.status, 201);
  const fresh = await created.json();
  assert.equal(fresh.mustChangePassword, true);
  const freshLogin = await f.passwordLogin('new@example.com', fresh.temporaryPassword);
  assert.equal(freshLogin.status, 200);
  assert.equal((await freshLogin.json()).mustChangePassword, true);
});

test('registration policy: invite-only by default, closed and open; invites can be activated with a password', async t => {
  const f = await setup();
  t.after(() => f.close());
  const admin = await f.firstAdmin();
  const view = await (await f.request('/api/admin/registration', { cookie: admin })).json();
  assert.equal(view.policy, 'invite');
  assert.equal(view.default, 'invite');
  const register = (email: string, invite?: string) =>
    f.request('/api/auth/password/register', { method: 'POST', body: { email, password: 'member secret 1', ...(invite ? { invite } : {}) } });
  const noInvite = await register('a@example.com');
  assert.equal(noInvite.status, 403);
  assert.equal((await noInvite.json()).error.code, 'INVITATION_REQUIRED');
  assert.equal((await (await register('a@example.com', 'not-a-real-invite')).json()).error.code, 'INVITE_INVALID');
  const { spaces } = await (await f.request('/api/spaces', { cookie: admin })).json();
  const invite = await (await f.request('/api/admin/invites', { method: 'POST', cookie: admin, body: { spaceId: spaces[0].id, maxUses: 1 } })).json();
  const joined = await register('a@example.com', invite.token);
  assert.equal(joined.status, 201);
  assert.equal((await register('b@example.com', invite.token)).status, 403);
  assert.equal((await register('A@example.com', undefined)).status, 403);

  assert.equal((await f.request('/api/admin/registration', { method: 'PUT', cookie: admin, body: { policy: 'nope' } })).status, 400);
  assert.equal((await f.request('/api/admin/registration', { method: 'PUT', cookie: cookieFrom(joined), body: { policy: 'open' } })).status, 403);
  assert.equal((await (await f.request('/api/admin/registration', { method: 'PUT', cookie: admin, body: { policy: 'closed' } })).json()).policy, 'closed');
  assert.equal((await (await f.request('/api/auth/providers')).json()).registration, 'closed');
  assert.equal((await (await register('c@example.com')).json()).error.code, 'REGISTRATION_CLOSED');
  const closedOAuth = await f.oauth('stranger');
  assert.match(closedOAuth.response.headers.get('location')!, /REGISTRATION_CLOSED/);

  await f.request('/api/admin/registration', { method: 'PUT', cookie: admin, body: { policy: 'open' } });
  const open = await register('c@example.com');
  assert.equal(open.status, 201);
  assert.equal((await open.json()).user.role, 'user');
  assert.equal((await register('C@example.com')).status, 409);
  assert.equal((await register('owner@example.com')).status, 409);
  assert.equal(new URL((await f.oauth('stranger2')).response.headers.get('location')!).pathname, '/');

  // An admin pre-created (pending) account becomes active by signing in with its temporary password.
  const pre = await (await f.request('/api/admin/users', { method: 'POST', cookie: admin, body: { email: 'pre@example.com', name: 'Pre', role: 'user', temporaryPassword: true } })).json();
  assert.equal((await f.passwordLogin('pre@example.com', pre.temporaryPassword)).status, 200);
  const users = (await (await f.request('/api/admin/users', { cookie: admin })).json()).users;
  assert.equal(users.find((user: { email: string }) => user.email === 'pre@example.com').pending, 0);
});

test('CLI: dropit-admin reset-password sets a temporary password and forces a change', async t => {
  const f = await setup();
  t.after(() => f.close());
  const admin = await f.firstAdmin();
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  assert.equal(runAdminCli(['reset-password', 'missing@example.com'], { DATA_DIR: f.dir }, io), 2);
  assert.match(err.join('\n'), /No account/);
  assert.equal(runAdminCli([], { DATA_DIR: f.dir }, io), 1);
  assert.equal(runAdminCli(['list-users'], { DATA_DIR: f.dir }, io), 0);
  assert.match(out.join('\n'), /owner@example\.com\tadmin\tactive\tpassword/);
  assert.equal(runAdminCli(['reset-password', 'Owner@Example.com'], { DATA_DIR: f.dir }, io), 0);
  const temporary = /: ([a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4})$/m.exec(out.join('\n'))![1];
  // Sessions are revoked by the CLI too (it writes the same database).
  assert.equal((await f.request('/api/me', { cookie: admin })).status, 401);
  assert.equal((await f.passwordLogin('owner@example.com', 'correct horse battery')).status, 401);
  const login = await f.passwordLogin('owner@example.com', temporary);
  assert.equal(login.status, 200);
  assert.equal((await login.json()).mustChangePassword, true);
});
