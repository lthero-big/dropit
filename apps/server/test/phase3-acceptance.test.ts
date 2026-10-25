// Independent phase-3 acceptance probes for runtime limits.
// These talk to the HTTP API and a reopened SQLite file, rather than
// replaying the implementers' own assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { hash, token } from '../src/domain.js';

const origin = 'http://localhost:3000';
const editable = [
  'maxFileBytes', 'maxTextBytes', 'maxItems', 'userQuotaBytes', 'retentionMs',
  'roomQuotaBytes', 'roomMaxFileBytes', 'roomRetentionMs', 'rateWindowMs',
  'rateGeneral', 'rateAuth', 'rateInvite', 'rateUpload', 'rateRoom', 'sessionMs',
] as const;

type Limits = Record<string, { value: number; default: number; overridden: boolean; min: number; max: number }>;
type Audit = {
  id: number; actorId: string; actorEmail: string; createdAt: number; key: string;
  oldValue: number; newValue: number; oldOverride: number | null; newOverride: number | null;
};

async function fixture(overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-p3-'));
  let time = Date.parse('2026-10-25T00:00:00Z');
  const providers = {
    mock: {
      authorizationUrl(state: string) { return `https://mock.example/authorize?state=${state}`; },
      async exchange() { return { provider: 'mock', subject: 'admin', email: 'admin@example.com', name: 'admin' }; },
    },
  };
  const build = (defaults: Config) => createBackend({
    config: defaults,
    now: () => time,
    remoteAddress: () => '127.0.0.1',
    providers,
  });
  let backend = build({ ...loadConfig({}), origin, dataDir: directory, ...overrides });
  function login(subject: string, quotaBytes: number | null = null) {
    const raw = token();
    if (backend.repo.users().length) {
      backend.repo.provisionUser({ email: `${subject}@example.com`, name: subject, role: 'user', quotaBytes, now: time });
    }
    const user = backend.repo.login(
      { provider: 'mock', subject, email: `${subject}@example.com`, name: subject },
      null, [], hash(raw), time + 86_400_000, time,
    );
    return { user, cookie: `dropit_session=${raw}`, space: backend.repo.spaces(user.id)[0]! };
  }
  const admin = login('admin');
  const member = login('member', 50);
  const request = (path: string, method = 'GET', body?: unknown, cookie = admin.cookie, headers: Record<string, string> = {}) =>
    backend.app.request(path, {
      method,
      headers: {
        origin,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    get backend() { return backend; },
    directory, admin, member, request,
    time: () => time,
    advance(ms: number) { time += ms; },
    async restart(defaults: Partial<Config> = {}) {
      await backend.close();
      backend = build({ ...loadConfig({}), origin, dataDir: directory, ...overrides, ...defaults });
    },
    async dispose() { await backend.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function bodyOf(response: Response) {
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : null;
}

async function codeOf(response: Response) {
  const body = await bodyOf(response.clone()) as { error?: { code?: string } } | null;
  return body?.error?.code ?? '';
}

test('AC-O1: an override outranks the environment and is still there after the process reopens the database', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const before = await bodyOf(await f.request('/api/admin/limits')) as Limits;
  assert.equal(Object.keys(before).length, 15);
  assert.equal(before.maxTextBytes.overridden, false);
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { maxTextBytes: 100, maxItems: 12 })).status, 200);
  await f.restart({ maxTextBytes: 200 });
  const restarted = await bodyOf(await f.request('/api/admin/limits')) as Limits;
  assert.equal(restarted.maxTextBytes.value, 100);
  assert.equal(restarted.maxTextBytes.default, 200);
  assert.equal(restarted.maxTextBytes.overridden, true);
  assert.equal(restarted.maxItems.value, 12);
  assert.equal(restarted.maxItems.default, before.maxItems.default);
  const reset = await bodyOf(await f.request('/api/admin/limits', 'PATCH', { maxTextBytes: null })) as Limits;
  assert.equal(reset.maxTextBytes.value, 200);
  assert.equal(reset.maxTextBytes.overridden, false);
  assert.equal(reset.maxItems.value, 12);
  await f.restart({ maxTextBytes: 300 });
  const after = await bodyOf(await f.request('/api/admin/limits')) as Limits;
  assert.equal(after.maxTextBytes.value, 300);
  assert.equal(after.maxTextBytes.overridden, false);
  assert.equal(after.maxItems.value, 12);
});

test('AC-O2: all fifteen limits apply on the next request, and startup-only settings stay out of the API', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const patch = {
    maxFileBytes: 10_000_000,
    maxTextBytes: 1000,
    maxItems: 50,
    userQuotaBytes: 50_000_000,
    retentionMs: 2 * 86_400_000,
    roomQuotaBytes: 1_000_000,
    roomMaxFileBytes: 100_000,
    roomRetentionMs: 3_600_000,
    rateWindowMs: 1000,
    rateGeneral: 100,
    rateAuth: 5,
    rateInvite: 4,
    rateUpload: 20,
    rateRoom: 1,
    sessionMs: 1000,
  };
  const saved = await bodyOf(await f.request('/api/admin/limits', 'PATCH', patch)) as Limits;
  for (const key of editable) {
    assert.equal(saved[key].value, patch[key], key);
    assert.equal(saved[key].overridden, true, key);
  }
  assert.equal('origin' in saved, false);
  assert.equal('rateToken' in saved, false);
  const me = await bodyOf(await f.request('/api/me')) as { maxFileBytes: number; maxTextBytes: number; retentionMs: number; quotaBytes: number };
  assert.equal(me.maxFileBytes, patch.maxFileBytes);
  assert.equal(me.maxTextBytes, patch.maxTextBytes);
  assert.equal(me.retentionMs, patch.retentionMs);
  assert.equal(me.quotaBytes, patch.userQuotaBytes);
  const room = await f.request('/api/rooms', 'POST', {});
  assert.equal(room.status, 201);
  const limited = await f.request('/api/rooms', 'POST', {});
  assert.equal(limited.status, 429);
  assert.equal(await codeOf(limited), 'RATE_LIMITED');
  for (const body of [
    { SESSION_SECRET: 'secret' },
    { APP_ORIGIN: 'http://evil.example' },
    { TRUST_PROXY: '10.0.0.0/8' },
    { DATA_DIR: '/tmp/elsewhere' },
    { rateToken: 1 },
    { GITHUB_CLIENT_SECRET: 'nope' },
  ]) {
    assert.equal((await f.request('/api/admin/limits', 'PATCH', body)).status, 400, JSON.stringify(body));
  }
  const unchanged = await bodyOf(await f.request('/api/admin/limits')) as Limits;
  assert.equal(unchanged.maxItems.value, patch.maxItems);
});

test('AC-O3: a bad field rejects the whole patch, and non-admins plus read-only tokens cannot write', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const before = await bodyOf(await f.request('/api/admin/limits')) as Limits;
  for (const body of [
    {},
    { maxItems: 0 },
    { maxItems: -1 },
    { maxItems: 1.5 },
    { maxItems: '12' },
    { maxItems: true },
    { maxTextBytes: before.maxTextBytes.max + 1 },
    { roomMaxFileBytes: before.maxFileBytes.value },
    { roomQuotaBytes: before.userQuotaBytes.value },
    { retentionMs: 1000, maxItems: 10 },
    { rateGeneral: 20, maxItems: 10 },
    { maxItems: 10, origin: 'http://evil.example' },
  ]) {
    const response = await f.request('/api/admin/limits', 'PATCH', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(await codeOf(response), 'INVALID_LIMITS');
  }
  assert.deepEqual(await bodyOf(await f.request('/api/admin/limits')), before);
  assert.deepEqual((await bodyOf(await f.request('/api/admin/limits/audit')) as { entries: Audit[] }).entries, []);

  assert.equal((await f.request('/api/admin/limits', 'GET', undefined, '')).status, 401);
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { maxItems: 10 }, '')).status, 401);
  assert.equal((await f.request('/api/admin/limits', 'GET', undefined, f.member.cookie)).status, 403);
  assert.equal((await f.request('/api/admin/limits/audit', 'GET', undefined, f.member.cookie)).status, 403);
  assert.equal(await codeOf(await f.request('/api/admin/limits', 'PATCH', { maxItems: 10 }, f.member.cookie)), 'FORBIDDEN');
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { maxItems: 10 }, f.admin.cookie, { origin: 'https://evil.example' })).status, 403);

  const read = await bodyOf(await f.request('/api/tokens', 'POST', { name: 'Read only', scopes: ['read'] })) as { token: string };
  const readHeaders = { authorization: `Bearer ${read.token}`, cookie: '' };
  assert.equal((await f.request('/api/admin/limits', 'GET', undefined, '', readHeaders)).status, 200);
  assert.equal((await f.request('/api/admin/limits/audit', 'GET', undefined, '', readHeaders)).status, 200);
  const denied = await f.request('/api/admin/limits', 'PATCH', { maxItems: 10 }, f.admin.cookie, readHeaders);
  assert.equal(denied.status, 403);
  assert.equal(await codeOf(denied), 'INSUFFICIENT_SCOPE');

  const writer = await bodyOf(await f.request('/api/tokens', 'POST', { name: 'Writer', scopes: ['write'] })) as { token: string };
  const written = await f.request('/api/admin/limits', 'PATCH', { maxItems: 10 }, '', { authorization: `Bearer ${writer.token}`, cookie: '' });
  assert.equal(written.status, 200);
  assert.equal((await bodyOf(written) as Limits).maxItems.value, 10);
  const current = await bodyOf(await f.request('/api/admin/limits')) as Limits;
  assert.equal(current.maxItems.value, 10);
  assert.equal(current.maxTextBytes.value, before.maxTextBytes.value);
});

test('AC-O4: lowering quota, file size, and item count keeps existing content and only stamps new expiry', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const base = `/api/spaces/${f.admin.space.id}`;
  const text = await bodyOf(await f.request(`${base}/items/text`, 'POST', { text: '1234567890' })) as { item: { id: string; expiresAt: number; text: string } };
  assert.equal((await f.request(`${base}/items/text`, 'POST', { text: '1234567890' })).status, 201);
  const fileResponse = await f.backend.app.request(`${base}/items/file`, {
    method: 'POST',
    headers: { origin, cookie: f.admin.cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'keep.bin' },
    body: 'abcdef',
  });
  assert.equal(fileResponse.status, 201, await fileResponse.clone().text());
  const file = await fileResponse.json() as { item: { id: string } };
  const keptExpires = text.item.expiresAt;

  const patched = await f.request('/api/admin/limits', 'PATCH', {
    maxTextBytes: 4,
    maxFileBytes: 4,
    roomMaxFileBytes: 3,
    maxItems: 2,
    userQuotaBytes: 8,
    roomQuotaBytes: 7,
    retentionMs: 2000,
    roomRetentionMs: 1000,
  });
  assert.equal(patched.status, 200, await patched.clone().text());

  const listed = await bodyOf(await f.request(`${base}/items`)) as { items: Array<{ id: string; text: string | null; expiresAt: number }> };
  assert.equal(listed.items.length, 3);
  assert.equal(listed.items.find(item => item.id === text.item.id)?.text, '1234567890');
  assert.equal(listed.items.find(item => item.id === text.item.id)?.expiresAt, keptExpires);
  const download = await f.request(`${base}/items/${file.item.id}/download`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'abcdef');

  assert.equal(await codeOf(await f.request(`${base}/items/text`, 'POST', { text: 'x' })), 'QUOTA_EXCEEDED');
  const tiny = await f.backend.app.request(`${base}/items/file`, {
    method: 'POST',
    headers: { origin, cookie: f.admin.cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'nope.bin' },
    body: '12345',
  });
  assert.equal(tiny.status, 413);

  assert.equal((await f.request('/api/admin/limits', 'PATCH', { maxItems: 4, userQuotaBytes: 30, roomQuotaBytes: 20 })).status, 200);
  const blocked = await f.request(`${base}/items/text`, 'POST', { text: '12345' });
  assert.equal(blocked.status, 413);
  assert.equal(await codeOf(blocked), 'TEXT_TOO_LARGE');
  const fresh = await bodyOf(await f.request(`${base}/items/text`, 'POST', { text: 'new' })) as { item: { expiresAt: number } };
  assert.equal(fresh.item.expiresAt, f.time() + 2000);
  const still = await bodyOf(await f.request(`${base}/items`)) as { items: Array<{ id: string; expiresAt: number }> };
  assert.equal(still.items.find(item => item.id === text.item.id)?.expiresAt, keptExpires);

  const memberMe = await bodyOf(await f.request('/api/me', 'GET', undefined, f.member.cookie)) as { quotaBytes: number };
  assert.equal(memberMe.quotaBytes, 50);
  const memberBase = `/api/spaces/${f.member.space.id}`;
  assert.equal((await f.request(`${memberBase}/items/text`, 'POST', { text: 'ok' }, f.member.cookie)).status, 201);

  const oldRoom = await bodyOf(await f.request('/api/rooms', 'POST', {})) as { token: string; expiresAt: number };
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { roomRetentionMs: 1000 })).status, 200);
  const newRoom = await bodyOf(await f.request('/api/rooms', 'POST', {})) as { token: string; expiresAt: number };
  assert.equal(newRoom.expiresAt, f.time() + 1000);
  assert.equal((await bodyOf(await f.request(`/api/rooms/${oldRoom.token}`)) as { expiresAt: number }).expiresAt, oldRoom.expiresAt);
});

test('AC-O2: session lifetime changes the next OAuth cookie and leaves the current session alone', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { sessionMs: 1000 })).status, 200);
  const flow = await f.backend.app.request('/api/auth/mock');
  const state = new URL(flow.headers.get('location') ?? '').searchParams.get('state');
  assert.ok(state);
  const browser = flow.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  const login = await f.backend.app.request(`/api/auth/mock/callback?state=${state}&code=admin`, { headers: { cookie: browser } });
  assert.equal(login.status, 302);
  const sessionCookie = login.headers.getSetCookie().find(cookie => cookie.startsWith('dropit_session='));
  assert.match(sessionCookie ?? '', /Max-Age=1(?:;|$)/);
  f.advance(1001);
  const fresh = sessionCookie?.split(';')[0] ?? '';
  assert.equal((await f.backend.app.request('/api/me', { headers: { cookie: fresh, origin } })).status, 401);
  assert.equal((await f.request('/api/me')).status, 200);
});

test('AC-O4: a restarted process keeps the override and drops in-memory rate counters', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { rateUpload: 2, rateRoom: 1 })).status, 200);
  const base = `/api/spaces/${f.admin.space.id}/items/text`;
  assert.equal((await f.request(base, 'POST', { text: 'one' })).status, 201);
  assert.equal((await f.request(base, 'POST', { text: 'two' })).status, 201);
  assert.equal((await f.request(base, 'POST', { text: 'three' })).status, 429);
  await f.restart();
  const limits = await bodyOf(await f.request('/api/admin/limits')) as Limits;
  assert.equal(limits.rateUpload.value, 2);
  assert.equal(limits.rateUpload.overridden, true);
  assert.equal((await f.request(base, 'POST', { text: 'four' })).status, 201);
  assert.equal((await f.request(base, 'POST', { text: 'five' })).status, 201);
  assert.equal((await f.request(base, 'POST', { text: 'six' })).status, 429);
});

test('AC-O5: audit names the actor and the old and new values, pages stably, and hides no-ops', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const defaults = await bodyOf(await f.request('/api/admin/limits')) as Limits;
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { maxItems: 20 })).status, 200);
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { maxItems: 20 })).status, 200);
  const only = await bodyOf(await f.request('/api/admin/limits/audit')) as { entries: Audit[] };
  assert.equal(only.entries.length, 1);
  assert.equal((await f.request('/api/admin/limits', 'PATCH', { maxTextBytes: 30 })).status, 200);
  const first = await bodyOf(await f.request('/api/admin/limits/audit?limit=1')) as { entries: Audit[]; nextCursor: number | null };
  assert.equal(first.entries.length, 1);
  assert.equal(first.nextCursor, first.entries[0].id);
  assert.equal(first.entries[0].actorId, f.admin.user.id);
  assert.equal(first.entries[0].actorEmail, f.admin.user.email);
  assert.equal(first.entries[0].createdAt, f.time());
  assert.equal(first.entries[0].key, 'maxTextBytes');
  assert.equal(first.entries[0].oldValue, defaults.maxTextBytes.value);
  assert.equal(first.entries[0].newValue, 30);
  assert.equal(first.entries[0].oldOverride, null);
  assert.equal(first.entries[0].newOverride, 30);
  const second = await bodyOf(await f.request(`/api/admin/limits/audit?limit=1&cursor=${first.nextCursor}`)) as { entries: Audit[]; nextCursor: number | null };
  assert.equal(second.entries[0].key, 'maxItems');
  assert.equal(second.entries[0].newValue, 20);
  assert.equal(second.nextCursor, null);
  for (const query of ['limit=0', 'limit=101', 'cursor=0', 'cursor=abc']) {
    assert.equal((await f.request(`/api/admin/limits/audit?${query}`)).status, 400, query);
  }
  assert.equal((await f.request('/api/admin/limits/audit', 'GET', undefined, f.member.cookie)).status, 403);
});

test('AC-O6: the API and operator docs describe persistence, atomic rejection, and non-deletion', async () => {
  const api = await readFile(new URL('../../../docs/api.md', import.meta.url), 'utf8');
  const config = await readFile(new URL('../../../docs/backend-config.md', import.meta.url), 'utf8');
  assert.match(api, /GET[\s\S]*\/admin\/limits/);
  assert.match(api, /PATCH[\s\S]*\/admin\/limits/);
  assert.match(api, /\/admin\/limits\/audit/);
  assert.match(api, /does\s+not delete existing content/);
  assert.match(api, /sessionMs` affects only newly issued OAuth sessions/);
  assert.match(api, /Retention is assigned on creation/);
  assert.match(api, /no partial writes/);
  assert.match(config, /persistent data volume/);
  assert.match(config, /does not remove existing content/);
  assert.match(config, /existing `expiresAt` values/);
  assert.match(config, /SESSION_SECRET/);
});
