import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { hash, token } from '../src/domain.js';
import * as migrations from '../src/migrations.js';
import { migrateRoomCodes } from '../src/repository.js';
import { hashPasswordSync } from '../src/password.js';

// RHEA-190 auth step 4: one code per room (the link is /r/<code>), optional PIN that also guards the link,
// and migration 16 that gives every older room a code.
const SITE = 'http://dropit.lan:8787';
const FUTURE = 9_999_999_999_999;

async function setup(overrides: Partial<Config> = {}, prepare?: (dir: string) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-step4-'));
  prepare?.(dir);
  const config = { ...loadConfig({}), dataDir: dir, ...overrides };
  const backend = createBackend({ config, providers: {}, remoteAddress: c => c.req.header('x-test-peer') ?? '203.0.113.9' });
  const request = (path: string, init: { method?: string; body?: unknown; peer?: string } = {}) => {
    const headers: Record<string, string> = { host: 'dropit.lan:8787', origin: SITE };
    if (init.peer) headers['x-test-peer'] = init.peer;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return backend.app.request(`${SITE}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const enter = (code: string, pin?: string, peer?: string) => request('/api/rooms/enter', { method: 'POST', body: { code, ...(pin === undefined ? {} : { pin }) }, peer });
  const errorCode = async (response: Response) => (await response.json()).error.code as string;
  return { request, enter, errorCode, dir, async close() { await backend.close(); await rm(dir, { recursive: true, force: true }); } };
}

/** A database as step 3 left it (schema 15): a pre-step-3 room, step-3 rooms with a short link and a code, a private space. */
function stepThreeDatabase(dir: string, legacy: string) {
  const db = new Database(join(dir, 'dropit.sqlite'));
  for (let i = 1; i <= 15; i++) db.exec((migrations as Record<string, string>)[`migration${i}`]);
  assert.equal(db.pragma('user_version', { simple: true }), 15);
  const room = db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash,roomCode,pinHash) VALUES (?,?,NULL,?,?,?,?)');
  room.run('11111111-1111-4111-8111-111111111111', 'Temporary room', FUTURE, hash(legacy), null, null);
  room.run('22222222-2222-4222-8222-222222222222', 'Temporary room', FUTURE, hash('Ab3dEf'), 'k7Rm2', null);
  room.run('33333333-3333-4333-8333-333333333333', 'Temporary room', FUTURE, hash('Zz9yX8'), 'team', hashPasswordSync('4821'));
  room.run('44444444-4444-4444-8444-444444444444', 'Temporary room', 1, hash(token()), null, null);
  db.prepare("INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES ('p1','Private space',NULL,NULL,NULL)").run();
  db.close();
}

test('migration 16 gives every old room a unique code; old links keep working and lead to the code', async t => {
  const legacy = token();
  const f = await setup({ rateRoom: 100 }, dir => stepThreeDatabase(dir, legacy));
  t.after(() => f.close());
  const db = new Database(join(f.dir, 'dropit.sqlite'), { readonly: true });
  t.after(() => db.close());
  assert.equal(db.pragma('user_version', { simple: true }), 16);
  const codes = db.prepare('SELECT id, roomCode FROM spaces ORDER BY id').all() as { id: string; roomCode: string | null }[];
  const byId = new Map(codes.map(row => [row.id, row.roomCode]));
  // a room from before step 3 got a random 6-character code, even an expired one not cleaned up yet
  assert.match(byId.get('11111111-1111-4111-8111-111111111111')!, /^[^0O1Il]{6}$/);
  assert.match(byId.get('44444444-4444-4444-8444-444444444444')!, /^[^0O1Il]{6}$/);
  // step-3 rooms keep the code they had (it is what people typed), private spaces get none
  assert.equal(byId.get('22222222-2222-4222-8222-222222222222'), 'k7Rm2');
  assert.equal(byId.get('33333333-3333-4333-8333-333333333333'), 'team');
  assert.equal(byId.get('p1'), null);
  assert.equal(new Set(codes.map(row => row.roomCode).filter(Boolean)).size, 4);

  // the 43-character link still opens the room and tells the client the code to redirect to
  const code = byId.get('11111111-1111-4111-8111-111111111111')!;
  const info = await (await f.request(`/api/rooms/${legacy}`)).json();
  assert.equal(info.code, code);
  assert.equal(info.url, `${SITE}/r/${code}`);
  assert.equal((await f.request(`/api/rooms/${legacy}/items/text`, { method: 'POST', body: { text: 'old link' } })).status, 201);
  // ...and the new code opens the same room
  const entry = await (await f.enter(code)).json();
  assert.equal((await (await f.request(`/api/rooms/${entry.token}/items`)).json()).items[0].text, 'old link');

  // a step-3 short room link is accepted by enter and answers with the room's code
  const short = await f.enter('Ab3dEf');
  assert.equal(short.status, 200);
  assert.equal((await short.json()).code, 'k7Rm2');
  assert.equal((await f.enter('k7Rm2')).status, 200);
  // but it is no longer an API credential on its own
  assert.equal((await f.request('/api/rooms/Ab3dEf/items')).status, 404);
  // a step-3 room with a PIN now asks for it through its code AND its old link
  assert.equal(await f.errorCode(await f.enter('team')), 'PIN_REQUIRED');
  assert.equal(await f.errorCode(await f.enter('Zz9yX8')), 'PIN_REQUIRED');
  assert.equal((await f.enter('Zz9yX8', '4821')).status, 200);
});

test('migrateRoomCodes retries when a random code is already taken', () => {
  const db = new Database(':memory:');
  for (let i = 1; i <= 15; i++) db.exec((migrations as Record<string, string>)[`migration${i}`]);
  const room = db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash,roomCode) VALUES (?,?,NULL,?,?,?)');
  room.run('a', 'Temporary room', FUTURE, 'h1', 'AAAAAA');
  room.run('b', 'Temporary room', FUTURE, 'h2', null);
  const draws = ['AAAAAA', 'AAAAAA', 'BBBBBB'];
  assert.equal(migrateRoomCodes(db, () => draws.shift()!), 1);
  assert.equal((db.prepare("SELECT roomCode FROM spaces WHERE id='b'").get() as { roomCode: string }).roomCode, 'BBBBBB');
  assert.equal(migrateRoomCodes(db), 0);
  db.close();
});

test('a PIN guards opening the link of a random-code room; wrong PINs are rate limited with Retry-After', async t => {
  const f = await setup({ rateRoom: 100, rateAuth: 4 });
  t.after(() => f.close());
  const room = await (await f.request('/api/rooms', { method: 'POST', body: { pin: '1357' } })).json();
  assert.equal(room.hasPin, true);
  assert.equal(room.url, `${SITE}/r/${room.code}`);
  // the owner got a working access token straight away
  assert.equal((await f.request(`/api/rooms/${room.token}/items`)).status, 200);
  // anyone opening /r/<code> is asked for the PIN
  const asked = await f.enter(room.code);
  assert.equal(asked.status, 401);
  assert.equal(await f.errorCode(asked), 'PIN_REQUIRED');
  for (let i = 0; i < 4; i++) assert.equal((await f.enter(room.code, `000${i}`, '198.51.100.20')).status, 403);
  const blocked = await f.enter(room.code, '1357', '198.51.100.20');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // the code's own budget is spent too, so another IP cannot keep guessing it
  assert.equal((await f.enter(room.code, '1357', '198.51.100.21')).status, 429);
  // a room without PIN is entered by its code directly
  const open = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const entered = await f.enter(open.code, undefined, '198.51.100.22');
  assert.equal(entered.status, 200);
  assert.equal((await entered.json()).token, open.token);
});
