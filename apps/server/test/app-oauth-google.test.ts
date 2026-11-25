import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';

const SITE = 'http://dropit.test';
const APP_REDIRECT = 'dropit://auth/callback';
const GOOGLE_CLIENT_ID = '1234567890-dropit-web.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = 'GOCSPX-super-secret-never-leak';
const JWKS_URL = 'https://jwks.dropit.test/oauth2/v3/certs';

const cookieFrom = (response: Response) => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const hasFlowCookieClear = (response: Response) =>
  response.headers.getSetCookie().some(c => /^dropit_oauth=;\s*/i.test(c) && /Max-Age=0/i.test(c));
const hasSessionCookie = (response: Response) =>
  response.headers.getSetCookie().some(c => /^(?:__Host-)?dropit_session=/i.test(c));

function makeRsaKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
  return {
    kid,
    privateKey,
    jwk: { kty: jwk.kty, use: 'sig', alg: 'RS256', kid, n: jwk.n, e: jwk.e },
  };
}

function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: KeyObject,
) {
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url');
  return `${signingInput}.${sig}`;
}

function decodeHtmlAttr(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function visibleBodyText(html: string) {
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  assert.ok(bodyMatch, 'HTML bridge must include <body>');
  return bodyMatch[1].replace(/<[^>]+>/g, ' ');
}

interface MockOAuthIdentity {
  sub?: string;
  id?: number;
  email: string;
  name: string;
  email_verified?: boolean;
}

async function setup(options: {
  config?: Partial<Config>;
  oauthEnv?: NodeJS.ProcessEnv;
  jwksMaxAge?: number;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-v042-'));
  let clock = Date.now();
  const key1 = makeRsaKey('kid-primary-1');
  const key2 = makeRsaKey('kid-rotated-2');
  let activeJwks = [key1.jwk];
  let jwksFetches = 0;
  const mockOAuthUsers = new Map<string, MockOAuthIdentity>();

  const oauthFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === JWKS_URL) {
      jwksFetches += 1;
      const maxAge = options.jwksMaxAge ?? 3600;
      return new Response(JSON.stringify({ keys: activeJwks }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${maxAge}`,
        },
      });
    }
    if (url === 'https://oauth2.googleapis.com/token' || url === 'https://github.com/login/oauth/access_token') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      const code = form.get('code') ?? '';
      return new Response(JSON.stringify({ access_token: code }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const authHeader = new Headers(init?.headers).get('authorization') ?? '';
    const token = authHeader.replace(/^Bearer /, '');
    const identity = mockOAuthUsers.get(token);
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      if (!identity) return new Response('unauthorized', { status: 401 });
      return new Response(JSON.stringify({
        sub: identity.sub ?? 'g-sub-default',
        email: identity.email,
        email_verified: identity.email_verified ?? true,
        name: identity.name,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://api.github.com/user') {
      if (!identity) return new Response('unauthorized', { status: 401 });
      return new Response(JSON.stringify({ id: identity.id ?? 1001, login: 'ghuser', name: identity.name }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://api.github.com/user/emails') {
      if (!identity) return new Response('unauthorized', { status: 401 });
      return new Response(JSON.stringify([{ email: identity.email, primary: true, verified: true }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  const oauthEnv: NodeJS.ProcessEnv = options.oauthEnv ?? {
    GITHUB_CLIENT_ID: 'gh-client-id',
    GITHUB_CLIENT_SECRET: 'gh-client-secret',
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
  };

  const backend = createBackend({
    config: {
      ...loadConfig({}),
      origin: SITE,
      dataDir: dir,
      rateGeneral: 10000,
      rateAuth: 1000,
      rateUpload: 1000,
      ...options.config,
    },
    oauthEnv,
    oauthFetch,
    googleJwksUrl: JWKS_URL,
    now: () => clock,
    remoteAddress: c => c.req.header('x-test-peer') ?? '198.51.100.20',
  });

  const req = (path: string, init: {
    method?: string;
    cookie?: string;
    token?: string;
    body?: unknown;
    origin?: string | null;
    headers?: Record<string, string>;
  } = {}) => {
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

  return {
    backend,
    dir,
    key1,
    key2,
    mockOAuthUsers,
    req,
    now: () => clock,
    advance(ms: number) { clock += ms; },
    jwksFetchCount: () => jwksFetches,
    setJwks(keys: typeof activeJwks) { activeJwks = keys; },
    async dispose() {
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('RHEA-272: App OAuth callback renders CSP-safe HTML bridge page for Accept: text/html and keeps 302 for non-HTML', async t => {
  const f = await setup();
  t.after(() => f.dispose());

  // Bootstrap admin & switch to open registration so OAuth logins can create users
  const setupRes = await f.req('/api/setup', {
    method: 'POST',
    origin: SITE,
    body: { code: f.backend.setupCode(), email: 'admin@example.com', name: 'Admin', password: 'admin-password-123' },
  });
  assert.equal(setupRes.status, 201);
  const adminCookie = cookieFrom(setupRes);
  assert.equal((await f.req('/api/admin/registration', { method: 'PUT', cookie: adminCookie, body: { policy: 'open' } })).status, 200);

  // 1. Login success with Accept: text/html -> 200 HTML bridge page
  f.mockOAuthUsers.set('google-login-ok', { sub: 'g-html-1', email: 'bridge@example.com', name: 'Bridge User' });
  const appState = 'bridgeState_0123456789';
  const start = await f.req(`/api/auth/google?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: appState, device_name: 'Pixel 9' })}`);
  assert.equal(start.status, 302);
  const oauthState = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const flowCookie = cookieFrom(start);

  const cbHtml = await f.req(`/api/auth/google/callback?${new URLSearchParams({ state: oauthState, code: 'google-login-ok' })}`, {
    headers: {
      cookie: flowCookie,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  assert.equal(cbHtml.status, 200);
  assert.match(cbHtml.headers.get('content-type') ?? '', /^text\/html;\s*charset=utf-8/i);
  assert.equal(cbHtml.headers.get('cache-control'), 'no-store');
  assert.equal(cbHtml.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(hasFlowCookieClear(cbHtml), true, 'must clear flow cookie');
  assert.equal(hasSessionCookie(cbHtml), false, 'must never set browser session cookie');

  const html = await cbHtml.text();
  assert.equal(/<script\b/i.test(html), false, 'must not contain inline <script> (CSP)');
  const metaMatch = /<meta\s+http-equiv="refresh"\s+content="0;url=([^"]+)"/i.exec(html);
  assert.ok(metaMatch, 'must include meta refresh');
  const metaDropitUrl = decodeHtmlAttr(metaMatch[1]);
  const parsedDropit = new URL(metaDropitUrl);
  assert.equal(`${parsedDropit.protocol}//${parsedDropit.host}${parsedDropit.pathname}`, APP_REDIRECT);
  assert.equal(parsedDropit.searchParams.get('state'), appState);
  const exchangeCode = parsedDropit.searchParams.get('code')!;
  assert.match(exchangeCode, /^[A-Za-z0-9_-]{43}$/);

  const expectedQuery = new URLSearchParams({ code: exchangeCode, state: appState }).toString();
  const expectedIntent = `intent://auth/callback?${expectedQuery}#Intent;scheme=dropit;package=dev.dropit.app;end`;
  const intentHrefMatch = /<a\s+class="btn"\s+href="([^"]+)"/i.exec(html);
  assert.ok(intentHrefMatch, 'must include intent:// primary button');
  assert.equal(decodeHtmlAttr(intentHrefMatch[1]), expectedIntent);

  const fallbackHrefMatch = /<a\s+class="fallback"\s+href="([^"]+)"/i.exec(html);
  assert.ok(fallbackHrefMatch, 'must include dropit:// fallback link');
  assert.equal(decodeHtmlAttr(fallbackHrefMatch[1]), `${APP_REDIRECT}?${expectedQuery}`);

  assert.equal(visibleBodyText(html).includes(exchangeCode), false, 'must not print exchange code in visible body text');
  assert.ok(html.includes('授权已完成，正在返回 dropit…'));

  // Exchange the code obtained from the HTML bridge page to confirm end-to-end login
  const exchanged = await f.req('/api/auth/app/oauth/exchange', { method: 'POST', body: { code: exchangeCode } });
  assert.equal(exchanged.status, 200);
  const oauthToken = (await exchanged.json()).access_token as string;

  // 2. Link success with Accept: text/html -> 200 HTML bridge page with linked=github
  const linkReq = await f.req('/api/me/identities/github/app-link', {
    method: 'POST',
    token: oauthToken,
    body: { appState: 'linkHtmlState_987654' },
  });
  assert.equal(linkReq.status, 200);
  const linkBody = await linkReq.json();
  f.mockOAuthUsers.set('gh-link-ok', { id: 4242, email: 'bridge-gh@example.com', name: 'Bridge GH' });
  const linkStart = await f.req(linkBody.path);
  assert.equal(linkStart.status, 302);
  const linkState = new URL(linkStart.headers.get('location')!).searchParams.get('state')!;
  const linkCb = await f.req(`/api/auth/github/callback?${new URLSearchParams({ state: linkState, code: 'gh-link-ok' })}`, {
    headers: { cookie: cookieFrom(linkStart), accept: 'text/html' },
  });
  assert.equal(linkCb.status, 200);
  assert.equal(hasSessionCookie(linkCb), false);
  assert.equal(hasFlowCookieClear(linkCb), true);
  const linkHtml = await linkCb.text();
  const linkQuery = new URLSearchParams({ linked: 'github', state: 'linkHtmlState_987654' }).toString();
  assert.ok(decodeHtmlAttr(linkHtml).includes(`intent://auth/callback?${linkQuery}#Intent;scheme=dropit;package=dev.dropit.app;end`));
  assert.ok(decodeHtmlAttr(linkHtml).includes(`dropit://auth/callback?${linkQuery}`));
  assert.equal(/<script\b/i.test(linkHtml), false);

  // 3. Failure callback with Accept: text/html -> 200 HTML bridge page with failure copy & error=OAUTH_DENIED
  const startErr = await f.req(`/api/auth/google?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: 'errHtmlState_123456' })}`);
  const errOAuthState = new URL(startErr.headers.get('location')!).searchParams.get('state')!;
  const cbErrHtml = await f.req(`/api/auth/google/callback?${new URLSearchParams({ state: errOAuthState, error: 'access_denied' })}`, {
    headers: { cookie: cookieFrom(startErr), accept: 'text/html' },
  });
  assert.equal(cbErrHtml.status, 200);
  assert.equal(cbErrHtml.headers.get('cache-control'), 'no-store');
  assert.equal(hasFlowCookieClear(cbErrHtml), true);
  assert.equal(hasSessionCookie(cbErrHtml), false);
  const errHtml = await cbErrHtml.text();
  assert.ok(errHtml.includes('授权未完成，请返回 dropit 查看原因'));
  const errQuery = new URLSearchParams({ error: 'OAUTH_DENIED', state: 'errHtmlState_123456' }).toString();
  assert.ok(decodeHtmlAttr(errHtml).includes(`intent://auth/callback?${errQuery}#Intent;scheme=dropit;package=dev.dropit.app;end`));
  assert.ok(decodeHtmlAttr(errHtml).includes(`dropit://auth/callback?${errQuery}`));

  // 4. Early App error (replayed link_ticket) with Accept: text/html also returns 200 HTML bridge
  const replayHtml = await f.req(linkBody.path, { headers: { accept: 'text/html' } });
  assert.equal(replayHtml.status, 200);
  const replayBody = await replayHtml.text();
  assert.ok(replayBody.includes('授权未完成，请返回 dropit 查看原因'));
  assert.ok(decodeHtmlAttr(replayBody).includes('error=UNAUTHENTICATED'));

  // 5. Non-HTML request keeps 302 Location: dropit://auth/callback?...
  const start302 = await f.req(`/api/auth/google?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: 'nonHtmlState_12345' })}`);
  const state302 = new URL(start302.headers.get('location')!).searchParams.get('state')!;
  const cb302 = await f.req(`/api/auth/google/callback?${new URLSearchParams({ state: state302, code: 'google-login-ok' })}`, {
    headers: { cookie: cookieFrom(start302), accept: 'application/json' },
  });
  assert.equal(cb302.status, 302);
  assert.ok((cb302.headers.get('location') ?? '').startsWith('dropit://auth/callback?'));
});

test('RHEA-272: GET /api/auth/providers exposes googleClientId only when Google is enabled and never leaks secret', async t => {
  // 1. Enabled via env
  const f = await setup();
  t.after(() => f.dispose());

  const envRes = await f.req('/api/auth/providers');
  assert.equal(envRes.status, 200);
  const envText = await envRes.text();
  assert.equal(envText.includes(GOOGLE_CLIENT_SECRET), false, 'must never leak clientSecret');
  const envBody = JSON.parse(envText);
  assert.deepEqual(envBody.providers, ['github', 'google']);
  assert.equal(envBody.googleClientId, GOOGLE_CLIENT_ID);

  // Bootstrap admin and disable Google via admin settings -> googleClientId hidden
  const setupRes = await f.req('/api/setup', {
    method: 'POST',
    origin: SITE,
    body: { code: f.backend.setupCode(), email: 'admin@example.com', name: 'Admin', password: 'admin-password-123' },
  });
  const adminCookie = cookieFrom(setupRes);
  assert.equal((await f.req('/api/admin/oauth/google', {
    method: 'PUT',
    cookie: adminCookie,
    body: { clientId: 'db-google-client-id', clientSecret: 'db-google-secret', enabled: false },
  })).status, 200);

  const disabledRes = await f.req('/api/auth/providers');
  assert.equal(disabledRes.status, 200);
  const disabledBody = await disabledRes.json();
  assert.deepEqual(disabledBody.providers, ['github']);
  assert.equal(disabledBody.googleClientId, undefined);

  // Re-enable with DB clientId -> returns DB googleClientId and never leaks DB secret
  assert.equal((await f.req('/api/admin/oauth/google', {
    method: 'PUT',
    cookie: adminCookie,
    body: { clientId: 'db-google-client-id', clientSecret: 'db-google-secret', enabled: true },
  })).status, 200);
  const enabledRes = await f.req('/api/auth/providers');
  const enabledText = await enabledRes.text();
  assert.equal(enabledText.includes('db-google-secret'), false);
  const enabledBody = JSON.parse(enabledText);
  assert.deepEqual(enabledBody.providers, ['github', 'google']);
  assert.equal(enabledBody.googleClientId, 'db-google-client-id');
});

test('RHEA-272: POST /api/auth/app/google/id-token enforces strict RS256 verification, claims, JWKS caching/rotation, and account security boundaries', async t => {
  const f = await setup({ config: { adminEmails: ['boss@example.com'] } });
  t.after(() => f.dispose());

  // Bootstrap initial admin via /setup so registration policy defaults to invite-only
  const setupRes = await f.req('/api/setup', {
    method: 'POST',
    origin: SITE,
    body: { code: f.backend.setupCode(), email: 'root@example.com', name: 'Root', password: 'root-password-123' },
  });
  assert.equal(setupRes.status, 201);
  const rootCookie = cookieFrom(setupRes);

  const makeToken = (overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}, key = f.key1) => {
    const nowSec = Math.floor(f.now() / 1000);
    return signJwt(
      { alg: 'RS256', typ: 'JWT', kid: key.kid, ...headerOverrides },
      {
        iss: 'https://accounts.google.com',
        aud: GOOGLE_CLIENT_ID,
        sub: 'google-sub-001',
        email: 'alice@example.com',
        email_verified: true,
        name: 'Alice Google',
        iat: nowSec - 10,
        exp: nowSec + 3600,
        ...overrides,
      },
      key.privateKey,
    );
  };

  // Cross-site Origin rejected (CSRF boundary)
  assert.equal((await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    origin: 'https://evil.example',
    body: { idToken: makeToken() },
  })).status, 403);

  // 1. Invite-only policy blocks uninvited new user with 403 INVITATION_REQUIRED
  const noInvite = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: makeToken(), deviceName: 'Pixel 9' },
  });
  assert.equal(noInvite.status, 403);
  assert.equal((await noInvite.json()).error.code, 'INVITATION_REQUIRED');
  assert.equal(f.jwksFetchCount(), 1, 'JWKS fetched once and cached');

  // 2. Invalid invite rejected with 403 INVITE_INVALID
  const badInvite = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: makeToken(), invite: 'not-a-valid-invite' },
  });
  assert.equal(badInvite.status, 403);
  assert.equal((await badInvite.json()).error.code, 'INVITE_INVALID');
  assert.equal(f.jwksFetchCount(), 1, 'JWKS cache hit');

  // 3. Valid registration invite lets Alice register and issues App Bearer token with read write account scope
  const invRes = await f.req('/api/admin/invites', {
    method: 'POST',
    cookie: rootCookie,
    body: { kind: 'registration', maxUses: 1, expiresInHours: 24 },
  });
  assert.equal(invRes.status, 201);
  const inviteToken = (await invRes.json()).token as string;

  const aliceLogin = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: makeToken(), deviceName: 'Alice Pixel', invite: inviteToken },
  });
  assert.equal(aliceLogin.status, 200);
  const aliceAuth = await aliceLogin.json();
  assert.equal(aliceAuth.token_type, 'Bearer');
  assert.equal(aliceAuth.scope, 'read write account');
  assert.equal(aliceAuth.expires_in, 365 * 86400);
  assert.equal(aliceAuth.user.email, 'alice@example.com');
  assert.equal(aliceAuth.user.name, 'Alice Google');
  assert.equal(aliceAuth.user.role, 'user');
  assert.equal(aliceAuth.mustChangePassword, false);
  assert.match(aliceAuth.access_token, /^[A-Za-z0-9_-]{43}$/);

  // Verify issued token works on account-scoped routes and is rejected on admin routes
  assert.equal((await f.req('/api/me/identities', { token: aliceAuth.access_token })).status, 200);
  assert.equal((await f.req('/api/admin/users', { token: aliceAuth.access_token })).status, 403);

  // Subsequent login with same sub needs no invite and succeeds (also accepts iss = "accounts.google.com")
  const aliceAgain = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: makeToken({ iss: 'accounts.google.com' }) },
  });
  assert.equal(aliceAgain.status, 200);
  assert.equal((await aliceAgain.json()).user.id, aliceAuth.user.id);

  // 4. ADMIN_EMAILS bypasses invite policy and receives read write account admin scope
  const adminLogin = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: {
      idToken: makeToken({ sub: 'google-sub-admin', email: 'boss@example.com', name: 'Boss Admin' }),
      deviceName: 'Boss Phone',
    },
  });
  assert.equal(adminLogin.status, 200);
  const adminAuth = await adminLogin.json();
  assert.equal(adminAuth.scope, 'read write account admin');
  assert.equal(adminAuth.user.role, 'admin');
  assert.equal((await f.req('/api/admin/users', { token: adminAuth.access_token })).status, 200);

  // 5. Anti-hijacking: existing unlinked email (root@example.com) returns 409 ACCOUNT_EXISTS
  const hijack = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: makeToken({ sub: 'google-sub-hijack', email: 'root@example.com', name: 'Hijacker' }) },
  });
  assert.equal(hijack.status, 409);
  assert.equal((await hijack.json()).error.code, 'ACCOUNT_EXISTS');

  // 6. Disabled user returns 403 USER_DISABLED
  assert.equal((await f.req(`/api/admin/users/${aliceAuth.user.id}`, {
    method: 'PATCH',
    cookie: rootCookie,
    body: { disabled: true },
  })).status, 204);
  const disabledLogin = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: makeToken() },
  });
  assert.equal(disabledLogin.status, 403);
  assert.equal((await disabledLogin.json()).error.code, 'USER_DISABLED');

  // Re-enable Alice for remaining tests
  assert.equal((await f.req(`/api/admin/users/${aliceAuth.user.id}`, {
    method: 'PATCH',
    cookie: rootCookie,
    body: { disabled: false },
  })).status, 204);

  // 7. Tampered signature rejected
  const validTok = makeToken();
  const [h, p, s] = validTok.split('.');
  const tamperedSig = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  const tampered = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: `${h}.${p}.${tamperedSig}` },
  });
  assert.equal(tampered.status, 401);
  assert.equal((await tampered.json()).error.code, 'OAUTH_PROVIDER_ERROR');

  // 8. Non-RS256 alg (alg: none / HS256) rejected
  for (const alg of ['none', 'HS256', 'RS384']) {
    const badAlg = await f.req('/api/auth/app/google/id-token', {
      method: 'POST',
      body: { idToken: makeToken({}, { alg }) },
    });
    assert.equal(badAlg.status, 401, `alg=${alg}`);
    assert.equal((await badAlg.json()).error.code, 'OAUTH_PROVIDER_ERROR');
  }

  // 9. Wrong aud / wrong iss / expired exp / future nbf / missing sub rejected with 401 OAUTH_PROVIDER_ERROR
  const nowSec = Math.floor(f.now() / 1000);
  for (const [label, overrides] of [
    ['wrong aud', { aud: 'other-client.apps.googleusercontent.com' }],
    ['wrong iss', { iss: 'https://evil.example' }],
    ['expired >60s', { exp: nowSec - 61 }],
    ['future iat >60s', { iat: nowSec + 120 }],
    ['future nbf >60s', { nbf: nowSec + 120 }],
    ['empty sub', { sub: '' }],
  ] as [string, Record<string, unknown>][]) {
    const res = await f.req('/api/auth/app/google/id-token', {
      method: 'POST',
      body: { idToken: makeToken(overrides) },
    });
    assert.equal(res.status, 401, label);
    assert.equal((await res.json()).error.code, 'OAUTH_PROVIDER_ERROR', label);
  }

  // Clock skew tolerance: exp within 60s skew still succeeds
  const skewOk = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: makeToken({ exp: nowSec - 30 }) },
  });
  assert.equal(skewOk.status, 200);

  // 10. email_verified=false or missing email rejected with 403 VERIFIED_EMAIL_REQUIRED
  for (const [label, overrides] of [
    ['email_verified=false', { email_verified: false }],
    ['email_verified="true"', { email_verified: 'true' }],
    ['empty email', { email: '' }],
  ] as [string, Record<string, unknown>][]) {
    const res = await f.req('/api/auth/app/google/id-token', {
      method: 'POST',
      body: { idToken: makeToken(overrides) },
    });
    assert.equal(res.status, 403, label);
    assert.equal((await res.json()).error.code, 'VERIFIED_EMAIL_REQUIRED', label);
  }

  // 11. Anti-DoS cooldown on forged kid & key rotation refresh after cooldown
  const fetchesBeforeForged = f.jwksFetchCount();
  const forgedKid = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: makeToken({}, { kid: 'forged-kid-dos' }) },
  });
  assert.equal(forgedKid.status, 401);
  assert.equal(f.jwksFetchCount(), fetchesBeforeForged, 'unknown kid within cooldown must not refetch JWKS');

  // Rotate keys & advance clock past 10s cooldown -> unknown kid triggers one refresh and succeeds
  f.setJwks([f.key2.jwk]);
  f.advance(11_000);
  const rotatedRes = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: makeToken({}, {}, f.key2) },
  });
  assert.equal(rotatedRes.status, 200);
  assert.equal(f.jwksFetchCount(), fetchesBeforeForged + 1, 'key rotation refreshed JWKS once');

  // 12. Disabled Google provider returns 404 PROVIDER_UNAVAILABLE
  assert.equal((await f.req('/api/admin/oauth/google', {
    method: 'PUT',
    cookie: rootCookie,
    body: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, enabled: false },
  })).status, 200);
  const unavailable = await f.req('/api/auth/app/google/id-token', {
    method: 'POST',
    body: { idToken: makeToken({}, {}, f.key2) },
  });
  assert.equal(unavailable.status, 404);
  assert.equal((await unavailable.json()).error.code, 'PROVIDER_UNAVAILABLE');
});
