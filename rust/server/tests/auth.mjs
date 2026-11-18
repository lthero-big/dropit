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
  if (path === '/token') {
    const form = new URLSearchParams(body);
    if (form.get('code') === 'provider-error') { response.statusCode = 500; response.end(JSON.stringify({error: 'server_error'})); return; }
    if (form.get('code') === 'dropit-credential-check') { response.end(JSON.stringify({error: 'invalid_grant'})); return; }
    response.end(JSON.stringify({access_token: form.get('code') || 'first'})); return;
  }
  const access = request.headers.authorization?.replace(/^Bearer /, '') || 'first';
  if (path === '/user') {
    const users = {
      first: {id: 1, login: 'first', name: 'First User'},
      conflict: {id: 2, login: 'conflict', name: 'Conflict User'},
      pending: {id: 3, login: 'pending', name: 'Pending User'},
      linked: {id: 4, login: 'linked', name: 'Linked User'},
    };
    response.end(JSON.stringify(users[access] || users.first)); return;
  }
  if (path === '/emails') {
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

async function oauth(server, code, invite) {
  const start = await request(server, `/api/auth/github${invite ? `?invite=${invite}` : ''}`);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const flow = cookieFor(start.response, 'dropit_oauth');
  assert.ok(state && flow);
  const callback = await request(server, `/api/auth/github/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`, {cookie: flow});
  return {callback, state, flow};
}

let server;
try {
  server = await start();
  let result = await request(server, '/api/auth/providers');
  assert.deepEqual(result.body.providers, ['github']);
  assert.equal(result.body.setupRequired, true);

  // An invalid invite is ignored for the first OAuth bootstrap, matching TS.
  const first = await oauth(server, 'first', 'unknown');
  assert.equal(first.callback.status, 302);
  const adminCookie = cookieFor(first.callback.response, 'dropit_session');
  assert.ok(adminCookie);
  result = await request(server, '/api/me', {cookie: adminCookie});
  assert.equal(result.body.user.role, 'admin');

  // Replay and provider failures are browser redirects and clear the flow cookie.
  const replay = await request(server, `/api/auth/github/callback?state=${first.state}&code=first`, {cookie: first.flow});
  assert.equal(replay.status, 302); assert.match(replay.headers.get('location'), /OAUTH_STATE_INVALID/);
  assert.ok(cookies(replay.response).some(value => value.startsWith('dropit_oauth=;')));
  const failed = await oauth(server, 'provider-error');
  assert.equal(failed.callback.status, 302); assert.match(failed.callback.headers.get('location'), /OAUTH_PROVIDER_ERROR/);
  assert.ok(cookies(failed.callback.response).some(value => value.startsWith('dropit_oauth=;')));

  result = await request(server, '/api/admin/oauth', {cookie: adminCookie});
  assert.equal(result.body.providers.length, 2);
  result = await request(server, '/api/admin/oauth/github', {method: 'PUT', cookie: adminCookie, json: {clientId: 'mock-id', clientSecret: '秘密秘密秘密秘密秘密'}});
  assert.equal(result.status, 200); assert.ok(result.body.providers.find(provider => provider.provider === 'github').secretHint);
  result = await request(server, '/api/me/identities', {cookie: adminCookie});
  assert.deepEqual(result.body.available, ['github']);
  result = await request(server, '/api/admin/oauth/github/verify', {method: 'POST', cookie: adminCookie, json: {}});
  assert.equal(result.body.code, 'CREDENTIALS_OK');

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

  // Concurrent setup has one winner on an independent empty database.
  await stop(server); server = await start({GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined});
  const codeLine = server.output().split('\n').find(line => line.startsWith('dropit setup code: '));
  const setupCode = codeLine?.slice('dropit setup code: '.length); assert.ok(setupCode);
  const setup = body => request(server, '/api/setup', {method: 'POST', json: body});
  const setups = await Promise.all([setup({code: setupCode, email: 'one@example.test', password: 'Password-123'}), setup({code: setupCode, email: 'two@example.test', password: 'Password-123'})]);
  assert.deepEqual(setups.map(value => value.status).sort(), [201, 409]);
  console.log('PASS authentication, mock OAuth, setup race, redirects, invitations, admin OAuth and sessions');
} finally {
  if (server) await stop(server);
  mock.close(); await rm(temporary, {recursive: true, force: true});
}
