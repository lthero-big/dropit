import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliError } from '../src/errors.js';
import type { Item } from '../src/items.js';
import { createPushWriter, pushFiles } from '../src/push.js';

const cli = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function item(name: string): Item {
  return {
    id: `id-${name}`, spaceId: 's1', userId: 'u1', kind: 'file', text: null, filename: name,
    mime: 'application/octet-stream', size: 4, createdAt: 1, updatedAt: 1, expiresAt: 2, pinned: false, tags: [],
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('push concurrency stays at 3 while extra files wait', async () => {
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const upload = (file: string) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<Item>((resolve) => {
      releases.push(() => {
        active -= 1;
        resolve(item(file));
      });
    });
  };
  const pending = pushFiles({
    files: ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin'],
    signal: new AbortController().signal,
    upload,
    onEvent: () => {},
  });
  assert.equal(releases.length, 3);
  assert.equal(maxActive, 3);
  releases[0]!();
  await delay(0);
  assert.equal(releases.length, 4);
  assert.equal(maxActive, 3);
  releases[1]!();
  releases[2]!();
  releases[3]!();
  await delay(0);
  assert.equal(releases.length, 5);
  releases[4]!();
  const result = await pending;
  assert.equal(result.items.length, 5);
  assert.equal(result.failed, 0);
  assert.equal(result.cancelled, false);
});

test('429 retries with Retry-After 0, and one rejection does not cancel the others', async () => {
  const calls: string[] = [];
  const releases: Array<() => void> = [];
  const upload = (file: string) => {
    calls.push(file);
    if (file === 'busy.bin' && calls.filter((name) => name === 'busy.bin').length === 1) {
      const error = new CliError('UPLOAD_BUSY', 'busy.bin：服务器正在处理其他上传');
      error.retryAfter = 0;
      return Promise.reject(error);
    }
    if (file === 'bad.bin') return Promise.reject(new CliError('EMPTY_FILE', 'bad.bin 是空文件'));
    return new Promise<Item>((resolve) => {
      releases.push(() => resolve(item(file)));
    });
  };
  const pending = pushFiles({
    files: ['busy.bin', 'bad.bin', 'good.bin'],
    signal: new AbortController().signal,
    upload,
    onEvent: () => {},
    sleep: async () => {},
  });
  await delay(0);
  assert.equal(calls.filter((name) => name === 'busy.bin').length, 2);
  assert.equal(calls.includes('bad.bin'), true);
  assert.equal(calls.includes('good.bin'), true);
  assert.equal(releases.length, 2);
  for (const release of releases.splice(0)) release();
  const result = await pending;
  assert.equal(result.failed, 1);
  assert.equal(result.items.length, 2);
  assert.equal(result.cancelled, false);
  assert.equal(result.errors[0], 'bad.bin 是空文件');
});

test('abort cancels in-flight uploads and never starts the queued files', async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const events: string[] = [];
  const upload = (file: string, _onProgress: (sent: number, total: number) => void, signal: AbortSignal) => new Promise<Item>((_resolve, reject) => {
    started.push(file);
    signal.addEventListener('abort', () => reject(new CliError('INTERRUPTED', '已取消上传', 130)), { once: true });
  });
  const pending = pushFiles({
    files: ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin'],
    signal: controller.signal,
    upload,
    onEvent: (event) => events.push(`${event.status}:${event.name}`),
  });
  assert.deepEqual(started, ['a.bin', 'b.bin', 'c.bin']);
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.failed, 0);
  assert.equal(result.items.length, 0);
  assert.deepEqual(started, ['a.bin', 'b.bin', 'c.bin']);
  assert.equal(events.includes('cancelled:d.bin'), true);
  assert.equal(events.includes('cancelled:e.bin'), true);
  assert.equal(events.includes('uploading:d.bin'), false);
});

test('non-TTY writer prints one line per status and skips progress ticks', () => {
  const lines: string[] = [];
  const write = createPushWriter({
    stderr: { write(chunk: string) { lines.push(chunk); return true; } },
    stderrIsTTY: false,
  });
  write({ file: 'a.bin', name: 'a.bin', status: 'queued' });
  write({ file: 'a.bin', name: 'a.bin', status: 'uploading' });
  write({ file: 'a.bin', name: 'a.bin', status: 'uploading', sent: 1, total: 4 });
  write({ file: 'a.bin', name: 'a.bin', status: 'done' });
  write({ file: 'b.bin', name: 'b.bin', status: 'failed', message: '空文件' });
  assert.deepEqual(lines, ['排队 a.bin\n', '上传 a.bin\n', '完成 a.bin\n', '失败 b.bin：空文件\n']);
});

test('Ctrl+C cancels a hanging push and exits 130', async () => {
  let sawPost = false;
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/api/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        user: { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'user' },
        usedBytes: 0, quotaBytes: 1000, maxFileBytes: 1000, maxTextBytes: 1000, retentionMs: 1000,
      }));
      return;
    }
    if (req.method === 'GET' && url === '/api/spaces') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ spaces: [{ id: 's1', name: 'Private', ownerId: 'u1', expiresAt: null }] }));
      return;
    }
    if (req.method === 'POST' && url.startsWith('/api/spaces/s1/items/file')) {
      sawPost = true;
      req.resume();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const home = await mkdtemp(join(tmpdir(), 'dropit-cli-home-'));
  const work = await mkdtemp(join(tmpdir(), 'dropit-cli-push-'));
  const file = join(work, 'hang.bin');
  await writeFile(file, Buffer.alloc(32, 1));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', cli, 'push', file], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      NODE_ENV: 'test',
      DROPIT_URL: `http://127.0.0.1:${address.port}`,
      DROPIT_TOKEN: 'test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const err: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    const deadline = Date.now() + 8000;
    while (!sawPost && Date.now() < deadline) await delay(20);
    assert.equal(sawPost, true);
    child.kill('SIGINT');
    const result = await Promise.race([
      exited,
      delay(8000).then(() => ({ code: null as number | null, signal: 'timeout' as NodeJS.Signals | null })),
    ]);
    assert.equal(result.code, 130, Buffer.concat(err).toString('utf8'));
    assert.match(Buffer.concat(err).toString('utf8'), /已取消 hang\.bin/);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});
