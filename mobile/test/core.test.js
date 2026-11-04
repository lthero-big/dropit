import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeServerUrl, isDropitVersion, deviceName, pollOutcome,
  pickSpace, sharedText, newDeviceId, deviceHeaders, apiError, webEntry, LOGIN_SCOPES, LEGACY_SCOPES,
} from '../www/core.js';

test('https only, bare host gets https', () => {
  assert.equal(normalizeServerUrl('drop.example.com/'), 'https://drop.example.com');
  assert.equal(normalizeServerUrl(' https://a.b/sub/ '), 'https://a.b/sub');
  assert.throws(() => normalizeServerUrl('http://a.b'), /https/);
  assert.throws(() => normalizeServerUrl(''), /服务器地址/);
  assert.throws(() => normalizeServerUrl('https://u:p@a.b'), /用户名/);
});
test('dropit /api/version shape', () => {
  assert.ok(isDropitVersion({ version: '0.1.0', commit: 'abc1234', buildDate: null, install: 'docker' }));
  assert.ok(!isDropitVersion({ version: '0.1.0', install: 'nginx' }));
  assert.ok(!isDropitVersion({ status: 'ok' }));
  assert.ok(!isDropitVersion(null));
});
test('device name length', () => { assert.ok([...deviceName('x'.repeat(99))].length <= 40); });
test('poll outcomes', () => {
  assert.deepEqual(pollOutcome(200, { access_token: 't' }), { kind: 'token', token: 't' });
  assert.equal(pollOutcome(400, { error: 'authorization_pending' }).kind, 'pending');
  assert.equal(pollOutcome(400, { error: { code: 'EXPIRED_TOKEN' } }).kind, 'expired');
});
test('pick own private space', () => {
  const spaces = [{ id: 'shared', ownerId: 'x', expiresAt: null }, { id: 'mine', ownerId: 'u1', expiresAt: null }];
  assert.equal(pickSpace(spaces, 'u1').id, 'mine');
  assert.equal(pickSpace(spaces, 'nobody').id, 'shared');
  assert.equal(pickSpace([], 'u1'), null);
  assert.equal(pickSpace(undefined, 'u1'), null);
});
test('shared text combines subject and link', () => {
  assert.equal(sharedText({ text: 'https://x.y/a', subject: 'Title' }), 'Title\nhttps://x.y/a');
  assert.equal(sharedText({ text: 'Title https://x.y', subject: 'Title' }), 'Title https://x.y');
  assert.equal(sharedText({ text: '  ', subject: 'T' }), null);
  assert.equal(sharedText({}), null);
});
test('device headers', () => {
  const id = newDeviceId();
  assert.match(id, /^[A-Za-z0-9_-]{6,64}$/);
  const h = deviceHeaders(id, 'dropit Android · 手机');
  assert.equal(h['X-Dropit-Device'], id);
  assert.equal(h['X-Dropit-Device-Kind'], 'phone');
  assert.equal(decodeURIComponent(h['X-Dropit-Device-Name']), 'dropit Android · 手机');
  assert.ok(!('X-Dropit-Device' in deviceHeaders('bad id!', '')));
});
test('api error messages', () => {
  assert.equal(apiError(413, { error: { code: 'FILE_TOO_LARGE' } }), '文件太大，超过服务器限制');
  assert.equal(apiError(401, null), '登录已失效，请重新登录');
  assert.match(apiError(500, { error: { code: 'INTERNAL_ERROR' } }), /INTERNAL_ERROR/);
});
test('device login asks for the web scope, legacy fallback does not', () => {
  assert.deepEqual(LOGIN_SCOPES, ['read', 'write', 'web']);
  assert.deepEqual(LEGACY_SCOPES, ['read', 'write']);
});
test('web entry: one-time ticket, old servers, old tokens', () => {
  const t = 'A'.repeat(43);
  assert.deepEqual(webEntry('https://d.x', 200, { ticket: t, path: `/api/app-session?ticket=${t}` }), { kind: 'ticket', url: `https://d.x/api/app-session?ticket=${t}` });
  // never follow a path the server did not mean
  assert.equal(webEntry('https://d.x', 200, { path: '//evil.example/x' }).kind, 'error');
  assert.equal(webEntry('https://d.x', 200, { path: `/api/app-session?ticket=${t}&next=//evil` }).kind, 'error');
  assert.deepEqual(webEntry('https://d.x', 404, { error: { code: 'NOT_FOUND' } }), { kind: 'plain', url: 'https://d.x/' });
  assert.equal(webEntry('https://d.x', 401, null).kind, 'relogin');
  assert.equal(webEntry('https://d.x', 403, { error: { code: 'INSUFFICIENT_SCOPE' } }).kind, 'relogin');
  assert.equal(webEntry('https://d.x', 403, { error: { code: 'BEARER_REQUIRED' } }).kind, 'error');
  assert.match(webEntry('https://d.x', 429, { error: { code: 'RATE_LIMITED' } }).note, /太频繁/);
});

test('versionLabel shows version, short commit and date', async () => {
  const { versionLabel } = await import('../www/core.js');
  assert.equal(versionLabel({ version: '0.3.0', commit: '0123456789abcdef0123456789abcdef01234567', date: '2026-11-04T04:00:00Z' }), '版本 0.3.0 · 0123456 · 2026-11-04');
  assert.equal(versionLabel({ version: '0.3.0', commit: 'dev', date: '' }), '版本 0.3.0 · dev');
  assert.equal(versionLabel(null), '版本 ?');
});

test('RHEA-190 au: update offer from /api/app/android/latest', async () => {
  const { updateOffer, shouldPrompt, formatSize } = await import('../www/core.js');
  const sha = 'b'.repeat(64);
  const body = { versionCode: 5, versionName: '0.3.2', notes: '自动检查更新', size: 5_400_000, sha256: sha, url: '/api/app/android/download/dropit-android-0.3.2.apk' };
  assert.deepEqual(updateOffer('https://d.x', 4, 200, body), { kind: 'update', versionCode: 5, versionName: '0.3.2', notes: '自动检查更新', size: 5_400_000, sha256: sha, url: 'https://d.x/api/app/android/download/dropit-android-0.3.2.apk' });
  assert.deepEqual(updateOffer('https://d.x', 5, 200, body), { kind: 'latest', versionName: '0.3.2' });
  assert.equal(updateOffer('https://d.x', 6, 200, body).kind, 'latest');
  assert.deepEqual(updateOffer('https://d.x', 4, 404, { error: { code: 'NO_RELEASE' } }), { kind: 'none' });
  assert.match(updateOffer('https://d.x', 4, 429, { error: { code: 'RATE_LIMITED' } }).note, /太频繁/);
  // never follow a download somewhere else, never accept a broken manifest
  for (const bad of [{ url: 'https://evil.example/x.apk' }, { url: '//evil.example/api/app/android/download/x.apk' }, { url: '/api/app/android/download/../x.apk' },
    { url: '/api/app/android/download/x.apk?y' }, { sha256: 'abc' }, { versionCode: '5' }, { size: 0 }]) {
    assert.equal(updateOffer('https://d.x', 4, 200, { ...body, ...bad }).kind, 'error', JSON.stringify(bad));
  }
  assert.equal(updateOffer('https://d.x', 4, 200, null).kind, 'error');
  assert.equal(updateOffer('https://d.x', 4, 200, { ...body, notes: 7 }).notes, '');
  const offer = updateOffer('https://d.x', 4, 200, body);
  assert.ok(shouldPrompt(offer, null));
  assert.ok(!shouldPrompt(offer, '5'));
  assert.ok(shouldPrompt(offer, '4'));
  assert.ok(!shouldPrompt({ kind: 'latest' }, null));
  assert.equal(formatSize(5_400_000), '5.1 MB');
  assert.equal(formatSize(2048), '2 KB');
});

test('RHEA-190 au: build info carries the versionCode that matches build.gradle', async () => {
  const { readFile } = await import('node:fs/promises');
  const { BUILD } = await import('../www/build-info.js');
  const gradle = await readFile(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
  assert.equal(BUILD.code, Number(/versionCode (\d+)/.exec(gradle)[1]));
  assert.equal(BUILD.version, /versionName "([^"]+)"/.exec(gradle)[1]);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, BUILD.version);
});
