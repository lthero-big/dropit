import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, readlink, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './fixture.mjs';
import { seedFiles } from './files-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68';
const rust = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const temporary = await mkdtemp(resolve(root, 'rust/server/data/files-'));
const processes = new Set();

let checks = 0;

async function prepareReference() {
  const directory = resolve(temporary, 'ts-reference');
  await mkdir(directory);
  const archive = execFileSync('git', ['archive', baseline, '--',
    'apps/server', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@dropit/server...'],
    { cwd: directory, stdio: 'pipe' });
  execFileSync('pnpm', ['--filter', '@dropit/server', 'build'], { cwd: directory, stdio: 'pipe' });
  console.log('PASS file reference built from ' + baseline);
  return directory;
}

async function start(kind, data) {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((ok, reject) => socket.close(error => error ? reject(error) : ok()));
  const origin = 'http://dropit.test';
  const child = spawn(kind === 'rust' ? rust : process.execPath,
    kind === 'rust' ? [] : [resolve(referenceRoot, 'apps/server/dist/index.js')], {
      cwd: root,
      env: {
        PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port),
        APP_ORIGIN: origin, UPDATE_CHECK: '0', RATE_GENERAL: '10000', RATE_AUTH: '1000', RATE_UPLOAD: '100',
      },
      stdio: ['ignore', 'pipe', 'pipe'],

    });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  processes.add(child);

  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(kind + ' exited\n' + output);
    if (output.includes('dropit listening on port ')) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/healthz');
        await response.arrayBuffer();
        if (response.status === 200) {
          const started = { child, url: 'http://127.0.0.1:' + port, origin, output: '' };
          const remember = () => { started.output = output; };
          child.stdout.on('data', remember);
          child.stderr.on('data', remember);
          return started;
        }
      } catch (error) {
        await error.response?.arrayBuffer?.().catch(() => {});
      }
    }
    await delay(25);
  }
  throw new Error(kind + ' failed readiness\n' + output);
}

async function stop(server) {
  if (server.child.exitCode === null) {
    const exited = once(server.child, 'exit');
    server.child.kill('SIGTERM');
    await exited;
  }
  processes.delete(server.child);
}

async function raw(server, path, { method = 'GET', cookie, headers = {} } = {}) {
  const requestHeaders = { origin: server.origin, ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  let response;
  try {
    response = await fetch(server.url + path, { method, headers: requestHeaders, redirect: 'manual' });
    const bytes = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    checks++;
    return { status: response.status, headers: response.headers, bytes };
  } catch (error) {
    // TS createReadStream emits ENOENT on a recorded key with no disk object and drops the socket.
    if (error?.cause?.code === 'UND_ERR_SOCKET') {
      checks++;
      return { status: 0, headers: new Headers(), bytes: Buffer.alloc(0), dropped: true };
    }
    throw new Error(method + ' ' + path + ' failed: ' + error.message + '\n' + server.output);
  }
}

function cookieOf(login) {
  return login.headers.get('set-cookie').split(';')[0];
}

async function login(server, email) {
  const response = await fetch(server.url + '/api/auth/password/login', {
    method: 'POST',
    headers: { origin: server.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password-e\u0301-🔐' }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return cookieOf(response);
}

const HEADER_KEYS = [
  'content-type', 'content-disposition', 'content-length', 'content-range', 'accept-ranges',
  'cache-control', 'x-content-type-options',
];

function observed(response) {
  const headers = {};
  for (const key of HEADER_KEYS) headers[key] = response.headers.get(key);
  // Hyper adds Content-Length: 0 while sending an empty 416 body. TS leaves it unset.
  // Both bodies are empty, so the length header is not a byte difference.
  if (response.status === 416 && response.bytes.length === 0 && headers['content-length'] === '0') {
    headers['content-length'] = null;
  }
  // Hono omits Content-Length on JSON errors. Axum sets it. The JSON bytes stay exact.
  if (headers['content-type'] === 'application/json' && headers['content-length'] !== null) {
    headers['content-length'] = null;
  }
  return { status: response.status, headers, bytes: response.bytes.toString('base64') };
}

async function compare(ts, rustServer, path, options) {
  const left = await raw(ts, path, options);
  const right = await raw(rustServer, path, options);
  assert.deepEqual(observed(right), observed(left), path + ' ' + JSON.stringify(options.headers ?? {}));
  return left;
}

async function openFileDescriptors(pid) {
  const directory = '/proc/' + pid + '/fd';
  const names = await readdir(directory);
  const targets = [];
  for (const name of names) {
    try {
      targets.push(await readlink(resolve(directory, name)));
    } catch { /* closed between readdir and readlink */ }
  }
  return targets;
}

async function disconnect(server, path, cookie) {
  const controller = new AbortController();
  let response;
  try {
    response = await fetch(server.url + path, {
      headers: { cookie, origin: server.origin, range: 'bytes=0-' },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error('disconnect request failed: ' + error + '\n' + server.output);
  }
  assert.equal(response.status, 206, server.output);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  const opened = (await openFileDescriptors(server.child.pid)).filter(target => target.includes('/files/'));
  assert.ok(opened.length >= 1, 'stream should hold the file while the body is open: ' + opened.join(','));
  controller.abort();
  await reader.cancel().catch(() => {});
  let released = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const still = (await openFileDescriptors(server.child.pid)).filter(target => target.includes('/files/'));
    if (still.length === 0) {
      released = true;
      break;
    }
    await delay(25);
  }
  assert.equal(released, true, 'client disconnect must close the stored file');
  const probe = await raw(server, '/healthz');
  assert.equal(probe.status, 200);
  const again = await raw(server, path, { cookie, headers: { range: 'bytes=0-1' } });
  assert.equal(again.status, 206);
  assert.equal(again.bytes.toString(), 'aa');
}


let referenceRoot;
try {
  referenceRoot = await prepareReference();
  const seed = resolve(temporary, 'seed');
  const metadata = await fixture(seed, { referenceRoot });
  await seedFiles(seed, metadata, referenceRoot);
  const space = '/api/spaces/' + metadata.aliceSpace;
  const results = {};
  for (const kind of ['ts', 'rust']) {
    const data = resolve(temporary, kind);
    await cp(seed, data, { recursive: true });
    const server = await start(kind, data);
    server.data = data;

    const alice = await login(server, 'alice@example.test');
    const bob = await login(server, 'bob@example.test');
    const viewer = await login(server, 'viewer@example.test');
    const temporaryUser = await login(server, 'temporary@example.test');
    results[kind] = { server, alice, bob, viewer, temporaryUser };
  }

  const ts = results.ts.server;
  const rustServer = results.rust.server;
  const paired = [
    [results.ts.alice, results.rust.alice],
    [results.ts.bob, results.rust.bob],
    [results.ts.viewer, results.rust.viewer],
    [results.ts.temporaryUser, results.rust.temporaryUser],
  ];
  async function compareAuth(path, options, pair = paired[0]) {
    const left = await raw(ts, path, { ...options, cookie: pair[0] });
    const right = await raw(rustServer, path, { ...options, cookie: pair[1] });
    assert.deepEqual(observed(right), observed(left), path + ' ' + JSON.stringify(options.headers ?? {}) + ' ' + options.method);
    return left;
  }
  const cases = [
    ['range', 'download'], ['range', 'thumbnail'], ['range', 'media'],
    ['mp4', 'download'], ['mp4', 'media'], ['m4a', 'media'], ['quicktime', 'media'],
    ['webm', 'media'], ['wav', 'media'], ['flac', 'media'], ['mp3', 'media'],
    ['avif', 'download'], ['avif', 'thumbnail'], ['avif', 'media'],
    ['png', 'download'], ['png', 'thumbnail'], ['png', 'media'],
    ['html', 'download'], ['html', 'media'], ['bin', 'download'], ['bin', 'media'],
    ['nofile', 'download'], ['emptyname', 'download'], ['missing', 'download'], ['expired', 'download'],
    ['bob', 'download'],
  ];
  for (const [label, action] of cases) {
    const path = `${space}/items/file-${label}/${action}`;
    if (label === 'missing') {
      const left = await raw(ts, path, { cookie: results.ts.alice });
      const right = await raw(rustServer, path, { cookie: results.rust.alice });
      assert.equal(left.dropped, true);
      assert.equal(right.status, 404);
      assert.equal(right.bytes.toString(), '{"error":{"code":"NOT_FOUND"}}');
      continue;
    }
    await compareAuth(path, {});
  }
  const ranges = [undefined, 'bytes=2-5', 'bytes=7-', 'bytes=-3', 'bytes=8-99', 'bytes=10-', 'bytes=5-2', 'bytes=0-1,4-5', 'not-a-range', 'bytes=-0', 'bytes='];
  for (const range of ranges) {
    const headers = range ? { range } : {};
    await compareAuth(`${space}/items/file-range/download`, { headers });
    await compareAuth(`${space}/items/file-mp4/media`, { headers });
    await compareAuth(`${space}/items/file-range/download`, { method: 'HEAD', headers });
    await compareAuth(`${space}/items/file-avif/download`, { method: 'HEAD', headers });
  }
  for (const action of ['download', 'thumbnail', 'media']) {
    await compare(ts, rustServer, `${space}/items/file-png/${action}`, {});
    await compare(ts, rustServer, `${space}/items/file-range/${action}`, { method: 'HEAD' });
    await compareAuth(`${space}/items/file-png/${action}`, {}, paired[1]);
    await compareAuth(`${space}/items/file-range/${action}`, { method: 'HEAD' }, paired[2]);
    await compareAuth(`${space}/items/file-png/${action}`, {}, paired[3]);
  }
  await compareAuth(`${space}/items/%FF/download`, {});
  await compare(ts, rustServer, `${space}/items/%FF/download`, {});
  await compareAuth(`/api/spaces/${metadata.bobSpace}/items/file-bob/download`, {});
  await compareAuth(`/api/spaces/${metadata.bobSpace}/items/file-bob/download`, {}, paired[1]);
  await disconnect(rustServer, `${space}/items/file-hold/download`, results.rust.alice);
  console.log('PASS file reads compared ' + checks + ' HTTP responses');
} finally {
  await Promise.all([...processes].map(async child => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([exited, delay(1000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, delay(1000)]);
    }
  }));
  await rm(temporary, { recursive: true, force: true });
}
