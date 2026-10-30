import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import Database from 'better-sqlite3';
import { readdir } from 'node:fs/promises';
import { SqliteRepository } from '../src/repository.js';

// RHEA-190 m50: space invites (read-only by default), members, admin 临时房间, migration 17.
const SITE = 'http://dropit.lan:8787';
const cookieFrom = (response: Response) => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

async function setup(overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-m50-'));
  let time = 1_800_000_000_000;
  const config = { ...loadConfig({}), dataDir: dir, ...overrides };
  const backend = createBackend({ config, providers: {}, now: () => time, remoteAddress: c => c.req.header('x-test-peer') ?? '203.0.113.9' });
  const request = (path: string, init: { method?: string; cookie?: string; body?: unknown; peer?: string } = {}) => {
    const headers: Record<string, string> = { host: 'dropit.lan:8787', origin: SITE };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.peer) headers['x-test-peer'] = init.peer;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return backend.app.request(`${SITE}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const errorCode = async (response: Response) => (await response.json()).error.code as string;
  const admin = async () => {
    const created = await request('/api/setup', { method: 'POST', body: { code: backend.setupCode(), email: 'owner@example.com', name: 'Owner', password: 'correct horse battery' } });
    assert.equal(created.status, 201);
    return cookieFrom(created);
  };
  const register = async (email: string, invite?: string) =>
    request('/api/auth/password/register', { method: 'POST', body: { email, password: 'member secret 1', ...(invite ? { invite } : {}) } });
  /** A member who joined through an admin space invite. */
  const member = async (adminCookie: string, email: string) => {
    const { spaces } = await (await request('/api/spaces', { cookie: adminCookie })).json();
    const invite = await (await request('/api/admin/invites', { method: 'POST', cookie: adminCookie, body: { spaceId: spaces[0].id, maxUses: 10 } })).json();
    const joined = await register(email, invite.token);
    assert.equal(joined.status, 201);
    return { cookie: cookieFrom(joined), user: (await joined.json()).user };
  };
  return { backend, request, errorCode, admin, register, member, advance(ms: number) { time += ms; },
    async close() { await backend.close(); await rm(dir, { recursive: true, force: true }); } };
}


const spaceOf = async (f: Awaited<ReturnType<typeof setup>>, cookie: string) =>
  (await (await f.request('/api/spaces', { cookie })).json()).spaces as { id: string; ownerId: string | null; role: string; ownerName: string | null }[];

test('space invites: read-only by default, owner-only management, limit, expiry, revoke and removal', async t => {
  const f = await setup({ rateInvite: 1000, rateUpload: 1000 });
  t.after(() => f.close());
  const admin = await f.admin();
  const alice = await f.member(admin, 'alice@example.com');
  const bob = await f.member(admin, 'bob@example.com');
  const aliceSpace = (await spaceOf(f, alice.cookie)).find(space => space.ownerId === alice.user.id)!;
  const adminSpace = (await spaceOf(f, alice.cookie)).find(space => space.ownerId !== alice.user.id)!;
  assert.equal(aliceSpace.role, 'owner');
  assert.equal(adminSpace.role, 'editor');
  // only the owner manages a space's invites and members
  assert.equal((await f.request(`/api/spaces/${adminSpace.id}/invites`, { method: 'POST', cookie: alice.cookie, body: {} })).status, 403);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/invites`, { cookie: bob.cookie })).status, 404);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/members`, { cookie: bob.cookie })).status, 404);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/invites`, { method: 'POST', body: {} })).status, 401);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/invites`, { method: 'POST', cookie: alice.cookie, body: { role: 'owner' } })).status, 400);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/invites`, { method: 'POST', cookie: alice.cookie, body: { maxUses: 101 } })).status, 400);

  const createdRes = await f.request(`/api/spaces/${aliceSpace.id}/invites`, { method: 'POST', cookie: alice.cookie, body: { maxUses: 2, expiresInHours: 2 } });
  assert.equal(createdRes.status, 201);
  const invite = await createdRes.json();
  assert.equal(invite.role, 'viewer');
  assert.equal(invite.maxUses, 2);
  assert.ok(!('tokenHash' in invite));
  assert.ok(invite.url.endsWith(`/invite/${invite.token}`));
  const preview = await (await f.request(`/api/invites/${invite.token}`)).json();
  assert.equal(preview.personal, false);
  assert.equal(preview.role, 'viewer');
  assert.equal(preview.inviterName, 'alice');
  assert.equal(preview.canRegister, false);
  // a user's space invite never opens registration
  const reg = await f.register('mallory@example.com', invite.token);
  assert.equal(reg.status, 403);
  assert.equal(await f.errorCode(reg), 'INVITE_NEEDS_ACCOUNT');

  await f.request(`/api/spaces/${aliceSpace.id}/items/text`, { method: 'POST', cookie: alice.cookie, body: { text: 'from alice' } });
  const accepted = await f.request(`/api/invites/${invite.token}/accept`, { method: 'POST', cookie: bob.cookie });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { spaceId: aliceSpace.id, role: 'viewer' });
  // accepting again is idempotent and does not spend a use
  assert.equal((await f.request(`/api/invites/${invite.token}/accept`, { method: 'POST', cookie: bob.cookie })).status, 200);
  const bobView = (await spaceOf(f, bob.cookie)).find(space => space.id === aliceSpace.id)!;
  assert.equal(bobView.role, 'viewer');
  assert.equal(bobView.ownerName, 'alice');
  // viewers read and copy, never write
  const items = await (await f.request(`/api/spaces/${aliceSpace.id}/items`, { cookie: bob.cookie })).json();
  assert.equal(items.items[0].text, 'from alice');
  for (const [method, path, body] of [
    ['POST', 'items/text', { text: 'nope' }], ['POST', 'groups', { name: 'g' }],
    ['DELETE', `items/${items.items[0].id}`, undefined], ['PATCH', `items/${items.items[0].id}/labels`, { pinned: true }],
    ['PATCH', `items/${items.items[0].id}`, { text: 'edit' }], ['POST', 'uploads', { filename: 'a.txt', size: 3, mime: 'text/plain' }], ['POST', `items/${items.items[0].id}/shares`, { expiresIn: '1d' }],
  ] as const) {
    const res = await f.request(`/api/spaces/${aliceSpace.id}/${path}`, { method, cookie: bob.cookie, body });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(await f.errorCode(res), 'READ_ONLY', `${method} ${path}`);
  }
  // the owner manages members
  const members = await (await f.request(`/api/spaces/${aliceSpace.id}/members`, { cookie: alice.cookie })).json();
  assert.deepEqual(members.members.map((m: { email: string; role: string }) => [m.email, m.role]), [['alice@example.com', 'owner'], ['bob@example.com', 'viewer']]);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/members/${alice.user.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 404);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/members/${bob.user.id}`, { method: 'PATCH', cookie: alice.cookie, body: { role: 'editor' } })).status, 200);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/items/text`, { method: 'POST', cookie: bob.cookie, body: { text: 'bob edits' } })).status, 201);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/members/${bob.user.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 204);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/items`, { cookie: bob.cookie })).status, 404);
  // the second use; then the invite is used up
  const carol = await f.member(admin, 'carol@example.com');
  const dave = await f.member(admin, 'dave@example.com');
  assert.equal((await f.request(`/api/invites/${invite.token}/accept`, { method: 'POST', cookie: carol.cookie })).status, 200);
  assert.equal((await f.request(`/api/invites/${invite.token}/accept`, { method: 'POST', cookie: dave.cookie })).status, 403);
  // a member can leave; the owner cannot
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/membership`, { method: 'DELETE', cookie: carol.cookie })).status, 204);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/membership`, { method: 'DELETE', cookie: alice.cookie })).status, 409);
  // signing in with an invite joins too (editor invite)
  const editorInvite = await (await f.request(`/api/spaces/${aliceSpace.id}/invites`, { method: 'POST', cookie: alice.cookie, body: { role: 'editor', expiresInHours: 1 } })).json();
  const login = await f.request('/api/auth/password/login', { method: 'POST', body: { email: 'dave@example.com', password: 'member secret 1', invite: editorInvite.token } });
  assert.equal(login.status, 200);
  assert.equal((await spaceOf(f, cookieFrom(login))).find(space => space.id === aliceSpace.id)?.role, 'editor');
  // revoke and expiry
  const revocable = await (await f.request(`/api/spaces/${aliceSpace.id}/invites`, { method: 'POST', cookie: alice.cookie, body: {} })).json();
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/invites/${revocable.id}`, { method: 'DELETE', cookie: bob.cookie })).status, 404);
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/invites/${revocable.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 204);
  assert.equal((await f.request(`/api/invites/${revocable.token}/accept`, { method: 'POST', cookie: bob.cookie })).status, 403);
  const shortLived = await (await f.request(`/api/spaces/${aliceSpace.id}/invites`, { method: 'POST', cookie: alice.cookie, body: { expiresInHours: 1 } })).json();
  const listed = await (await f.request(`/api/spaces/${aliceSpace.id}/invites`, { cookie: alice.cookie })).json();
  assert.equal(listed.limit, 5);
  assert.equal(listed.active, 1);
  assert.deepEqual(listed.invites.map((i: { status: string }) => i.status).sort(), ['open', 'used', 'used']);
  // admin users list: 空间邀请 column
  const users = await (await f.request('/api/admin/users', { cookie: admin })).json();
  const aliceRow = users.users.find((user: { email: string }) => user.email === 'alice@example.com');
  assert.equal(aliceRow.spaceInvitesEnabled, true);
  assert.equal(aliceRow.activeSpaceInvites, 1);
  f.advance(3600000 + 1000);
  assert.equal((await f.request(`/api/invites/${shortLived.token}/accept`, { method: 'POST', cookie: bob.cookie })).status, 403);
  assert.equal((await (await f.request('/api/admin/users', { cookie: admin })).json()).users.find((user: { email: string }) => user.email === 'alice@example.com').activeSpaceInvites, 0);
  // the admin's limit applies to open space invites; the switch turns them off
  await f.request(`/api/admin/users/${aliceRow.id}`, { method: 'PATCH', cookie: admin, body: { inviteLimit: 1 } });
  assert.equal((await f.request(`/api/spaces/${aliceSpace.id}/invites`, { method: 'POST', cookie: alice.cookie, body: {} })).status, 201);
  const over = await f.request(`/api/spaces/${aliceSpace.id}/invites`, { method: 'POST', cookie: alice.cookie, body: {} });
  assert.equal(await f.errorCode(over), 'INVITE_LIMIT_REACHED');
  await f.request('/api/admin/registration', { method: 'PUT', cookie: admin, body: { userInvites: { enabled: false } } });
  assert.equal(await f.errorCode(await f.request(`/api/spaces/${aliceSpace.id}/invites`, { method: 'POST', cookie: alice.cookie, body: {} })), 'INVITES_DISABLED');
  assert.equal((await (await f.request('/api/admin/users', { cookie: admin })).json()).users.find((user: { email: string }) => user.email === 'alice@example.com').spaceInvitesEnabled, false);
  // admins are not limited
  const adminSpace2 = (await spaceOf(f, admin))[0];
  assert.equal((await f.request(`/api/spaces/${adminSpace2.id}/invites`, { method: 'POST', cookie: admin, body: {} })).status, 201);
});

test('a registration invite made by someone who is no longer an admin stops working', async t => {
  const f = await setup({ rateInvite: 1000 });
  t.after(() => f.close());
  const admin = await f.admin();
  const erin = await f.member(admin, 'erin@example.com');
  assert.equal((await f.request(`/api/admin/users/${erin.user.id}`, { method: 'PATCH', cookie: admin, body: { role: 'admin' } })).status, 204);
  const invite = await (await f.request('/api/me/invites', { method: 'POST', cookie: erin.cookie, body: {} })).json();
  assert.equal((await f.request(`/api/invites/${invite.token}`)).status, 200);
  assert.equal((await f.request(`/api/admin/users/${erin.user.id}`, { method: 'PATCH', cookie: admin, body: { role: 'user' } })).status, 204);
  assert.equal((await f.request(`/api/invites/${invite.token}`)).status, 404);
  assert.equal((await f.register('frank@example.com', invite.token)).status, 403);
});

test('admin 临时房间: metadata only, close/reopen, unlock a PIN lockout, delete', async t => {
  const f = await setup({ rateRoom: 100, rateAuth: 200, pinLockFailures: 3 });
  t.after(() => f.close());
  const admin = await f.admin();
  const alice = await f.member(admin, 'alice@example.com');
  const anon = await (await f.request('/api/rooms', { method: 'POST', body: { pin: '2468' } })).json();
  const owned = await (await f.request('/api/rooms', { method: 'POST', cookie: alice.cookie })).json();
  assert.equal((await f.request(`/api/rooms/${anon.token}/items/text`, { method: 'POST', body: { text: 'top secret room text' } })).status, 201);
  assert.equal((await f.request('/api/admin/rooms', { cookie: alice.cookie })).status, 403);
  assert.equal((await f.request('/api/admin/rooms')).status, 401);
  const list = await f.request('/api/admin/rooms', { cookie: admin });
  assert.equal(list.status, 200);
  const raw = await list.text();
  assert.ok(!raw.includes('top secret'), 'room contents never reach the admin list');
  assert.ok(!raw.includes(anon.token.split('.')[1]), 'no access token');
  const rooms = JSON.parse(raw).rooms as Record<string, unknown>[];
  const a = rooms.find(room => room.code === anon.code)!;
  const o = rooms.find(room => room.code === owned.code)!;
  assert.equal(a.hasPin, true);
  assert.equal(a.itemCount, 1);
  assert.equal(a.owner, null);
  assert.equal(a.anonymous, true);
  assert.equal(o.owner, 'alice@example.com');
  assert.equal(o.hasPin, false);
  assert.equal(typeof a.createdAt, 'number');
  assert.equal(typeof a.lastActiveAt, 'number');
  assert.deepEqual(Object.keys(a).sort(), ['anonymous', 'bytes', 'closed', 'closedAt', 'code', 'createdAt', 'createdAtEstimated', 'expiresAt', 'hasPin', 'id', 'itemCount', 'lastActiveAt', 'lockedFor', 'owner']);
  // there is no admin route to a room's items
  assert.equal((await f.request(`/api/admin/rooms/${a.id}/items`, { cookie: admin })).status, 404);
  // PIN lockout: locked after 3 wrong PINs from different IPs; the admin clears it
  for (let i = 0; i < 3; i++) await f.request('/api/rooms/enter', { method: 'POST', body: { code: anon.code, pin: `999${i}` }, peer: `198.51.100.${i + 1}` });
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: anon.code, pin: '2468' }, peer: '198.51.100.50' })).status, 429);
  const locked = (await (await f.request('/api/admin/rooms', { cookie: admin })).json()).rooms.find((room: { id: string }) => room.id === a.id);
  assert.ok(locked.lockedFor > 0);
  assert.equal((await f.request(`/api/admin/rooms/${a.id}/unlock`, { method: 'POST', cookie: alice.cookie })).status, 403);
  assert.equal((await f.request(`/api/admin/rooms/${a.id}/unlock`, { method: 'POST', cookie: admin })).status, 204);
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: anon.code, pin: '2468' }, peer: '198.51.100.51' })).status, 200);
  // close: the code and every access token stop working; reopen brings them back
  assert.equal((await f.request(`/api/admin/rooms/${a.id}/close`, { method: 'POST', cookie: admin })).status, 204);
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: anon.code, pin: '2468' } })).status, 404);
  assert.equal((await f.request(`/api/rooms/${anon.token}/items`)).status, 404);
  assert.equal((await (await f.request('/api/admin/rooms', { cookie: admin })).json()).rooms.find((room: { id: string }) => room.id === a.id).closed, true);
  assert.equal((await f.request(`/api/admin/rooms/${a.id}/reopen`, { method: 'POST', cookie: admin })).status, 204);
  assert.equal((await f.request(`/api/rooms/${anon.token}/items`)).status, 200);
  // delete: gone with its items
  assert.equal((await f.request(`/api/admin/rooms/${a.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 403);
  assert.equal((await f.request(`/api/admin/rooms/${a.id}`, { method: 'DELETE', cookie: admin })).status, 204);
  assert.equal((await f.request(`/api/rooms/${anon.token}/items`)).status, 404);
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: anon.code, pin: '2468' } })).status, 404);
  const after = (await (await f.request('/api/admin/rooms', { cookie: admin })).json()).rooms as { id: string }[];
  assert.deepEqual(after.map(room => room.id), [o.id]);
  assert.equal((await f.request(`/api/admin/rooms/${a.id}`, { method: 'DELETE', cookie: admin })).status, 404);
});

test('migration 17 upgrades a schema-16 database in place: backup, members stay editors, rooms keep working', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-m50-mig-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'dropit.sqlite');
  const fresh = new SqliteRepository(path);
  fresh.close();
  // turn the fresh v17 database back into what production has today (v16)
  const db = new Database(path);
  for (const [table, column] of [['members', 'role'], ['invites', 'role'], ['spaces', 'createdAt'], ['spaces', 'lastActiveAt'], ['spaces', 'closedAt'], ['spaces', 'createdBy']]) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  db.exec(`INSERT INTO users (id,email,name,role,disabled,createdAt,pending) VALUES ('u1','a@example.com','A','admin',0,1,0),('u2','b@example.com','B','user',0,1,0);
    INSERT INTO spaces (id,name,ownerId,expiresAt) VALUES ('s1','Private space','u1',NULL);
    INSERT INTO spaces (id,name,ownerId,expiresAt,roomKey,roomCode) VALUES ('r1','Temporary room',NULL,9999999999999,'rk','Abc234');
    INSERT INTO members (spaceId,userId) VALUES ('s1','u1'),('s1','u2');
    INSERT INTO invites (id,tokenHash,spaceId,maxUses,uses,expiresAt,revoked,createdBy,joinSpace) VALUES ('i1','th','s1',5,0,9999999999999,0,'u1',1);
    PRAGMA user_version=16;`);
  db.close();
  const repo = new SqliteRepository(path);
  t.after(() => repo.close());
  assert.equal((await readdir(dir)).filter(name => name.includes('.pre-v16-') && name.endsWith('.bak')).length, 1);
  assert.equal(repo.memberRole('s1', 'u2'), 'editor');
  assert.equal(repo.memberRole('s1', 'u1'), 'owner');
  assert.equal(repo.invite('th', 1)?.role, null);
  assert.equal(repo.roomByCode('Abc234', 1)?.id, 'r1');
  assert.equal(repo.adminRooms(1)[0].createdAt, null);
  const check = new Database(path, { readonly: true });
  t.after(() => check.close());
  assert.equal(check.pragma('user_version', { simple: true }), 17);
  // opening it again is a no-op
  repo.close();
  const again = new SqliteRepository(path);
  again.close();
  assert.equal((await readdir(dir)).filter(name => name.endsWith('.bak')).length, 1);
});
