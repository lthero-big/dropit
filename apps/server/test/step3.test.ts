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

test('random room codes are 6 characters without look-alikes, the link is /r/<code> and share links are 6 characters', async t => {
  const f = await setup({ rateRoom: 100 });
  t.after(() => f.close());
  for (let i = 0; i < 200; i++) {
    const code = randomRoomCode();
    assert.equal(code.length, 6);
    for (const char of code) assert.ok(ROOM_CODE_ALPHABET.includes(char));
  }
  for (const bad of ['0', 'O', 'o', 'l', 'I', '1']) assert.ok(!ROOM_CODE_ALPHABET.includes(bad), bad);
  const room = await (await f.request('/api/rooms', { method: 'POST' })).json();
  // step 4: the client gets an access token for the room API, and ONE code that is also the link
  assert.match(room.token, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.match(room.code, /^[^0O1Il]{6}$/);
  assert.equal(room.hasPin, false);
  assert.equal(room.url, `${SITE}/r/${room.code}`);
  assert.equal((await f.request(`/api/rooms/${room.token}`)).status, 200);
  const info = await (await f.request(`/api/rooms/${room.token}`)).json();
  assert.equal(info.code, room.code);
  assert.equal(info.hasPin, false);
  assert.equal(info.url, room.url);
  // the code itself is not an API credential: it only works through /api/rooms/enter (PIN + rate limit)
  assert.equal((await f.request(`/api/rooms/${room.code}`)).status, 404);
  assert.equal((await f.request(`/api/rooms/${room.code}/items`)).status, 404);
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

test('custom codes: validation, taken codes are refused, a PIN works with random and custom codes', async t => {
  const f = await setup({ rateRoom: 100 });
  t.after(() => f.close());
  const post = (body: unknown) => f.request('/api/rooms', { method: 'POST', body });
  assert.equal(await f.errorCode(await post({ code: 'a b' })), 'INVALID_CODE');
  assert.equal(await f.errorCode(await post({ code: 'ab' })), 'INVALID_CODE');
  assert.equal(await f.errorCode(await post({ code: 'x'.repeat(33) })), 'INVALID_CODE');
  assert.equal(await f.errorCode(await post({ code: 'team-red', pin: '12' })), 'INVALID_PIN');
  const created = await post({ code: 'team-red', pin: '4821' });
  assert.equal(created.status, 201);
  const room = await created.json();
  assert.equal(room.code, 'team-red');
  assert.equal(room.hasPin, true);
  assert.equal(room.url, `${SITE}/r/team-red`);
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
  assert.equal(entry.token, room.token);
  assert.equal((await f.request(`/api/rooms/${entry.token}/items`)).status, 200);
  // the link is the code, so there is no way around the PIN
  assert.equal((await f.request('/api/rooms/team-red/items')).status, 404);
  // a PIN on a random code (step 3 needed a custom code for that)
  const randomWithPin = await post({ pin: '2468' });
  assert.equal(randomWithPin.status, 201);
  const second = await randomWithPin.json();
  assert.match(second.code, /^[^0O1Il]{6}$/);
  assert.equal(second.hasPin, true);
  assert.equal(await f.errorCode(await enter({ code: second.code })), 'PIN_REQUIRED');
  assert.equal((await enter({ code: second.code, pin: '2468' })).status, 200);
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

test('a browser changes the code and PIN of its own room separately; others cannot', async t => {
  const f = await setup({ rateRoom: 100 });
  t.after(() => f.close());
  const key = 'k'.repeat(43);
  const room = await (await f.request('/api/rooms', { method: 'POST', body: { deviceKey: key } })).json();
  const put = (body: Record<string, unknown>, token = room.token) => f.request(`/api/rooms/${token}/code`, { method: 'PUT', body: { deviceKey: key, ...body } });
  // RHEA-190 m50: a changed code is exactly 6 letters/digits
  for (const bad of ['my-room', 'abc', 'abcdefg', 'abc de', 'abc_de']) assert.equal(await f.errorCode(await put({ code: bad })), 'INVALID_CODE', bad);
  const set = await put({ code: 'MyRoom', pin: '7777' });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { code: 'MyRoom', hasPin: true, url: `${SITE}/r/MyRoom` });
  // the old code is gone, the new one asks for the PIN
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: room.code } })).status, 404);
  assert.equal(await f.errorCode(await f.request('/api/rooms/enter', { method: 'POST', body: { code: 'MyRoom' } })), 'PIN_REQUIRED');
  // case-sensitive
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: 'myroom' } })).status, 404);
  // the owner keeps its access token (not asked for the PIN), and so does whoever entered before
  assert.equal((await f.request(`/api/rooms/${room.token}/items`)).status, 200);
  const again = await (await f.request('/api/rooms', { method: 'POST', body: { deviceKey: key } })).json();
  assert.equal(again.token, room.token);
  assert.equal(again.code, 'MyRoom');
  assert.equal(again.hasPin, true);
  assert.equal((await f.request(`/api/rooms/${room.token}/code`, { method: 'PUT', body: { deviceKey: 'z'.repeat(43), code: 'Steal1' } })).status, 403);
  // a second browser cannot take the code
  const other = await (await f.request('/api/rooms', { method: 'POST', body: { deviceKey: 'o'.repeat(43) } })).json();
  const clash = await f.request(`/api/rooms/${other.token}/code`, { method: 'PUT', body: { deviceKey: 'o'.repeat(43), code: 'MyRoom' } });
  assert.equal(clash.status, 409);
  assert.equal(await f.errorCode(clash), 'CODE_TAKEN');
  // PIN only: clear it, the code stays
  assert.deepEqual(await (await put({ pin: null })).json(), { code: 'MyRoom', hasPin: false, url: `${SITE}/r/MyRoom` });
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: 'MyRoom' } })).status, 200);
  assert.equal((await put({ pin: '5555' })).status, 200);
  // code null: a fresh random code, the PIN stays
  const reset = await (await put({ code: null })).json();
  assert.match(reset.code, /^[^0O1Il]{6}$/);
  assert.equal(reset.hasPin, true);
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: 'MyRoom' } })).status, 404);
  assert.equal((await f.request('/api/rooms/enter', { method: 'POST', body: { code: reset.code, pin: '5555' } })).status, 200);
  // nothing to change
  assert.equal((await put({})).status, 400);
  // creating the room together with a code from a browser that already has one changes that room's code
  const viaPost = await f.request('/api/rooms', { method: 'POST', body: { deviceKey: key, code: 'third' } });
  assert.equal(viaPost.status, 200);
  const third = await viaPost.json();
  assert.equal(third.code, 'third');
  assert.equal(third.hasPin, true);
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

test('RHEA-190 m50: registration invites are admin-only; users invite into their space instead', async t => {
  const f = await setup({ rateInvite: 1000 });
  t.after(() => f.close());
  const admin = await f.admin();
  const alice = await f.member(admin, 'alice@example.com');
  // RHEA-192 m17: ordinary users cannot even list registration invites
  const view = await f.request('/api/me/invites', { cookie: alice.cookie });
  assert.equal(view.status, 403);
  assert.equal(await f.errorCode(view), 'INVITES_ADMIN_ONLY');
  assert.equal((await f.request('/api/me/invites')).status, 401);
  const refused = await f.request('/api/me/invites', { method: 'POST', cookie: alice.cookie, body: {} });
  assert.equal(refused.status, 403);
  assert.equal(await f.errorCode(refused), 'INVITES_ADMIN_ONLY');
  // admins still invite people to register; the invite is single use and bound to no space
  const created = await f.request('/api/me/invites', { method: 'POST', cookie: admin, body: {} });
  assert.equal(created.status, 201);
  const invite = await created.json();
  assert.ok(invite.url.endsWith(`/invite/${invite.token}`));
  assert.ok(!('tokenHash' in invite));
  const preview = await (await f.request(`/api/invites/${invite.token}`)).json();
  assert.equal(preview.personal, true);
  assert.equal(preview.spaceName, null);
  const joined = await f.register('bob@example.com', invite.token);
  assert.equal(joined.status, 201);
  const bobSpaces = await (await f.request('/api/spaces', { cookie: cookieFrom(joined) })).json();
  assert.equal(bobSpaces.spaces.length, 1);
  assert.equal(bobSpaces.spaces[0].role, 'owner');
  assert.equal((await f.register('carol@example.com', invite.token)).status, 403);
  const listed = await (await f.request('/api/me/invites', { cookie: admin })).json();
  assert.equal(listed.enabled, true);
  assert.equal(listed.invites[0].status, 'used');
  const open = await (await f.request('/api/me/invites', { method: 'POST', cookie: admin, body: {} })).json();
  assert.equal((await f.request(`/api/me/invites/${open.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 403);
  assert.equal((await f.request(`/api/me/invites/${open.id}`, { method: 'DELETE', cookie: admin })).status, 204);
  // the per-user limit stays admin controlled (it bounds open space invites; the default is 5)
  const users = await (await f.request('/api/admin/users', { cookie: admin })).json();
  const aliceRow = users.users.find((user: { email: string }) => user.email === 'alice@example.com');
  assert.equal(aliceRow.inviteLimit, null);
  assert.equal(aliceRow.inviteLimitEffective, 5);
  assert.equal((await f.request(`/api/admin/users/${aliceRow.id}`, { method: 'PATCH', cookie: alice.cookie, body: { inviteLimit: 50 } })).status, 403);
  assert.equal((await f.request(`/api/admin/users/${aliceRow.id}`, { method: 'PATCH', cookie: admin, body: { inviteLimit: -1 } })).status, 400);
  assert.equal((await f.request(`/api/admin/users/${aliceRow.id}`, { method: 'PATCH', cookie: admin, body: { inviteLimit: 8 } })).status, 204);
  // RHEA-192 m17: the site-wide 允许普通用户邀请 / 每人默认邀请上限 setting is gone
  assert.equal((await f.request('/api/admin/registration', { method: 'PUT', cookie: admin, body: { userInvites: { defaultLimit: 1 } } })).status, 400);
  assert.ok(!('userInvites' in await (await f.request('/api/admin/registration', { cookie: admin })).json()));
});

