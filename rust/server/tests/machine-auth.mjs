import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68';
const rust = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
const temporary = await mkdtemp(resolve(root, 'rust/server/data/machine-auth-'));
const processes = [];

async function prepareReference() {
  const reference = resolve(temporary, 'ts-reference');
  await mkdir(reference);
  const archive = execFileSync('git', ['archive', baseline, '--', 'apps/server', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', reference], { input: archive });
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@dropit/server...'], { cwd: reference, stdio: 'pipe' });
  execFileSync('pnpm', ['--filter', '@dropit/server', 'build'], { cwd: reference, stdio: 'pipe' });
  return reference;
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function start(data) {
  const port = await freePort();
  const child = spawn(rust, [], { cwd: root, env: {
    PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port),
    APP_ORIGIN: 'http://dropit.test', UPDATE_CHECK: '0', RATE_GENERAL: '10000', RATE_AUTH: '1000', RATE_UPLOAD: '100', RATE_TOKEN: '1000',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  processes.push(child);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`Rust exited\n${output}`);
    if (output.includes('dropit listening on port ')) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.status === 200) return { child, url: `http://127.0.0.1:${port}` };
      } catch {
        // The process logs before the listener is ready.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Rust failed readiness\n${output}`);
}

async function startReference(data, reference) {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(reference, 'apps/server/dist/index.js')], { cwd: root, env: {
    PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port),
    APP_ORIGIN: 'http://dropit.test', UPDATE_CHECK: '0', RATE_GENERAL: '10000', RATE_AUTH: '1000', RATE_UPLOAD: '100',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`TS reference exited\n${output}`);
    if (output.includes('dropit listening on port ')) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.status === 200) return { child, url: `http://127.0.0.1:${port}` };
      } catch {
        // The process logs before the listener is ready.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`TS reference failed readiness\n${output}`);
}

async function stop(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await once(server.child, 'exit');
}

async function request(server, path, { method = 'GET', cookie, token, json, origin = null } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin !== null) headers.origin = origin;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(server.url + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual' });
  const text = await response.text();
  let body = text;
  if (response.headers.get('content-type')?.startsWith('application/json')) body = JSON.parse(text);
  return { status: response.status, headers: response.headers, body };
}

function cookie(response) {
  return /(?:__Host-)?dropit_session=([^;]+)/.exec(response.headers.get('set-cookie') || '')?.[1];
}

const reference = await prepareReference();
const require = createRequire(resolve(reference, 'apps/server/package.json'));
const Sqlite = require('better-sqlite3');
const { fixture } = await import(pathToFileURL(resolve(root, 'rust/server/tests/fixture.mjs')));
const seed = resolve(temporary, 'seed');
const metadata = await fixture(seed, { referenceRoot: reference });
let server = await start(seed);
try {
  const loggedIn = await request(server, '/api/auth/password/login', { method: 'POST', json: { email: 'alice@example.test', password: 'Password-é-🔐' }, origin: 'http://dropit.test' });
  assert.equal(loggedIn.status, 200);
  const aliceCookie = `dropit_session=${cookie(loggedIn)}`;

  const created = await request(server, '/api/tokens', { method: 'POST', cookie: aliceCookie, json: { name: 'machine', scopes: ['read', 'write'], expiresInDays: null }, origin: 'http://dropit.test' });
  assert.equal(created.status, 201);
  const pat = created.body.token;
  assert.equal(Buffer.from(pat, 'base64url').length, 32);
  const stored = await readFile(resolve(seed, 'dropit.sqlite'));
  assert.equal(stored.includes(Buffer.from(pat)), false);
  assert.equal((await request(server, '/api/me', { token: pat, cookie: 'dropit_session=not-used' })).status, 200);
  assert.equal((await request(server, `/api/spaces/${metadata.aliceSpace}/items/text`, { method: 'POST', token: pat, json: { text: 'PAT text' } })).status, 201);

  const readonly = await request(server, '/api/tokens', { method: 'POST', cookie: aliceCookie, json: { name: 'read-only', scopes: ['read'] }, origin: 'http://dropit.test' });
  assert.equal(readonly.status, 201);
  assert.equal((await request(server, `/api/spaces/${metadata.aliceSpace}/items/text`, { method: 'POST', token: readonly.body.token, json: { text: 'blocked' } })).body.error.code, 'INSUFFICIENT_SCOPE');
  assert.equal((await request(server, '/api/me', { token: 'wrong' })).status, 401);

  const authorize = await request(server, '/api/auth/device/authorize', { method: 'POST', json: { name: 'CLI', scopes: ['read', 'write'], expiresInDays: null } });
  assert.equal(authorize.status, 200);
  const device = authorize.body;
  const approve = await request(server, '/api/auth/device/approve', { method: 'POST', cookie: aliceCookie, json: { user_code: device.user_code, verification_id: device.verification_id }, origin: 'http://dropit.test' });
  assert.equal(approve.status, 204);
  const database = new Sqlite(resolve(seed, 'dropit.sqlite'));
  database.prepare('UPDATE device_authorizations SET nextPollAt=0').run();
  const issued = await request(server, '/api/auth/device/token', { method: 'POST', json: { device_code: device.device_code } });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.scope, 'read write');
  assert.equal((await request(server, '/api/me', { token: issued.body.access_token })).status, 200);

  const webAuthorize = await request(server, '/api/auth/device/authorize', { method: 'POST', json: { name: 'WebView', scopes: ['read', 'write', 'web'], expiresInDays: null } });
  assert.equal(webAuthorize.status, 200);
  const webDevice = webAuthorize.body;
  assert.equal((await request(server, '/api/auth/device/approve', { method: 'POST', cookie: aliceCookie, json: { user_code: webDevice.user_code, verification_id: webDevice.verification_id }, origin: 'http://dropit.test' })).status, 204);
  database.prepare('UPDATE device_authorizations SET nextPollAt=0').run();
  const webIssued = await request(server, '/api/auth/device/token', { method: 'POST', json: { device_code: webDevice.device_code } });
  assert.equal(webIssued.status, 200);
  const ticket = await request(server, '/api/app-session/ticket', { method: 'POST', token: webIssued.body.access_token });
  assert.equal(ticket.status, 200);
  const opened = await request(server, ticket.body.path);
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.get('location'), '/');
  const webCookie = `dropit_session=${cookie(opened)}`;
  assert.equal((await request(server, '/api/me', { cookie: webCookie })).status, 200);
  assert.equal((await request(server, ticket.body.path)).headers.get('location'), '/login?error=APP_SESSION_EXPIRED');

  database.close();
  await stop(server);
  server = await startReference(seed, reference);
  const tsCreated = await request(server, '/api/tokens', { method: 'POST', cookie: aliceCookie, json: { name: 'TS token', scopes: ['read'] }, origin: 'http://dropit.test' });
  assert.equal(tsCreated.status, 201);
  assert.equal((await request(server, '/api/me', { token: pat })).status, 200);
  await stop(server);
  server = await start(seed);
  assert.equal((await request(server, '/api/me', { token: tsCreated.body.token })).status, 200);

  assert.equal((await request(server, `/api/admin/users/${metadata.alice.id}`, { method: 'PATCH', cookie: aliceCookie, json: { disabled: true }, origin: 'http://dropit.test' })).status, 204);
  assert.equal((await request(server, '/api/me', { token: pat })).status, 401);
  assert.equal((await request(server, '/api/me', { token: tsCreated.body.token })).status, 401);
  console.log('PASS PAT, scopes, cookie precedence, TS/Rust token compatibility, device approval, one-time WebView ticket, disablement');
} finally {
  await stop(server);
  await rm(temporary, { recursive: true, force: true });
}
