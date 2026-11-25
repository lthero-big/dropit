import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Identity } from '../src/domain.js';
import type { OAuthProvider } from '../src/oauth.js';

const SITE = 'http://dropit.test';
const APP_REDIRECT = 'dropit://auth/callback';

const cookieFrom = (response: Response) => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });

async function setup(overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-app-auth-'));
  let clock = Date.now();
  const identities = new Map<string, Identity>();
  const makeProvider = (name: string): OAuthProvider => ({
    authorizationUrl(state, _challenge, redirect) {
      return `https://mock.example/${name}/authorize?${new URLSearchParams({ state, redirect_uri: redirect })}`;
    },
    async exchange(code) {
      const identity = identities.get(code);
      if (!identity) throw new Error('missing mock identity');
      return identity;
    },
  });
  const backend = createBackend({
    config: { ...loadConfig({}), origin: SITE, dataDir: dir, rateGeneral: 10000, rateAuth: 1000, rateUpload: 1000, ...overrides },
    providers: { github: makeProvider('github'), google: makeProvider('google') },
    now: () => clock,
    remoteAddress: c => c.req.header('x-test-peer') ?? '198.51.100.10',
  });
  const req = (path: string, init: { method?: string; cookie?: string; token?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.origin !== undefined) {
      if (init.origin !== null) headers.origin = init.origin;
    } else if (init.cookie) {
      headers.origin = SITE;
    }
    if (init.cookie) headers.cookie = init.cookie;
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return backend.app.request(`${SITE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };
  // Bootstrap admin + regular member with passwords
  const setupRes = await req('/api/setup', {
    method: 'POST',
    origin: SITE,
    body: { code: backend.setupCode(), email: 'admin@example.com', name: 'Admin', password: 'admin-password-123' },
  });
  assert.equal(setupRes.status, 201);
  const adminCookie = cookieFrom(setupRes);
  const adminUser = (await setupRes.json()).user;
  assert.equal((await req('/api/admin/registration', { method: 'PUT', cookie: adminCookie, body: { policy: 'open' } })).status, 200);
  const regRes = await req('/api/auth/password/register', {
    method: 'POST',
    origin: SITE,
    body: { email: 'member@example.com', name: 'Member', password: 'member-password-123' },
  });
  assert.equal(regRes.status, 201);
  const memberCookie = cookieFrom(regRes);
  const memberUser = (await regRes.json()).user;
  const adminSpace = backend.repo.spaces(adminUser.id)[0];
  const memberSpace = backend.repo.spaces(memberUser.id)[0];
  return {
    backend, dir, identities, req, adminCookie, memberCookie, adminUser, memberUser, adminSpace, memberSpace,
    advance(ms: number) { clock += ms; },
    async dispose() { await backend.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('RHEA-270: PAT and device-code cannot request account/admin scopes; ordinary PATs get 403 INSUFFICIENT_SCOPE on account/admin routes but can GET share-presets', async t => {
  const f = await setup();
  t.after(() => f.dispose());

  // Hard gate: PAT & device-authorize reject account/admin scopes
  for (const scopes of [['read', 'write', 'account'], ['read', 'write', 'admin'], ['account'], ['admin']]) {
    assert.equal((await f.req('/api/tokens', { method: 'POST', cookie: f.adminCookie, body: { name: 'bad', scopes } })).status, 400);
    assert.equal((await f.req('/api/auth/device/authorize', { method: 'POST', body: { name: 'bad', scopes } })).status, 400);
  }

  // Admin creates an ordinary read+write PAT
  const patRes = await f.req('/api/tokens', { method: 'POST', cookie: f.adminCookie, body: { name: 'cli', scopes: ['read', 'write'] } });
  assert.equal(patRes.status, 201);
  const pat = (await patRes.json()).token as string;
  const readOnlyPatRes = await f.req('/api/tokens', { method: 'POST', cookie: f.adminCookie, body: { name: 'ro', scopes: ['read'] } });
  const readOnlyPat = (await readOnlyPatRes.json()).token as string;

  // Save a preset via browser, then verify read-scoped PAT can GET it
  assert.equal((await f.req('/api/me/share-presets', { method: 'PUT', cookie: f.adminCookie, body: { days: [2, 7], views: [5] } })).status, 200);
  const presetsGet = await f.req('/api/me/share-presets', { token: readOnlyPat });
  assert.equal(presetsGet.status, 200);
  assert.deepEqual(await presetsGet.json(), { hours: [], days: [2, 7], months: [], views: [5] });

  // Create an item + share so we can test managed share endpoints
  const itemRes = await f.req(`/api/spaces/${f.adminSpace.id}/items/text`, { method: 'POST', token: pat, body: { text: 'hello' } });
  assert.equal(itemRes.status, 201);
  const item = (await itemRes.json()).item;
  const shareRes = await f.req(`/api/spaces/${f.adminSpace.id}/items/${item.id}/shares`, { method: 'POST', token: pat, body: { expiresIn: '2d' } });
  assert.equal(shareRes.status, 201);
  const share = await shareRes.json();

  // Ordinary read+write PAT must receive 403 INSUFFICIENT_SCOPE on all account & admin routes
  const blocked: [string, string, unknown?][] = [
    ['PUT', '/api/me/share-presets', { days: [3], views: [] }],
    ['GET', '/api/shares'],
    ['GET', `/api/shares/${share.id}/link`],
    ['POST', `/api/shares/${share.id}/revoke`],
    ['DELETE', `/api/shares/${share.id}`],
    ['GET', '/api/sessions'],
    ['DELETE', '/api/sessions/nonexistent'],
    ['POST', '/api/sessions/revoke-others'],
    ['PUT', '/api/me/password', { currentPassword: 'admin-password-123', newPassword: 'new-password-456' }],
    ['GET', '/api/me/identities'],
    ['DELETE', '/api/me/identities/github'],
    ['POST', '/api/me/identities/github/app-link', {}],
    ['POST', '/api/tokens', { name: 'nested', scopes: ['read'] }],
    ['PATCH', '/api/tokens/nonexistent', { name: 'rename' }],
    ['DELETE', '/api/tokens/nonexistent?purge=1'],
    ['GET', '/api/auth/device?user_code=AAAA-BBBB'],
    ['POST', '/api/auth/device/approve', { user_code: 'AAAA-BBBB' }],
    ['POST', '/api/auth/device/deny', { user_code: 'AAAA-BBBB' }],
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users', { email: 'x@example.com' }],
    ['PATCH', `/api/admin/users/${f.memberUser.id}`, { name: 'X' }],
    ['POST', `/api/admin/users/${f.memberUser.id}/password`],
    ['POST', `/api/admin/users/${f.memberUser.id}/logout`],
    ['GET', `/api/admin/users/${f.memberUser.id}/sessions`],
    ['DELETE', '/api/admin/sessions/nonexistent'],
    ['GET', '/api/admin/tokens'],
    ['DELETE', '/api/admin/tokens/nonexistent'],
    ['GET', '/api/admin/invites'],
    ['POST', '/api/admin/invites', { kind: 'registration' }],
    ['DELETE', '/api/admin/invites/nonexistent'],
    ['GET', '/api/admin/registration'],
    ['PUT', '/api/admin/registration', { policy: 'invite' }],
    ['GET', '/api/admin/limits'],
    ['PATCH', '/api/admin/limits', { maxItems: 500 }],
    ['GET', '/api/admin/limits/audit'],
    ['GET', '/api/admin/rooms'],
    ['GET', '/api/admin/site'],
    ['PUT', '/api/admin/site', { origin: SITE, confirm: true }],
    ['GET', '/api/admin/oauth'],
    ['GET', '/api/admin/update'],
    ['POST', '/api/admin/update/check'],
  ];
  for (const [method, path, body] of blocked) {
    const res = await f.req(path, { method, token: pat, body });
    assert.equal(res.status, 403, `${method} ${path} expected 403, got ${res.status}`);
    assert.equal((await res.json()).error.code, 'INSUFFICIENT_SCOPE', `${method} ${path}`);
  }
});

test('RHEA-270: App password login issues account/admin tokens, unlocks all settings, enforces instant demotion and mustChangePassword', async t => {
  const f = await setup();
  t.after(() => f.dispose());

  // Cross-site Origin on cookie-less App login is rejected; no Origin succeeds
  assert.equal((await f.req('/api/auth/app/password/login', {
    method: 'POST', origin: 'https://evil.example', body: { email: 'member@example.com', password: 'member-password-123' },
  })).status, 403);

  const memberLogin = await f.req('/api/auth/app/password/login', {
    method: 'POST',
    body: { email: 'MEMBER@example.com', password: 'member-password-123', deviceName: 'Pixel 9' },
  });
  assert.equal(memberLogin.status, 200);
  const memberAuth = await memberLogin.json();
  assert.equal(memberAuth.token_type, 'Bearer');
  assert.equal(memberAuth.scope, 'read write account');
  assert.equal(memberAuth.expires_in, 365 * 86400);
  assert.equal(memberAuth.user.email, 'member@example.com');
  assert.equal(memberAuth.mustChangePassword, false);
  const memberToken = memberAuth.access_token as string;

  // Regular member's App token can manage own settings (presets, shares, sessions, tokens, identities, device)
  assert.equal((await f.req('/api/me/share-presets', { method: 'PUT', token: memberToken, body: { days: [2, 14], views: [10] } })).status, 200);
  assert.deepEqual(await (await f.req('/api/me/share-presets', { token: memberToken })).json(), { hours: [], days: [2, 14], months: [], views: [10] });
  assert.equal((await f.req('/api/shares', { token: memberToken })).status, 200);
  assert.equal((await f.req('/api/sessions', { token: memberToken })).status, 200);
  assert.equal((await f.req('/api/me/identities', { token: memberToken })).status, 200);
  const subPat = await f.req('/api/tokens', { method: 'POST', token: memberToken, body: { name: 'from-app', scopes: ['read'] } });
  assert.equal(subPat.status, 201);
  const subPatId = (await subPat.json()).id as string;
  assert.equal((await f.req(`/api/tokens/${subPatId}`, { method: 'PATCH', token: memberToken, body: { name: 'renamed-from-app' } })).status, 204);
  assert.equal((await f.req(`/api/tokens/${subPatId}`, { method: 'DELETE', token: memberToken })).status, 204);
  assert.equal((await f.req(`/api/tokens/${subPatId}?purge=1`, { method: 'DELETE', token: memberToken })).status, 204);

  // Member App token can approve a device code
  const dev = await (await f.req('/api/auth/device/authorize', { method: 'POST', body: { name: 'CLI', scopes: ['read', 'write'] } })).json();
  assert.equal((await f.req(`/api/auth/device?user_code=${encodeURIComponent(dev.user_code)}&verification_id=${dev.verification_id}`, { token: memberToken })).status, 200);
  assert.equal((await f.req('/api/auth/device/approve', { method: 'POST', token: memberToken, body: { user_code: dev.user_code, verification_id: dev.verification_id } })).status, 204);

  // Member App token is still denied admin endpoints
  const memberAdminRes = await f.req('/api/admin/users', { token: memberToken });
  assert.equal(memberAdminRes.status, 403);
  assert.equal((await memberAdminRes.json()).error.code, 'INSUFFICIENT_SCOPE');

  // Admin App password login includes admin scope
  const adminLogin = await f.req('/api/auth/app/password/login', {
    method: 'POST',
    body: { email: 'admin@example.com', password: 'admin-password-123', deviceName: 'Admin Phone' },
  });
  assert.equal(adminLogin.status, 200);
  const adminAuth = await adminLogin.json();
  assert.equal(adminAuth.scope, 'read write account admin');
  const adminToken = adminAuth.access_token as string;

  // Admin App token can access full admin surface
  assert.equal((await f.req('/api/admin/users', { token: adminToken })).status, 200);
  assert.equal((await f.req('/api/admin/registration', { token: adminToken })).status, 200);
  assert.equal((await f.req('/api/admin/limits', { token: adminToken })).status, 200);
  assert.equal((await f.req('/api/admin/limits', { method: 'PATCH', token: adminToken, body: { maxItems: 777 } })).status, 200);
  assert.equal((await f.req('/api/admin/limits/audit', { token: adminToken })).status, 200);
  assert.equal((await f.req('/api/admin/rooms', { token: adminToken })).status, 200);
  assert.equal((await f.req('/api/admin/site', { token: adminToken })).status, 200);
  assert.equal((await f.req('/api/admin/oauth', { token: adminToken })).status, 200);
  assert.equal((await f.req('/api/admin/update', { token: adminToken })).status, 200);

  // Admin resets member password -> member logs in via App -> mustChangePassword enforces whitelist until password changed
  const resetRes = await f.req(`/api/admin/users/${f.memberUser.id}/password`, { method: 'POST', token: adminToken });
  assert.equal(resetRes.status, 200);
  const tempPassword = (await resetRes.json()).temporaryPassword as string;
  const tempLogin = await f.req('/api/auth/app/password/login', {
    method: 'POST',
    body: { email: 'member@example.com', password: tempPassword, deviceName: 'Temp Phone' },
  });
  assert.equal(tempLogin.status, 200);
  const tempAuth = await tempLogin.json();
  assert.equal(tempAuth.mustChangePassword, true);
  const tempToken = tempAuth.access_token as string;
  assert.equal((await f.req('/api/me', { token: tempToken })).status, 200);
  const blockedSpace = await f.req('/api/spaces', { token: tempToken });
  assert.equal(blockedSpace.status, 403);
  assert.equal((await blockedSpace.json()).error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await f.req('/api/me/password', {
    method: 'PUT', token: tempToken, body: { currentPassword: tempPassword, newPassword: 'brand-new-password-789' },
  })).status, 200);
  assert.equal((await f.req('/api/spaces', { token: tempToken })).status, 200);

  // Promote member to admin, then demote original admin -> original admin's admin-scoped token is IMMEDIATELY rejected with 403 FORBIDDEN!
  assert.equal((await f.req(`/api/admin/users/${f.memberUser.id}`, { method: 'PATCH', token: adminToken, body: { role: 'admin' } })).status, 204);
  assert.equal((await f.req(`/api/admin/users/${f.adminUser.id}`, { method: 'PATCH', token: adminToken, body: { role: 'user' } })).status, 204);
  const demoted = await f.req('/api/admin/users', { token: adminToken });
  assert.equal(demoted.status, 403);
  assert.equal((await demoted.json()).error.code, 'FORBIDDEN');
  // Account scope on own settings still works for the demoted user
  assert.equal((await f.req('/api/sessions', { token: adminToken })).status, 200);
});

test('RHEA-270: App OAuth login whitelist, single-use code exchange, replay/expiry rejection, and App OAuth link round-trip', async t => {
  const f = await setup();
  t.after(() => f.dispose());

  // Strict app_redirect whitelist
  for (const badRedirect of ['https://evil.example/cb', 'dropit://auth/callback/', 'dropit://auth/callback?x=1', 'dropit://other', '']) {
    const res = await f.req(`/api/auth/github?${new URLSearchParams({ app_redirect: badRedirect, app_state: 'validState1234' })}`);
    assert.equal(res.status, 400, badRedirect);
    assert.equal((await res.json()).error.code, 'INVALID_APP_REDIRECT');
  }
  // Invalid app_state
  for (const badState of ['', 'short', 'bad space!!']) {
    const res = await f.req(`/api/auth/github?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: badState })}`);
    assert.equal(res.status, 400, badState);
    assert.equal((await res.json()).error.code, 'INVALID_INPUT');
  }

  // Successful App OAuth login -> redirects to dropit://auth/callback?code=...&state=... with no session cookie
  f.identities.set('gh-new', { provider: 'github', subject: 'gh-900', email: 'oauth-app@example.com', name: 'OAuth App' });
  const appState = 'appState_0123456789';
  const start = await f.req(`/api/auth/github?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: appState, device_name: 'OnePlus 13' })}`);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const flowCookie = cookieFrom(start);
  const cb = await f.req(`/api/auth/github/callback?${new URLSearchParams({ state, code: 'gh-new' })}`, { headers: { cookie: flowCookie } });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.getSetCookie().some(c => c.startsWith('dropit_session=')), false);
  const cbUrl = new URL(cb.headers.get('location')!);
  assert.equal(`${cbUrl.protocol}//${cbUrl.host}${cbUrl.pathname}`, APP_REDIRECT);
  assert.equal(cbUrl.searchParams.get('state'), appState);
  const exchangeCode = cbUrl.searchParams.get('code')!;
  assert.match(exchangeCode, /^[A-Za-z0-9_-]{43}$/);

  // Exchange succeeds once and issues account-scoped Bearer token
  const exchanged = await f.req('/api/auth/app/oauth/exchange', { method: 'POST', body: { code: exchangeCode } });
  assert.equal(exchanged.status, 200);
  const oauthAuth = await exchanged.json();
  assert.equal(oauthAuth.token_type, 'Bearer');
  assert.equal(oauthAuth.scope, 'read write account');
  assert.equal(oauthAuth.user.email, 'oauth-app@example.com');
  const oauthToken = oauthAuth.access_token as string;

  // Replay of same code fails with 401 OAUTH_CODE_INVALID
  const replay = await f.req('/api/auth/app/oauth/exchange', { method: 'POST', body: { code: exchangeCode } });
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error.code, 'OAUTH_CODE_INVALID');

  // Expired exchange code (>60s) fails
  const startExp = await f.req(`/api/auth/github?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: 'expState_01234567' })}`);
  const stateExp = new URL(startExp.headers.get('location')!).searchParams.get('state')!;
  const cbExp = await f.req(`/api/auth/github/callback?${new URLSearchParams({ state: stateExp, code: 'gh-new' })}`, { headers: { cookie: cookieFrom(startExp) } });
  const expCode = new URL(cbExp.headers.get('location')!).searchParams.get('code')!;
  f.advance(61_000);
  const expRes = await f.req('/api/auth/app/oauth/exchange', { method: 'POST', body: { code: expCode } });
  assert.equal(expRes.status, 401);
  assert.equal((await expRes.json()).error.code, 'OAUTH_CODE_INVALID');

  // Provider error in App mode redirects to dropit://auth/callback?error=OAUTH_DENIED&state=...
  const startErr = await f.req(`/api/auth/github?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: 'errState_01234567' })}`);
  const stateErr = new URL(startErr.headers.get('location')!).searchParams.get('state')!;
  const cbErr = await f.req(`/api/auth/github/callback?${new URLSearchParams({ state: stateErr, error: 'access_denied' })}`, { headers: { cookie: cookieFrom(startErr) } });
  assert.equal(cbErr.status, 302);
  const errUrl = new URL(cbErr.headers.get('location')!);
  assert.equal(errUrl.searchParams.get('error'), 'OAUTH_DENIED');
  assert.equal(errUrl.searchParams.get('state'), 'errState_01234567');

  // App OAuth linking (bind Google to the GitHub-signed-in account without browser cookies!)
  const linkReq = await f.req('/api/me/identities/google/app-link', {
    method: 'POST',
    token: oauthToken,
    body: { appState: 'linkState_01234567' },
  });
  assert.equal(linkReq.status, 200);
  const linkBody = await linkReq.json();
  assert.equal(linkBody.state, 'linkState_01234567');
  assert.equal(linkBody.expires_in, 60);
  assert.ok(linkBody.path.startsWith('/api/auth/google?'));

  f.identities.set('google-bind', { provider: 'google', subject: 'g-555', email: 'oauth-app-google@example.com', name: 'OAuth Google' });
  const linkStart = await f.req(linkBody.path);
  assert.equal(linkStart.status, 302);
  const linkOAuthState = new URL(linkStart.headers.get('location')!).searchParams.get('state')!;
  const linkCb = await f.req(`/api/auth/google/callback?${new URLSearchParams({ state: linkOAuthState, code: 'google-bind' })}`, { headers: { cookie: cookieFrom(linkStart) } });
  assert.equal(linkCb.status, 302);
  const linkedUrl = new URL(linkCb.headers.get('location')!);
  assert.equal(`${linkedUrl.protocol}//${linkedUrl.host}${linkedUrl.pathname}`, APP_REDIRECT);
  assert.equal(linkedUrl.searchParams.get('linked'), 'google');
  assert.equal(linkedUrl.searchParams.get('state'), 'linkState_01234567');

  // Confirm identity is now bound!
  const identitiesRes = await f.req('/api/me/identities', { token: oauthToken });
  assert.equal(identitiesRes.status, 200);
  const providers = ((await identitiesRes.json()).identities as { provider: string }[]).map(i => i.provider);
  assert.deepEqual(providers.sort(), ['github', 'google']);

  // Replaying the consumed link_ticket fails cleanly with dropit://auth/callback?error=UNAUTHENTICATED
  const replayLink = await f.req(linkBody.path);
  assert.equal(replayLink.status, 302);
  assert.equal(new URL(replayLink.headers.get('location')!).searchParams.get('error'), 'UNAUTHENTICATED');

  // Ensure bearer helper stays used
  assert.ok(bearer(oauthToken).authorization.startsWith('Bearer '));
});
