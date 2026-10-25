import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';
import { CliError } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '../src/index.ts');
const serverScript = join(here, 'chunk-server.ts');
const CHUNK = 64 * 1024;
const SIZE = CHUNK * 4;

interface Stats {
  inflight: number;
  maxInflight: number;
  chunkPuts: number;
  creates: number;
  deletes: number;
  committed: number;
  maxRange: number;
  ranges: string[];
}

interface Lab {
  child: ChildProcess;
  base: string;
  origin: string;
  spaceId: string;
  token: string;
  stop: () => Promise<void>;
}

let lab: Lab;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function pattern(size = SIZE): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = i % 251;
  return buf;
}

function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: unknown; text: string }> {
  const url = new URL(path, lab.base);
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
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
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function stats(): Promise<Stats> {
  const response = await call('GET', '/__test/stats');
  if (response.status !== 200) throw new Error(`stats ${response.status}`);
  return response.json as Stats;
}

async function control(body: { reset?: boolean; holdFrom?: number | 'off'; drop?: boolean; delayMs?: number; delayRanges?: boolean }): Promise<void> {
  const response = await call('POST', '/__test/control', { body });
  if (response.status !== 200) throw new Error(`control ${response.status}`);
}

async function startLab(): Promise<Lab> {
  const child = spawn(process.execPath, ['--import', 'tsx', serverScript], {
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
      reject(new Error(`chunk server timeout: ${Buffer.concat(stderr).toString('utf8')}`));
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
      reject(new Error(`chunk server exited ${code ?? 'null'}: ${Buffer.concat(stderr).toString('utf8')}`));
    });
  });
  const info = JSON.parse(line) as { port: number; origin: string; spaceId: string; token: string };
  const started: Lab = {
    child,
    base: `http://127.0.0.1:${info.port}`,
    origin: info.origin,
    spaceId: info.spaceId,
    token: info.token,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode) return;
      child.kill('SIGTERM');
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited.catch(() => undefined);
      clearTimeout(timer);
    },
  };
  lab = started;
  return started;
}

function cliEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_ENV: 'test',
    DROPIT_URL: lab.base,
    DROPIT_TOKEN: lab.token,
    DROPIT_CONFIG: join(home, 'config.json'),
  };
}

function sessionPath(home: string): string {
  return join(home, 'uploads.json');
}

function spawnCli(args: string[], home: string): {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => { stdout: string; stderr: string };
} {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: join(here, '..'),
    env: cliEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    output: () => ({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
  };
}

async function run(args: string[], home: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawnCli(args, home);
  const result = await child.exited;
  return { ...result, ...child.output() };
}

async function waitFor(check: () => Promise<boolean>, label: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

async function readSessions(home: string): Promise<Array<{ uploadId: string }>> {
  try {
    const parsed = JSON.parse(await readFile(sessionPath(home), 'utf8')) as { uploads?: Array<{ uploadId: string }> };
    return parsed.uploads ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

test('flags reject out-of-range jobs and keep --keep on push', () => {
  assert.throws(() => parseArgs(['get', 'id', '--jobs', '0']), (error: CliError) => error.exitCode === 2);
  assert.throws(() => parseArgs(['get', 'id', '--jobs', '9']), (error: CliError) => error.exitCode === 2);
  assert.throws(() => parseArgs(['push', 'a.bin', '--jobs', '2']), (error: CliError) => error.exitCode === 2);
  assert.deepEqual(parseArgs(['push', 'a.bin', '--keep']).command, { kind: 'push', files: ['a.bin'], keep: true });
  assert.equal(parseArgs(['get', 'latest', '-o', 'out', '--jobs', '4']).command.kind, 'get');
});

test('chunked push resumes, cancels, and caps concurrency', { timeout: 60_000 }, async () => {
  let current: Lab | undefined;
  const home = await mkdtemp(join(tmpdir(), 'dropit-cli-chunk-home-'));
  const work = await mkdtemp(join(tmpdir(), 'dropit-cli-chunk-work-'));
  const file = join(work, 'big.bin');
  const bytes = pattern();
  await writeFile(file, bytes);
  try {
    current = await startLab();
    lab = current;
    await control({ reset: true, delayMs: 200 });
    const capped = await run(['push', file], home);
    assert.equal(capped.code, 0, capped.stderr);
    const cappedStats = await stats();
    assert.equal(cappedStats.maxInflight, 3, `max in-flight chunks ${cappedStats.maxInflight}`);
    assert.ok(cappedStats.chunkPuts >= 4);
    assert.equal((await readSessions(home)).length, 0);

    await control({ reset: true, holdFrom: 1 });
    const first = spawnCli(['push', file], home);
    await waitFor(async () => (await stats()).committed >= 1, 'first chunk');
    first.child.kill('SIGKILL');
    const killed = await first.exited;
    assert.equal(killed.signal, 'SIGKILL');
    const held = await readSessions(home);
    assert.equal(held.length, 1);
    const saved = await lstat(sessionPath(home));
    assert.equal(saved.mode & 0o777, 0o600);
    const sessionText = await readFile(sessionPath(home), 'utf8');
    assert.equal(sessionText.includes(lab.token), false);
    assert.equal(sessionText.includes('"token"'), false);
    const uploadId = held[0]!.uploadId;
    await control({ drop: true });
    await waitFor(async () => (await stats()).inflight === 0, 'held chunks to drop');
    await control({ drop: false, holdFrom: 'off' });
    const putsBefore = (await stats()).chunkPuts;
    const createsBefore = (await stats()).creates;
    const resumed = await run(['push', file], home);
    assert.equal(resumed.code, 0, resumed.stderr);
    const afterResume = await stats();
    assert.ok(afterResume.chunkPuts - putsBefore < 4, `resume put ${afterResume.chunkPuts - putsBefore} chunks`);
    assert.equal(afterResume.creates, createsBefore);
    assert.equal(resumed.stdout.includes(lab.token), false);
    assert.equal(resumed.stderr.includes(lab.token), false);
    const id = resumed.stdout.split('\t')[0]?.trim() ?? '';
    assert.ok(id);
    const gone = await call('GET', `/api/spaces/${lab.spaceId}/uploads/${uploadId}`, { token: lab.token });
    assert.equal(gone.status, 404);
    const out = join(work, 'out');
    await mkdir(out);
    await control({ reset: true, delayRanges: true });
    const downloaded = await run(['get', id, '-o', out, '--jobs', '4'], home);
    assert.equal(downloaded.code, 0, downloaded.stderr);
    assert.deepEqual(await readFile(join(out, 'big.bin')), bytes);
    await assert.rejects(access(join(out, 'big.bin.dropit-partial')));
    const ranged = await stats();
    assert.ok(ranged.maxRange >= 2, `parallel ranges peaked at ${ranged.maxRange}`);
    assert.equal(downloaded.stdout.includes(lab.token), false);

    const fresh = join(work, 'fresh');
    await mkdir(fresh);
    const partial = join(fresh, 'big.bin.dropit-partial');
    const width = Math.ceil(SIZE / 2);
    await writeFile(partial, bytes.subarray(0, width));
    await writeFile(`${partial}.json`, `${JSON.stringify({ total: SIZE, jobs: 2, done: [0] })}\n`);
    await control({ reset: true });
    const continued = await run(['get', id, '-o', fresh, '-c', '--jobs', '2'], home);
    assert.equal(continued.code, 0, continued.stderr);
    assert.deepEqual(await readFile(join(fresh, 'big.bin')), bytes);
    assert.equal((await stats()).ranges.some(range => range === `bytes=0-${width - 1}`), false);

    const tooBig = join(work, 'too-big');
    await mkdir(tooBig);
    const oversized = join(tooBig, 'big.bin.dropit-partial');
    await writeFile(oversized, Buffer.alloc(SIZE + 32, 7));
    await writeFile(`${oversized}.json`, `${JSON.stringify({ total: SIZE, jobs: 2, done: [] })}\n`);
    const rejected = await run(['get', id, '-o', tooBig, '-c', '--jobs', '2'], home);
    assert.notEqual(rejected.code, 0);
    await assert.rejects(access(join(tooBig, 'big.bin')));
    assert.equal((await readFile(oversized)).length, SIZE + 32);

    const linked = join(work, 'linked');
    await mkdir(linked);
    await symlink(file, join(linked, 'big.bin'));
    const linkGet = await run(['get', id, '-o', linked, '--force'], home);
    assert.notEqual(linkGet.code, 0);
    assert.match(linkGet.stderr, /符号链接/);
    assert.equal((await lstat(join(linked, 'big.bin'))).isSymbolicLink(), true);

    const occupied = join(work, 'occupied');
    await mkdir(occupied);
    await writeFile(join(occupied, 'big.bin'), Buffer.from('keep'));
    const clash = await run(['get', id, '-o', occupied, '--jobs', '4'], home);
    assert.notEqual(clash.code, 0);
    assert.equal(await readFile(join(occupied, 'big.bin'), 'utf8'), 'keep');

    await control({ reset: true, holdFrom: 0 });
    const cancelHome = await mkdtemp(join(tmpdir(), 'dropit-cli-chunk-cancel-'));
    const cancelling = spawnCli(['push', file], cancelHome);
    await waitFor(async () => (await stats()).creates >= 1 && (await readSessions(cancelHome)).length === 1, 'cancel session');
    const cancelId = (await readSessions(cancelHome))[0]!.uploadId;
    const mode = await lstat(sessionPath(cancelHome));
    assert.equal(mode.mode & 0o777, 0o600);
    cancelling.child.kill('SIGINT');
    const cancelled = await Promise.race([
      cancelling.exited,
      delay(8000).then(() => ({ code: null, signal: 'timeout' as NodeJS.Signals | null })),
    ]);
    assert.equal(cancelled.code, 130, cancelling.output().stderr);
    assert.ok((await stats()).deletes >= 1);
    assert.equal((await readSessions(cancelHome)).length, 0);
    const missing = await call('GET', `/api/spaces/${lab.spaceId}/uploads/${cancelId}`, { token: lab.token });
    assert.equal(missing.status, 404);
    await control({ drop: true });
    await waitFor(async () => (await stats()).inflight === 0, 'cancel holds');

    await control({ reset: true, holdFrom: 1 });
    const keepHome = await mkdtemp(join(tmpdir(), 'dropit-cli-chunk-keep-'));
    const keeping = spawnCli(['push', '--keep', file], keepHome);
    await waitFor(async () => (await stats()).committed >= 1 && (await readSessions(keepHome)).length === 1, 'keep session');
    keeping.child.kill('SIGINT');
    const kept = await Promise.race([
      keeping.exited,
      delay(8000).then(() => ({ code: null, signal: 'timeout' as NodeJS.Signals | null })),
    ]);
    assert.equal(kept.code, 130, keeping.output().stderr);
    assert.equal((await stats()).deletes, 0);
    assert.equal((await readSessions(keepHome)).length, 1);
    assert.equal((await readFile(sessionPath(keepHome), 'utf8')).includes(lab.token), false);
    await control({ drop: true });
    await waitFor(async () => (await stats()).inflight === 0, 'keep holds');
    await control({ drop: false, holdFrom: 'off' });
    const keepCreates = (await stats()).creates;
    const finished = await run(['push', file], keepHome);
    assert.equal(finished.code, 0, finished.stderr);
    assert.equal((await stats()).creates, keepCreates);
    assert.equal((await readSessions(keepHome)).length, 0);

    await control({ reset: true });
    const jsonHome = await mkdtemp(join(tmpdir(), 'dropit-cli-chunk-json-'));
    const json = await run(['--json', 'push', file], jsonHome);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stdout.includes(lab.token), false);
    assert.equal(json.stderr.includes(lab.token), false);
    assert.equal(json.stderr.includes('uploadId'), false);
    const lines = json.stderr.split('\n').filter(Boolean);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const event = JSON.parse(line) as { status?: string };
      assert.equal(typeof event.status, 'string');
    }
    assert.equal(json.stdout.trim().startsWith('{'), true);

    await control({ reset: true });
    const lineHome = await mkdtemp(join(tmpdir(), 'dropit-cli-chunk-lines-'));
    const linesRun = await run(['push', file], lineHome);
    assert.equal(linesRun.code, 0, linesRun.stderr);
    assert.match(linesRun.stderr, /%/);
    assert.match(linesRun.stderr, /剩余/);
    assert.equal(linesRun.stderr.includes('\r'), false);
    assert.equal(linesRun.stderr.includes(lab.token), false);

    const jobs = await run(['get', id, '--jobs', '2'], home);
    assert.equal(jobs.code, 2);

    const tiny = join(work, 'tiny.bin');
    await writeFile(tiny, Buffer.alloc(32, 3));
    await control({ reset: true });
    const small = await run(['push', tiny], home);
    assert.equal(small.code, 0, small.stderr);
    assert.equal((await stats()).creates, 0);
  } finally {
    await current?.stop();
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});
