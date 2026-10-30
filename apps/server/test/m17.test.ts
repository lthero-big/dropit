import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { normalizeVersion } from '../src/version.js';

// RHEA-192 m17: only admins invite people to register (管理 → 邀请, no cap); space invites keep working;
// the shown version follows the newest vX.Y.Z tag + commits since it.
const SITE = 'http://dropit.lan:8787';
const cookieFrom = (response: Response) => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

async function setup(overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-m17-'));
  const time = 1_800_000_000_000;
  const config = { ...loadConfig({}), dataDir: dir, rateInvite: 1000, ...overrides };
  const backend = createBackend({ config, providers: {}, now: () => time, remoteAddress: () => '203.0.113.9' });
  const request = (path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { host: 'dropit.lan:8787', origin: SITE };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return backend.app.request(`${SITE}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const errorCode = async (response: Response) => (await response.json()).error.code as string;
  const created = await request('/api/setup', { method: 'POST', body: { code: backend.setupCode(), email: 'owner@example.com', name: 'Owner', password: 'correct horse battery' } });
  assert.equal(created.status, 201);
  const admin = cookieFrom(created);
  const register = (email: string, invite?: string) =>
    request('/api/auth/password/register', { method: 'POST', body: { email, password: 'member secret 1', ...(invite ? { invite } : {}) } });
  const member = async (email: string) => {
    const { spaces } = await (await request('/api/spaces', { cookie: admin })).json();
    const invite = await (await request('/api/admin/invites', { method: 'POST', cookie: admin, body: { spaceId: spaces[0].id, maxUses: 10 } })).json();
    const joined = await register(email, invite.token);
    assert.equal(joined.status, 201);
    return { cookie: cookieFrom(joined), user: (await joined.json()).user as { id: string } };
  };
  return { dir, request, errorCode, admin, register, member,
    async close() { await backend.close(); await rm(dir, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const ownSpace = async (f: Fixture, cookie: string, userId: string) =>
  ((await (await f.request('/api/spaces', { cookie })).json()).spaces as { id: string; ownerId: string | null }[]).find(space => space.ownerId === userId)!;

test('ordinary users get 403 for every registration-invite route', async t => {
  const f = await setup();
  t.after(() => f.close());
  const alice = await f.member('alice@example.com');
  for (const [path, method, body] of [
    ['/api/me/invites', 'GET', undefined], ['/api/me/invites', 'POST', {}], ['/api/me/invites/x', 'DELETE', undefined],
  ] as const) {
    const response = await f.request(path, { method, cookie: alice.cookie, body });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(await f.errorCode(response), 'INVITES_ADMIN_ONLY');
  }
  for (const body of [{ kind: 'registration' }, { kind: 'registration', maxUses: 5, expiresInHours: 24 }]) {
    assert.equal((await f.request('/api/admin/invites', { method: 'POST', cookie: alice.cookie, body })).status, 403);
  }
  assert.equal((await f.request('/api/admin/invites', { cookie: alice.cookie })).status, 403);
  // 管理 → 注册 no longer exposes the old switch or default cap
  const registration = await (await f.request('/api/admin/registration', { cookie: f.admin })).json();
  assert.deepEqual(Object.keys(registration).sort(), ['default', 'policy', 'updatedAt', 'updatedBy']);
});

test('admins create, list and revoke registration invites in 管理 with no cap', async t => {
  const f = await setup();
  t.after(() => f.close());
  const made = [];
  for (let i = 0; i < 12; i++) {
    const response = await f.request('/api/admin/invites', { method: 'POST', cookie: f.admin, body: { kind: 'registration', maxUses: 2, expiresInHours: 48 } });
    assert.equal(response.status, 201);
    made.push(await response.json());
  }
  const first = made[0];
  assert.equal(first.kind, 'registration');
  assert.equal(first.joinSpace, 0);
  assert.equal(first.maxUses, 2);
  assert.ok(!('tokenHash' in first) && !('spaceId' in first));
  assert.ok(first.url.endsWith(`/invite/${first.token}`));
  assert.equal((await f.request('/api/admin/invites', { method: 'POST', cookie: f.admin, body: { kind: 'bogus' } })).status, 400);
  assert.equal((await f.request('/api/admin/invites', { method: 'POST', cookie: f.admin, body: { kind: 'registration', maxUses: 101 } })).status, 400);

  const listed = (await (await f.request('/api/admin/invites', { cookie: f.admin })).json()).invites as { id: string; kind: string; creatorAdmin: boolean; status: string; createdByEmail: string }[];
  const registrationInvites = listed.filter(invite => invite.kind === 'registration');
  assert.equal(registrationInvites.length, 12);
  assert.ok(registrationInvites.every(invite => invite.creatorAdmin && invite.status === 'open' && invite.createdByEmail === 'owner@example.com'));

  // it opens registration, twice (maxUses 2), and never joins the admin's space
  const preview = await (await f.request(`/api/invites/${first.token}`)).json();
  assert.equal(preview.personal, true);
  const bob = await f.register('bob@example.com', first.token);
  assert.equal(bob.status, 201);
  const bobSpaces = (await (await f.request('/api/spaces', { cookie: cookieFrom(bob) })).json()).spaces;
  assert.equal(bobSpaces.length, 1);
  assert.equal(bobSpaces[0].role, 'owner');
  assert.equal((await f.register('carol@example.com', first.token)).status, 201);
  assert.equal((await f.register('dave@example.com', first.token)).status, 403);

  // revoke from 管理: the link stops working at once
  const second = made[1];
  assert.equal((await f.request(`/api/admin/invites/${second.id}`, { method: 'DELETE', cookie: f.admin })).status, 204);
  const after = (await (await f.request('/api/admin/invites', { cookie: f.admin })).json()).invites as { id: string; status: string }[];
  assert.equal(after.find(invite => invite.id === second.id)?.status, 'revoked');
  assert.equal(after.find(invite => invite.id === first.id)?.status, 'used');
  assert.equal((await f.request(`/api/invites/${second.token}`)).status, 404);
  assert.equal((await f.register('erin@example.com', second.token)).status, 403);
});

test('older registration invites made by a non-admin are flagged and cannot register anyone', async t => {
  const f = await setup();
  t.after(() => f.close());
  const erin = await f.member('erin@example.com');
  assert.equal((await f.request(`/api/admin/users/${erin.user.id}`, { method: 'PATCH', cookie: f.admin, body: { role: 'admin' } })).status, 204);
  const invite = await (await f.request('/api/me/invites', { method: 'POST', cookie: erin.cookie, body: {} })).json();
  assert.equal((await f.request(`/api/admin/users/${erin.user.id}`, { method: 'PATCH', cookie: f.admin, body: { role: 'user' } })).status, 204);
  const listed = (await (await f.request('/api/admin/invites', { cookie: f.admin })).json()).invites as { id: string; kind: string; creatorAdmin: boolean; status: string }[];
  const row = listed.find(item => item.id === invite.id)!;
  assert.equal(row.kind, 'registration');
  assert.equal(row.creatorAdmin, false);
  assert.equal(row.status, 'open'); // still listed so an admin can decide to revoke it
  assert.equal((await f.register('frank@example.com', invite.token)).status, 403);
  assert.equal((await f.request(`/api/admin/invites/${invite.id}`, { method: 'DELETE', cookie: f.admin })).status, 204);
});

test('space invites keep working for ordinary users and ignore a leftover userInvites setting', async t => {
  const f = await setup();
  t.after(() => f.close());
  const alice = await f.member('alice@example.com');
  // a row written by an older build (允许普通用户邀请 off, cap 0) no longer has any effect
  const db = new Database(join(f.dir, 'dropit.sqlite'));
  db.prepare('INSERT OR REPLACE INTO app_settings (key,value,updatedAt,updatedBy) VALUES (?,?,?,?)').run('userInvites', JSON.stringify({ enabled: false, defaultLimit: 0 }), 1, 'test');
  db.close();
  const space = await ownSpace(f, alice.cookie, alice.user.id);
  const view = await (await f.request(`/api/spaces/${space.id}/invites`, { cookie: alice.cookie })).json();
  assert.equal(view.enabled, true);
  assert.equal(view.limit, 5);
  const created = await f.request(`/api/spaces/${space.id}/invites`, { method: 'POST', cookie: alice.cookie, body: {} });
  assert.equal(created.status, 201);
  const invite = await created.json();
  // a user's space invite brings existing accounts in, but cannot create one
  const preview = await (await f.request(`/api/invites/${invite.token}`)).json();
  assert.equal(preview.canRegister, false);
  const refused = await f.register('zed@example.com', invite.token);
  assert.equal(refused.status, 403);
  assert.equal(await f.errorCode(refused), 'INVITE_NEEDS_ACCOUNT');
  const bob = await f.member('bob@example.com');
  assert.equal((await f.request(`/api/invites/${invite.token}/accept`, { method: 'POST', cookie: bob.cookie })).status, 200);
  // the per-user cap (管理 → 用户 → 空间邀请上限) still applies; 0 switches it off for that user
  assert.equal((await f.request(`/api/admin/users/${alice.user.id}`, { method: 'PATCH', cookie: f.admin, body: { inviteLimit: 0 } })).status, 204);
  const off = await f.request(`/api/spaces/${space.id}/invites`, { method: 'POST', cookie: alice.cookie, body: {} });
  assert.equal(await f.errorCode(off), 'INVITES_DISABLED');
  const users = (await (await f.request('/api/admin/users', { cookie: f.admin })).json()).users as { email: string; spaceInvitesEnabled: boolean; inviteLimitEffective: number }[];
  const aliceRow = users.find(user => user.email === 'alice@example.com')!;
  assert.equal(aliceRow.spaceInvitesEnabled, false);
  assert.equal(aliceRow.inviteLimitEffective, 0);
});

const script = fileURLToPath(new URL('../../../scripts/release-version.sh', import.meta.url));
test('release version: newest vX.Y.Z tag + commits since it, package.json without tags', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'dropit-m17-git-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  // the script resolves the repo from its own path, so run a copy inside the temp repo
  execFileSync('mkdir', ['-p', join(repo, 'scripts')]);
  execFileSync('cp', [script, join(repo, 'scripts', 'release-version.sh')]);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }, null, 2));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const version = () => execFileSync('sh', [join(repo, 'scripts', 'release-version.sh')], { cwd: tmpdir() }).toString().trim();
  git('init', '-q');
  assert.equal(version(), '0.1.0'); // no commits yet: package.json
  git('add', '.'); git('commit', '-qm', 'one');
  assert.equal(version(), '0.1.0'); // no tag yet: package.json
  git('tag', 'v0.1.0');
  assert.equal(version(), '0.1.0'); // on the tag
  git('commit', '-q', '--allow-empty', '-m', 'two'); git('commit', '-q', '--allow-empty', '-m', 'three');
  assert.equal(version(), '0.1.0+2'); // two commits after v0.1.0
  git('tag', 'cli-v9.0.0'); // CLI release tags do not count
  assert.equal(version(), '0.1.0+2');
  git('tag', 'v0.2.0');
  assert.equal(version(), '0.2.0');
  git('commit', '-q', '--allow-empty', '-m', 'four');
  assert.equal(version(), '0.2.0+1');
  // /api/version accepts the scheme unchanged
  assert.equal(normalizeVersion('0.2.0+1'), '0.2.0+1');
  assert.equal(normalizeVersion('v0.1.0+20'), '0.1.0+20');
});
