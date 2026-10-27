import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { jsonFileStore, readJsonFile } from '../src/files.js';
import { loadConfig } from '../src/config.js';
import { hash, token } from '../src/domain.js';
import { loadUpdateSettings, UpdateChecker, upgradeCommand, type UpdateSettings } from '../src/update-check.js';
import { compareVersions, loadBuildInfo, type BuildInfo } from '../src/version.js';

const settings = (overrides: Partial<UpdateSettings> = {}): UpdateSettings => ({ ...loadUpdateSettings({}), ...overrides });
const build = (overrides: Partial<BuildInfo> = {}): BuildInfo => ({ version: '0.1.0', commit: 'aaaaaaa', buildDate: null, install: 'source', ...overrides });
const quiet = () => undefined;

type Route = (url: URL) => unknown;
function fakeFetch(routes: Record<string, unknown | Route>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.host}${url.pathname}`);
    for (const [prefix, value] of Object.entries(routes)) {
      if (!`${url.host}${url.pathname}`.startsWith(prefix)) continue;
      const body = typeof value === 'function' ? (value as Route)(url) : value;
      if (body instanceof Error) throw body;
      if (typeof body === 'number') return new Response('{}', { status: body });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}
const hub = (digest: string, tags: [string, string][]) => ({
  'hub.docker.com/v2/repositories/lthero1/dropit/tags/latest': { name: 'latest', digest, last_updated: '2026-10-27T12:10:59Z' },
  'hub.docker.com/v2/repositories/lthero1/dropit/tags': { results: [{ name: 'latest', digest }, ...tags.map(([name, d]) => ({ name, digest: d }))] },
});

test('update settings: enabled by default, 12h, disable flags, bounds and validation', () => {
  const defaults = loadUpdateSettings({});
  assert.deepEqual(defaults, { enabled: true, intervalMs: 12 * 3600000, image: 'lthero1/dropit', repo: 'lthero-big/dropit', branch: 'main' });
  for (const flag of ['false', '0', 'off', 'NO', 'disabled']) assert.equal(loadUpdateSettings({ UPDATE_CHECK: flag }).enabled, false);
  assert.equal(loadUpdateSettings({ UPDATE_CHECK: 'true' }).enabled, true);
  assert.equal(loadUpdateSettings({ UPDATE_CHECK_HOURS: '6' }).intervalMs, 6 * 3600000);
  for (const hours of ['1', '5', '200', 'x']) assert.throws(() => loadUpdateSettings({ UPDATE_CHECK_HOURS: hours }), /UPDATE_CHECK_HOURS/);
  assert.throws(() => loadUpdateSettings({ UPDATE_IMAGE: 'https://evil/x' }), /UPDATE_IMAGE/);
  assert.throws(() => loadUpdateSettings({ UPDATE_REPO: 'a/b/c' }), /UPDATE_REPO/);
  assert.throws(() => loadUpdateSettings({ UPDATE_BRANCH: '../x' }), /UPDATE_BRANCH/);
  assert.equal(upgradeCommand('docker'), 'docker compose pull && docker compose up -d');
  assert.equal(upgradeCommand('docker-build'), './scripts/update.sh --docker');
  assert.equal(upgradeCommand('source'), './scripts/update.sh');
});

test('build info: env (docker build-args) beats build-info.json; junk is ignored', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-build-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'build-info.json');
  await writeFile(file, JSON.stringify({ version: '0.1.0', commit: 'abcdef1234', buildDate: '2026-10-27T00:00:00Z', install: 'source' }));
  assert.deepEqual(loadBuildInfo({ NODE_ENV: 'production' }, readJsonFile(file)), { version: '0.1.0', commit: 'abcdef1', buildDate: '2026-10-27T00:00:00.000Z', install: 'source' });
  assert.deepEqual(loadBuildInfo({ NODE_ENV: 'production', DROPIT_VERSION: 'v1.2.3', DROPIT_COMMIT: 'ABC1234', DROPIT_INSTALL: 'docker', DROPIT_BUILD_DATE: '' }, readJsonFile(file)),
    { version: '1.2.3', commit: 'abc1234', buildDate: '2026-10-27T00:00:00.000Z', install: 'docker' });
  assert.deepEqual(loadBuildInfo({ NODE_ENV: 'production', DROPIT_COMMIT: 'not-a-sha;rm', DROPIT_INSTALL: 'k8s' }, readJsonFile(join(dir, 'missing.json'))),
    { version: '0.0.0', commit: null, buildDate: null, install: 'source' });
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('v0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.2.0-rc.1'), -1);
});

test('source install: GitHub compare reports commits behind main', async () => {
  const { fn, calls } = fakeFetch({
    'api.github.com/repos/lthero-big/dropit/compare/aaaaaaa...main': { status: 'ahead', ahead_by: 3, behind_by: 0, html_url: 'https://github.com/lthero-big/dropit/compare/aaaaaaa...main', commits: [{ sha: '1111111aaaa' }, { sha: 'bbbbbbbcccc' }] },
    'api.github.com/repos/lthero-big/dropit/releases/latest': 404,
  });
  const checker = new UpdateChecker(build(), settings(), { fetch: fn, log: quiet });
  const state = await checker.check();
  assert.equal(state.status, 'available');
  assert.equal(state.source, 'github');
  assert.deepEqual({ commit: state.latest?.commit, behindBy: state.latest?.behindBy }, { commit: 'bbbbbbb', behindBy: 3 });
  assert.ok(calls.every(call => /^(api\.github\.com|hub\.docker\.com)\//.test(call)));

  const same = new UpdateChecker(build(), settings(), { fetch: fakeFetch({ 'api.github.com/repos/lthero-big/dropit/compare/': { status: 'identical', ahead_by: 0, commits: [] } }).fn, log: quiet });
  assert.equal((await same.check()).status, 'up-to-date');
  const fork = new UpdateChecker(build(), settings(), { fetch: fakeFetch({}).fn, log: quiet });
  assert.deepEqual([(await fork.check()).status, fork.state().reason], ['unknown', 'COMMIT_NOT_ON_GITHUB']);
  const nocommit = new UpdateChecker(build({ commit: null }), settings(), { fetch: fakeFetch({}).fn, log: quiet });
  assert.deepEqual([(await nocommit.check()).status, nocommit.state().reason], ['unknown', 'NO_LOCAL_COMMIT']);
});

test('docker install: Docker Hub latest digest + sibling hash tag decide the status', async () => {
  const upToDate = new UpdateChecker(build({ install: 'docker', commit: 'f9db2bd' }), settings(), {
    fetch: fakeFetch(hub('sha256:cd12', [['f9db2bd', 'sha256:cd12'], ['0cd7cdb', 'sha256:dfda']])).fn, log: quiet,
  });
  const state = await upToDate.check();
  assert.equal(state.status, 'up-to-date');
  assert.equal(state.source, 'dockerhub');
  assert.deepEqual({ digest: state.latest?.digest, commit: state.latest?.commit }, { digest: 'sha256:cd12', commit: 'f9db2bd' });

  const newer = new UpdateChecker(build({ install: 'docker', commit: '0cd7cdb' }), settings(), {
    fetch: fakeFetch({ ...hub('sha256:cd12', [['f9db2bd', 'sha256:cd12']]), 'api.github.com/repos/lthero-big/dropit/compare/0cd7cdb...f9db2bd': { status: 'ahead', ahead_by: 5, commits: [{ sha: 'f9db2bdffff' }] } }).fn, log: quiet,
  });
  assert.deepEqual([(await newer.check()).status, newer.state().latest?.behindBy], ['available', 5]);

  // Running a commit newer than the Hub image (e.g. a local build) is not an "update".
  const ahead = new UpdateChecker(build({ install: 'docker', commit: 'ccccccc' }), settings(), {
    fetch: fakeFetch({ ...hub('sha256:cd12', [['f9db2bd', 'sha256:cd12']]), 'api.github.com/repos/lthero-big/dropit/compare/': { status: 'behind', ahead_by: 0, behind_by: 2, commits: [] } }).fn, log: quiet,
  });
  assert.equal((await ahead.check()).status, 'up-to-date');
});

test('a newer GitHub release counts as an update; equal or older does not', async () => {
  const routes = (tag: string) => fakeFetch({
    'api.github.com/repos/lthero-big/dropit/compare/': { status: 'identical', ahead_by: 0, commits: [] },
    'api.github.com/repos/lthero-big/dropit/releases/latest': { tag_name: tag, html_url: `https://github.com/lthero-big/dropit/releases/tag/${tag}`, published_at: '2026-11-01T00:00:00Z' },
  }).fn;
  const newer = await new UpdateChecker(build(), settings(), { fetch: routes('v0.2.0'), log: quiet }).check();
  assert.equal(newer.status, 'available');
  assert.equal(newer.latest?.version, '0.2.0');
  assert.match(newer.latest?.url ?? '', /releases\/tag\/v0\.2\.0$/);
  assert.equal((await new UpdateChecker(build(), settings(), { fetch: routes('v0.1.0'), log: quiet }).check()).status, 'up-to-date');
});

test('offline-safe: network errors and timeouts become status "error", never throw, keep last result', async () => {
  const logs: string[] = [];
  let mode: 'ok' | 'down' | 'slow' = 'ok';
  const fn = (async (input: string | URL | Request) => {
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'slow') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const url = String(input instanceof Request ? input.url : input);
    return new Response(JSON.stringify(url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, commits: [{ sha: 'bbbbbbb' }] } : {}), { status: url.includes('/compare/') ? 200 : 404 });
  }) as typeof fetch;
  let time = 1_000_000;
  const checker = new UpdateChecker(build(), settings(), { fetch: fn, log: message => logs.push(message), now: () => time });
  assert.equal((await checker.check()).status, 'available');
  mode = 'down'; time += 1000;
  const down = await checker.check();
  assert.deepEqual([down.status, down.error, down.latest?.commit], ['error', 'NETWORK', 'bbbbbbb']);
  mode = 'slow';
  assert.equal((await checker.check()).error, 'TIMEOUT');
  assert.deepEqual(logs, ['Update check failed (NETWORK); will retry later', 'Update check failed (TIMEOUT); will retry later']);
});

test('disabled checker never touches the network', async () => {
  const { fn, calls } = fakeFetch({});
  const checker = new UpdateChecker(build(), settings({ enabled: false }), { fetch: fn, log: quiet, firstDelayMs: 0 });
  checker.start();
  assert.equal((await checker.check()).status, 'disabled');
  assert.equal((await checker.checkNow()).status, 'disabled');
  assert.equal(checker.report().check.nextCheckAt, null);
  checker.stop();
  assert.deepEqual(calls, []);
});

test('results are cached on disk per build; manual checks are throttled; concurrent checks share one request', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-update-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const cacheFile = join(dir, 'nested', 'update-check.json');
  const cache = jsonFileStore(cacheFile);
  let time = 5_000_000;
  const { fn, calls } = fakeFetch({ 'api.github.com/repos/lthero-big/dropit/compare/': { status: 'ahead', ahead_by: 2, commits: [{ sha: 'bbbbbbb' }] } });
  const first = new UpdateChecker(build(), settings(), { fetch: fn, cache, now: () => time, log: quiet });
  await Promise.all([first.check(), first.check()]);
  assert.equal(calls.filter(call => call.includes('/compare/')).length, 1);
  await first.checkNow();
  assert.equal(calls.filter(call => call.includes('/compare/')).length, 1, 'checkNow within 60s reuses the result');
  assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).state.status, 'available');

  time += 3600000;
  const restored = new UpdateChecker(build(), settings(), { fetch: fn, cache, now: () => time, log: quiet });
  assert.equal(restored.state().status, 'available');
  restored.start();
  assert.equal(restored.report().check.nextCheckAt, time + 11 * 3600000, 'fresh cache postpones the first request');
  restored.stop();
  const upgraded = new UpdateChecker(build({ commit: 'bbbbbbb' }), settings(), { fetch: fn, cache, now: () => time, log: quiet });
  assert.equal(upgraded.state().status, 'pending', 'a different build ignores the old cache');
});

test('GET /api/version is public; /api/admin/update needs an admin; POST check returns a fresh report', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dropit-update-api-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = 'http://localhost:3000';
  const config = { ...loadConfig({}), origin, dataDir: dir };
  const { fn, calls } = fakeFetch({ ...hub('sha256:new', [['bbbbbbb', 'sha256:new']]),
    'api.github.com/repos/lthero-big/dropit/compare/aaaaaaa...bbbbbbb': { status: 'ahead', ahead_by: 4, commits: [{ sha: 'bbbbbbb' }] } });
  const update = new UpdateChecker(build({ install: 'docker' }), settings(), { fetch: fn, log: quiet });
  const backend = createBackend({ config, providers: {}, update, remoteAddress: () => '127.0.0.1' });
  t.after(() => backend.close());
  const login = (subject: string, email: string) => {
    const session = token();
    backend.repo.login({ provider: 'test', subject, email, name: subject }, null, [], hash(session), Date.now() + 3600000, Date.now());
    return `dropit_session=${session}`;
  };
  const admin = login('admin', 'admin@example.com');
  const request = (path: string, cookie = '', method = 'GET') => backend.app.request(path, { method, headers: { origin, ...(cookie ? { cookie } : {}) } });

  const version = await request('/api/version');
  assert.equal(version.status, 200);
  assert.deepEqual(await version.json(), { version: '0.1.0', commit: 'aaaaaaa', buildDate: null, install: 'docker' });
  assert.equal((await request('/api/admin/update')).status, 401);
  const created = await backend.app.request('/api/admin/users', { method: 'POST', headers: { origin, cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com', name: 'User', role: 'user' }) });
  assert.equal(created.status, 201);
  const user = login('user', 'user@example.com');
  assert.equal((await request('/api/admin/update', user)).status, 403);
  assert.equal((await request('/api/admin/update/check', user, 'POST')).status, 403);

  const before = await (await request('/api/admin/update', admin)).json();
  assert.equal(before.check.status, 'pending');
  assert.equal(before.upgrade.command, 'docker compose pull && docker compose up -d');
  assert.deepEqual(calls, [], 'reading the report never triggers a network call');
  const after = await (await request('/api/admin/update/check', admin, 'POST')).json();
  assert.deepEqual([after.check.status, after.check.latest.commit, after.check.latest.behindBy], ['available', 'bbbbbbb', 4]);
});
