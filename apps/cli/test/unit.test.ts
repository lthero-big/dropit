import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { parseArgs } from '../src/args.js';
import { loadConfig, normalizeBase, resolveSettings, saveConfig } from '../src/config.js';
import { CliError, scrub } from '../src/errors.js';
import { runItemCommand } from '../src/exec.js';
import { latestItem, pickSpace, type Item } from '../src/items.js';
import { deviceLogin, interpretPoll } from '../src/login.js';
import { destination, downloadPlan, saveStream } from '../src/paths.js';
import { main, parseRoomTarget } from '../src/run.js';
import { applyWatch, createWatchState, nextDelay } from '../src/watch.js';

function item(id: string, createdAt: number, extra: Partial<Item> = {}): Item {
  return {
    id, spaceId: 'space', userId: 'user', kind: 'text', text: id, filename: null, mime: 'text/plain',
    size: id.length, createdAt, updatedAt: createdAt, expiresAt: createdAt + 1000, pinned: false, tags: [],
    ...extra,
  };
}

test('parseArgs reads globals and rejects unknown commands', () => {
  const parsed = parseArgs(['--json', '--url', 'http://localhost:8787', 'send', 'hello', 'world']);
  assert.equal(parsed.globals.json, true);
  assert.equal(parsed.globals.url, 'http://localhost:8787');
  assert.equal(parsed.command.kind, 'send');
  if (parsed.command.kind === 'send') assert.equal(parsed.command.text, 'hello world');
  assert.equal(parseArgs(['--help']).command.kind, 'help');
  assert.throws(() => parseArgs(['nope']), (error: CliError) => error.exitCode === 2);
  assert.throws(() => parseArgs(['share', 'latest']), (error: CliError) => error.code === 'USAGE');
  const watch = parseArgs(['watch', '--exec', '--', 'node', '-e', 'process.exit(0)']);
  assert.equal(watch.command.kind, 'watch');
  if (watch.command.kind === 'watch') assert.deepEqual(watch.command.exec, ['node', '-e', 'process.exit(0)']);
});

test('env credentials override the file and are not copied back by resolveSettings', () => {
  const settings = resolveSettings({ url: 'http://file', token: 'file-token', spaceId: 's' }, {
    DROPIT_URL: 'http://env', DROPIT_TOKEN: 'env-token',
  }, 'http://flag');
  assert.equal(settings.url, 'http://flag');
  assert.equal(settings.token, 'env-token');
  assert.equal(settings.spaceId, 's');
  assert.equal(normalizeBase('http://example.test/api/'), 'http://example.test');
  assert.throws(() => normalizeBase('http://user:secret@example.test'), (error: CliError) => error.code === 'USAGE');
});

test('config file is created with mode 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-cli-config-'));
  try {
    const path = join(dir, 'nested', 'config.json');
    await saveConfig(path, { url: 'http://127.0.0.1:8787', token: 'secret-token-value' });
    const file = await stat(path);
    const parent = await stat(join(dir, 'nested'));
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal(parent.mode & 0o777, 0o700);
    assert.deepEqual(await loadConfig(path), { url: 'http://127.0.0.1:8787', token: 'secret-token-value' });
    await saveConfig(path, { url: 'http://127.0.0.1:8787' });
    assert.equal((await loadConfig(path)).token, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('download names cannot escape the destination directory', () => {
  const dir = '/tmp/dropit-out';
  assert.equal(destination(dir, '../etc/passwd'), '/tmp/dropit-out/passwd');
  assert.equal(destination(dir, '..\\..\\windows\\system.ini'), '/tmp/dropit-out/system.ini');
  assert.throws(() => destination(dir, '..'), (error: CliError) => error.code === 'UNSAFE_PATH');
  assert.throws(() => destination(dir, '.'), (error: CliError) => error.code === 'UNSAFE_PATH');
});

test('range plan resumes without replacing a partial file', () => {
  assert.equal(downloadPlan(206, 10, 'bytes 10-19/20'), 'append');
  assert.equal(downloadPlan(200, 0, undefined), 'replace');
  assert.equal(downloadPlan(416, 20, 'bytes */20'), 'done');
  assert.throws(() => downloadPlan(416, 30, 'bytes */20'), (error: CliError) => error.code === 'RANGE');
  assert.throws(() => downloadPlan(206, 10, 'bytes 9-19/20'), (error: CliError) => error.code === 'RANGE');
});

test('failed download removes the partial file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-cli-partial-'));
  try {
    const dest = join(dir, 'clip.txt');
    const stream = Readable.from((async function* () {
      yield Buffer.from('abc');
      throw new Error('boom');
    })());
    await assert.rejects(() => saveStream(dest, stream, false));
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('latest ignores pin order and space selection does not prompt', () => {
  const pinned = item('old', 1, { pinned: true });
  const fresh = item('new', 5);
  assert.equal(latestItem([pinned, fresh])?.id, 'new');
  const spaces = [
    { id: 'a', name: 'Private space', ownerId: 'user', expiresAt: null },
    { id: 'b', name: 'Other', ownerId: 'owner', expiresAt: null },
  ];
  assert.equal(pickSpace(spaces, 'user').id, 'a');
  assert.throws(() => pickSpace(spaces, 'nobody'), (error: CliError) => error.code === 'SPACE_REQUIRED');
  assert.equal(pickSpace(spaces, 'nobody', 'b').id, 'b');
});

test('device login waits out the interval and does not reveal secrets', async () => {
  const sleeps: number[] = [];
  let now = 0;
  let polls = 0;
  const printed: string[] = [];
  const result = await deviceLogin({
    authorize: async () => ({
      device_code: 'device-code-secret-value-not-for-display',
      user_code: 'ABCD-EFGH',
      verification_uri: 'http://dropit.local/device',
      verification_uri_complete: 'http://dropit.local/device?user_code=ABCD-EFGH&verification_id=1',
      verification_id: '1', expires_in: 600, interval: 5,
    }),
    poll: async () => {
      polls += 1;
      if (polls === 1) return { kind: 'pending' };
      if (polls === 2) return { kind: 'slow_down', interval: 10 };
      return { kind: 'ok', accessToken: 'access-token-secret-value-not-for-display', scope: 'read write', expiresAt: null, name: 'laptop' };
    },
    sleep: async (seconds) => { sleeps.push(seconds); now += seconds * 1000; },
    now: () => now,
    onUserCode: (info) => printed.push(JSON.stringify(info)),
  });
  assert.deepEqual(sleeps, [5, 5, 10]);
  assert.equal(result.accessToken, 'access-token-secret-value-not-for-display');
  assert.equal(printed.join('').includes('device-code-secret'), false);
  assert.equal(printed.join('').includes('access-token-secret'), false);
  assert.equal(interpretPoll(400, { error: 'authorization_pending' }).kind, 'pending');
  assert.deepEqual(interpretPoll(400, { error: 'slow_down', interval: 15 }), { kind: 'slow_down', interval: 15 });
  assert.equal(interpretPoll(429, {}, '7').kind, 'retry');
});

test('watch baseline is not replayed and backoff stays capped', () => {
  const state = createWatchState();
  assert.deepEqual(applyWatch(state, { type: 'snapshot', items: [item('a', 1)] }), []);
  assert.equal(applyWatch(state, { type: 'item.created', item: item('b', 2) })[0]?.id, 'b');
  assert.equal(applyWatch(state, { type: 'item.updated', item: item('b', 2, { text: 'edited' }) }).length, 0);
  assert.deepEqual(applyWatch(state, { type: 'snapshot', items: [item('b', 2), item('c', 3)] }).map(entry => entry.id), ['c']);
  assert.equal(applyWatch(state, { type: 'item.deleted', id: 'b' }).length, 0);
  assert.equal(state.items.has('b'), false);
  assert.ok(nextDelay(0, 0) >= 250 && nextDelay(0, 1) <= 500);
  assert.ok(nextDelay(20, 1) <= 30_000);
});

test('exec passes the item on stdin and env, not through a shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-cli-exec-'));
  const marker = join(dir, 'PWNED');
  const out = join(dir, 'out.json');
  const payload = `hello; touch ${marker}; $(touch ${marker})`;
  const previous = process.env.OUT;
  process.env.OUT = out;
  try {
    const script = "const fs=require('fs'); let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>fs.writeFileSync(process.env.OUT, JSON.stringify({argv:process.argv, stdin:s, text:process.env.DROPIT_ITEM_TEXT})));";
    await runItemCommand(['node', '-e', script], item('1', 1, { text: payload, size: Buffer.byteLength(payload) }), Buffer.from(payload));
    const body = JSON.parse(await readFile(out, 'utf8')) as { argv: string[]; stdin: string; text: string };
    assert.equal(body.stdin, payload);
    assert.equal(body.text, payload);
    assert.equal(body.argv.some(arg => arg.includes(payload)), false);
    assert.equal((await readdir(dir)).includes('PWNED'), false);
    const shelled = spawnSync('touch', [marker], { shell: false });
    assert.equal(shelled.status, 0);
  } finally {
    if (previous === undefined) delete process.env.OUT;
    else process.env.OUT = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('errors scrub secrets and usage is exit 2', async () => {
  assert.equal(scrub('token abcdefghijklmnopqrstuvwxyz leaked', ['abcdefghijklmnopqrstuvwxyz']), 'token [redacted] leaked');
  const stderr: string[] = [];
  const code = await main(['missing-command', '--json'], {}, {
    stdout: process.stdout,
    stderr: new Writable({
      write(chunk, _encoding, callback) {
        stderr.push(String(chunk));
        callback();
      },
    }),
    stdin: Readable.from([]),
    stdinIsTTY: false,
    stderrIsTTY: false,
  });
  assert.equal(code, 2);
  assert.equal(JSON.parse(stderr.join('')).error.code, 'USAGE');
});

test('RHEA-190 step 5: the CLI identifies itself as a stable, URL-safe cli device', async () => {
  const { cliDevice } = await import('../src/client.js');
  const first = cliDevice('build box');
  assert.deepEqual(first, cliDevice('build box'));
  assert.match(first['x-dropit-device'], /^cli-[A-Za-z0-9_-]{16}$/);
  assert.equal(first['x-dropit-device-kind'], 'cli');
  assert.equal(decodeURIComponent(first['x-dropit-device-name']), 'build box');
  assert.notEqual(cliDevice('other').id, first['x-dropit-device']);
  assert.equal([...decodeURIComponent(cliDevice('x'.repeat(80))['x-dropit-device-name'])].length, 40);
});

test('room targets: /r/<code> links and bare codes are codes; tokens and old /rooms/ links are tokens', () => {
  const code = (value: string) => ({ kind: 'code', code: value });
  const tok = (value: string) => ({ kind: 'token', token: value });
  assert.deepEqual(parseRoomTarget('Ab3dEf'), code('Ab3dEf'));
  assert.deepEqual(parseRoomTarget('team-red'), code('team-red'));
  assert.deepEqual(parseRoomTarget('https://drop.example/r/Ab3dEf'), code('Ab3dEf'));
  assert.deepEqual(parseRoomTarget('https://drop.example/r/team_red'), code('team_red'));
  const long = 'A'.repeat(43);
  assert.deepEqual(parseRoomTarget(long), tok(long));
  assert.deepEqual(parseRoomTarget(`https://drop.example/rooms/${long}`), tok(long));
  assert.deepEqual(parseRoomTarget(`https://drop.example/r/${long}`), tok(long));
  const entry = `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}.${'B'.repeat(43)}`;
  assert.deepEqual(parseRoomTarget(entry), tok(entry));
  assert.throws(() => parseRoomTarget('ab'), CliError);
  assert.throws(() => parseRoomTarget('has space'), CliError);
  assert.throws(() => parseRoomTarget('https://drop.example/r/ab'), CliError);
  assert.throws(() => parseRoomTarget('https://drop.example/s/Ab3dEf'), CliError);
});

test('room new / enter flags are validated', () => {
  assert.deepEqual(parseArgs(['room', 'new', '--code', 'team-red', '--pin', '4821']).command, { kind: 'room-new', code: 'team-red', pin: '4821' });
  assert.deepEqual(parseArgs(['room', 'enter', 'team-red', '--pin', '4821']).command, { kind: 'room-enter', code: 'team-red', pin: '4821' });
  assert.deepEqual(parseArgs(['room', 'new', '--pin', '4821']).command, { kind: 'room-new', code: undefined, pin: '4821' });
  assert.deepEqual(parseArgs(['room', 'join', 'https://drop.example/r/Ab3dEf', '--pin', '1']).command, { kind: 'room-join', target: 'https://drop.example/r/Ab3dEf', pin: '1' });
  assert.throws(() => parseArgs(['room', 'enter']), CliError);
  assert.throws(() => parseArgs(['room', 'join', 'Ab3dEf', '--code', 'x']), CliError);
});
