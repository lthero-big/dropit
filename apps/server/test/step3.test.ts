import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { ROOM_CODE_ALPHABET, randomRoomCode } from '../src/domain.js';

// RHEA-190 auth step 3: short link tokens, room codes with optional PIN, and personal invites.
const SITE = 'http://dropit.lan:8787';
const cookieFrom = (response: Response) => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

async function setup(overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-step3-'));
  let time = Date.now();
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

test('random room codes are 5 characters without look-alikes and room / share links are 6 characters', async t => {
  const f = await setup({ rateRoom: 100 });
  t.after(() => f.close());
  for (let i = 0; i < 200; i++) {
    const code = randomRoomCode();
    assert.equal(code.length, 5);
    for (const char of code) assert.ok(ROOM_CODE_ALPHABET.includes(char));
  }
  for (const bad of ['0', 'O', 'l', 'I', '1']) assert.ok(!ROOM_CODE_ALPHABET.includes(bad), bad);
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  assert.match(room.token, /^[A-Za-z0-9]{6}$/);
  assert.match(room.code, /^[^0O1Il]{5}$/);
  assert.equal(room.hasPin, false);
  assert.ok(room.url.endsWith(`/r/${room.token}`));
  // the room link is case-sensitive
  const swapped = room.token.replace(/[a-z]/i, (c: string) => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  assert.equal((await f.request(`/api/rooms/${room.token}`)).status, 200);
  if (swapped !== room.token) assert.equal((await f.request(`/api/rooms/${swapped}`)).status, 404);
  assert.equal((await f.request(`/api/rooms/${room.token}`)).status, 200);
  const info = await (await f.request(`/api/rooms/${room.token}`)).json();
  assert.equal(info.code, room.code);
  assert.equal(info.hasPin, false);
});

test('entering a room by its random code works, is case-sensitive and does not show the PIN state wrongly', async t => {
  const f = await setup({ rateRoom: 100 });
  t.after(() => f.close());
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const entered = await f.request('/api/rooms/enter', { method: 'POST', body: { code: room.code } });
  assert.equal(entered.status, 200);
  const entry = await entered.json();
  assert.equal(entry.code, room.code);
  // the entry token reaches the same room as the link: items written through one show through the other
  const written = await f.request(`/api/rooms/${entry.token}/items/text`, { method: 'POST', body: { text: 'via code' } });
  assert.equal(written.status, 201);
  const items = await (await f.request(`/api/rooms/${room.token}/items`)).json();
  assert.equal(items.items.length, 1);
  // a forged entry token with the right space id is refused
  const forged = `${entry.token.split('.')[0]}.${'A'.repeat(43)}`;
  assert.equal((await f.request(`/api/rooms/${forged}/items`)).status, 404);
  // case matters
  const wrongCase = room.code === room.code.toLowerCase() ? room.code.toUpperCase() : room.code.toLowerCase();
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: wrongCase } })).status, 404);
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: '' } })).status, 400);
});

test('custom codes: validation, taken codes are refused, PIN needs a custom code and is checked on entry', async t => {
  const f = await setup({ rateRoom: 100 });
  t.after(() => f.close());
  const post = (body: unknown) => f.request('/api/rooms', { method: 'POST', body });
  assert.equal(await f.errorCode(await post({ code: 'a b' })), 'INVALID_CODE');
  assert.equal(await f.errorCode(await post({ code: 'ab' })), 'INVALID_CODE');
  assert.equal(await f.errorCode(await post({ pin: '1234' })), 'PIN_NEEDS_CODE');
  assert.equal(await f.errorCode(await post({ code: 'team-red', pin: '12' })), 'INVALID_PIN');
  const created = await post({ code: 'team-red', pin: '4821' });
  assert.equal(created.status, 201);
  const room = await created.json();
  assert.equal(room.code, 'team-red');
  assert.equal(room.hasPin, true);
  assert.ok(!JSON.stringify(room).includes('4821'));
  // taken, even with other letter case being a different code
  const taken = await post({ code: 'team-red' });
  assert.equal(taken.status, 409);
  assert.equal(await f.errorCode(taken), 'CODE_TAKEN');
  assert.equal((await post({ code: 'Team-red' })).status, 201);
  // PIN: required, wrong, correct
  const enter = (body: unknown, peer?: string) => f.request('/api/rooms/enter', { method: 'POST', body, peer });
  const missing = await enter({ code: 'team-red' });
  assert.equal(missing.status, 401);
  assert.equal(await f.errorCode(missing), 'PIN_REQUIRED');
  const wrong = await enter({ code: 'team-red', pin: '0000' });
  assert.equal(wrong.status, 403);
  assert.equal(await f.errorCode(wrong), 'PIN_INVALID');
  const right = await enter({ code: 'team-red', pin: '4821' });
  assert.equal(right.status, 200);
  const entry = await right.json();
  assert.equal((await f.request(`/api/rooms/${entry.token}/items`)).status, 200);
  // the room link itself still opens the room without the PIN
  assert.equal((await f.request(`/api/rooms/${room.token}/items`)).status, 200);
});

test('wrong codes and PINs are rate limited per IP, other IPs are unaffected', async t => {
  const f = await setup({ rateRoom: 100, rateAuth: 5 });
  t.after(() => f.close());
  await f.request('/api/rooms', { method: 'POST', body: { code: 'locked', pin: '9999' } });
  const enter = (code: string, pin: string | undefined, peer: string) => f.request('/api/rooms/enter', { method: 'POST', body: { code, pin }, peer });
  for (let i = 0; i < 5; i++) assert.equal((await enter('locked', `000${i}`, '198.51.100.7')).status, 403);
  const blocked = await enter('locked', '9999', '198.51.100.7');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // the same wrong-code budget covers unknown codes from that IP
  assert.equal((await enter('nope-nope', undefined, '198.51.100.7')).status, 429);
  // the wrong PINs also used up that code's own budget, so even another IP cannot keep guessing it
  assert.equal((await enter('locked', '9999', '198.51.100.8')).status, 429);
  // ...while a different IP is not blocked for other codes
  assert.equal((await enter('nope-nope', undefined, '198.51.100.8')).status, 404);
  // unknown codes: only misses are charged, successful entries are not
  const g = await setup({ rateRoom: 100, rateAuth: 3 });
  t.after(() => g.close());
  const room = await (await g.request('/api/rooms', { method: 'POST' })).json();
  for (let i = 0; i < 10; i++) assert.equal((await g.request('/api/rooms/enter', { method: 'POST', body: { code: room.code } })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await g.request('/api/rooms/enter', { method: 'POST', body: { code: `miss${i}` } })).status, 404);
  assert.equal((await g.request('/api/rooms/enter', { method: 'POST', body: { code: room.code } })).status, 429);
});

test('a browser changes the code and PIN of its own room; others cannot', async t => {
  const f = await setup({ rateRoom: 100 });
  t.after(() => f.close());
  const key = 'k'.repeat(43);
  const room = await (await f.request('/api/rooms', { method: 'POST', body: { deviceKey: key } })).json();
  const set = await f.request(`/api/rooms/${room.token}/code`, { method: 'PUT', body: { deviceKey: key, code: 'my-room', pin: '7777' } });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { code: 'my-room', hasPin: true });
  // reopening from the same browser returns the room with its new code
  const again = await (await f.request('/api/rooms', { method: 'POST', body: { deviceKey: key } })).json();
  assert.equal(again.token, room.token);
  assert.equal(again.code, 'my-room');
  assert.equal(again.hasPin, true);
  assert.equal((await f.request(`/api/rooms/${room.token}/code`, { method: 'PUT', body: { deviceKey: 'z'.repeat(43), code: 'steal' } })).status, 403);
  // a second browser cannot take the code
  const other = await (await f.request('/api/rooms', { method: 'POST', body: { deviceKey: 'o'.repeat(43) } })).json();
  const clash = await f.request(`/api/rooms/${other.token}/code`, { method: 'PUT', body: { deviceKey: 'o'.repeat(43), code: 'my-room' } });
  assert.equal(await f.errorCode(clash), 'CODE_TAKEN');
  // dropping the code gives a fresh random one and removes the PIN
  const reset = await (await f.request(`/api/rooms/${room.token}/code`, { method: 'PUT', body: { deviceKey: key } })).json();
  assert.match(reset.code, /^[^0O1Il]{5}$/);
  assert.equal(reset.hasPin, false);
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: 'my-room' } })).status, 404);
  // creating the room together with a code from a browser that already has one changes that room's code
  const viaPost = await f.request('/api/rooms', { method: 'POST', body: { deviceKey: key, code: 'third' } });
  assert.equal(viaPost.status, 200);
  assert.equal((await viaPost.json()).code, 'third');
});

test('a custom code is free again once its room expires', async t => {
  const f = await setup({ rateRoom: 100 });
  t.after(() => f.close());
  assert.equal((await f.request('/api/rooms', { method: 'POST', body: { code: 'short-lived' } })).status, 201);
  assert.equal((await f.request('/api/rooms', { method: 'POST', body: { code: 'short-lived' } })).status, 409);
  f.advance(loadConfig({}).roomRetentionMs + 1000);
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: 'short-lived' } })).status, 404);
  assert.equal((await f.request('/api/rooms', { method: 'POST', body: { code: 'short-lived' } })).status, 201);
});

test('share links are 6 characters and unknown links of either length are 404', async t => {
  const f = await setup({ rateRoom: 100 });
  t.after(() => f.close());
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  const item = await (await f.request(`/api/rooms/${room.token}/items/text`, { method: 'POST', body: { text: 'hello' } })).json();
  const share = await (await f.request(`/api/rooms/${room.token}/items/${item.item.id}/shares`, { method: 'POST', body: { expiresIn: '1d', maxViews: 5 } })).json();
  assert.match(share.token, /^[A-Za-z0-9]{6}$/);
  assert.ok(share.url.endsWith(`/s/${share.token}`));
  assert.equal((await f.request(`/api/s/${share.token}`)).status, 200);
  assert.equal((await f.request(`/api/s/${'a'.repeat(43)}`)).status, 404);
  assert.equal((await f.request('/api/s/abcdef')).status, 404);
  assert.equal((await f.request('/api/s/abcde')).status, 404);
});

test('personal invites: members invite up to the default of 5, admins edit the switch, default and per-user limit', async t => {
  const f = await setup({ rateInvite: 1000 });
  t.after(() => f.close());
  const admin = await f.admin();
  const alice = await f.member(admin, 'alice@example.com');
  const view = await (await f.request('/api/me/invites', { cookie: alice.cookie })).json();
  assert.equal(view.enabled, true);
  assert.equal(view.limit, 5);
  assert.equal(view.used, 0);
  assert.equal((await f.request('/api/me/invites')).status, 401);
  const tokens: string[] = [];
  for (let i = 0; i < 5; i++) {
    const created = await f.request('/api/me/invites', { method: 'POST', cookie: alice.cookie, body: {} });
    assert.equal(created.status, 201);
    const invite = await created.json();
    assert.ok(invite.url.endsWith(`/invite/${invite.token}`));
    assert.ok(!('tokenHash' in invite));
    tokens.push(invite.token);
  }
  const over = await f.request('/api/me/invites', { method: 'POST', cookie: alice.cookie, body: {} });
  assert.equal(over.status, 403);
  assert.equal(await f.errorCode(over), 'INVITE_LIMIT_REACHED');
  const listed = await (await f.request('/api/me/invites', { cookie: alice.cookie })).json();
  assert.equal(listed.used, 5);
  assert.equal(listed.remaining, 0);
  assert.equal(listed.invites.length, 5);
  assert.ok(listed.invites.every((invite: { status: string }) => invite.status === 'open'));
  // the invitee sees a personal invite and registers; the invite is spent and bound to no space
  const preview = await (await f.request(`/api/invites/${tokens[0]}`)).json();
  assert.equal(preview.personal, true);
  assert.equal(preview.spaceName, null);
  const joined = await f.register('bob@example.com', tokens[0]);
  assert.equal(joined.status, 201);
  const bobCookie = cookieFrom(joined);
  const bobSpaces = await (await f.request('/api/spaces', { cookie: bobCookie })).json();
  assert.equal(bobSpaces.spaces.length, 1);
  assert.equal((await f.register('carol@example.com', tokens[0])).status, 403);
  const after = await (await f.request('/api/me/invites', { cookie: alice.cookie })).json();
  assert.equal(after.invites.find((invite: { uses: number }) => invite.uses === 1).status, 'used');
  // a used invite counts against the limit even though it is spent
  assert.equal((await f.request('/api/me/invites', { method: 'POST', cookie: alice.cookie, body: {} })).status, 403);
  // revoking an open invite frees the slot; a used one cannot be revoked
  const open = after.invites.find((invite: { status: string }) => invite.status === 'open');
  const used = after.invites.find((invite: { status: string }) => invite.status === 'used');
  assert.equal((await f.request(`/api/me/invites/${used.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 409);
  assert.equal((await f.request(`/api/me/invites/${open.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 204);
  assert.equal((await f.request(`/api/me/invites/${open.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 404);
  assert.equal((await f.request('/api/me/invites', { method: 'POST', cookie: alice.cookie, body: {} })).status, 201);
  // another user cannot revoke Alice's invites
  assert.equal((await f.request(`/api/me/invites/${after.invites.find((invite: { status: string }) => invite.status === 'open').id}`, { method: 'DELETE', cookie: bobCookie })).status, 404);

  // admins see and revoke every invite
  const all = await (await f.request('/api/admin/invites', { cookie: admin })).json();
  const personal = all.invites.filter((invite: { joinSpace: number }) => invite.joinSpace === 0);
  assert.equal(personal.length, 6);
  assert.ok(personal.every((invite: { createdByEmail: string }) => invite.createdByEmail === 'alice@example.com'));
  assert.deepEqual([...new Set(personal.map((invite: { status: string }) => invite.status))].sort(), ['open', 'revoked', 'used']);
  const toRevoke = personal.find((invite: { status: string }) => invite.status === 'open');
  assert.equal((await f.request(`/api/admin/invites/${toRevoke.id}`, { method: 'DELETE', cookie: admin })).status, 204);

  // per-user limit and the default are admin controlled
  const users = await (await f.request('/api/admin/users', { cookie: admin })).json();
  const aliceRow = users.users.find((user: { email: string }) => user.email === 'alice@example.com');
  assert.equal(aliceRow.inviteLimit, null);
  assert.equal(aliceRow.inviteLimitEffective, 5);
  assert.equal(aliceRow.invitesUsed, 4);
  assert.equal((await f.request(`/api/admin/users/${aliceRow.id}`, { method: 'PATCH', cookie: alice.cookie, body: { inviteLimit: 50 } })).status, 403);
  assert.equal((await f.request(`/api/admin/users/${aliceRow.id}`, { method: 'PATCH', cookie: admin, body: { inviteLimit: -1 } })).status, 400);
  assert.equal((await f.request(`/api/admin/users/${aliceRow.id}`, { method: 'PATCH', cookie: admin, body: { inviteLimit: 8 } })).status, 204);
  assert.equal((await (await f.request('/api/me/invites', { cookie: alice.cookie })).json()).limit, 8);
  assert.equal((await f.request('/api/me/invites', { method: 'POST', cookie: alice.cookie, body: {} })).status, 201);
  assert.equal((await f.request(`/api/admin/users/${aliceRow.id}`, { method: 'PATCH', cookie: admin, body: { inviteLimit: null } })).status, 204);
  const registration = await f.request('/api/admin/registration', { method: 'PUT', cookie: admin, body: { userInvites: { defaultLimit: 1 } } });
  assert.deepEqual((await registration.json()).userInvites, { enabled: true, defaultLimit: 1 });
  assert.equal((await (await f.request('/api/me/invites', { cookie: alice.cookie })).json()).limit, 1);
  const off = await f.request('/api/admin/registration', { method: 'PUT', cookie: admin, body: { userInvites: { enabled: false } } });
  assert.equal((await off.json()).userInvites.enabled, false);
  const disabled = await f.request('/api/me/invites', { method: 'POST', cookie: alice.cookie, body: {} });
  assert.equal(await f.errorCode(disabled), 'INVITES_DISABLED');
  assert.equal((await f.request('/api/admin/registration', { method: 'PUT', cookie: admin, body: { userInvites: { defaultLimit: 'x' } } })).status, 400);
  // admins are never blocked by the switch or the limit
  assert.equal((await f.request('/api/me/invites', { method: 'POST', cookie: admin, body: {} })).status, 201);
});

