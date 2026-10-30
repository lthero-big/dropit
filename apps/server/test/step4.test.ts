import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { hash, token } from '../src/domain.js';
import * as migrations from '../src/migrations.js';
import { isAppRoute } from '../src/origin.js';
import { migrateRoomCodes } from '../src/repository.js';
import { hashPasswordSync } from '../src/password.js';
import { deviceRoomHash } from '../src/service.js';

// RHEA-190 auth step 4: one code per room (the link is /r/<code>), optional PIN that also guards the link,
// and migration 16, which gives every room a 6-character code and removes the old long room links for good.
const SITE = 'http://dropit.lan:8787';
const FUTURE = 9_999_999_999_999;
const RANDOM_CODE = /^[23456789A-HJ-NP-Za-km-np-z]{6}$/;

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

const migrate = (db: Database.Database, upTo: number) => {
  for (let i = 1; i <= upTo; i++) db.exec((migrations as Record<string, string>)[`migration${i}`]);
  assert.equal(db.pragma('user_version', { simple: true }), upTo);
};
const OLD_ROOM = '11111111-1111-4111-8111-111111111111';
const OLD_EXPIRED = '44444444-4444-4444-8444-444444444444';
const DEVICE_KEY = 'd'.repeat(43);

/** A database as production (main, schema 14) has it: rooms with a 43-character link, a user with a private space. */
function mainDatabase(dir: string, legacy: string) {
  const db = new Database(join(dir, 'dropit.sqlite'));
  migrate(db, 14);
  db.prepare("INSERT INTO users (id,email,name,role,disabled,createdAt) VALUES ('u','a@example.com','A','user',0,1)").run();
  db.prepare("INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES ('p1','Private space','u',NULL,NULL)").run();
  db.prepare("INSERT INTO members (spaceId,userId) VALUES ('p1','u')").run();
  const room = db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash,deviceHash) VALUES (?,?,NULL,?,?,?)');
  room.run(OLD_ROOM, 'Temporary room', FUTURE, hash(legacy), deviceRoomHash(DEVICE_KEY));
  room.run(OLD_EXPIRED, 'Temporary room', 1, hash(token()), null);
  const item = db.prepare(`INSERT INTO items (id,spaceId,userId,kind,text,size,storedBytes,createdAt,expiresAt,updatedAt)
    VALUES (?,?,?,'text',?,?,?,1,?,1)`);
  item.run('i-room', OLD_ROOM, null, 'room text', 9, 9, FUTURE);
  item.run('i-private', 'p1', 'u', 'mine', 4, 4, FUTURE);
  db.close();
}

test('migration 16 from production schema 14: backup first, a 6-character code per room, old long links are gone', async t => {
  const legacy = token();
  const f = await setup({ rateRoom: 100 }, dir => mainDatabase(dir, legacy));
  t.after(() => f.close());
  // the untouched schema-14 file was copied next to the database before migrating
  const backups = (await readdir(f.dir)).filter(name => /^dropit\.sqlite\.pre-v14-.+\.bak$/.test(name));
  assert.equal(backups.length, 1);
  const backup = new Database(join(f.dir, backups[0]), { readonly: true });
  assert.equal(backup.pragma('user_version', { simple: true }), 14);
  assert.equal((backup.prepare('SELECT roomHash FROM spaces WHERE id=?').get(OLD_ROOM) as { roomHash: string }).roomHash, hash(legacy));
  backup.close();

  const db = new Database(join(f.dir, 'dropit.sqlite'), { readonly: true });
  t.after(() => db.close());
  assert.equal(db.pragma('user_version', { simple: true }), 17);
  const columns = (db.prepare('PRAGMA table_info(spaces)').all() as { name: string }[]).map(c => c.name);
  assert.equal(columns.includes('roomHash'), false);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const rows = db.prepare('SELECT id, roomCode, roomKey FROM spaces ORDER BY id').all() as { id: string; roomCode: string | null; roomKey: string | null }[];
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.match(byId.get(OLD_ROOM)!.roomCode!, RANDOM_CODE);
  assert.match(byId.get(OLD_EXPIRED)!.roomCode!, RANDOM_CODE);
  assert.notEqual(byId.get(OLD_ROOM)!.roomCode, byId.get(OLD_EXPIRED)!.roomCode);
  assert.equal(byId.get('p1')!.roomCode, null);
  assert.equal(byId.get('p1')!.roomKey, null);
  // nothing derived from the old link survives
  assert.equal(rows.some(row => row.roomKey === hash(legacy)), false);
  // members and items of the rebuilt table are intact
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, 2);

  // the old 43-character link: not an API token, not a code, no page
  assert.equal((await f.request(`/api/rooms/${legacy}`)).status, 404);
  assert.equal((await f.request(`/api/rooms/${legacy}/items`)).status, 404);
  assert.equal((await f.enter(legacy)).status, 404);
  assert.equal(isAppRoute(`/rooms/${legacy}`), false);
  // the room itself lives on behind its new code, with its content
  const code = byId.get(OLD_ROOM)!.roomCode!;
  const entered = await f.enter(code);
  assert.equal(entered.status, 200);
  const entry = await entered.json();
  assert.equal(entry.url, `${SITE}/r/${code}`);
  assert.equal((await (await f.request(`/api/rooms/${entry.token}/items`)).json()).items[0].text, 'room text');
  // and the browser that owned it gets it back (with the new code) from its room key
  const mine = await f.request('/api/rooms', { method: 'POST', body: { deviceKey: DEVICE_KEY } });
  assert.equal(mine.status, 200);
  const reused = await mine.json();
  assert.equal(reused.reused, true);
  assert.equal(reused.code, code);
  assert.equal(reused.token, entry.token);
});

/** A database as the unmerged step 3 left it (schema 15): a random 5-character code, a custom code with a PIN, a 6-character link. */
function stepThreeDatabase(dir: string) {
  const db = new Database(join(dir, 'dropit.sqlite'));
  migrate(db, 15);
  const room = db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash,roomCode,pinHash) VALUES (?,?,NULL,?,?,?,?)');
  room.run('22222222-2222-4222-8222-222222222222', 'Temporary room', FUTURE, hash('Ab3dEf'), 'k7Rm2', null);
  room.run('33333333-3333-4333-8333-333333333333', 'Temporary room', FUTURE, hash('Zz9yX8'), 'team', hashPasswordSync('4821'));
  db.close();
}

test('migration 16 from step-3 schema 15: random 5-character codes are replaced, a custom code keeps its PIN, step-3 links are gone', async t => {
  const f = await setup({ rateRoom: 100 }, stepThreeDatabase);
  t.after(() => f.close());
  assert.equal((await readdir(f.dir)).filter(name => name.includes('.pre-v15-')).length, 1);
  const db = new Database(join(f.dir, 'dropit.sqlite'), { readonly: true });
  t.after(() => db.close());
  const code = (id: string) => (db.prepare('SELECT roomCode FROM spaces WHERE id=?').get(id) as { roomCode: string }).roomCode;
  assert.match(code('22222222-2222-4222-8222-222222222222'), RANDOM_CODE);
  assert.equal(code('33333333-3333-4333-8333-333333333333'), 'team');
  assert.equal((await f.enter('k7Rm2')).status, 404);
  assert.equal((await f.enter('Ab3dEf')).status, 404);
  assert.equal((await f.enter('Zz9yX8')).status, 404);
  assert.equal(await f.errorCode(await f.enter('team')), 'PIN_REQUIRED');
  assert.equal((await f.enter('team', '4821')).status, 200);
  assert.equal((await f.enter(code('22222222-2222-4222-8222-222222222222'))).status, 200);
});

test('a fresh database is created at schema 17 without a backup and without roomHash', async t => {
  const f = await setup();
  t.after(() => f.close());
  assert.deepEqual((await readdir(f.dir)).filter(name => name.endsWith('.bak')), []);
  const db = new Database(join(f.dir, 'dropit.sqlite'), { readonly: true });
  t.after(() => db.close());
  assert.equal(db.pragma('user_version', { simple: true }), 17);
  assert.equal((db.prepare('PRAGMA table_info(spaces)').all() as { name: string }[]).some(c => c.name === 'roomHash'), false);
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  assert.match(room.code, RANDOM_CODE);
});

test('migrateRoomCodes retries when a random code is already taken', () => {
  const db = new Database(':memory:');
  migrate(db, 15);
  db.exec(migrations.migration16);
  const room = db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomKey,roomCode) VALUES (?,?,NULL,?,?,?)');
  room.run('a', 'Temporary room', FUTURE, 'k1', 'AAAAAA');
  room.run('b', 'Temporary room', FUTURE, 'k2', null);
  const draws = ['AAAAAA', 'AAAAAA', 'BBBBBB'];
  assert.equal(migrateRoomCodes(db, () => draws.shift()!), 1);
  assert.equal((db.prepare("SELECT roomCode FROM spaces WHERE id='b'").get() as { roomCode: string }).roomCode, 'BBBBBB');
  assert.equal(migrateRoomCodes(db), 0);
  db.close();
});

test('only the web app routes are app pages; old /rooms/ links are not', () => {
  for (const path of ['/', '/login', '/setup', '/change-password', '/join', '/admin', '/settings', '/device', '/invite/x', '/r/Ab3dEf', '/s/Ab3dEf'])
    assert.equal(isAppRoute(path), true, path);
  for (const path of ['/rooms/x', `/rooms/${'A'.repeat(43)}`, '/r', '/r/a/b', '/nope']) assert.equal(isAppRoute(path), false, path);
});

test('changing the code / PIN has its own rate limit, separate from creating rooms', async t => {
  const f = await setup({ rateRoom: 2 });
  t.after(() => f.close());
  const key = 'q'.repeat(43);
  const room = await (await f.request('/api/rooms', { method: 'POST', body: { deviceKey: key } })).json();
  // two more creations spend the creation budget
  for (let i = 0; i < 1; i++) assert.equal((await f.request('/api/rooms', { method: 'POST' })).status, 201);
  assert.equal((await f.request('/api/rooms', { method: 'POST' })).status, 429);
  // the owner can still change the code
  const put = () => f.request(`/api/rooms/${room.token}/code`, { method: 'PUT', body: { deviceKey: key, code: null } });
  assert.equal((await put()).status, 200);
  assert.equal((await put()).status, 200);
  assert.equal((await put()).status, 429);
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
