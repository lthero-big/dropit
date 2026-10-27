import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { loadConfig } from '../src/config.js';
import { checkOAuthCredentials } from '../src/oauth.js';

// RHEA-190 m11: OAuth apps configured from 设置 and several providers per account.
const origin = 'http://localhost:3000';
const GH_SECRET = 'env-github-secret-0123456789abcdef';
const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(';')[0] ?? '';

async function setup(env: Record<string, string> = { GITHUB_CLIENT_ID: 'env-gh-id', GITHUB_CLIENT_SECRET: GH_SECRET }) {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-oauth-'));
  const people = new Map<string, { id: string; email: string }>(); // code -> profile
  const checks = { github: 'bad_verification_code', google: 'invalid_grant' };
  const tokenCalls: URLSearchParams[] = [];
  const oauthFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const auth = String((init.headers as Record<string, string> | undefined)?.Authorization ?? '').replace('Bearer ', '');
    if (url === 'https://github.com/login/oauth/access_token' || url === 'https://oauth2.googleapis.com/token') {
      const body = init.body as URLSearchParams;
      tokenCalls.push(body);
      const github = url.includes('github');
      if (body.get('code') === 'dropit-credential-check') {
        const error = github ? checks.github : checks.google;
        if (error === 'HTTP_404') return Response.json({ error: 'Not Found' }, { status: 404 });
        return Response.json({ error }, { status: github ? 200 : error === 'invalid_client' ? 401 : 400 });
      }
      return Response.json({ access_token: body.get('code') });
    }
    const person = people.get(auth)!;
    if (url === 'https://api.github.com/user') return Response.json({ id: Number(person.id), login: 'member' });
    if (url === 'https://api.github.com/user/emails') return Response.json([{ email: person.email, primary: true, verified: true }]);
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: person.id, email: person.email, email_verified: true, name: 'G' });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const config = { ...loadConfig({}), origin, dataDir: directory };
  const backend = createBackend({ config, oauthEnv: env, oauthFetch, remoteAddress: () => '127.0.0.1' });
  const request = (path: string, init: RequestInit = {}, cookie = '') => backend.app.request(path, {
    ...init, headers: { origin, ...(cookie ? { cookie } : {}), ...init.headers as Record<string, string> },
  });
  const send = (path: string, method: string, body: unknown, cookie: string) => request(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, cookie);
  /** Runs the redirect round-trip. `session` makes it a bind (?link=1) from that browser. */
  const oauth = async (provider: string, code: string, person: { id: string; email: string }, session = '', link = false) => {
    people.set(code, person);
    const start = await request(`/api/auth/${provider}${link ? '?link=1' : ''}`, {}, session);
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get('location')!);
    if (location.origin === origin) return { response: start, location };
    assert.equal(location.searchParams.get('redirect_uri'), `${origin}/api/auth/${provider}/callback`);
    const flow = cookieOf(start, 'dropit_oauth');
    const response = await request(`/api/auth/${provider}/callback?${new URLSearchParams({ state: location.searchParams.get('state')!, code })}`,
      {}, [flow, session].filter(Boolean).join('; '));
    assert.equal(response.status, 302);
    return { response, location: new URL(response.headers.get('location')!) };
  };
  const login = async (provider: string, code: string, person: { id: string; email: string }) => {
    const { response, location } = await oauth(provider, code, person);
    return { cookie: cookieOf(response, 'dropit_session'), location };
  };
  const me = async (cookie: string) => (await (await request('/api/me', {}, cookie)).json() as { user: { id: string } }).user.id;
  return { backend, request, send, oauth, login, me, checks, tokenCalls, people,
    async close() { await backend.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('settings show the callback URL, keep secrets server-side and switch providers without restart', async () => {
  const t = await setup();
  try {
    assert.deepEqual((await (await t.request('/api/auth/providers')).json() as { providers: string[] }).providers, ['github']);
    const admin = await t.login('github', 'a1', { id: '1', email: 'owner@example.com' });
    let view = await (await t.request('/api/admin/oauth', {}, admin.cookie)).json() as { providers: Record<string, unknown>[] };
    const github = view.providers.find(p => p.provider === 'github')!;
    assert.equal(github.callbackUrl, `${origin}/api/auth/github/callback`);
    assert.equal(github.source, 'env'); assert.equal(github.clientId, 'env-gh-id'); assert.equal(github.secretSet, true);
    assert.equal(github.secretHint, `••••••••${GH_SECRET.slice(-4)}`);
    assert.equal(view.providers.find(p => p.provider === 'google')!.source, 'none');
    assert.equal(view.providers.find(p => p.provider === 'google')!.callbackUrl, `${origin}/api/auth/google/callback`);

    // Google needs a secret the first time; then it is live immediately.
    let saved = await t.send('/api/admin/oauth/google', 'PUT', { clientId: 'g-id.apps.googleusercontent.com' }, admin.cookie);
    assert.equal(saved.status, 400); assert.equal((await saved.json() as { error: { code: string } }).error.code, 'OAUTH_SECRET_REQUIRED');
    const googleSecret = 'GOCSPX-super-secret-value-123456';
    saved = await t.send('/api/admin/oauth/google', 'PUT', { clientId: 'g-id.apps.googleusercontent.com', clientSecret: googleSecret }, admin.cookie);
    assert.equal(saved.status, 200);
    const text = await saved.text();
    assert(!text.includes(googleSecret) && !text.includes(GH_SECRET), 'secrets must never be returned');
    assert.deepEqual((await (await t.request('/api/auth/providers')).json() as { providers: string[] }).providers, ['github', 'google']);
    // Saving without a secret keeps the stored one.
    await t.send('/api/admin/oauth/google', 'PUT', { clientId: 'g-id2.apps.googleusercontent.com', clientSecret: '' }, admin.cookie);
    await t.request('/api/admin/oauth/google/verify', { method: 'POST' }, admin.cookie);
    const last = t.tokenCalls.at(-1)!;
    assert.equal(last.get('client_secret'), googleSecret); assert.equal(last.get('client_id'), 'g-id2.apps.googleusercontent.com');
    assert.equal(last.get('redirect_uri'), `${origin}/api/auth/google/callback`);
    // Disabling hides it from the login page; deleting falls back to env / none.
    await t.send('/api/admin/oauth/google', 'PUT', { clientId: 'g-id2.apps.googleusercontent.com', enabled: false }, admin.cookie);
    assert.deepEqual((await (await t.request('/api/auth/providers')).json() as { providers: string[] }).providers, ['github']);
    assert.equal((await t.request('/api/auth/google')).status, 404);
    // A database override for github with a new id but the env secret.
    await t.send('/api/admin/oauth/github', 'PUT', { clientId: 'db-gh-id' }, admin.cookie);
    view = await (await t.request('/api/admin/oauth', {}, admin.cookie)).json() as typeof view;
    assert.equal(view.providers.find(p => p.provider === 'github')!.source, 'database');
    const start = await t.request('/api/auth/github');
    assert.equal(new URL(start.headers.get('location')!).searchParams.get('client_id'), 'db-gh-id');
    view = await (await t.request('/api/admin/oauth/github', { method: 'DELETE' }, admin.cookie)).json() as typeof view;
    assert.equal(view.providers.find(p => p.provider === 'github')!.source, 'env');
    assert.equal(view.providers.find(p => p.provider === 'github')!.clientId, 'env-gh-id');
    // Input validation and unknown providers.
    assert.equal((await t.send('/api/admin/oauth/gitlab', 'PUT', { clientId: 'x', clientSecret: 'y' }, admin.cookie)).status, 404);
    assert.equal((await t.send('/api/admin/oauth/github', 'PUT', { clientId: 'bad id<script>', clientSecret: 'y' }, admin.cookie)).status, 400);
    // Cross-origin writes are rejected like every other API write.
    assert.equal((await t.backend.app.request('/api/admin/oauth/github', { method: 'DELETE', headers: { cookie: admin.cookie, origin: 'https://evil.example' } })).status, 403);
  } finally { await t.close(); }
});

test('only admins with a browser session can read or change OAuth settings', async () => {
  const t = await setup();
  try {
    const admin = await t.login('github', 'a1', { id: '1', email: 'owner@example.com' });
    const pending = await t.send('/api/admin/users', 'POST', { email: 'member@example.com' }, admin.cookie);
    assert.equal(pending.status, 201);
    const member = await t.login('github', 'm1', { id: '2', email: 'member@example.com' });
    assert.notEqual(await t.me(member.cookie), await t.me(admin.cookie));
    assert.equal((await t.request('/api/admin/oauth', {}, member.cookie)).status, 403);
    assert.equal((await t.send('/api/admin/oauth/google', 'PUT', { clientId: 'x', clientSecret: 'y' }, member.cookie)).status, 403);
    assert.equal((await t.request('/api/admin/oauth/github/verify', { method: 'POST' }, member.cookie)).status, 403);
    assert.equal((await t.request('/api/admin/oauth')).status, 401);
    const token = await (await t.send('/api/tokens', 'POST', { name: 'cli' }, admin.cookie)).json() as { token: string };
    const bearer = await t.backend.app.request('/api/admin/oauth', { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(bearer.status, 403);
  } finally { await t.close(); }
});

test('verify distinguishes valid and wrong client credentials and resets when they change', async () => {
  const t = await setup();
  try {
    const admin = await t.login('github', 'a1', { id: '1', email: 'owner@example.com' });
    const verify = async (provider: string) => await (await t.request(`/api/admin/oauth/${provider}/verify`, { method: 'POST' }, admin.cookie)).json() as { ok: boolean; code: string };
    assert.deepEqual(await verify('github').then(r => [r.ok, r.code]), [true, 'CREDENTIALS_OK']);
    t.checks.github = 'incorrect_client_credentials';
    assert.deepEqual(await verify('github').then(r => [r.ok, r.code]), [false, 'INVALID_CLIENT']);
    t.checks.github = 'redirect_uri_mismatch';
    assert.deepEqual(await verify('github').then(r => [r.ok, r.code]), [false, 'REDIRECT_MISMATCH']);
    t.checks.github = 'HTTP_404'; // GitHub's answer for an unknown client_id
    assert.deepEqual(await verify('github').then(r => [r.ok, r.code]), [false, 'INVALID_CLIENT']);
    const none = await t.request('/api/admin/oauth/google/verify', { method: 'POST' }, admin.cookie);
    assert.equal(none.status, 400);
    await t.send('/api/admin/oauth/google', 'PUT', { clientId: 'g', clientSecret: 'secret-1' }, admin.cookie);
    assert.deepEqual(await verify('google').then(r => [r.ok, r.code]), [true, 'CREDENTIALS_OK']);
    type View = { providers: { provider: string; check: { ok: boolean; code: string } | null }[] };
    let view = await (await t.request('/api/admin/oauth', {}, admin.cookie)).json() as View;
    assert.deepEqual(view.providers.find(p => p.provider === 'google')!.check?.code, 'CREDENTIALS_OK');
    t.checks.google = 'invalid_client';
    assert.deepEqual(await verify('google').then(r => [r.ok, r.code]), [false, 'INVALID_CLIENT']);
    t.checks.google = 'invalid_request'; // Google rejects http / bare-IP redirect URIs
    assert.deepEqual(await verify('google').then(r => [r.ok, r.code]), [false, 'REDIRECT_NOT_ALLOWED']);
    await t.send('/api/admin/oauth/google', 'PUT', { clientId: 'g', clientSecret: 'secret-2' }, admin.cookie);
    view = await (await t.request('/api/admin/oauth', {}, admin.cookie)).json() as View;
    assert.equal(view.providers.find(p => p.provider === 'google')!.check, null, 'changed credentials need a new check');
    // A real sign-in through a database-configured app proves the callback URL too.
    await t.oauth('google', 'g-login', { id: 'g-owner', email: 'owner@example.com' }, admin.cookie, true);
    view = await (await t.request('/api/admin/oauth', {}, admin.cookie)).json() as View;
    assert.equal(view.providers.find(p => p.provider === 'google')!.check?.code, 'LOGIN_OK');
    // Network failures are reported, not thrown.
    const offline = await checkOAuthCredentials('github', 'id', 'secret', 'https://x/cb', (async () => { throw new Error('offline'); }) as typeof fetch);
    assert.deepEqual(offline, { ok: false, code: 'PROVIDER_UNREACHABLE' });
  } finally { await t.close(); }
});

test('GitHub and Google bind to one account; email match never merges or duplicates silently', async () => {
  const t = await setup();
  try {
    const admin = await t.login('github', 'a1', { id: '1', email: 'owner@example.com' });
    await t.send('/api/admin/oauth/google', 'PUT', { clientId: 'g', clientSecret: 'google-secret' }, admin.cookie);
    const ownerId = await t.me(admin.cookie);

    // Signing in with Google for the same email is refused with guidance, no second account.
    const refused = await t.oauth('google', 'g0', { id: 'g-owner', email: 'owner@example.com' });
    assert.equal(refused.location.pathname, '/login'); assert.equal(refused.location.searchParams.get('error'), 'ACCOUNT_EXISTS');
    let users = await (await t.request('/api/admin/users', {}, admin.cookie)).json() as { users: unknown[] };
    assert.equal(users.users.length, 1);

    // Bind while signed in, even with a different Google email.
    const bound = await t.oauth('google', 'g1', { id: 'g-owner', email: 'owner.personal@gmail.com' }, admin.cookie, true);
    assert.equal(bound.location.pathname, '/settings'); assert.equal(bound.location.searchParams.get('linked'), 'google');
    assert.equal(bound.response.headers.getSetCookie().some(c => c.startsWith('dropit_session=')), false, 'binding keeps the current session');
    const list = await (await t.request('/api/me/identities', {}, admin.cookie)).json() as { identities: { provider: string; email: string }[]; available: string[] };
    assert.deepEqual(list.identities.map(i => i.provider).sort(), ['github', 'google']);
    assert.equal(list.identities.find(i => i.provider === 'google')!.email, 'owner.personal@gmail.com');
    assert.deepEqual(list.available, ['github', 'google']);
    // Binding again is idempotent.
    const again = await t.oauth('google', 'g2', { id: 'g-owner', email: 'owner.personal@gmail.com' }, admin.cookie, true);
    assert.equal(again.location.searchParams.get('already'), '1');
    // Either provider now signs in to the same account.
    const viaGoogle = await t.login('google', 'g3', { id: 'g-owner', email: 'owner.personal@gmail.com' });
    assert.equal(await t.me(viaGoogle.cookie), ownerId);
    const viaGithub = await t.login('github', 'a2', { id: '1', email: 'owner@example.com' });
    assert.equal(await t.me(viaGithub.cookie), ownerId);
    // A second Google account cannot replace the bound one without unbinding first.
    const second = await t.oauth('google', 'g4', { id: 'g-other', email: 'other@gmail.com' }, admin.cookie, true);
    assert.equal(second.location.searchParams.get('link_error'), 'PROVIDER_ALREADY_LINKED');

    // An identity owned by another account is never moved.
    await t.send('/api/admin/users', 'POST', { email: 'member@example.com' }, admin.cookie);
    const member = await t.login('google', 'm1', { id: 'g-member', email: 'member@example.com' });
    assert.notEqual(await t.me(member.cookie), ownerId);
    const stolen = await t.oauth('github', 'x1', { id: '1', email: 'owner@example.com' }, member.cookie, true);
    assert.equal(stolen.location.searchParams.get('link_error'), 'IDENTITY_IN_USE');
    users = await (await t.request('/api/admin/users', {}, admin.cookie)).json() as { users: unknown[] };
    assert.equal(users.users.length, 2);

    // Unbind; the last method stays.
    assert.equal((await t.request('/api/me/identities/google', { method: 'DELETE' }, admin.cookie)).status, 204);
    const last = await t.request('/api/me/identities/github', { method: 'DELETE' }, admin.cookie);
    assert.equal(last.status, 409); assert.equal((await last.json() as { error: { code: string } }).error.code, 'LAST_IDENTITY');
    assert.equal((await t.request('/api/me/identities/google', { method: 'DELETE' }, admin.cookie)).status, 404);
    // After unbinding, that Google account is just an unknown identity again (refused by email match).
    const after = await t.oauth('google', 'g5', { id: 'g-owner', email: 'owner@example.com' });
    assert.equal(after.location.searchParams.get('error'), 'ACCOUNT_EXISTS');
  } finally { await t.close(); }
});

test('a bind needs the same signed-in browser from start to callback', async () => {
  const t = await setup();
  try {
    const anonymous = await t.oauth('github', 'x', { id: '9', email: 'x@example.com' }, '', true);
    assert.equal(anonymous.location.pathname, '/login'); assert.equal(anonymous.location.searchParams.get('error'), 'UNAUTHENTICATED');
    const admin = await t.login('github', 'a1', { id: '1', email: 'owner@example.com' });
    await t.send('/api/admin/oauth/google', 'PUT', { clientId: 'g', clientSecret: 'google-secret' }, admin.cookie);
    // Start a bind, then sign out before the provider redirects back.
    t.people.set('g1', { id: 'g-owner', email: 'owner@example.com' });
    const start = await t.request('/api/auth/google?link=1', {}, admin.cookie);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    await t.request('/api/auth/logout', { method: 'POST' }, admin.cookie);
    const callback = await t.request(`/api/auth/google/callback?${new URLSearchParams({ state, code: 'g1' })}`, {}, `${cookieOf(start, 'dropit_oauth')}; ${admin.cookie}`);
    assert.equal(new URL(callback.headers.get('location')!).searchParams.get('link_error'), 'UNAUTHENTICATED');
    const again = await t.login('github', 'a2', { id: '1', email: 'owner@example.com' });
    const list = await (await t.request('/api/me/identities', {}, again.cookie)).json() as { identities: { provider: string }[] };
    assert.deepEqual(list.identities.map(i => i.provider), ['github']);
  } finally { await t.close(); }
});
