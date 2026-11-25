import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const rust = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
await mkdir(resolve(root, 'rust/server/data'), {recursive: true});
const temporary = await mkdtemp(resolve(root, 'rust/server/data/auth-'));
const mock = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://mock').pathname;
  let body = '';
  for await (const chunk of request) body += chunk;
  response.setHeader('content-type', 'application/json');
  if (path === '/token' || path === '/google/token') {
    const form = new URLSearchParams(body);
    const code = form.get('code') || '';
    if (code === 'provider-error') { response.statusCode = 500; response.end(JSON.stringify({error: 'server_error'})); return; }
    if (code === 'dropit-credential-check') { response.end(JSON.stringify({error: 'invalid_grant'})); return; }
    const known = new Set(['first', 'conflict', 'pending', 'linked', 'unverified', 'google-link', 'google-unverified']);
    const fallback = path === '/google/token' ? 'google-link' : 'first';
    response.end(JSON.stringify({access_token: known.has(code) ? code : fallback})); return;
  }
  const access = request.headers.authorization?.replace(/^Bearer /, '') || 'first';
  if (path === '/google/userinfo') {
    const users = {
      'google-link': {sub: 'g-link-1', name: 'Google Linked', email: 'google-link@example.test', email_verified: true},
      'google-unverified': {sub: 'g-unverified', name: 'Unverified Google', email: 'unverified@example.test', email_verified: false},
    };
    response.end(JSON.stringify(users[access] || users['google-link'])); return;
  }
  if (path === '/user') {
    const users = {
      first: {id: 1, login: 'first', name: 'First User'},
      conflict: {id: 2, login: 'conflict', name: 'Conflict User'},
      pending: {id: 3, login: 'pending', name: 'Pending User'},
      linked: {id: 4, login: 'linked', name: 'Linked User'},
      unverified: {id: 5, login: 'unverified', name: 'Unverified User'},
    };
    response.end(JSON.stringify(users[access] || users.first)); return;
  }
  if (path === '/emails') {
    if (access === 'unverified') {
      response.end(JSON.stringify([{email: 'unverified@example.test', primary: true, verified: false}])); return;
    }
    const emails = {first: 'first@example.test', conflict: 'existing@example.test', pending: 'pending@example.test', linked: 'linked@example.test'};
    response.end(JSON.stringify([{email: emails[access] || emails.first, primary: true, verified: true}])); return;
  }
  response.statusCode = 404; response.end(JSON.stringify({error: 'not_found'}));
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const mockPort = mock.address().port;

async function freePort() {
  const server = createTcpServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

async function start(options = {}) {
  const data = await mkdtemp(resolve(temporary, 'data-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(rust, [], {cwd: root, env: {
    PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin,
    RATE_GENERAL: '10000', RATE_AUTH: '1000', RATE_INVITE: '1000', RATE_UPLOAD: '1000',
    GITHUB_CLIENT_ID: 'mock-id', GITHUB_CLIENT_SECRET: 'mock-secret',
    GITHUB_AUTHORIZE_URL: `http://127.0.0.1:${mockPort}/authorize`, GITHUB_TOKEN_URL: `http://127.0.0.1:${mockPort}/token`,
    GITHUB_PROFILE_URL: `http://127.0.0.1:${mockPort}/user`, GITHUB_EMAILS_URL: `http://127.0.0.1:${mockPort}/emails`, ...options,
  }, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error('Rust exited during startup\n' + output);
    if (output.includes('dropit listening on port ')) return {child, url: origin, data, output: () => output};
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Rust readiness timeout\n' + output);
}

async function stop(server) {
  if (server.child.exitCode === null) { server.child.kill('SIGTERM'); await once(server.child, 'exit'); }
}

function cookies(response) { return response.headers.getSetCookie?.() || (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []); }
function cookieFor(response, name) { return cookies(response).find(value => value.startsWith(name + '='))?.split(';')[0]; }

async function request(server, path, {method = 'GET', cookie, json, headers = {}, redirect = 'manual'} = {}) {
  const response = await fetch(server.url + path, {method, redirect, headers: {origin: server.url, ...(cookie ? {cookie} : {}), ...(json !== undefined ? {'content-type': 'application/json'} : {}), ...headers}, body: json === undefined ? undefined : JSON.stringify(json)});
  const text = await response.text(); let body = text;
  if (response.headers.get('content-type')?.startsWith('application/json')) body = text ? JSON.parse(text) : null;
  return {response, status: response.status, headers: response.headers, body};
}

function hasFlowCookieClear(response) {
  return cookies(response).some(value => value.startsWith('dropit_oauth=;') && value.includes('Max-Age=0'));
}
function hasAnyFlowCookie(response) {
  return cookies(response).some(value => value.startsWith('dropit_oauth='));
}
function positiveRetryAfter(headers) {
  const retry = headers.get('retry-after');
  return retry !== null && /^[0-9]+$/.test(retry) && Number(retry) > 0;
}

async function oauth(server, code, {provider = 'github', invite, link = false, cookie, headers = {}} = {}) {
  const params = new URLSearchParams();
  if (link) params.set('link', '1');
  else if (invite) params.set('invite', invite);
  const query = params.toString() ? `?${params}` : '';
  const start = await request(server, `/api/auth/${provider}${query}`, {cookie, headers});
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const flow = cookieFor(start.response, 'dropit_oauth');
  assert.ok(state && flow);
  const combinedCookie = cookie ? `${cookie}; ${flow}` : flow;
  const callback = await request(server, `/api/auth/${provider}/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`, {cookie: combinedCookie, headers});
  return {start, callback, state, flow};
}

let server;
try {
  server = await start();
  let result = await request(server, '/api/auth/providers');
  assert.deepEqual(result.body.providers, ['github']);
  assert.equal(result.body.setupRequired, true);

  // An invalid invite is ignored for the first OAuth bootstrap, matching TS.
  const first = await oauth(server, 'first', {invite: 'unknown'});
  assert.equal(first.callback.status, 302);
  assert.ok(hasFlowCookieClear(first.callback.response), 'successful callback must clear flow cookie');
  const adminCookie = cookieFor(first.callback.response, 'dropit_session');
  assert.ok(adminCookie);
  result = await request(server, '/api/me', {cookie: adminCookie});
  assert.equal(result.body.user.role, 'admin');

  // Replay of an already-consumed flow fails before cookie clearing, matching TS.
  const replay = await request(server, `/api/auth/github/callback?state=${first.state}&code=first`, {cookie: first.flow});
  assert.equal(replay.status, 302);
  assert.equal(replay.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`);
  assert.equal(hasAnyFlowCookie(replay.response), false, 'replayed consumed flow must not clear flow cookie');
  assert.equal(replay.headers.get('retry-after'), null);

  // Post-consumption failures (provider error, unverified email, denied) clear the flow cookie.
  const failed = await oauth(server, 'provider-error');
  assert.equal(failed.callback.status, 302);
  assert.equal(failed.callback.headers.get('location'), `${server.url}/login?error=OAUTH_PROVIDER_ERROR`);
  assert.ok(hasFlowCookieClear(failed.callback.response));
  const unverified = await oauth(server, 'unverified');
  assert.equal(unverified.callback.status, 302);
  assert.equal(unverified.callback.headers.get('location'), `${server.url}/login?error=VERIFIED_EMAIL_REQUIRED`);
  assert.ok(hasFlowCookieClear(unverified.callback.response));

  // Pre-flow callback rejections (unknown/unconfigured provider, missing/wrong state/cookie) never clear
  // the flow cookie and never consume an unrelated pending flow.
  for (const path of ['/api/auth/password', '/api/auth/unknown', '/api/auth/google']) {
    const startMiss = await request(server, path);
    assert.equal(startMiss.status, 404);
    assert.equal(startMiss.body?.error?.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(startMiss.headers.get('location'), null);
    assert.equal(hasAnyFlowCookie(startMiss.response), false);
    const cbMiss = await request(server, `${path}/callback`);
    assert.equal(cbMiss.status, 302);
    assert.equal(cbMiss.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`);
    assert.equal(hasAnyFlowCookie(cbMiss.response), false);
  }
  const pendingStart = await request(server, '/api/auth/github');
  assert.equal(pendingStart.status, 302);
  const pendingState = new URL(pendingStart.headers.get('location')).searchParams.get('state');
  const pendingFlow = cookieFor(pendingStart.response, 'dropit_oauth');
  assert.ok(pendingState && pendingFlow);
  for (const [query, cookie] of [
    ['', pendingFlow],
    ['state=', pendingFlow],
    ['state=wrong-state&code=first', pendingFlow],
    [`state=${encodeURIComponent(pendingState)}&code=first`, undefined],
    [`state=${encodeURIComponent(pendingState)}&code=first`, 'dropit_oauth=wrong-cookie'],
  ]) {
    const bad = await request(server, `/api/auth/github/callback${query ? `?${query}` : ''}`, {cookie});
    assert.equal(bad.status, 302);
    assert.equal(bad.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`);
    assert.equal(hasAnyFlowCookie(bad.response), false, `pre-flow rejection (${query}) must not clear cookie`);
  }
  // Because none of the invalid callbacks consumed the flow, the real flow is still valid and
  // completes login cleanly; replaying it afterwards fails without clearing the cookie.
  const pendingOk = await request(server, `/api/auth/github/callback?state=${encodeURIComponent(pendingState)}&code=first`, {cookie: pendingFlow});
  assert.equal(pendingOk.status, 302);
  assert.equal(pendingOk.headers.get('location'), `${server.url}/`);
  assert.ok(hasFlowCookieClear(pendingOk.response));
  assert.ok(cookieFor(pendingOk.response, 'dropit_session'));
  const afterOkReplay = await request(server, `/api/auth/github/callback?state=${encodeURIComponent(pendingState)}&code=first`, {cookie: pendingFlow});
  assert.equal(afterOkReplay.status, 302);
  assert.equal(afterOkReplay.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`);
  assert.equal(hasAnyFlowCookie(afterOkReplay.response), false);

  // Explicit provider denial consumes the flow and clears the flow cookie.
  const deniedStart = await request(server, '/api/auth/github');
  assert.equal(deniedStart.status, 302);
  const deniedState = new URL(deniedStart.headers.get('location')).searchParams.get('state');
  const deniedFlow = cookieFor(deniedStart.response, 'dropit_oauth');
  const denied = await request(server, `/api/auth/github/callback?state=${encodeURIComponent(deniedState)}&error=access_denied`, {cookie: deniedFlow});
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get('location'), `${server.url}/login?error=OAUTH_DENIED`);
  assert.ok(hasFlowCookieClear(denied.response));
  const afterDeniedReplay = await request(server, `/api/auth/github/callback?state=${encodeURIComponent(deniedState)}&code=first`, {cookie: deniedFlow});
  assert.equal(afterDeniedReplay.status, 302);
  assert.equal(afterDeniedReplay.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`);
  assert.equal(hasAnyFlowCookie(afterDeniedReplay.response), false);

  // OAuth callback code length uses JS UTF-16 code units (<= 4096), not UTF-8 bytes or scalar count.
  const emptyCodeStart = await request(server, '/api/auth/github');
  assert.equal(emptyCodeStart.status, 302);
  const emptyCodeState = new URL(emptyCodeStart.headers.get('location')).searchParams.get('state');
  const emptyCodeFlow = cookieFor(emptyCodeStart.response, 'dropit_oauth');
  const emptyCodeCb = await request(server, `/api/auth/github/callback?state=${encodeURIComponent(emptyCodeState)}&code=`, {cookie: emptyCodeFlow});
  assert.equal(emptyCodeCb.status, 302);
  assert.equal(emptyCodeCb.headers.get('location'), `${server.url}/login?error=OAUTH_DENIED`);
  assert.ok(hasFlowCookieClear(emptyCodeCb.response));

  for (const [label, code, shouldAccept] of [
    ['ascii-4096', 'a'.repeat(4096), true],
    ['ascii-4097', 'a'.repeat(4097), false],
    ['bmp-1366', '界'.repeat(1366), true],
    ['bmp-4096-units', '界'.repeat(1366) + 'a'.repeat(2730), true],
    ['bmp-4097-units', '界'.repeat(1366) + 'a'.repeat(2731), false],
    ['supplementary-4096-units', 'a'.repeat(4094) + '😀', true],
    ['supplementary-4097-units', 'a'.repeat(4095) + '😀', false],
  ]) {
    const res = await oauth(server, code);
    assert.equal(res.callback.status, 302, label);
    assert.ok(hasFlowCookieClear(res.callback.response), `${label} must clear flow cookie`);
    if (shouldAccept) {
      assert.equal(res.callback.headers.get('location'), `${server.url}/`, `${label} should succeed`);
      assert.ok(cookieFor(res.callback.response, 'dropit_session'), `${label} should set session`);
    } else {
      assert.equal(res.callback.headers.get('location'), `${server.url}/login?error=OAUTH_DENIED`, `${label} should fail with OAUTH_DENIED`);
      assert.equal(cookieFor(res.callback.response, 'dropit_session'), undefined, `${label} must not set session`);
    }
    const replayCode = await request(server, `/api/auth/github/callback?state=${encodeURIComponent(res.state)}&code=first`, {cookie: res.flow});
    assert.equal(replayCode.status, 302, `${label} replay`);
    assert.equal(replayCode.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`, `${label} replay must see consumed flow`);
    assert.equal(hasAnyFlowCookie(replayCode.response), false, `${label} replay must not clear cookie`);
  }

  result = await request(server, '/api/admin/oauth', {cookie: adminCookie});
  assert.equal(result.body.providers.length, 2);
  result = await request(server, '/api/admin/oauth/github', {method: 'PUT', cookie: adminCookie, json: {clientId: 'mock-id', clientSecret: '秘密秘密秘密秘密秘密'}});
  assert.equal(result.status, 200); assert.ok(result.body.providers.find(provider => provider.provider === 'github').secretHint);
  result = await request(server, '/api/me/identities', {cookie: adminCookie});
  assert.deepEqual(result.body.available, ['github']);
  result = await request(server, '/api/admin/oauth/github/verify', {method: 'POST', cookie: adminCookie, json: {}});
  assert.equal(result.body.code, 'CREDENTIALS_OK');

  // Disabled DB provider returns 404 on start and OAUTH_STATE_INVALID (without clearing cookie) on callback.
  result = await request(server, '/api/admin/oauth/github', {method: 'PUT', cookie: adminCookie, json: {clientId: 'mock-id', enabled: false}});
  assert.equal(result.status, 200);
  const disabledStart = await request(server, '/api/auth/github');
  assert.equal(disabledStart.status, 404);
  assert.equal(disabledStart.body?.error?.code, 'PROVIDER_UNAVAILABLE');
  const disabledCb = await request(server, '/api/auth/github/callback?state=any&code=first', {cookie: 'dropit_oauth=any'});
  assert.equal(disabledCb.status, 302);
  assert.equal(disabledCb.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`);
  assert.equal(hasAnyFlowCookie(disabledCb.response), false);
  result = await request(server, '/api/admin/oauth/github', {method: 'PUT', cookie: adminCookie, json: {clientId: 'mock-id', enabled: true}});
  assert.equal(result.status, 200);

  // Registration policy and the single-use personal invite retain the old API shape.
  result = await request(server, '/api/auth/password/register', {method: 'POST', json: {email: 'existing@example.test', password: 'Password-123'}});
  assert.equal(result.body.error.code, 'INVITATION_REQUIRED');
  result = await request(server, '/api/admin/registration', {method: 'PUT', cookie: adminCookie, json: {policy: 'open'}});
  assert.equal(result.status, 200);
  result = await request(server, '/api/auth/password/register', {method: 'POST', json: {email: 'existing@example.test', password: 'Password-123'}});
  assert.equal(result.status, 201);
  const userCookie = cookieFor(result.response, 'dropit_session');
  result = await request(server, '/api/auth/logout', {method: 'POST', cookie: userCookie}); assert.equal(result.status, 204);
  result = await request(server, '/api/auth/password/login', {method: 'POST', json: {email: 'existing@example.test', password: 'Password-123'}});
  const existingCookie = cookieFor(result.response, 'dropit_session'); assert.ok(existingCookie);
  const conflict = await oauth(server, 'conflict');
  assert.equal(conflict.callback.status, 302); assert.match(conflict.callback.headers.get('location'), /ACCOUNT_EXISTS/);

  result = await request(server, '/api/me/invites', {method: 'POST', cookie: adminCookie, json: {maxUses: 5}});
  assert.equal(result.status, 201); assert.equal(result.body.maxUses, 1);
  result = await request(server, '/api/admin/invites', {cookie: adminCookie});
  assert.equal(result.status, 200); assert.ok(result.body.invites.every(invite => 'kind' in invite && 'status' in invite && 'creatorAdmin' in invite));
  result = await request(server, '/api/admin/users', {method: 'POST', cookie: adminCookie, json: {email: 'pending@example.test', name: 'Pending'}});
  assert.equal(result.status, 201);
  result = await request(server, `/api/admin/users/${result.body.id}`, {method: 'PATCH', cookie: adminCookie, json: {disabled: true}});
  assert.equal(result.status, 204);
  const disabledOAuth = await oauth(server, 'pending');
  assert.equal(disabledOAuth.callback.status, 302); assert.match(disabledOAuth.callback.headers.get('location'), /USER_DISABLED/);

  // Mock Google OAuth + account linking + link denial without revoking the browser session.
  await stop(server);
  server = await start({
    GOOGLE_CLIENT_ID: 'google-mock-id',
    GOOGLE_CLIENT_SECRET: 'google-mock-secret',
    GOOGLE_AUTHORIZE_URL: `http://127.0.0.1:${mockPort}/google/authorize`,
    GOOGLE_TOKEN_URL: `http://127.0.0.1:${mockPort}/google/token`,
    GOOGLE_PROFILE_URL: `http://127.0.0.1:${mockPort}/google/userinfo`,
  });
  const boot = await oauth(server, 'first');
  assert.equal(boot.callback.status, 302);
  const linkedAdminCookie = cookieFor(boot.callback.response, 'dropit_session');
  assert.ok(linkedAdminCookie);
  const unauthLink = await request(server, '/api/auth/google?link=1');
  assert.equal(unauthLink.status, 302);
  assert.equal(unauthLink.headers.get('location'), `${server.url}/login?error=UNAUTHENTICATED`);
  assert.equal(hasAnyFlowCookie(unauthLink.response), false);
  const linkDeniedStart = await request(server, '/api/auth/google?link=1', {cookie: linkedAdminCookie});
  assert.equal(linkDeniedStart.status, 302);
  const linkDeniedState = new URL(linkDeniedStart.headers.get('location')).searchParams.get('state');
  const linkDeniedFlow = cookieFor(linkDeniedStart.response, 'dropit_oauth');
  const linkDeniedCb = await request(server, `/api/auth/google/callback?state=${encodeURIComponent(linkDeniedState)}&error=access_denied`, {cookie: `${linkedAdminCookie}; ${linkDeniedFlow}`});
  assert.equal(linkDeniedCb.status, 302);
  assert.equal(linkDeniedCb.headers.get('location'), `${server.url}/settings?link_error=OAUTH_DENIED#login-methods`);
  assert.ok(hasFlowCookieClear(linkDeniedCb.response));
  const linkTooLong = await oauth(server, 'a'.repeat(4095) + '😀', {provider: 'google', link: true, cookie: linkedAdminCookie});
  assert.equal(linkTooLong.callback.status, 302);
  assert.equal(linkTooLong.callback.headers.get('location'), `${server.url}/settings?link_error=OAUTH_DENIED#login-methods`);
  assert.ok(hasFlowCookieClear(linkTooLong.callback.response));
  const linkTooLongReplay = await request(server, `/api/auth/google/callback?state=${encodeURIComponent(linkTooLong.state)}&code=google-link`, {cookie: `${linkedAdminCookie}; ${linkTooLong.flow}`});
  assert.equal(linkTooLongReplay.status, 302);
  assert.equal(linkTooLongReplay.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`);
  assert.equal(hasAnyFlowCookie(linkTooLongReplay.response), false);
  const googleLinked = await oauth(server, 'google-link', {provider: 'google', link: true, cookie: linkedAdminCookie});
  assert.equal(googleLinked.callback.status, 302);
  assert.equal(googleLinked.callback.headers.get('location'), `${server.url}/settings?linked=google#login-methods`);
  assert.ok(hasFlowCookieClear(googleLinked.callback.response));
  const googleLinkedAgain = await oauth(server, 'google-link', {provider: 'google', link: true, cookie: linkedAdminCookie});
  assert.equal(googleLinkedAgain.callback.status, 302);
  assert.equal(googleLinkedAgain.callback.headers.get('location'), `${server.url}/settings?linked=google&already=1#login-methods`);
  assert.ok(hasFlowCookieClear(googleLinkedAgain.callback.response));
  result = await request(server, '/api/me/identities', {cookie: linkedAdminCookie});
  assert.deepEqual(result.body.identities.map(item => item.provider).sort(), ['github', 'google']);
  const googleSignIn = await oauth(server, 'google-link', {provider: 'google'});
  assert.equal(googleSignIn.callback.status, 302);
  assert.equal(googleSignIn.callback.headers.get('location'), `${server.url}/`);
  assert.ok(hasFlowCookieClear(googleSignIn.callback.response));
  assert.ok(cookieFor(googleSignIn.callback.response, 'dropit_session'));
  result = await request(server, '/api/me', {cookie: linkedAdminCookie});
  assert.equal(result.status, 200);

  // Rate limiting: shared auth bucket across password login + OAuth start/callback uses a generous window
  // so debug scrypt verification cannot race the bucket reset on slower CI runners.
  await stop(server);
  server = await start({
    GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '',
    ADMIN_EMAIL: 'rate@example.test', ADMIN_PASSWORD: 'Password-123',
    RATE_AUTH: '3', RATE_WINDOW_MS: '60000',
  });
  const loginRes = await request(server, '/api/auth/password/login', {method: 'POST', json: {email: 'rate@example.test', password: 'Password-123'}});
  assert.equal(loginRes.status, 200);
  const keptSession = cookieFor(loginRes.response, 'dropit_session');
  assert.ok(keptSession);
  // 1 auth token was spent by password login; next 2 start requests are 404, 4th is 429 JSON.
  const startSeq = [];
  for (const [index, path] of ['/api/auth/password', '/api/auth/github', '/api/auth/github'].entries()) {
    startSeq.push(await request(server, path, {cookie: keptSession, headers: {'x-forwarded-for': `203.0.113.${index + 1}`}}));
  }
  assert.deepEqual(startSeq.map(item => item.status), [404, 404, 429]);
  assert.equal(startSeq[2].body?.error?.code, 'RATE_LIMITED');
  assert.ok(positiveRetryAfter(startSeq[2].headers), 'start 429 must include positive Retry-After');
  assert.equal(startSeq[2].headers.get('location'), null);
  assert.equal(hasAnyFlowCookie(startSeq[2].response), false);
  // Existing session must not be revoked by auth rate limiting.
  assert.equal((await request(server, '/api/me', {cookie: keptSession})).status, 200);
  // Callback on the same exhausted IP bucket redirects with 302 RATE_LIMITED + Retry-After and no flow cookie clear.
  const limitedCb = await request(server, '/api/auth/github/callback', {headers: {'x-forwarded-for': '203.0.113.99'}});
  assert.equal(limitedCb.status, 302);
  assert.equal(limitedCb.headers.get('location'), `${server.url}/login?error=RATE_LIMITED`);
  assert.ok(positiveRetryAfter(limitedCb.headers), 'callback 302 RATE_LIMITED must include positive Retry-After');
  assert.equal(hasAnyFlowCookie(limitedCb.response), false);

  // Separate lightweight window-recovery scenario without expensive password hashing:
  // verifies both start (429 JSON) and callback (302 RATE_LIMITED) recover after the window expires.
  await stop(server);
  server = await start({GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', RATE_AUTH: '2', RATE_WINDOW_MS: '1500'});
  const fastStart = [];
  for (let i = 0; i < 3; i++) {
    fastStart.push(await request(server, '/api/auth/github', {headers: {'x-forwarded-for': `203.0.113.${10 + i}`}}));
  }
  assert.deepEqual(fastStart.map(item => item.status), [404, 404, 429]);
  assert.equal(fastStart[2].body?.error?.code, 'RATE_LIMITED');
  assert.ok(positiveRetryAfter(fastStart[2].headers), 'fast start 429 must include positive Retry-After');
  assert.equal(fastStart[2].headers.get('location'), null);
  assert.equal(hasAnyFlowCookie(fastStart[2].response), false);
  const startRetryMs = Number(fastStart[2].headers.get('retry-after')) * 1000;
  await new Promise(resolve => setTimeout(resolve, Math.max(1700, startRetryMs + 250)));
  const recoveredStart = await request(server, '/api/auth/github');
  assert.equal(recoveredStart.status, 404);
  assert.equal(recoveredStart.body?.error?.code, 'PROVIDER_UNAVAILABLE');
  const cbSecond = await request(server, '/api/auth/github/callback');
  assert.equal(cbSecond.status, 302);
  assert.equal(cbSecond.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`);
  assert.equal(hasAnyFlowCookie(cbSecond.response), false);
  const cbBlocked = await request(server, '/api/auth/github/callback');
  assert.equal(cbBlocked.status, 302);
  assert.equal(cbBlocked.headers.get('location'), `${server.url}/login?error=RATE_LIMITED`);
  assert.ok(positiveRetryAfter(cbBlocked.headers));
  assert.equal(hasAnyFlowCookie(cbBlocked.response), false);
  const cbRetryMs = Number(cbBlocked.headers.get('retry-after')) * 1000;
  await new Promise(resolve => setTimeout(resolve, Math.max(1700, cbRetryMs + 250)));
  const recoveredCb = await request(server, '/api/auth/github/callback');
  assert.equal(recoveredCb.status, 302);
  assert.equal(recoveredCb.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`);
  assert.equal(hasAnyFlowCookie(recoveredCb.response), false);

  // Callback-only rate limit sequence (without provider credentials) matches TS exactly.
  await stop(server);
  server = await start({GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', RATE_AUTH: '3', RATE_WINDOW_MS: '60000'});
  for (let i = 0; i < 4; i++) {
    const res = await request(server, '/api/auth/github/callback', {headers: {'x-forwarded-for': `198.51.100.${i + 1}`}});
    assert.equal(res.status, 302);
    assert.equal(hasAnyFlowCookie(res.response), false);
    if (i < 3) {
      assert.equal(res.headers.get('location'), `${server.url}/login?error=OAUTH_STATE_INVALID`);
      assert.equal(res.headers.get('retry-after'), null);
    } else {
      assert.equal(res.headers.get('location'), `${server.url}/login?error=RATE_LIMITED`);
      assert.ok(positiveRetryAfter(res.headers));
    }
  }

  // Identity rate limit (auth:identity) after valid flow consumption preserves Retry-After,
  // clears the flow cookie, routes login vs link correctly, and preserves existing sessions.
  await stop(server);
  server = await start({RATE_AUTH: '2', RATE_WINDOW_MS: '60000', TRUST_PROXY: 'loopback'});
  const idRun1 = await oauth(server, 'first', {headers: {'x-forwarded-for': '198.51.100.11'}});
  assert.equal(idRun1.callback.status, 302);
  assert.equal(idRun1.callback.headers.get('location'), `${server.url}/`);
  const idSession = cookieFor(idRun1.callback.response, 'dropit_session');
  assert.ok(idSession);
  const idRun2 = await oauth(server, 'first', {headers: {'x-forwarded-for': '198.51.100.12'}});
  assert.equal(idRun2.callback.status, 302);
  assert.equal(idRun2.callback.headers.get('location'), `${server.url}/`);
  const idRun3 = await oauth(server, 'first', {headers: {'x-forwarded-for': '198.51.100.13'}});
  assert.equal(idRun3.callback.status, 302);
  assert.equal(idRun3.callback.headers.get('location'), `${server.url}/login?error=RATE_LIMITED`);
  assert.ok(positiveRetryAfter(idRun3.callback.headers), 'identity limit on login callback must include Retry-After');
  assert.ok(hasFlowCookieClear(idRun3.callback.response), 'identity limit after flow consumption must clear flow cookie');
  const idLinkLimited = await oauth(server, 'first', {link: true, cookie: idSession, headers: {'x-forwarded-for': '198.51.100.14'}});
  assert.equal(idLinkLimited.callback.status, 302);
  assert.equal(idLinkLimited.callback.headers.get('location'), `${server.url}/settings?link_error=RATE_LIMITED#login-methods`);
  assert.ok(positiveRetryAfter(idLinkLimited.callback.headers), 'identity limit on link callback must include Retry-After');
  assert.ok(hasFlowCookieClear(idLinkLimited.callback.response), 'identity limit on link callback must clear flow cookie');
  assert.equal((await request(server, '/api/me', {cookie: idSession})).status, 200);

  // Concurrent setup has one winner on an independent empty database.
  await stop(server); server = await start({GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: ''});
  const codeLine = server.output().split('\n').find(line => line.startsWith('dropit setup code: '));
  const setupCode = codeLine?.slice('dropit setup code: '.length); assert.ok(setupCode);
  const setup = body => request(server, '/api/setup', {method: 'POST', json: body});
  const setups = await Promise.all([setup({code: setupCode, email: 'one@example.test', password: 'Password-123'}), setup({code: setupCode, email: 'two@example.test', password: 'Password-123'})]);
  assert.deepEqual(setups.map(value => value.status).sort(), [201, 409]);
  console.log('PASS authentication, mock OAuth, Google/link, rate-limit boundaries, setup race, redirects, invitations, admin OAuth and sessions');
} finally {
  if (server) await stop(server);
  mock.close(); await rm(temporary, {recursive: true, force: true});
}
