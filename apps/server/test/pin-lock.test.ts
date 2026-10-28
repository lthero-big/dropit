import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { PinLockout } from '../src/rate-limit.js';

// RHEA-190: per-room-code total PIN-failure lockout, on top of the per-IP / per-code RATE_AUTH budget.
const SITE = 'http://dropit.lan:8787';

async function setup(overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-pinlock-'));
  let clock = 1_800_000_000_000;
  const config = { ...loadConfig({}), dataDir: dir, rateRoom: 100, rateAuth: 200, rateGeneral: 1000, rateUpload: 500, rateWindowMs: 60000, pinLockFailures: 5, pinLockMs: 15 * 60000, ...overrides };
  const backend = createBackend({ config, providers: {}, now: () => clock, remoteAddress: c => c.req.header('x-test-peer') ?? '203.0.113.9' });
  const request = (path: string, init: { method?: string; body?: unknown; peer?: string } = {}) => {
    const headers: Record<string, string> = { host: 'dropit.lan:8787', origin: SITE };
    if (init.peer) headers['x-test-peer'] = init.peer;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return backend.app.request(`${SITE}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const enter = (code: string, pin?: string, peer?: string) => request('/api/rooms/enter', { method: 'POST', body: { code, ...(pin === undefined ? {} : { pin }) }, peer });
  return { request, enter, advance: (ms: number) => { clock += ms; }, async close() { await backend.close(); await rm(dir, { recursive: true, force: true }); } };
}
const newRoom = async (f: Awaited<ReturnType<typeof setup>>, pin = '1357') =>
  await (await f.request('/api/rooms', { method: 'POST', body: { pin } })).json() as { code: string; token: string; hasPin: boolean };
// each wrong guess comes from a different IP, so only the per-room total can stop them
const wrong = (f: Awaited<ReturnType<typeof setup>>, code: string, i: number) => f.enter(code, `00${i}0`, `198.51.100.${i + 1}`);

test('PinLockout counts failures, locks, expires and clears', () => {
  const lock = new PinLockout(3, 1000);
  assert.equal(lock.fail('r', 0), undefined);
  assert.equal(lock.fail('r', 10), undefined);
  assert.equal(lock.locked('r', 20), undefined);
  assert.equal(lock.fail('r', 20), 1);
  assert.equal(lock.locked('r', 500), 1);
  assert.equal(lock.locked('r', 1019), 1);
  assert.equal(lock.locked('r', 1020), undefined);
  // the counter starts over after the lock
  assert.equal(lock.fail('r', 1100), undefined);
  // failures older than the window are forgotten
  assert.equal(lock.fail('s', 0), undefined);
  assert.equal(lock.fail('s', 5000), undefined);
  assert.equal(lock.fail('s', 5001), undefined);
  assert.equal(lock.fail('s', 5002), 1);
  lock.clear('s');
  assert.equal(lock.locked('s', 5003), undefined);
  // memory stays bounded
  const small = new PinLockout(2, 1000, 3);
  for (let i = 0; i < 10; i++) small.fail(`room${i}`, 0);
  assert.equal(small.fail('room9', 1), 1);
});

test('a room code is locked after too many wrong PINs from any IP, the right PIN is refused meanwhile, and it unlocks by itself', async t => {
  const f = await setup();
  t.after(() => f.close());
  const room = await newRoom(f);
  for (let i = 0; i < 4; i++) assert.equal((await wrong(f, room.code, i)).status, 403);
  // the 5th wrong PIN trips the lock
  const tripped = await wrong(f, room.code, 4);
  assert.equal(tripped.status, 429);
  assert.equal(Number(tripped.headers.get('retry-after')), 900);
  // even the right PIN from a fresh IP is refused, and so is a request without a PIN
  const refused = await f.enter(room.code, '1357', '198.51.100.99');
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.equal((await f.enter(room.code, undefined, '198.51.100.98')).status, 429);
  // other rooms are not affected
  const other = await newRoom(f, '2468');
  assert.equal((await f.enter(other.code, '2468', '198.51.100.97')).status, 200);
  // the owner's existing access token keeps working while the code is locked
  assert.equal((await f.request(`/api/rooms/${room.token}/items`)).status, 200);
  // still locked a little before the end, open right after it
  f.advance(15 * 60000 - 5000);
  assert.equal((await f.enter(room.code, '1357', '198.51.100.96')).status, 429);
  f.advance(6000);
  const ok = await f.enter(room.code, '1357', '198.51.100.95');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).token, room.token);
});

test('failures older than the window are forgotten, and a right PIN resets the counter', async t => {
  const f = await setup();
  t.after(() => f.close());
  const room = await newRoom(f);
  for (let i = 0; i < 4; i++) assert.equal((await wrong(f, room.code, i)).status, 403);
  f.advance(16 * 60000);
  for (let i = 0; i < 4; i++) assert.equal((await wrong(f, room.code, i)).status, 403);
  // a right PIN clears the four failures, so four more are allowed again
  assert.equal((await f.enter(room.code, '1357', '198.51.100.50')).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await wrong(f, room.code, i)).status, 403);
});

test('the owner changing the code or PIN lifts the lock; PIN-less rooms and unknown codes never lock', async t => {
  const f = await setup();
  t.after(() => f.close());
  const deviceKey = 'k'.repeat(43);
  const room = await (await f.request('/api/rooms', { method: 'POST', body: { pin: '1357', deviceKey } })).json() as { code: string; token: string; id?: string };
  for (let i = 0; i < 5; i++) await wrong(f, room.code, i);
  assert.equal((await f.enter(room.code, '1357', '198.51.100.60')).status, 429);
  const changed = await f.request(`/api/rooms/${room.token}/code`, { method: 'PUT', body: { deviceKey, pin: '9753' } });
  assert.equal(changed.status, 200);
  assert.equal((await f.enter(room.code, '9753', '198.51.100.61')).status, 200);
  // a room without PIN and unknown codes are not counted by the room lock
  const open = await (await f.request('/api/rooms', { method: 'POST' })).json() as { code: string };
  for (let i = 0; i < 8; i++) assert.equal((await f.enter(open.code, undefined, `198.51.100.${70 + i}`)).status, 200);
  for (let i = 0; i < 8; i++) assert.equal((await f.enter('NoSuch', undefined, `198.51.100.${80 + i}`)).status, 404);
});

test('PIN_LOCK_FAILURES and PIN_LOCK_MINUTES are configurable and validated', () => {
  const config = loadConfig({ PIN_LOCK_FAILURES: '3', PIN_LOCK_MINUTES: '2' });
  assert.equal(config.pinLockFailures, 3);
  assert.equal(config.pinLockMs, 120000);
  const defaults = loadConfig({});
  assert.equal(defaults.pinLockFailures, 10);
  assert.equal(defaults.pinLockMs, 15 * 60000);
  assert.throws(() => loadConfig({ PIN_LOCK_FAILURES: '0' }), /PIN_LOCK_FAILURES/);
  assert.throws(() => loadConfig({ PIN_LOCK_MINUTES: '-1' }), /PIN_LOCK_MINUTES/);
  assert.throws(() => loadConfig({ PIN_LOCK_MINUTES: '99999' }), /PIN_LOCK/);
});
