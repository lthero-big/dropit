// RHEA-190 r4: 登录设备 — list browser sessions with readable names and sign
// out one device / all other devices, with owner and admin checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createBackend } from '../src/backend.js';
import { describeAgent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { hash, type Identity } from '../src/domain.js';
import { migration1, migration2, migration3, migration4, migration5, migration6, migration7, migration8, migration9, migration10 } from '../src/migrations.js';
import type { OAuthProvider } from '../src/oauth.js';
import { SqliteRepository } from '../src/repository.js';

const origin = 'http://localhost:3000';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const WIN_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
const cookieValue = (response: Response, name: string) => response.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(';')[0] ?? '';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-sessions-'));
  let time = Date.now();
  const identities = new Map<string, Identity>();
  const provider: OAuthProvider = {
    authorizationUrl: (state) => `https://mock.example/authorize?${new URLSearchParams({ state })}`,
    async exchange(code) { return identities.get(code)!; },
  };
  const config = { ...loadConfig({}), origin, dataDir: directory };
  const backend = createBackend({ config, providers: { github: provider }, now: () => time,
    remoteAddress: c => c.req.header('x-test-ip') ?? '127.0.0.1' });
  const request = (path: string, init: RequestInit = {}, cookie = '') => backend.app.request(path, {
    ...init, headers: { origin, ...(cookie ? { cookie } : {}), ...init.headers },
  });
  const login = async (subject: string, userAgent: string, ip = '203.0.113.7', invite?: string) => {
    const start = await request(`/api/auth/github${invite ? `?invite=${invite}` : ''}`, { headers: { 'user-agent': userAgent, 'x-test-ip': ip } });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    identities.set(subject, { provider: 'github', subject, email: `${subject}@example.com`, name: subject });
    const done = await request(`/api/auth/github/callback?${new URLSearchParams({ state, code: subject })}`,
      { headers: { 'user-agent': userAgent, 'x-test-ip': ip } }, cookieValue(start, 'dropit_oauth'));
    assert.equal(done.status, 302);
    const cookie = cookieValue(done, 'dropit_session');
    assert.ok(cookie, 'login sets a session cookie');
    return cookie;
  };
  const list = async (cookie: string, ip = '127.0.0.1') => {
    const response = await request('/api/sessions', { headers: { 'x-test-ip': ip } }, cookie);
    assert.equal(response.status, 200);
    return (await response.json() as { sessions: { id: string; current: boolean; online: boolean; browser: string; os: string; ipSummary: string | null; lastSeenAt: number | null; createdAt: number | null }[] }).sessions;
  };
  return { backend, request, login, list, advance: (ms: number) => { time += ms; }, async close() { await backend.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('describeAgent turns user agents into readable browser / OS names', () => {
  assert.deepEqual(describeAgent(MAC_CHROME), { browser: 'Chrome 131', os: 'macOS' });
  assert.deepEqual(describeAgent(IPHONE_SAFARI), { browser: 'Safari 18', os: 'iPhone' });
  assert.deepEqual(describeAgent(WIN_FIREFOX), { browser: 'Firefox 132', os: 'Windows' });
  assert.deepEqual(describeAgent(null), { browser: '未知浏览器', os: '未知系统' });
});

test('lists every browser login with a readable name, IP summary and current marker; never leaks hashes', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const mac = await f.login('owner', MAC_CHROME, '203.0.113.7');
  const phone = await f.login('owner', IPHONE_SAFARI, '198.51.100.20');
  const sessions = await f.list(mac, '203.0.113.7');
  assert.equal(sessions.length, 2);
  const current = sessions.find(s => s.current)!;
  assert.equal(current.browser, 'Chrome 131');
  assert.equal(current.os, 'macOS');
  assert.equal(current.ipSummary, '203.0.113.0/24');
  const other = sessions.find(s => !s.current)!;
  assert.equal(other.os, 'iPhone');
  assert.equal(other.ipSummary, '198.51.100.0/24');
  assert.ok(typeof other.lastSeenAt === 'number');
  const raw = JSON.stringify(await (await f.request('/api/sessions', {}, phone)).json());
  assert.doesNotMatch(raw, /sessionHash|userAgent/);
  assert.ok(!raw.includes(hash(mac.split('=')[1])), 'session hash must not be exposed');
});

test('last active is refreshed (throttled) on use', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const mac = await f.login('owner', MAC_CHROME);
  const first = (await f.list(mac))[0].lastSeenAt!;
  f.advance(10_000);
  assert.equal((await f.list(mac))[0].lastSeenAt, first, 'no write within the 60s throttle window');
  f.advance(61_000);
  assert.ok((await f.list(mac))[0].lastSeenAt! > first);
});

test('signing out one device kills only that session; signing out self clears the cookie', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const mac = await f.login('owner', MAC_CHROME);
  const phone = await f.login('owner', IPHONE_SAFARI);
  const target = (await f.list(mac)).find(s => !s.current)!;
  const removed = await f.request(`/api/sessions/${target.id}`, { method: 'DELETE' }, mac);
  assert.equal(removed.status, 204);
  assert.equal((await f.request('/api/me', {}, phone)).status, 401, 'the signed-out phone is logged out');
  assert.equal((await f.request('/api/me', {}, mac)).status, 200, 'the current device stays signed in');
  assert.equal((await f.request(`/api/sessions/${target.id}`, { method: 'DELETE' }, mac)).status, 404, 'already gone');
  const self = (await f.list(mac))[0];
  const bye = await f.request(`/api/sessions/${self.id}`, { method: 'DELETE' }, mac);
  assert.equal(bye.status, 204);
  assert.match(bye.headers.getSetCookie().join(';'), /dropit_session=;/);
  assert.equal((await f.request('/api/me', {}, mac)).status, 401);
});

test('log out all other devices keeps the current one', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const mac = await f.login('owner', MAC_CHROME);
  const phone = await f.login('owner', IPHONE_SAFARI);
  const win = await f.login('owner', WIN_FIREFOX);
  const response = await f.request('/api/sessions/revoke-others', { method: 'POST' }, mac);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: 2 });
  assert.equal((await f.request('/api/me', {}, phone)).status, 401);
  assert.equal((await f.request('/api/me', {}, win)).status, 401);
  assert.equal((await f.list(mac)).length, 1);
});

test('auth checks: anonymous, cross-user, cross-origin and bearer tokens cannot sign devices out', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const admin = await f.login('admin', MAC_CHROME);
  const { spaces } = await (await f.request('/api/spaces', {}, admin)).json() as { spaces: { id: string }[] };
  const invite = await (await f.request('/api/admin/invites', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spaceId: spaces[0].id, maxUses: 1, expiresInHours: 1 }) }, admin)).json() as { url: string };
  const member = await f.login('member', IPHONE_SAFARI, '198.51.100.1', new URL(invite.url).pathname.split('/').pop());
  const adminSession = (await f.list(admin))[0];
  const memberSession = (await f.list(member))[0];
  assert.equal((await f.request('/api/sessions')).status, 401);
  assert.equal((await f.request(`/api/sessions/${adminSession.id}`, { method: 'DELETE' })).status, 401);
  // a member cannot see or touch the admin's sessions
  assert.equal((await f.request(`/api/sessions/${adminSession.id}`, { method: 'DELETE' }, member)).status, 404);
  assert.equal((await f.request('/api/me', {}, admin)).status, 200);
  assert.equal((await f.request(`/api/admin/users/${adminSession.id}/sessions`, {}, member)).status, 403);
  assert.equal((await f.request(`/api/admin/sessions/${adminSession.id}`, { method: 'DELETE' }, member)).status, 403);
  // CSRF: a foreign origin is rejected before anything is deleted
  const foreign = await f.backend.app.request(`/api/sessions/${memberSession.id}`, { method: 'DELETE', headers: { origin: 'https://evil.example', cookie: member } });
  assert.equal(foreign.status, 403);
  assert.equal((await f.request('/api/me', {}, member)).status, 200);
  // a bearer token may not manage browser sessions
  const created = await (await f.request('/api/tokens', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cli', scopes: ['read', 'write'] }) }, member)).json() as { token: string };
  const bearer = await f.backend.app.request(`/api/sessions/${memberSession.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${created.token}` } });
  assert.equal(bearer.status, 403);
  assert.equal((await f.backend.app.request('/api/sessions', { headers: { authorization: `Bearer ${created.token}` } })).status, 403);
  assert.equal((await f.request('/api/me', {}, member)).status, 200);
});

test('admins can list and sign out a user\'s individual devices', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const admin = await f.login('admin', MAC_CHROME);
  const { spaces } = await (await f.request('/api/spaces', {}, admin)).json() as { spaces: { id: string }[] };
  const invite = await (await f.request('/api/admin/invites', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spaceId: spaces[0].id, maxUses: 1, expiresInHours: 1 }) }, admin)).json() as { url: string };
  const memberPhone = await f.login('member', IPHONE_SAFARI, '198.51.100.1', new URL(invite.url).pathname.split('/').pop());
  const memberPc = await f.login('member', WIN_FIREFOX, '198.51.100.2');
  const { users } = await (await f.request('/api/admin/users', {}, admin)).json() as { users: { id: string; email: string }[] };
  const memberId = users.find(u => u.email === 'member@example.com')!.id;
  const listed = await (await f.request(`/api/admin/users/${memberId}/sessions`, {}, admin)).json() as { sessions: { id: string; os: string; current: boolean }[] };
  assert.equal(listed.sessions.length, 2);
  assert.ok(listed.sessions.every(s => !s.current));
  const phone = listed.sessions.find(s => s.os === 'iPhone')!;
  assert.equal((await f.request(`/api/admin/sessions/${phone.id}`, { method: 'DELETE' }, admin)).status, 204);
  assert.equal((await f.request('/api/me', {}, memberPhone)).status, 401);
  assert.equal((await f.request('/api/me', {}, memberPc)).status, 200);
  assert.equal((await f.request('/api/admin/users/nope/sessions', {}, admin)).status, 404);
});

test('migration 11 gives pre-existing sessions an id and keeps them valid', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-m11-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'dropit.sqlite');
  const db = new Database(path);
  for (const migration of [migration1, migration2, migration3, migration4, migration5, migration6, migration7, migration8, migration9, migration10]) db.exec(migration);
  db.prepare("INSERT INTO users (id,email,name,role,disabled,createdAt) VALUES ('u1','a@example.com','a','admin',0,1)").run();
  db.prepare("INSERT INTO sessions (sessionHash,userId,expiresAt) VALUES ('h1','u1',9999999999999)").run();
  db.close();
  const repo = new SqliteRepository(path);
  t.after(() => repo.close());
  const session = repo.session('h1', 1);
  assert.equal(session?.user.id, 'u1');
  assert.match(session?.sessionId ?? '', /^[0-9a-f]{32}$/);
  const [row] = repo.browserSessions('u1', 1);
  assert.equal(row.id, session?.sessionId);
  assert.equal(row.userAgent, null);
  assert.equal(repo.revokeSession(row.id, 'u1'), 'h1');
  assert.equal(repo.session('h1', 1), undefined);
});
