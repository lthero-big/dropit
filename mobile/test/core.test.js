import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeServerUrl, isDropitVersion, deviceName, pollOutcome,
  pickSpace, itemTitle, formatSize, timeAgo, sharedText, newDeviceId, deviceHeaders, apiError,
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
test('item titles and sizes', () => {
  assert.equal(itemTitle({ kind: 'text', text: ' a\n\n b ' }), 'a b');
  assert.equal([...itemTitle({ kind: 'text', text: '字'.repeat(500) }, 10)].length, 10);
  assert.equal(itemTitle({ kind: 'file', filename: 'p.png' }), 'p.png');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(50 * 1024 * 1024), '50 MB');
  assert.equal(timeAgo(1000, 1000 + 30e3), '刚刚');
  assert.equal(timeAgo(0, 3 * 3600e3), '3 小时前');
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
