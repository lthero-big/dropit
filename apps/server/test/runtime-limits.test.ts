import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { hash, token } from '../src/domain.js';
import { limitRanges, validateLimits, type LimitAudit } from '../src/limits.js';
import { migration1, migration2, migration3, migration4, migration5, migration6 } from '../src/migrations.js';
import { RateLimiter } from '../src/rate-limit.js';
import { SqliteRepository } from '../src/repository.js';

const origin = 'http://localhost:3000';
async function fixture(overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-limits-'));
  const config = { ...loadConfig({}), dataDir: directory, origin, ...overrides };
  let time = Date.now();
  const build = (defaults: Config) => createBackend({ config: defaults, now: () => time, remoteAddress: () => '127.0.0.1',
    providers: { mock: {
      authorizationUrl(state) { return `https://mock.example/?state=${state}`; },
      async exchange() { return { provider: 'mock', subject: 'admin', email: 'admin@example.com', name: 'admin' }; },
    } },
  });
  let backend = build(config);
  function login(subject: string) {
    const raw = token();
    if (backend.repo.users().length) backend.repo.provisionUser({ email: `${subject}@example.com`, name: subject, role: 'user', quotaBytes: null, now: time });
    const user = backend.repo.login({ provider: 'mock', subject, email: `${subject}@example.com`, name: subject },
      null, [], hash(raw), time + config.sessionMs, time);
    return { user, cookie: `dropit_session=${raw}`, space: backend.repo.spaces(user.id)[0]! };
  }
  const admin = login('admin');
  const member = login('member');
  const request = (path: string, method = 'GET', body?: unknown, cookie = admin.cookie, headers: Record<string, string> = {}) =>
    backend.app.request(path, { method, headers: { origin, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const patch = (body: unknown, cookie = admin.cookie) => request('/api/admin/limits', 'PATCH', body, cookie);
  const upload = (base: string, bytes: string) => backend.app.request(`${base}/items/file`, {
    method: 'POST', headers: { origin, cookie: admin.cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'test.bin' }, body: bytes,
  });
  return {
    get backend() { return backend; }, config, directory, admin, member, request, patch, upload,
    time: () => time, advance(ms: number) { time += ms; },
    async restart(defaults: Partial<Config> = {}) {
      await backend.close();
      backend = build({ ...config, ...defaults });
    },
    async dispose() { await backend.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
async function ok(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test('AC-O1/O3/O5: overrides and audits survive backend recreation; reset follows the current environment default', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const before = await ok(await f.request('/api/admin/limits'));
  assert.equal(Object.keys(before).length, 15);
  assert.deepEqual(before.maxTextBytes, { value: 65536, default: 65536, overridden: false, min: 1, max: 1048576 });
  assert.equal('origin' in before, false);
  const saved = await ok(await f.patch({ maxTextBytes: 100, maxItems: 12 }));
  assert.equal(saved.maxTextBytes.value, 100);
  assert.equal(saved.maxTextBytes.overridden, true);
  assert.equal(f.config.maxTextBytes, 65536, 'caller-owned defaults are not mutated');
  await f.restart({ maxTextBytes: 200 });
  const restarted = await ok(await f.request('/api/admin/limits'));
  assert.deepEqual(restarted.maxTextBytes, { ...before.maxTextBytes, value: 100, default: 200, overridden: true });
  assert.equal(restarted.maxItems.value, 12);
  const reset = await ok(await f.patch({ maxTextBytes: null }));
  assert.equal(reset.maxTextBytes.value, 200);
  assert.equal(reset.maxTextBytes.overridden, false);
  const audit = await ok(await f.request('/api/admin/limits/audit')) as { entries: LimitAudit[] };
  assert.equal(audit.entries.length, 3);
  assert.deepEqual(audit.entries[0], {
    id: 3, actorId: f.admin.user.id, actorEmail: f.admin.user.email, createdAt: f.time(),
    key: 'maxTextBytes', oldValue: 100, newValue: 200, oldOverride: 100, newOverride: null,
  });
  await f.restart({ maxTextBytes: 300 });
  assert.equal((await ok(await f.request('/api/admin/limits'))).maxTextBytes.value, 300);
  assert.equal((await ok(await f.request('/api/admin/limits'))).maxItems.value, 12);
});

test('AC-O3: all keys reject bad types/ranges; cross-field and reset failures are atomic', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const before = await ok(await f.request('/api/admin/limits'));
  for (const [key, { max }] of Object.entries(limitRanges)) {
    for (const value of [0, -1, 1.5, '2', true, [], {}, max + 1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await f.patch({ maxItems: 10, [key]: value })).status, 400, `${key}=${JSON.stringify(value)}`);
    }
  }
  for (const body of [
    {}, [], null, { SESSION_SECRET: 'secret' }, { origin: 'http://evil.example' }, { rateToken: 200 },
    { roomMaxFileBytes: before.maxFileBytes.value }, { roomQuotaBytes: before.userQuotaBytes.value },
    { retentionMs: 1000 }, { rateGeneral: 20 }, { rateUpload: 10 },
    JSON.parse('{"__proto__":1}'),
  ]) assert.equal((await f.patch(body)).status, 400);
  assert.deepEqual(await ok(await f.request('/api/admin/limits')), before);
  assert.deepEqual((await ok(await f.request('/api/admin/limits/audit'))).entries, []);
  await ok(await f.patch({ maxFileBytes: 100 * 1024 ** 2, roomMaxFileBytes: 50 * 1024 ** 2 }));
  assert.equal((await f.patch({ maxFileBytes: null, maxItems: 10 })).status, 400);
  const after = await ok(await f.request('/api/admin/limits'));
  assert.equal(after.maxFileBytes.value, 100 * 1024 ** 2);
  assert.equal(after.maxItems.overridden, false);
});

test('AC-O3: admin role, CSRF and Bearer scopes protect writes and audit reads', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  for (const path of ['/api/admin/limits', '/api/admin/limits/audit']) {
    assert.equal((await f.request(path, 'GET', undefined, '')).status, 401);
    assert.equal((await f.request(path, 'GET', undefined, f.member.cookie)).status, 403);
  }
  assert.equal((await f.patch({ maxItems: 10 }, f.member.cookie)).status, 403);
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { maxItems: 10 }, f.admin.cookie, { origin: 'http://evil.example' })).status, 403);
  const read = await ok(await f.request('/api/tokens', 'POST', { name: 'Read only', scopes: ['read'] }), 201);
  const headers = { authorization: `Bearer ${read.token}` };
  assert.equal((await f.request('/api/admin/limits', 'GET', undefined, '', headers)).status, 200);
  assert.equal((await f.request('/api/admin/limits/audit', 'GET', undefined, '', headers)).status, 200);
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { maxItems: 10 }, f.admin.cookie, headers)).status, 403);
  const writer = await ok(await f.request('/api/tokens', 'POST', { name: 'Writer' }), 201);
  await ok(await f.request('/api/admin/limits', 'PATCH', { maxItems: 10 }, '', { authorization: `Bearer ${writer.token}` }));
  f.backend.repo.updateUser(f.member.user.id, { role: 'admin' });
  f.backend.repo.updateUser(f.admin.user.id, { role: 'user' });
  assert.equal((await f.patch({ maxItems: 11 })).status, 403);
  assert.equal((await f.request('/api/admin/limits/audit', 'GET', undefined, '', headers)).status, 403);
});

test('AC-O4: text/file/item limits apply immediately while existing content and expiry remain intact', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const base = `/api/spaces/${f.admin.space.id}`;
  const old = (await ok(await f.request(`${base}/items/text`, 'POST', { text: 'old text' }), 201)).item;
  const file = (await ok(await f.upload(base, '123456'), 201)).item;
  await ok(await f.patch({ maxTextBytes: 5, maxFileBytes: 5, roomMaxFileBytes: 4, maxItems: 2, retentionMs: 2000, roomRetentionMs: 1000 }));
  assert.equal((await f.request(`${base}/items/text`, 'POST', { text: '123456' })).status, 413);
  assert.equal((await f.upload(base, '123456')).status, 413);
  assert.equal((await f.request(`${base}/items/text`, 'POST', { text: 'x' })).status, 413);
  assert.equal((await f.request(`${base}/items/${file.id}/download`)).status, 200);
  assert.equal(f.backend.repo.item(old.id, f.time())?.expiresAt, old.expiresAt);
  await ok(await f.patch({ maxItems: 3 }));
  const fresh = (await ok(await f.request(`${base}/items/text`, 'POST', { text: 'new' }), 201)).item;
  assert.equal(fresh.expiresAt, f.time() + 2000);
  f.advance(2001);
  await f.backend.service.cleanup();
  assert.equal(f.backend.repo.item(fresh.id, f.time()), undefined);
  assert.equal(f.backend.repo.items(f.admin.space.id, f.time()).length, 2);
});

test('AC-O4: changing the default quota respects user overrides and allows shrinking over-quota content', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const base = `/api/spaces/${f.admin.space.id}`;
  const old = (await ok(await f.request(`${base}/items/text`, 'POST', { text: '1234567890' }), 201)).item;
  f.backend.repo.updateUser(f.member.user.id, { quotaBytes: 50 });
  await ok(await f.patch({ userQuotaBytes: 8, roomQuotaBytes: 7 }));
  assert.equal((await ok(await f.request('/api/me'))).quotaBytes, 8);
  assert.equal((await ok(await f.request('/api/me', 'GET', undefined, f.member.cookie))).quotaBytes, 50);
  assert.equal((await f.request(`${base}/items/text`, 'POST', { text: 'x' })).status, 413);
  assert.equal(f.backend.repo.item(old.id, f.time())?.text, '1234567890');
  await ok(await f.request(`${base}/items/${old.id}`, 'PATCH', { text: '123456789' }));
  await ok(await f.request(`${base}/items/${old.id}`, 'PATCH', { text: '12345' }));
  await ok(await f.request(`${base}/items/text`, 'POST', { text: '123' }), 201);
});

test('AC-O2/O4: room file/quota limits apply to existing rooms; lifetime changes only affect new rooms', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const old = await ok(await f.request('/api/rooms', 'POST', {}), 201);
  await ok(await f.patch({ maxFileBytes: 8, roomMaxFileBytes: 4, userQuotaBytes: 16, roomQuotaBytes: 8, roomRetentionMs: 1000 }));
  const fresh = await ok(await f.request('/api/rooms', 'POST', {}), 201);
  assert.equal(fresh.expiresAt, f.time() + 1000);
  const base = `/api/rooms/${old.token}`;
  assert.equal((await ok(await f.request(base))).expiresAt, old.expiresAt);
  assert.equal((await f.upload(base, '12345')).status, 413);
  await ok(await f.upload(base, '1234'), 201);
  assert.equal((await f.request(`${base}/items/text`, 'POST', { text: '12345' })).status, 413);
  await ok(await f.patch({ roomQuotaBytes: 10 }));
  await ok(await f.request(`${base}/items/text`, 'POST', { text: '12345' }), 201);
  f.advance(1001);
  assert.equal((await f.request(`/api/rooms/${fresh.token}`)).status, 404);
  assert.equal((await f.request(base)).status, 200);
});

test('AC-O4: changing rate thresholds/window keeps live counters and uses the new duration after rollover', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const path = `/api/spaces/${f.admin.space.id}/items/text`;
  await ok(await f.request(path, 'POST', { text: 'one' }), 201);
  await ok(await f.patch({ rateUpload: 2, rateRoom: 1, rateWindowMs: 1000 }));
  await ok(await f.request(path, 'POST', { text: 'two' }), 201);
  assert.equal((await f.request(path, 'POST', { text: 'three' })).status, 429);
  f.advance(1001);
  const stillLimited = await f.request(path, 'POST', { text: 'four' });
  assert.equal(stillLimited.status, 429);
  assert.equal(stillLimited.headers.get('retry-after'), '59');
  f.advance(59000);
  await ok(await f.request(path, 'POST', { text: 'five' }), 201);
  await ok(await f.request(path, 'POST', { text: 'six' }), 201);
  assert.equal((await f.request(path, 'POST', { text: 'seven' })).status, 429);
  f.advance(1000);
  await ok(await f.request(path, 'POST', { text: 'eight' }), 201);
});

test('AC-O2: general, auth, invite and room thresholds update their existing IP/account buckets', async t => {
  await t.test('general', async t => {
    const f = await fixture(); t.after(() => f.dispose());
    await ok(await f.patch({ rateGeneral: 4, rateAuth: 1, rateInvite: 1, rateUpload: 3, rateRoom: 1 }));
    for (let i = 0; i < 3; i++) await ok(await f.request('/api/me'));
    assert.equal((await f.request('/api/me')).status, 429);
  });
  await t.test('auth', async t => {
    const f = await fixture(); t.after(() => f.dispose());
    assert.equal((await f.request('/api/auth/mock')).status, 302);
    await ok(await f.patch({ rateAuth: 1 }));
    assert.equal((await f.request('/api/auth/mock')).status, 429);
  });
  await t.test('invite', async t => {
    const f = await fixture(); t.after(() => f.dispose());
    const body = { spaceId: f.admin.space.id };
    await ok(await f.request('/api/admin/invites', 'POST', body), 201);
    await ok(await f.patch({ rateInvite: 1 }));
    assert.equal((await f.request('/api/admin/invites', 'POST', body)).status, 429);
  });
  await t.test('room', async t => {
    const f = await fixture(); t.after(() => f.dispose());
    await ok(await f.request('/api/rooms', 'POST', {}), 201);
    await ok(await f.patch({ rateRoom: 1 }));
    assert.equal((await f.request('/api/rooms', 'POST', {})).status, 429);
  });
});

test('AC-O2: session duration updates only new OAuth sessions', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  await ok(await f.patch({ sessionMs: 1000 }));
  const backend = f.backend;
  const flow = await backend.app.request('/api/auth/mock');
  const state = new URL(flow.headers.get('location')!).searchParams.get('state')!;
  const browser = flow.headers.getSetCookie()[0].split(';')[0];
  const login = await backend.app.request(`/api/auth/mock/callback?state=${state}&code=admin`, { headers: { cookie: browser } });
  assert.equal(login.status, 302);
  const sessionCookie = login.headers.getSetCookie().find(cookie => cookie.startsWith('dropit_session='))!;
  assert.match(sessionCookie, /Max-Age=1(?:;|$)/);
  const cookie = sessionCookie.split(';')[0];
  f.advance(1001);
  assert.equal((await backend.app.request('/api/me', { headers: { cookie } })).status, 401);
  assert.equal((await f.request('/api/me')).status, 200);
});

test('AC-O5: audit cursors are stable, record override-only changes, and skip no-ops', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  await ok(await f.patch({ maxItems: f.config.maxItems }));
  await ok(await f.patch({ maxItems: f.config.maxItems }));
  await ok(await f.patch({ maxItems: 20, maxTextBytes: 30 }));
  const first = await ok(await f.request('/api/admin/limits/audit?limit=2'));
  assert.equal(first.entries.length, 2);
  assert.equal(first.nextCursor, 2);
  await ok(await f.patch({ maxItems: null }));
  const second = await ok(await f.request(`/api/admin/limits/audit?limit=2&cursor=${first.nextCursor}`));
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].id, 1);
  assert.equal(second.entries[0].oldValue, second.entries[0].newValue);
  assert.equal(second.entries[0].oldOverride, null);
  assert.equal(second.entries[0].newOverride, f.config.maxItems);
  assert.equal(second.nextCursor, null);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=', 'cursor=-1', 'cursor=abc', 'cursor=1e2']) {
    assert.equal((await f.request(`/api/admin/limits/audit?${query}`)).status, 400);
  }
});

test('AC-O1/O5: audit failure rolls back all override writes and leaves effective settings unchanged', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const db = new Database(join(f.directory, 'dropit.sqlite')); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON limit_audit WHEN NEW.key='maxItems' BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
  assert.equal((await f.patch({ maxTextBytes: 12, maxItems: 13 })).status, 500);
  assert.deepEqual(f.backend.repo.limitOverrides(), {});
  assert.deepEqual(f.backend.repo.limitAudit(10), []);
  assert.equal((await ok(await f.request('/api/admin/limits'))).maxTextBytes.value, f.config.maxTextBytes);
});

test('AC-O1: schema v6 migrates without losing user/session/item data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-limit-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'dropit.sqlite');
  const db = new Database(path);
  for (const migration of [migration1, migration2, migration3, migration4, migration5, migration6]) db.exec(migration);
  db.exec(`INSERT INTO users (id,email,name,role,createdAt) VALUES ('u','a@example.com','A','admin',1);
    INSERT INTO spaces (id,name,ownerId) VALUES ('s','Private','u');
    INSERT INTO sessions VALUES ('session','u',9999999999999);
    INSERT INTO items (id,spaceId,userId,kind,text,size,storedBytes,createdAt,updatedAt,expiresAt)
      VALUES ('i','s','u','text','saved',5,5,1,1,9999999999999);`);
  db.close();
  const repo = new SqliteRepository(path); t.after(() => repo.close());
  assert.equal(repo.session('session', Date.now())?.user.id, 'u');
  assert.equal(repo.item('i', Date.now())?.text, 'saved');
  assert.deepEqual(repo.limitOverrides(), {});
  assert.deepEqual(repo.limitAudit(10), []);
});

test('limit policy enforces code ceilings for defaults and JSON-unrepresentable values', () => {
  const defaults = loadConfig({});
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => validateLimits({ ...defaults, maxItems: value }));
  for (const env of [{ MAX_FILE_BYTES: String(1024 ** 3 + 1) }, { USER_QUOTA_BYTES: String(100 * 1024 ** 3 + 1) }, { RETENTION_HOURS: '8761' }]) {
    assert.throws(() => loadConfig(env));
  }
});

test('rate window changes preserve long-lived buckets, counts and per-key isolation', () => {
  const limiter = new RateLimiter(1000);
  assert.equal(limiter.consume('a', 2, 0), undefined);
  limiter.setWindow(10000);
  assert.equal(limiter.consume('a', 1, 1), 1);
  assert.equal(limiter.consume('b', 1, 1), undefined);
  limiter.setWindow(100);
  assert.equal(limiter.consume('b', 1, 1001), 9);
  assert.equal(limiter.consume('a', 1, 1001), undefined);
  assert.equal(limiter.consume('a', 1, 1101), undefined);
});
