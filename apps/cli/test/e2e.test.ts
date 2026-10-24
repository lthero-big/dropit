import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/run.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../src/index.ts');
const fixtureScript = join(here, 'fixture-server.ts');

interface Fixture {
  child: ChildProcess;
  base: string;
  origin: string;
  cookie: string;
  spaceId: string;
}

let fx: Fixture;
let token = '';

function redact(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]');
}

function cliEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: 'test',
    DROPIT_URL: fx.base,
    ...extra,
  };
}

function call(method: string, path: string, options: {
  body?: unknown; cookie?: string; origin?: string; token?: string;
} = {}): Promise<{ status: number; json: unknown }> {
  const url = new URL(path, fx.base);
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        if (text) {
          try { json = JSON.parse(text) as unknown; } catch { json = null; }
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function mint(scopes?: string[]): Promise<string> {
  const response = await call('POST', '/api/tokens', {
    cookie: fx.cookie,
    origin: fx.origin,
    body: scopes ? { name: 'cli-test', scopes } : { name: 'cli-test' },
  });
  const issued = response.json as { token?: string };
  if (response.status !== 201 || !issued.token) throw new Error(`mint failed: ${response.status}`);
  return issued.token;
}

function run(args: string[], env: NodeJS.ProcessEnv, input?: string | Buffer): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: join(here, '..'),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dropit-cli-home-'));
}

function configFile(dir: string): string {
  return join(dir, '.config', 'dropit', 'config.json');
}

async function startFixture(): Promise<Fixture> {
  const child = spawn(process.execPath, ['--import', 'tsx', fixtureScript], {
    cwd: join(here, '..'),
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), TMPDIR: tmpdir(), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`fixture timeout: ${redact(Buffer.concat(stderr).toString('utf8'))}`));
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0 || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(buffer.slice(0, newline));
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`fixture exited ${code ?? 'null'}: ${redact(Buffer.concat(stderr).toString('utf8'))}`));
    });
  });
  const info = JSON.parse(line) as { port: number; origin: string; cookie: string; spaceId: string };
  return { child, base: `http://127.0.0.1:${info.port}`, origin: info.origin, cookie: info.cookie, spaceId: info.spaceId };
}

async function stopFixture(current: Fixture | undefined) {
  if (!current || current.child.exitCode !== null || current.child.signalCode) return;
  current.child.kill('SIGTERM');
  const exited = once(current.child, 'exit');
  const timer = setTimeout(() => current.child.kill('SIGKILL'), 5_000);
  await exited.catch(() => undefined);
  clearTimeout(timer);
}

test.before(async () => {
  fx = await startFixture();
  token = await mint();
});

test.after(async () => {
  await stopFixture(fx);
});

test('device login stores a 0600 token and does not print it', { timeout: 25_000 }, async () => {
  const dir = await home();
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'login', '--url', fx.base], {
    cwd: join(here, '..'),
    env: cliEnv(dir),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  let approved = false;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (approved) return;
    const match = stdout.match(/https?:\/\/\S+/);
    if (!match) return;
    approved = true;
    const page = new URL(match[0]);
    void call('POST', '/api/auth/device/approve', {
      cookie: fx.cookie,
      origin: fx.origin,
      body: { user_code: page.searchParams.get('user_code'), verification_id: page.searchParams.get('verification_id') },
    }).then((response) => {
      if (response.status !== 204) child.kill('SIGKILL');
    }).catch(() => child.kill('SIGKILL'));
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`login timeout: ${redact(stderr)}`));
    }, 20_000);
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve(status ?? 1);
    });
  });
  assert.equal(code, 0, redact(stderr));
  const combined = stdout + stderr;
  assert.equal(/[A-Za-z0-9_-]{43}/.test(combined), false);
  assert.equal(combined.includes('验证码'), true);
  assert.equal(combined.includes('设备码'), false);
  assert.equal(combined.toLowerCase().includes('password'), false);
  assert.equal(combined.includes('密码'), false);
  const path = configFile(dir);
  const file = await stat(path);
  const parent = await stat(dirname(path));
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(parent.mode & 0o777, 0o700);
  const saved = JSON.parse(await readFile(path, 'utf8')) as { token?: string };
  assert.equal(typeof saved.token, 'string');
  const who = await run(['whoami'], cliEnv(dir));
  assert.equal(who.code, 0, redact(who.stderr));
  assert.equal(who.stdout.includes('CLI User'), true);
  assert.equal(who.stdout.includes(saved.token ?? ''), false);
  assert.equal(who.stderr.includes(saved.token ?? ''), false);
  await rm(dir, { recursive: true, force: true });
});

test('DROPIT_TOKEN overrides a bad file token without rewriting it', async () => {
  const dir = await home();
  const path = configFile(dir);
  const { saveConfig } = await import('../src/config.js');
  const stale = 'a'.repeat(43);
  await saveConfig(path, { url: fx.base, token: stale });
  const who = await run(['whoami'], cliEnv(dir, { DROPIT_TOKEN: token }));
  assert.equal(who.code, 0, redact(who.stderr));
  assert.equal(who.stdout.includes(token), false);
  const saved = JSON.parse(await readFile(path, 'utf8')) as { token?: string };
  assert.equal(saved.token, stale);
  await rm(dir, { recursive: true, force: true });
});

test('send, stdin, and get latest round-trip exact bytes', async () => {
  const dir = await home();
  const env = cliEnv(dir, { DROPIT_TOKEN: token });
  const sent = await run(['send', 'hello', 'world'], env);
  assert.equal(sent.code, 0, redact(sent.stderr));
  const piped = await run(['send'], env, 'piped line\n');
  assert.equal(piped.code, 0, redact(piped.stderr));
  const exact = await run(['get', sent.stdout.trim()], env);
  assert.equal(exact.code, 0, redact(exact.stderr));
  assert.equal(exact.stdout, 'hello world');
  const latest = await run(['get', 'latest'], env);
  assert.equal(latest.stdout, 'piped line\n');
  await rm(dir, { recursive: true, force: true });
});

test('push keeps completed files and rejects an empty or missing file', async () => {
  const dir = await home();
  const work = await mkdtemp(join(tmpdir(), 'dropit-cli-push-'));
  const env = cliEnv(dir, { DROPIT_TOKEN: token });
  const kept = join(work, 'kept.bin');
  const empty = join(work, 'empty.bin');
  await writeFile(kept, Buffer.from('kept-body'));
  await writeFile(empty, Buffer.alloc(0));
  const failed = await run(['push', kept, empty], env);
  assert.notEqual(failed.code, 0);
  assert.equal(failed.stderr.includes('空文件'), true);
  const missing = await run(['push', join(work, 'missing.bin')], env);
  assert.notEqual(missing.code, 0);
  assert.equal(missing.stderr.includes('找不到文件'), true);
  const listed = await run(['ls', '--json'], env);
  assert.equal(listed.code, 0, redact(listed.stderr));
  assert.equal(listed.stdout.includes('kept.bin'), true);
  assert.equal(listed.stdout.includes('empty.bin'), false);
  await rm(dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

test('download uses the server filename, refuses overwrite, and resumes with Range', async () => {
  const dir = await home();
  const work = await mkdtemp(join(tmpdir(), 'dropit-cli-get-'));
  const env = cliEnv(dir, { DROPIT_TOKEN: token });
  const source = join(work, 'payload.bin');
  const bytes = Buffer.from('payload-bytes-v1');
  await writeFile(source, bytes);
  const pushed = await run(['push', source], env);
  assert.equal(pushed.code, 0, redact(pushed.stderr));
  const id = pushed.stdout.split('\t')[0]?.trim() ?? '';
  const out = join(work, 'out');
  const first = await run(['get', id, '-o', out], env);
  assert.equal(first.code, 0, redact(first.stderr));
  assert.deepEqual(await readFile(join(out, 'payload.bin')), bytes);
  const blocked = await run(['get', id, '-o', out], env);
  assert.notEqual(blocked.code, 0);
  assert.equal(blocked.stderr.includes('--force'), true);
  await writeFile(join(out, 'payload.bin'), Buffer.from('stale'));
  const forced = await run(['get', id, '-o', out, '--force'], env);
  assert.equal(forced.code, 0, redact(forced.stderr));
  assert.deepEqual(await readFile(join(out, 'payload.bin')), bytes);

  const original = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const resumeSource = join(work, 'resume.bin');
  await writeFile(resumeSource, original);
  const uploaded = await run(['push', resumeSource], env);
  assert.equal(uploaded.code, 0, redact(uploaded.stderr));
  const resumeId = uploaded.stdout.split('\t')[0]?.trim() ?? '';
  const resumeDir = join(work, 'resume');
  assert.equal((await run(['get', resumeId, '-o', resumeDir], env)).code, 0);
  const partialPath = join(resumeDir, 'resume.bin');
  const half = Math.floor(original.length / 2);
  const partial = Buffer.from(original.subarray(0, half));
  partial[0] = 0xff;
  await writeFile(partialPath, partial);
  const resumed = await run(['get', resumeId, '-o', resumeDir, '-c', '--force'], env);
  assert.equal(resumed.code, 0, redact(resumed.stderr));
  const restored = await readFile(partialPath);
  assert.equal(restored.length, original.length);
  assert.equal(restored[0], 0xff);
  assert.deepEqual(restored.subarray(half), original.subarray(half));
  const again = await run(['get', resumeId, '-o', resumeDir, '-c'], env);
  assert.equal(again.code, 0, redact(again.stderr));
  assert.deepEqual(await readFile(partialPath), restored);
  await rm(dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

test('rm removes the item', async () => {
  const dir = await home();
  const env = cliEnv(dir, { DROPIT_TOKEN: token });
  const marker = `remove-${Date.now()}`;
  const sent = await run(['send', marker], env);
  assert.equal(sent.code, 0, redact(sent.stderr));
  const id = sent.stdout.trim();
  assert.equal((await run(['get', id], env)).stdout, marker);
  const removed = await run(['rm', id], env);
  assert.equal(removed.code, 0, redact(removed.stderr));
  const gone = await run(['get', id], env);
  assert.notEqual(gone.code, 0);
  await rm(dir, { recursive: true, force: true });
});

test('share prints a one-view URL and not a separate token field', async () => {
  const dir = await home();
  const env = cliEnv(dir, { DROPIT_TOKEN: token });
  const sent = await run(['send', 'share-body'], env);
  const id = sent.stdout.trim();
  const shared = await run(['share', id, '--expires', '1d', '--max-views', '1', '--json'], env);
  assert.equal(shared.code, 0, redact(shared.stderr));
  const body = JSON.parse(shared.stdout) as { url?: string; maxViews?: number | null };
  assert.equal(Object.hasOwn(body, 'token'), false);
  assert.equal(body.maxViews, 1);
  const shareToken = new URL(body.url ?? '').pathname.split('/').filter(Boolean).at(-1) ?? '';
  assert.equal((await call('GET', `/api/s/${shareToken}`)).status, 200);
  assert.equal((await call('GET', `/api/s/${shareToken}`)).status, 404);
  await rm(dir, { recursive: true, force: true });
});

test('room new and join isolate items from the saved space', async () => {
  const dir = await home();
  const env = cliEnv(dir, { DROPIT_TOKEN: token });
  const created = await run(['room', 'new', '--json'], env);
  assert.equal(created.code, 0, redact(created.stderr));
  const room = JSON.parse(created.stdout) as { url?: string; expiresAt?: number };
  assert.equal(Object.hasOwn(room, 'token'), false);
  assert.equal(typeof room.expiresAt, 'number');
  const joined = await run(['room', 'join', room.url ?? '', '--json'], env);
  assert.equal(joined.code, 0, redact(joined.stderr));
  const joinBody = JSON.parse(joined.stdout) as { ok?: boolean };
  assert.equal(joinBody.ok, true);
  assert.equal(Object.hasOwn(joinBody, 'token'), false);
  const marker = `room-only-${Date.now()}`;
  assert.equal((await run(['send', marker], env)).code, 0);
  const inside = await run(['ls', '--json'], env);
  assert.equal(inside.stdout.includes(marker), true);
  const outside = await run(['--space', fx.spaceId, 'ls', '--json'], env);
  assert.equal(outside.code, 0, redact(outside.stderr));
  assert.equal(outside.stdout.includes(marker), false);
  const saved = JSON.parse(await readFile(configFile(dir), 'utf8')) as { roomToken?: string; spaceId?: string; token?: string };
  assert.equal(saved.roomToken, undefined);
  assert.equal(saved.spaceId, fx.spaceId);
  assert.equal(saved.token, undefined);
  await rm(dir, { recursive: true, force: true });
});

test('watch reports a new item and exits 130 on SIGINT', { timeout: 15_000 }, async () => {
  const dir = await home();
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'watch'], {
    cwd: join(here, '..'),
    env: cliEnv(dir, { DROPIT_TOKEN: token }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  try {
    const started = Date.now();
    while (!stderr.includes('正在监听')) {
      if (Date.now() - started > 8_000) throw new Error(`watch did not start: ${redact(stderr)}`);
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    const marker = `watched-${Date.now()}`;
    const posted = await call('POST', `/api/spaces/${fx.spaceId}/items/text`, { token, body: { text: marker } });
    assert.equal(posted.status, 201);
    const seenAt = Date.now();
    while (!stdout.includes(marker)) {
      if (Date.now() - seenAt > 5_000) throw new Error(`watch missed item: ${redact(stdout)}`);
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    child.kill('SIGINT');
    const code = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(child.exitCode ?? 1);
      }, 5_000);
      child.once('close', (status) => {
        clearTimeout(timer);
        resolve(status ?? 1);
      });
    });
    assert.equal(code, 130);
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('watch --exec passes the body on stdin and does not use a shell', { timeout: 15_000 }, async () => {
  const dir = await home();
  const work = await mkdtemp(join(tmpdir(), 'dropit-cli-exec-'));
  const marker = join(work, 'PWNED');
  const result = join(work, 'result.json');
  const script = `const fs=require('node:fs'); let stdin=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { fs.writeFileSync(process.env.OUT, JSON.stringify({ argv: process.argv.slice(1), text: process.env.DROPIT_ITEM_TEXT, stdin })); });`;
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'watch', '--exec', '--', process.execPath, '-e', script], {
    cwd: join(here, '..'),
    env: cliEnv(dir, { DROPIT_TOKEN: token, OUT: result }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  try {
    const started = Date.now();
    while (!stderr.includes('正在监听')) {
      if (Date.now() - started > 8_000) throw new Error(`watch did not start: ${redact(stderr)}`);
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    const payload = `hello; touch ${marker}; $(touch ${marker})`;
    assert.equal((await call('POST', `/api/spaces/${fx.spaceId}/items/text`, { token, body: { text: payload } })).status, 201);
    const seenAt = Date.now();
    let written = false;
    while (!written) {
      if (Date.now() - seenAt > 5_000) throw new Error(`exec did not run: ${redact(stderr)}`);
      written = await access(result).then(() => true, () => false);
      if (!written) await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    const recorded = JSON.parse(await readFile(result, 'utf8')) as { argv: string[]; text: string; stdin: string };
    assert.equal(recorded.text, payload);
    assert.equal(recorded.stdin, payload);
    assert.equal(recorded.argv.join('\n').includes(payload), false);
    assert.equal(await access(marker).then(() => true, () => false), false);
    child.kill('SIGINT');
    await once(child, 'close').catch(() => undefined);
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('a read-only token cannot send', async () => {
  const dir = await home();
  const readOnly = await mint(['read']);
  const result = await run(['send', 'nope'], cliEnv(dir, { DROPIT_TOKEN: readOnly }));
  assert.notEqual(result.code, 0);
  assert.equal(/范围|INSUFFICIENT_SCOPE/.test(result.stderr), true);
  assert.equal(result.stderr.includes(readOnly), false);
  await rm(dir, { recursive: true, force: true });
});

test('logout revokes a separate token and clears the file', async () => {
  const dir = await home();
  const extra = await mint();
  const { saveConfig } = await import('../src/config.js');
  await saveConfig(configFile(dir), { url: fx.base, token: extra });
  const result = await run(['logout'], cliEnv(dir));
  assert.equal(result.code, 0, redact(result.stderr));
  const saved = JSON.parse(await readFile(configFile(dir), 'utf8')) as { token?: string };
  assert.equal(saved.token, undefined);
  assert.equal((await call('GET', '/api/me', { token: extra })).status, 401);
  await rm(dir, { recursive: true, force: true });
});

test('help and usage stay machine readable without a prompt', async () => {
  const dir = await home();
  const env = cliEnv(dir, { DROPIT_TOKEN: token });
  const help = await run(['--help'], env);
  assert.equal(help.code, 0);
  assert.equal(help.stdout.includes('dropit login'), true);
  const unknown = await run(['missing-command', '--json'], env);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stdout, '');
  const error = JSON.parse(unknown.stderr) as { error: { code: string } };
  assert.equal(error.error.code, 'USAGE');
  const empty = await run(['send'], env, '');
  assert.notEqual(empty.code, 0);
  assert.equal(empty.stderr.includes('文本是空的'), true);
  const chunks: string[] = [];
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const code = await main(['send'], env, {
    stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    stderr,
    stdin: Readable.from([]),
    stdinIsTTY: true,
    stderrIsTTY: false,
  });
  assert.equal(code, 2);
  assert.equal(chunks.join('').includes('缺少文本'), true);
  await rm(dir, { recursive: true, force: true });
});

test('push draws a progress line on a stderr TTY', async () => {
  const dir = await home();
  const work = await mkdtemp(join(tmpdir(), 'dropit-cli-progress-'));
  const file = join(work, 'progress.bin');
  await writeFile(file, Buffer.alloc(4096, 7));
  const chunks: string[] = [];
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const stdoutChunks: string[] = [];
  const code = await main(['push', file], cliEnv(dir, { DROPIT_TOKEN: token }), {
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        stdoutChunks.push(String(chunk));
        callback();
      },
    }),
    stderr,
    stdin: Readable.from([]),
    stdinIsTTY: false,
    stderrIsTTY: true,
  });
  assert.equal(code, 0, redact(chunks.join('')));
  assert.equal(chunks.join('').includes('%'), true);
  assert.equal(stdoutChunks.join('').includes('%'), false);
  await rm(dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});
