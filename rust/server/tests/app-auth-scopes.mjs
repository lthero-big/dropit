import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const rust = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
const APP_REDIRECT = 'dropit://auth/callback';

await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const temporary = await mkdtemp(resolve(root, 'rust/server/data/app-auth-'));

const mock = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://mock').pathname;
  let body = '';
  for await (const chunk of request) body += chunk;
  response.setHeader('content-type', 'application/json');
  if (path === '/github/token' || path === '/google/token') {
    const code = new URLSearchParams(body).get('code') || '';
    response.end(JSON.stringify({ access_token: code || 'gh-user' }));
    return;
  }
  const access = request.headers.authorization?.replace(/^Bearer /, '') || '';
  if (path === '/github/user') {
    response.end(JSON.stringify({ id: 7001, login: 'ghapp', name: 'GitHub App User' }));
    return;
  }
  if (path === '/github/emails') {
    response.end(JSON.stringify([{ email: 'gh-app@example.test', primary: true, verified: true }]));
    return;
  }
  if (path === '/google/userinfo') {
    response.end(JSON.stringify({
      sub: access === 'google-bind' ? 'g-bind-7001' : 'g-7002',
      name: 'Google App User',
      email: access === 'google-bind' ? 'google-bind@example.test' : 'google-app@example.test',
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
      GITHUB_CLIENT_ID: 'gh-mock-id',
      GITHUB_CLIENT_SECRET: 'gh-mock-secret',
      GITHUB_AUTHORIZE_URL: `http://127.0.0.1:${mockPort}/github/authorize`,
      GITHUB_TOKEN_URL: `http://127.0.0.1:${mockPort}/github/token`,
      GITHUB_PROFILE_URL: `http://127.0.0.1:${mockPort}/github/user`,
      GITHUB_EMAILS_URL: `http://127.0.0.1:${mockPort}/github/emails`,
      GOOGLE_CLIENT_ID: 'gg-mock-id',
      GOOGLE_CLIENT_SECRET: 'gg-mock-secret',
      GOOGLE_AUTHORIZE_URL: `http://127.0.0.1:${mockPort}/google/authorize`,
      GOOGLE_TOKEN_URL: `http://127.0.0.1:${mockPort}/google/token`,
      GOOGLE_PROFILE_URL: `http://127.0.0.1:${mockPort}/google/userinfo`,
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
  return { response, status: response.status, headers: response.headers, body: parsed, bytes: raw };
}

let server;
try {
  server = await start({ ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'admin-password-123' });

  // Log in as admin via browser to set up member and ordinary PAT
  const adminWeb = await req(server, '/api/auth/password/login', {
    method: 'POST',
    origin: server.url,
    json: { email: 'admin@example.test', password: 'admin-password-123' },
  });
  assert.equal(adminWeb.status, 200);
  const adminCookie = cookieFor(adminWeb.response, 'dropit_session');
  assert.ok(adminCookie);
  const adminUser = adminWeb.body.user;

  assert.equal((await req(server, '/api/admin/registration', { method: 'PUT', cookie: adminCookie, json: { policy: 'open' } })).status, 200);
  const reg = await req(server, '/api/auth/password/register', {
    method: 'POST',
    origin: server.url,
    json: { email: 'member@example.test', name: 'Member', password: 'member-password-123' },
  });
  assert.equal(reg.status, 201);
  const memberUser = reg.body.user;

  const spacesRes = await req(server, '/api/spaces', { cookie: adminCookie });
  assert.equal(spacesRes.status, 200);
  const adminSpace = spacesRes.body.spaces[0].id;

  // =========================================================================
  // 1. P0 Bug Regression: Bearer token upload, chunk complete, and delete_item
  // =========================================================================
  const patCreate = await req(server, '/api/tokens', {
    method: 'POST',
    cookie: adminCookie,
    json: { name: 'cli-pat', scopes: ['read', 'write'] },
  });
  assert.equal(patCreate.status, 201);
  const pat = patCreate.body.token;

  // Direct file upload with Bearer + group
  const directPayload = Buffer.from('hello-bearer-direct-file');
  const directUpload = await req(server, `/api/spaces/${adminSpace}/items/file`, {
    method: 'POST',
    token: pat,
    headers: {
      'content-type': 'text/plain',
      'x-file-name': encodeURIComponent('direct.txt'),
      'x-dropit-group': encodeURIComponent('BearerGroup'),
    },
    body: directPayload,
  });
  assert.equal(directUpload.status, 201, `direct file upload with Bearer must succeed: ${JSON.stringify(directUpload.body)}`);
  const directItem = directUpload.body.item;
  assert.equal(directItem.filename, 'direct.txt');
  assert.equal(directItem.group, 'BearerGroup');

  // Chunked upload create + put chunk + complete with Bearer + group
  const chunkPayload = Buffer.from('hello-bearer-chunked-upload-payload');
  const chunkSha = createHash('sha256').update(chunkPayload).digest('hex');
  const openUpload = await req(server, `/api/spaces/${adminSpace}/uploads`, {
    method: 'POST',
    token: pat,
    json: { filename: 'chunked.bin', mime: 'application/octet-stream', size: chunkPayload.length },
  });
  assert.equal(openUpload.status, 201);
  const uploadId = openUpload.body.uploadId;
  const putChunk = await req(server, `/api/spaces/${adminSpace}/uploads/${uploadId}/chunks/0`, {
    method: 'PUT',
    token: pat,
    headers: { 'x-chunk-sha256': chunkSha },
    body: chunkPayload,
  });
  assert.equal(putChunk.status, 204);
  const completeUpload = await req(server, `/api/spaces/${adminSpace}/uploads/${uploadId}/complete`, {
    method: 'POST',
    token: pat,
    headers: { 'x-dropit-group': encodeURIComponent('ChunkGroup') },
  });
  assert.equal(completeUpload.status, 201, `chunk complete with Bearer must succeed: ${JSON.stringify(completeUpload.body)}`);
  const chunkItem = completeUpload.body.item;
  assert.equal(chunkItem.filename, 'chunked.bin');
  assert.equal(chunkItem.group, 'ChunkGroup');
  const dl = await req(server, `/api/spaces/${adminSpace}/items/${chunkItem.id}/download`, { token: pat });
  assert.equal(dl.status, 200);
  assert.deepEqual(dl.bytes, chunkPayload);

  // Retract (DELETE) both items with Bearer
  assert.equal((await req(server, `/api/spaces/${adminSpace}/items/${directItem.id}`, { method: 'DELETE', token: pat })).status, 204);
  assert.equal((await req(server, `/api/spaces/${adminSpace}/items/${chunkItem.id}`, { method: 'DELETE', token: pat })).status, 204);
  assert.equal((await req(server, `/api/spaces/${adminSpace}/items/${directItem.id}/download`, { token: pat })).status, 404);

  // =========================================================================
  // 2. Scope hard gates: PAT/device-code reject account/admin; GET share-presets allows read
  // =========================================================================
  for (const scopes of [['read', 'write', 'account'], ['read', 'write', 'admin'], ['account'], ['admin']]) {
    assert.equal((await req(server, '/api/tokens', { method: 'POST', cookie: adminCookie, json: { name: 'bad', scopes } })).status, 400);
    assert.equal((await req(server, '/api/auth/device/authorize', { method: 'POST', json: { name: 'bad', scopes } })).status, 400);
  }

  const roPat = (await req(server, '/api/tokens', { method: 'POST', cookie: adminCookie, json: { name: 'ro', scopes: ['read'] } })).body.token;
  assert.equal((await req(server, '/api/me/share-presets', { method: 'PUT', cookie: adminCookie, json: { days: [2, 7], views: [5] } })).status, 200);
  const presetsRead = await req(server, '/api/me/share-presets', { token: roPat });
  assert.equal(presetsRead.status, 200);
  assert.deepEqual(presetsRead.body, { hours: [], days: [2, 7], months: [], views: [5] });

  const textForShare = (await req(server, `/api/spaces/${adminSpace}/items/text`, { method: 'POST', token: pat, json: { text: 'for share' } })).body.item;
  const share = (await req(server, `/api/spaces/${adminSpace}/items/${textForShare.id}/shares`, { method: 'POST', token: pat, json: { expiresIn: '2d' } })).body;

  for (const [method, path, json] of [
    ['PUT', '/api/me/share-presets', { days: [3], views: [] }],
    ['GET', '/api/shares'],
    ['GET', `/api/shares/${share.id}/link`],
    ['POST', `/api/shares/${share.id}/revoke`],
    ['DELETE', `/api/shares/${share.id}`],
    ['GET', '/api/sessions'],
    ['DELETE', '/api/sessions/missing'],
    ['POST', '/api/sessions/revoke-others'],
    ['PUT', '/api/me/password', { currentPassword: 'admin-password-123', newPassword: 'new-password-456' }],
    ['GET', '/api/me/identities'],
    ['DELETE', '/api/me/identities/github'],
    ['POST', '/api/me/identities/github/app-link', {}],
    ['POST', '/api/tokens', { name: 'nested', scopes: ['read'] }],
    ['PATCH', '/api/tokens/missing', { name: 'x' }],
    ['DELETE', '/api/tokens/missing?purge=1'],
    ['GET', '/api/auth/device?user_code=AAAA-BBBB'],
    ['POST', '/api/auth/device/approve', { user_code: 'AAAA-BBBB' }],
    ['POST', '/api/auth/device/deny', { user_code: 'AAAA-BBBB' }],
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users', { email: 'x@example.test' }],
    ['PATCH', `/api/admin/users/${memberUser.id}`, { name: 'X' }],
    ['POST', `/api/admin/users/${memberUser.id}/password`],
    ['POST', `/api/admin/users/${memberUser.id}/logout`],
    ['GET', `/api/admin/users/${memberUser.id}/sessions`],
    ['DELETE', '/api/admin/sessions/missing'],
    ['GET', '/api/admin/tokens'],
    ['DELETE', '/api/admin/tokens/missing'],
    ['GET', '/api/admin/invites'],
    ['POST', '/api/admin/invites', { kind: 'registration' }],
    ['DELETE', '/api/admin/invites/missing'],
    ['GET', '/api/admin/registration'],
    ['PUT', '/api/admin/registration', { policy: 'invite' }],
    ['GET', '/api/admin/limits'],
    ['PATCH', '/api/admin/limits', { maxItems: 500 }],
    ['GET', '/api/admin/limits/audit'],
    ['GET', '/api/admin/rooms'],
    ['GET', '/api/admin/site'],
    ['PUT', '/api/admin/site', { origin: server.url, confirm: true }],
    ['GET', '/api/admin/oauth'],
    ['GET', '/api/admin/update'],
    ['POST', '/api/admin/update/check'],
  ]) {
    const res = await req(server, path, { method, token: pat, json });
    assert.equal(res.status, 403, `${method} ${path} got ${res.status} (${JSON.stringify(res.body)})`);
    assert.equal(res.body?.error?.code, 'INSUFFICIENT_SCOPE', `${method} ${path}`);
  }

  // =========================================================================
  // 3. App Password Login + Account/Admin access + mustChangePassword + Demotion
  // =========================================================================
  assert.equal((await req(server, '/api/auth/app/password/login', {
    method: 'POST', origin: 'https://evil.example', json: { email: 'member@example.test', password: 'member-password-123' },
  })).status, 403);

  const memberAppLogin = await req(server, '/api/auth/app/password/login', {
    method: 'POST',
    json: { email: 'MEMBER@example.test', password: 'member-password-123', deviceName: 'Pixel 9' },
  });
  assert.equal(memberAppLogin.status, 200);
  assert.equal(memberAppLogin.body.token_type, 'Bearer');
  assert.equal(memberAppLogin.body.scope, 'read write account');
  assert.equal(memberAppLogin.body.expires_in, 365 * 86400);
  assert.equal(memberAppLogin.body.mustChangePassword, false);
  const memberToken = memberAppLogin.body.access_token;

  assert.equal((await req(server, '/api/me/share-presets', { method: 'PUT', token: memberToken, json: { days: [2, 14], views: [10] } })).status, 200);
  assert.deepEqual((await req(server, '/api/me/share-presets', { token: memberToken })).body, { hours: [], days: [2, 14], months: [], views: [10] });
  assert.equal((await req(server, '/api/shares', { token: memberToken })).status, 200);
  assert.equal((await req(server, '/api/sessions', { token: memberToken })).status, 200);
  assert.equal((await req(server, '/api/me/identities', { token: memberToken })).status, 200);
  const subPat = await req(server, '/api/tokens', { method: 'POST', token: memberToken, json: { name: 'from-app', scopes: ['read'] } });
  assert.equal(subPat.status, 201);
  assert.equal((await req(server, `/api/tokens/${subPat.body.id}`, { method: 'PATCH', token: memberToken, json: { name: 'renamed' } })).status, 204);
  assert.equal((await req(server, `/api/tokens/${subPat.body.id}`, { method: 'DELETE', token: memberToken })).status, 204);
  assert.equal((await req(server, `/api/tokens/${subPat.body.id}?purge=1`, { method: 'DELETE', token: memberToken })).status, 204);

  const dev = (await req(server, '/api/auth/device/authorize', { method: 'POST', json: { name: 'CLI', scopes: ['read', 'write'] } })).body;
  assert.equal((await req(server, `/api/auth/device?user_code=${encodeURIComponent(dev.user_code)}&verification_id=${dev.verification_id}`, { token: memberToken })).status, 200);
  assert.equal((await req(server, '/api/auth/device/approve', { method: 'POST', token: memberToken, json: { user_code: dev.user_code, verification_id: dev.verification_id } })).status, 204);

  // Member App token cannot access admin routes
  const memberAdmin = await req(server, '/api/admin/users', { token: memberToken });
  assert.equal(memberAdmin.status, 403);
  assert.equal(memberAdmin.body?.error?.code, 'INSUFFICIENT_SCOPE');

  // Admin App login includes admin scope
  const adminAppLogin = await req(server, '/api/auth/app/password/login', {
    method: 'POST',
    json: { email: 'admin@example.test', password: 'admin-password-123', deviceName: 'Admin Phone' },
  });
  assert.equal(adminAppLogin.status, 200);
  assert.equal(adminAppLogin.body.scope, 'read write account admin');
  const adminToken = adminAppLogin.body.access_token;

  assert.equal((await req(server, '/api/admin/users', { token: adminToken })).status, 200);
  assert.equal((await req(server, '/api/admin/registration', { token: adminToken })).status, 200);
  assert.equal((await req(server, '/api/admin/rooms', { token: adminToken })).status, 200);
  assert.equal((await req(server, '/api/admin/oauth', { token: adminToken })).status, 200);
  assert.equal((await req(server, '/api/admin/update', { token: adminToken })).status, 200);

  // Admin site & runtime limits + audit on Rust!
  const siteGet = await req(server, '/api/admin/site', { token: adminToken });
  assert.equal(siteGet.status, 200);
  assert.equal(siteGet.body.origin, server.url);
  const siteAsk = await req(server, '/api/admin/site', { method: 'PUT', token: adminToken, json: { origin: 'https://custom.dropit.test' } });
  assert.equal(siteAsk.status, 409);
  assert.equal(siteAsk.body.error.code, 'ORIGIN_CONFIRM_REQUIRED');
  const siteSave = await req(server, '/api/admin/site', { method: 'PUT', token: adminToken, json: { origin: 'https://custom.dropit.test', confirm: true } });
  assert.equal(siteSave.status, 200);
  assert.equal(siteSave.body.origin, 'https://custom.dropit.test');
  assert.equal(siteSave.body.source, 'admin');
  const siteReset = await req(server, '/api/admin/site', { method: 'PUT', token: adminToken, json: { origin: null, confirm: true } });
  assert.equal(siteReset.status, 200);
  assert.equal(siteReset.body.source, 'env');

  const limitsGet = await req(server, '/api/admin/limits', { token: adminToken });
  assert.equal(limitsGet.status, 200);
  assert.equal(limitsGet.body.maxItems.overridden, false);
  const limitsPatch = await req(server, '/api/admin/limits', { method: 'PATCH', token: adminToken, json: { maxItems: 777 } });
  assert.equal(limitsPatch.status, 200);
  assert.equal(limitsPatch.body.maxItems.value, 777);
  assert.equal(limitsPatch.body.maxItems.overridden, true);
  const limitsAudit = await req(server, '/api/admin/limits/audit', { token: adminToken });
  assert.equal(limitsAudit.status, 200);
  assert.equal(limitsAudit.body.entries.length, 1);
  assert.equal(limitsAudit.body.entries[0].key, 'maxItems');
  assert.equal(limitsAudit.body.entries[0].newValue, 777);

  // mustChangePassword enforcement on App token
  const reset = await req(server, `/api/admin/users/${memberUser.id}/password`, { method: 'POST', token: adminToken });
  assert.equal(reset.status, 200);
  const tempPassword = reset.body.temporaryPassword;
  const tempLogin = await req(server, '/api/auth/app/password/login', {
    method: 'POST',
    json: { email: 'member@example.test', password: tempPassword },
  });
  assert.equal(tempLogin.status, 200);
  assert.equal(tempLogin.body.mustChangePassword, true);
  const tempToken = tempLogin.body.access_token;
  assert.equal((await req(server, '/api/me', { token: tempToken })).status, 200);
  const locked = await req(server, '/api/spaces', { token: tempToken });
  assert.equal(locked.status, 403);
  assert.equal(locked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await req(server, '/api/me/password', {
    method: 'PUT', token: tempToken, json: { currentPassword: tempPassword, newPassword: 'brand-new-password-789' },
  })).status, 200);
  assert.equal((await req(server, '/api/spaces', { token: tempToken })).status, 200);

  // Instant admin demotion revokes admin-scoped token immediately
  assert.equal((await req(server, `/api/admin/users/${memberUser.id}`, { method: 'PATCH', token: adminToken, json: { role: 'admin' } })).status, 204);
  assert.equal((await req(server, `/api/admin/users/${adminUser.id}`, { method: 'PATCH', token: adminToken, json: { role: 'user' } })).status, 204);
  const demoted = await req(server, '/api/admin/users', { token: adminToken });
  assert.equal(demoted.status, 403);
  assert.equal(demoted.body.error.code, 'FORBIDDEN');
  assert.equal((await req(server, '/api/sessions', { token: adminToken })).status, 200);

  // =========================================================================
  // 4. App OAuth login whitelist, single-use code exchange, and App OAuth link
  // =========================================================================
  for (const badRedirect of ['https://evil.example/cb', 'dropit://auth/callback/', 'dropit://auth/callback?x=1', 'dropit://other', '']) {
    const res = await req(server, `/api/auth/github?${new URLSearchParams({ app_redirect: badRedirect, app_state: 'validState1234' })}`);
    assert.equal(res.status, 400, badRedirect);
    assert.equal(res.body.error.code, 'INVALID_APP_REDIRECT');
  }
  for (const badState of ['', 'short', 'bad space!!']) {
    const res = await req(server, `/api/auth/github?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: badState })}`);
    assert.equal(res.status, 400, badState);
    assert.equal(res.body.error.code, 'INVALID_INPUT');
  }

  const appState = 'rustAppState_12345';
  const startGh = await req(server, `/api/auth/github?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: appState, device_name: 'Rust Phone' })}`);
  assert.equal(startGh.status, 302);
  const oauthState = new URL(startGh.headers.get('location')).searchParams.get('state');
  const flowCookie = cookieFor(startGh.response, 'dropit_oauth');
  assert.ok(oauthState && flowCookie);

  const cbGh = await req(server, `/api/auth/github/callback?${new URLSearchParams({ state: oauthState, code: 'gh-user' })}`, { headers: { cookie: flowCookie } });
  assert.equal(cbGh.status, 302);
  assert.equal(cookieFor(cbGh.response, 'dropit_session'), undefined);
  const cbUrl = new URL(cbGh.headers.get('location'));
  assert.equal(`${cbUrl.protocol}//${cbUrl.host}${cbUrl.pathname}`, APP_REDIRECT);
  assert.equal(cbUrl.searchParams.get('state'), appState);
  const exchangeCode = cbUrl.searchParams.get('code');
  assert.match(exchangeCode, /^[A-Za-z0-9_-]{43}$/);

  const exchanged = await req(server, '/api/auth/app/oauth/exchange', { method: 'POST', json: { code: exchangeCode } });
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.body.token_type, 'Bearer');
  assert.equal(exchanged.body.scope, 'read write account');
  assert.equal(exchanged.body.user.email, 'gh-app@example.test');
  const oauthToken = exchanged.body.access_token;

  // Replay fails
  const replay = await req(server, '/api/auth/app/oauth/exchange', { method: 'POST', json: { code: exchangeCode } });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, 'OAUTH_CODE_INVALID');

  // Provider error in App mode redirects to dropit://auth/callback?error=OAUTH_DENIED
  const startDenied = await req(server, `/api/auth/github?${new URLSearchParams({ app_redirect: APP_REDIRECT, app_state: 'deniedState_1234' })}`);
  const deniedState = new URL(startDenied.headers.get('location')).searchParams.get('state');
  const cbDenied = await req(server, `/api/auth/github/callback?${new URLSearchParams({ state: deniedState, error: 'access_denied' })}`, { headers: { cookie: cookieFor(startDenied.response, 'dropit_oauth') } });
  assert.equal(cbDenied.status, 302);
  assert.equal(new URL(cbDenied.headers.get('location')).searchParams.get('error'), 'OAUTH_DENIED');

  // App OAuth linking (bind Google using account Bearer token, no browser cookie!)
  const linkReq = await req(server, '/api/me/identities/google/app-link', {
    method: 'POST',
    token: oauthToken,
    json: { appState: 'linkState_rust_123' },
  });
  assert.equal(linkReq.status, 200);
  assert.equal(linkReq.body.state, 'linkState_rust_123');
  assert.equal(linkReq.body.expires_in, 60);

  const linkStart = await req(server, linkReq.body.path);
  assert.equal(linkStart.status, 302);
  const linkOAuthState = new URL(linkStart.headers.get('location')).searchParams.get('state');
  const linkCb = await req(server, `/api/auth/google/callback?${new URLSearchParams({ state: linkOAuthState, code: 'google-bind' })}`, { headers: { cookie: cookieFor(linkStart.response, 'dropit_oauth') } });
  assert.equal(linkCb.status, 302);
  const linkedUrl = new URL(linkCb.headers.get('location'));
  assert.equal(`${linkedUrl.protocol}//${linkedUrl.host}${linkedUrl.pathname}`, APP_REDIRECT);
  assert.equal(linkedUrl.searchParams.get('linked'), 'google');
  assert.equal(linkedUrl.searchParams.get('state'), 'linkState_rust_123');

  const ids = await req(server, '/api/me/identities', { token: oauthToken });
  assert.equal(ids.status, 200);
  assert.deepEqual(ids.body.identities.map(i => i.provider).sort(), ['github', 'google']);

  // Replay of consumed link_ticket fails cleanly
  const replayLink = await req(server, linkReq.body.path);
  assert.equal(replayLink.status, 302);
  assert.equal(new URL(replayLink.headers.get('location')).searchParams.get('error'), 'UNAUTHENTICATED');

  console.log('PASS RHEA-270 Rust Bearer upload/chunk/retract fix, account/admin scopes, admin site/limits, App password/OAuth login & linking');
} finally {
  await stop(server);
  mock.close();
  await rm(temporary, { recursive: true, force: true });
}
