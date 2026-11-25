import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const rust = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
const APP_REDIRECT = 'dropit://auth/callback';
const GOOGLE_CLIENT_ID = '1234567890-dropit-rust.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = 'GOCSPX-rust-secret-never-leak';

await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const temporary = await mkdtemp(resolve(root, 'rust/server/data/app-oauth-google-'));

function makeRsaKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    kid,
    privateKey,
    jwk: { kty: jwk.kty, use: 'sig', alg: 'RS256', kid, n: jwk.n, e: jwk.e },
  };
}

function signJwt(header, payload, privateKey) {
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url');
  return `${signingInput}.${sig}`;
}

function decodeHtmlAttr(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function visibleBodyText(html) {
  const match = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  assert.ok(match, 'HTML bridge must include <body>');
  return match[1].replace(/<[^>]+>/g, ' ');
}

const key1 = makeRsaKey('rust-kid-1');
let jwksFetches = 0;

const mock = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://mock').pathname;
  let body = '';
  for await (const chunk of request) body += chunk;
  response.setHeader('content-type', 'application/json');
  if (path === '/google/jwks') {
    jwksFetches += 1;
    response.setHeader('cache-control', 'public, max-age=3600');
    response.end(JSON.stringify({ keys: [key1.jwk] }));
    return;
  }
  if (path === '/github/token' || path === '/google/token') {
    const code = new URLSearchParams(body).get('code') || '';
    response.end(JSON.stringify({ access_token: code || 'google-login-ok' }));
    return;
  }
  const access = request.headers.authorization?.replace(/^Bearer /, '') || '';
  if (path === '/github/user') {
    response.end(JSON.stringify({ id: 9001, login: 'ghbridge', name: 'GH Bridge' }));
    return;
  }
  if (path === '/github/emails') {
    response.end(JSON.stringify([{ email: 'gh-bridge@example.test', primary: true, verified: true }]));
    return;
  }
  if (path === '/google/userinfo') {
    response.end(JSON.stringify({
      sub: access === 'google-login-ok' ? 'g-bridge-9001' : 'g-other',
      name: 'Google Bridge User',
      email: 'google-bridge@example.test',
      email_verified: true,
    }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not_found' }));
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const mockPort = mock.address().port;

async function freePort() {
  const server = createTcpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}

async function start(extra = {}) {
  const data = await mkdtemp(resolve(temporary, 'data-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(rust, [], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATA_DIR: data,
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_ORIGIN: origin,
      UPDATE_CHECK: '0',
      RATE_GENERAL: '10000',
      RATE_AUTH: '1000',
      RATE_INVITE: '1000',
      RATE_UPLOAD: '1000',
      RATE_TOKEN: '10000',
      ADMIN_EMAILS: 'boss@example.test',
      GITHUB_CLIENT_ID: 'gh-mock-id',
      GITHUB_CLIENT_SECRET: 'gh-mock-secret',
      GITHUB_AUTHORIZE_URL: `http://127.0.0.1:${mockPort}/github/authorize`,
      GITHUB_TOKEN_URL: `http://127.0.0.1:${mockPort}/github/token`,
      GITHUB_PROFILE_URL: `http://127.0.0.1:${mockPort}/github/user`,
      GITHUB_EMAILS_URL: `http://127.0.0.1:${mockPort}/github/emails`,
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_AUTHORIZE_URL: `http://127.0.0.1:${mockPort}/google/authorize`,
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${mockPort}/google/token`,
      GOOGLE_PROFILE_URL: `http://127.0.0.1:${mockPort}/google/userinfo`,
      GOOGLE_JWKS_URL: `http://127.0.0.1:${mockPort}/google/jwks`,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`Rust exited\n${output}`);
    if (output.includes('dropit listening on port ')) {
      try {
        const res = await fetch(`${origin}/healthz`);
        if (res.ok) return { child, url: origin, data, output: () => output };
      } catch {
        // Wait for TCP readiness.
      }
    }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Rust readiness timeout\n${output}`);
}

async function stop(server) {
  if (server && server.child.exitCode === null) {
    server.child.kill('SIGTERM');
    await once(server.child, 'exit');
  }
}

function cookies(response) {
  return response.headers.getSetCookie?.() || (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
}
function cookieFor(response, name) {
  return cookies(response).find(value => value.startsWith(`${name}=`))?.split(';')[0];
}
function hasFlowCookieClear(response) {
  return cookies(response).some(value => /^dropit_oauth=;\s*/i.test(value) && /Max-Age=0/i.test(value));
}

async function req(server, path, { method = 'GET', cookie, token, json, body, headers = {}, origin = undefined } = {}) {
  const hdrs = { ...headers };
  if (origin !== undefined) {
    if (origin !== null) hdrs.origin = origin;
  } else if (cookie) {
    hdrs.origin = server.url;
  }
  if (cookie) hdrs.cookie = cookie;
  if (token) hdrs.authorization = `Bearer ${token}`;
  let payload = body;
  if (json !== undefined) {
    hdrs['content-type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const response = await fetch(server.url + path, { method, headers: hdrs, body: payload, redirect: 'manual' });
  const raw = Buffer.from(await response.arrayBuffer());
  const text = raw.toString('utf8');
  let parsed = text;
  if (response.headers.get('content-type')?.startsWith('application/json')) {
    parsed = text ? JSON.parse(text) : null;
  }
  return { response, status: response.status, headers: response.headers, body: parsed, text };
}

function makeToken(overrides = {}, headerOverrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signJwt(
    { alg: 'RS256', typ: 'JWT', kid: key1.kid, ...headerOverrides },
    {
      iss: 'https://accounts.google.com',
      aud: GOOGLE_CLIENT_ID,
      sub: 'rust-google-sub-001',
      email: 'alice@example.test',
      email_verified: true,
      name: 'Alice Rust',
      iat: nowSec - 10,
      exp: nowSec + 3600,
      ...overrides,
    },
    key1.privateKey,
  );
}

let server;
try {
  server = await start({ ADMIN_EMAIL: 'root@example.test', ADMIN_PASSWORD: 'root-password-123' });

  // =========================================================================
  // 1. GET /api/auth/providers returns googleClientId without leaking secret
  // =========================================================================
  const providersRes = await req(server, '/api/auth/providers');
  assert.equal(providersRes.status, 200);
  assert.equal(providersRes.text.includes(GOOGLE_CLIENT_SECRET), false, 'must never leak clientSecret');
  assert.deepEqual(providersRes.body.providers, ['github', 'google']);
  assert.equal(providersRes.body.googleClientId, GOOGLE_CLIENT_ID);

  // Admin login via password
  const rootWeb = await req(server, '/api/auth/password/login', {
    method: 'POST',
    origin: server.url,
    json: { email: 'root@example.test', password: 'root-password-123' },
  });
  assert.equal(rootWeb.status, 200);
  const rootCookie = cookieFor(rootWeb.response, 'dropit_session');
  assert.ok(rootCookie);

  // =========================================================================
  // 2. App OAuth HTML Bridge Page (Accept: text/html) vs 302 (non-HTML)
  // =========================================================================
  // Open registration temporarily to test App OAuth login + link HTML bridges
  assert.equal((await req(server, '/api/admin/registration', { method: 'PUT', cookie: rootCookie, json: { policy: 'open' } })).status, 200);

  const appState = 'rustBridgeState_12345';
  const startLogin = await req(server, `/api/auth/google?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: appState, device_name: 'Rust Phone' })}`);
  assert.equal(startLogin.status, 302);
  const oauthState = new URL(startLogin.headers.get('location')).searchParams.get('state');
  const flowCookie = cookieFor(startLogin.response, 'dropit_oauth');

  const cbHtml = await req(server, `/api/auth/google/callback?${new URLSearchParams({ state: oauthState, code: 'google-login-ok' })}`, {
    headers: {
      cookie: flowCookie,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  assert.equal(cbHtml.status, 200);
  assert.match(cbHtml.headers.get('content-type') || '', /^text\/html;\s*charset=utf-8/i);
  assert.equal(cbHtml.headers.get('cache-control'), 'no-store');
  assert.equal(cbHtml.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(hasFlowCookieClear(cbHtml.response), true, 'must clear flow cookie');
  assert.equal(cookieFor(cbHtml.response, 'dropit_session'), undefined, 'must not set browser session cookie');
  assert.equal(/<script\b/i.test(cbHtml.text), false, 'must not contain <script>');

  const metaMatch = /<meta\s+http-equiv="refresh"\s+content="0;url=([^"]+)"/i.exec(cbHtml.text);
  assert.ok(metaMatch, 'must include meta refresh');
  const dropitUrl = new URL(decodeHtmlAttr(metaMatch[1]));
  assert.equal(`${dropitUrl.protocol}//${dropitUrl.host}${dropitUrl.pathname}`, APP_REDIRECT);
  assert.equal(dropitUrl.searchParams.get('state'), appState);
  const exchangeCode = dropitUrl.searchParams.get('code');
  assert.match(exchangeCode, /^[A-Za-z0-9_-]{43}$/);

  const expectedQuery = new URLSearchParams({ code: exchangeCode, state: appState }).toString();
  const intentMatch = /<a\s+class="btn"\s+href="([^"]+)"/i.exec(cbHtml.text);
  assert.ok(intentMatch);
  assert.equal(decodeHtmlAttr(intentMatch[1]), `intent://auth/callback?${expectedQuery}#Intent;scheme=dropit;package=dev.dropit.app;end`);
  const fallbackMatch = /<a\s+class="fallback"\s+href="([^"]+)"/i.exec(cbHtml.text);
  assert.ok(fallbackMatch);
  assert.equal(decodeHtmlAttr(fallbackMatch[1]), `${APP_REDIRECT}?${expectedQuery}`);
  assert.equal(visibleBodyText(cbHtml.text).includes(exchangeCode), false, 'must not print code in visible text');
  assert.ok(cbHtml.text.includes('授权已完成，正在返回 dropit…'));

  const exchanged = await req(server, '/api/auth/app/oauth/exchange', { method: 'POST', json: { code: exchangeCode } });
  assert.equal(exchanged.status, 200);
  const oauthToken = exchanged.body.access_token;

  // Link success HTML bridge
  const linkReq = await req(server, '/api/me/identities/github/app-link', {
    method: 'POST',
    token: oauthToken,
    json: { appState: 'rustLinkHtml_123456' },
  });
  assert.equal(linkReq.status, 200);
  const linkStart = await req(server, linkReq.body.path);
  assert.equal(linkStart.status, 302);
  const linkState = new URL(linkStart.headers.get('location')).searchParams.get('state');
  const linkCbHtml = await req(server, `/api/auth/github/callback?${new URLSearchParams({ state: linkState, code: 'gh-bind' })}`, {
    headers: { cookie: cookieFor(linkStart.response, 'dropit_oauth'), accept: 'text/html' },
  });
  assert.equal(linkCbHtml.status, 200);
  assert.equal(hasFlowCookieClear(linkCbHtml.response), true);
  assert.equal(cookieFor(linkCbHtml.response, 'dropit_session'), undefined);
  const linkQuery = new URLSearchParams({ linked: 'github', state: 'rustLinkHtml_123456' }).toString();
  assert.ok(decodeHtmlAttr(linkCbHtml.text).includes(`intent://auth/callback?${linkQuery}#Intent;scheme=dropit;package=dev.dropit.app;end`));
  assert.ok(decodeHtmlAttr(linkCbHtml.text).includes(`dropit://auth/callback?${linkQuery}`));

  // Failure HTML bridge
  const startErr = await req(server, `/api/auth/google?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: 'rustErrHtml_123456' })}`);
  const errState = new URL(startErr.headers.get('location')).searchParams.get('state');
  const cbErrHtml = await req(server, `/api/auth/google/callback?${new URLSearchParams({ state: errState, error: 'access_denied' })}`, {
    headers: { cookie: cookieFor(startErr.response, 'dropit_oauth'), accept: 'text/html' },
  });
  assert.equal(cbErrHtml.status, 200);
  assert.equal(cbErrHtml.headers.get('cache-control'), 'no-store');
  assert.equal(hasFlowCookieClear(cbErrHtml.response), true);
  assert.equal(cookieFor(cbErrHtml.response, 'dropit_session'), undefined);
  assert.ok(cbErrHtml.text.includes('授权未完成，请返回 dropit 查看原因'));
  const errQuery = new URLSearchParams({ error: 'OAUTH_DENIED', state: 'rustErrHtml_123456' }).toString();
  assert.ok(decodeHtmlAttr(cbErrHtml.text).includes(`intent://auth/callback?${errQuery}#Intent;scheme=dropit;package=dev.dropit.app;end`));

  // Non-HTML request still returns 302 Location: dropit://auth/callback?...
  const start302 = await req(server, `/api/auth/google?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: 'rustNonHtml_12345' })}`);
  const state302 = new URL(start302.headers.get('location')).searchParams.get('state');
  const cb302 = await req(server, `/api/auth/google/callback?${new URLSearchParams({ state: state302, code: 'google-login-ok' })}`, {
    headers: { cookie: cookieFor(start302.response, 'dropit_oauth'), accept: 'application/json' },
  });
  assert.equal(cb302.status, 302);
  assert.ok((cb302.headers.get('location') || '').startsWith('dropit://auth/callback?'));

  // =========================================================================
  // 3. POST /api/auth/app/google/id-token full verification & security checks
  // =========================================================================
  // Switch back to invite-only registration
  assert.equal((await req(server, '/api/admin/registration', { method: 'PUT', cookie: rootCookie, json: { policy: 'invite' } })).status, 200);

  // Cross-site Origin rejected
  assert.equal((await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    origin: 'https://evil.example',
    json: { idToken: makeToken() },
  })).status, 403);

  // Invite-only blocks uninvited new user
  const noInvite = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: makeToken(), deviceName: 'Rust Pixel' },
  });
  assert.equal(noInvite.status, 403);
  assert.equal(noInvite.body.error.code, 'INVITATION_REQUIRED');
  assert.equal(jwksFetches, 1, 'JWKS fetched once and cached');

  // Invalid invite rejected
  const badInvite = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: makeToken(), invite: 'invalid-invite-code' },
  });
  assert.equal(badInvite.status, 403);
  assert.equal(badInvite.body.error.code, 'INVITE_INVALID');
  assert.equal(jwksFetches, 1, 'JWKS served from cache');

  // Valid invite allows registration and issues read write account token
  const invRes = await req(server, '/api/admin/invites', {
    method: 'POST',
    cookie: rootCookie,
    json: { kind: 'registration', maxUses: 1, expiresInHours: 24 },
  });
  assert.equal(invRes.status, 201);
  const inviteToken = invRes.body.token;

  const aliceLogin = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: makeToken(), deviceName: 'Alice Rust Phone', invite: inviteToken },
  });
  assert.equal(aliceLogin.status, 200);
  assert.equal(aliceLogin.body.token_type, 'Bearer');
  assert.equal(aliceLogin.body.scope, 'read write account');
  assert.equal(aliceLogin.body.expires_in, 365 * 86400);
  assert.equal(aliceLogin.body.user.email, 'alice@example.test');
  assert.equal(aliceLogin.body.user.name, 'Alice Rust');
  assert.equal(aliceLogin.body.user.role, 'user');
  assert.equal(aliceLogin.body.mustChangePassword, false);
  assert.match(aliceLogin.body.access_token, /^[A-Za-z0-9_-]{43}$/);

  assert.equal((await req(server, '/api/me/identities', { token: aliceLogin.body.access_token })).status, 200);
  assert.equal((await req(server, '/api/admin/users', { token: aliceLogin.body.access_token })).status, 403);

  // Subsequent login with iss="accounts.google.com" reuses existing account without invite
  const aliceAgain = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: makeToken({ iss: 'accounts.google.com' }) },
  });
  assert.equal(aliceAgain.status, 200);
  assert.equal(aliceAgain.body.user.id, aliceLogin.body.user.id);

  // ADMIN_EMAILS bypasses invite and receives admin scope
  const bossLogin = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: makeToken({ sub: 'rust-google-boss', email: 'boss@example.test', name: 'Boss Rust' }) },
  });
  assert.equal(bossLogin.status, 200);
  assert.equal(bossLogin.body.scope, 'read write account admin');
  assert.equal(bossLogin.body.user.role, 'admin');
  assert.equal((await req(server, '/api/admin/users', { token: bossLogin.body.access_token })).status, 200);

  // Existing unlinked email防劫持 -> 409 ACCOUNT_EXISTS
  const hijack = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: makeToken({ sub: 'rust-hijack-sub', email: 'root@example.test', name: 'Hijack' }) },
  });
  assert.equal(hijack.status, 409);
  assert.equal(hijack.body.error.code, 'ACCOUNT_EXISTS');

  // Disabled user -> 403 USER_DISABLED
  assert.equal((await req(server, `/api/admin/users/${aliceLogin.body.user.id}`, {
    method: 'PATCH',
    cookie: rootCookie,
    json: { disabled: true },
  })).status, 204);
  const disabledLogin = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: makeToken() },
  });
  assert.equal(disabledLogin.status, 403);
  assert.equal(disabledLogin.body.error.code, 'USER_DISABLED');

  // Re-enable Alice
  assert.equal((await req(server, `/api/admin/users/${aliceLogin.body.user.id}`, {
    method: 'PATCH',
    cookie: rootCookie,
    json: { disabled: false },
  })).status, 204);

  // Tampered signature -> 401 OAUTH_PROVIDER_ERROR
  const validTok = makeToken();
  const [h, p, s] = validTok.split('.');
  const tampered = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: `${h}.${p}.${(s[0] === 'A' ? 'B' : 'A') + s.slice(1)}` },
  });
  assert.equal(tampered.status, 401);
  assert.equal(tampered.body.error.code, 'OAUTH_PROVIDER_ERROR');

  // Non-RS256 alg -> 401 OAUTH_PROVIDER_ERROR
  for (const alg of ['none', 'HS256', 'RS384']) {
    const res = await req(server, '/api/auth/app/google/id-token', {
      method: 'POST',
      json: { idToken: makeToken({}, { alg }) },
    });
    assert.equal(res.status, 401, alg);
    assert.equal(res.body.error.code, 'OAUTH_PROVIDER_ERROR', alg);
  }

  // Claims checks: aud, iss, exp, iat, nbf, sub
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [label, overrides] of [
    ['wrong aud', { aud: 'wrong-client.apps.googleusercontent.com' }],
    ['wrong iss', { iss: 'https://evil.example' }],
    ['expired >60s', { exp: nowSec - 61 }],
    ['future iat >60s', { iat: nowSec + 120 }],
    ['future nbf >60s', { nbf: nowSec + 120 }],
    ['empty sub', { sub: '' }],
  ]) {
    const res = await req(server, '/api/auth/app/google/id-token', {
      method: 'POST',
      json: { idToken: makeToken(overrides) },
    });
    assert.equal(res.status, 401, label);
    assert.equal(res.body.error.code, 'OAUTH_PROVIDER_ERROR', label);
  }

  // Clock skew tolerance within 60s
  const skewOk = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: makeToken({ exp: nowSec - 30 }) },
  });
  assert.equal(skewOk.status, 200);

  // email_verified=false or empty email -> 403 VERIFIED_EMAIL_REQUIRED
  for (const [label, overrides] of [
    ['email_verified=false', { email_verified: false }],
    ['email_verified="true"', { email_verified: 'true' }],
    ['empty email', { email: '' }],
  ]) {
    const res = await req(server, '/api/auth/app/google/id-token', {
      method: 'POST',
      json: { idToken: makeToken(overrides) },
    });
    assert.equal(res.status, 403, label);
    assert.equal(res.body.error.code, 'VERIFIED_EMAIL_REQUIRED', label);
  }

  // Anti-DoS cooldown: unknown kid within cooldown does not refetch JWKS
  const fetchesBefore = jwksFetches;
  const unknownKid = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: makeToken({}, { kid: 'forged-kid-rust' }) },
  });
  assert.equal(unknownKid.status, 401);
  assert.equal(jwksFetches, fetchesBefore);

  // Disable Google via admin settings -> providers hides googleClientId & id-token returns 404 PROVIDER_UNAVAILABLE
  assert.equal((await req(server, '/api/admin/oauth/google', {
    method: 'PUT',
    cookie: rootCookie,
    json: { clientId: 'db-google-id', clientSecret: 'db-google-secret', enabled: false },
  })).status, 200);

  const disabledProviders = await req(server, '/api/auth/providers');
  assert.equal(disabledProviders.status, 200);
  assert.deepEqual(disabledProviders.body.providers, ['github']);
  assert.equal(disabledProviders.body.googleClientId, undefined);

  const unavailable = await req(server, '/api/auth/app/google/id-token', {
    method: 'POST',
    json: { idToken: makeToken() },
  });
  assert.equal(unavailable.status, 404);
  assert.equal(unavailable.body.error.code, 'PROVIDER_UNAVAILABLE');

  // Re-enable with DB clientId -> returns DB googleClientId without secret
  assert.equal((await req(server, '/api/admin/oauth/google', {
    method: 'PUT',
    cookie: rootCookie,
    json: { clientId: 'db-google-id', clientSecret: 'db-google-secret', enabled: true },
  })).status, 200);
  const reenabledProviders = await req(server, '/api/auth/providers');
  assert.equal(reenabledProviders.text.includes('db-google-secret'), false);
  assert.equal(reenabledProviders.body.googleClientId, 'db-google-id');

  console.log('PASS RHEA-272 Rust App OAuth HTML bridge, providers googleClientId & Google ID Token login');
} finally {
  await stop(server);
  mock.close();
  await rm(temporary, { recursive: true, force: true });
}
