import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServerUrl, isDropitVersion, deviceName, pollOutcome } from '../www/core.js';

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
