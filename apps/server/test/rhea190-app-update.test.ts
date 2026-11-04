import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBackend } from '../src/backend.js';
import { loadConfig } from '../src/config.js';
import { androidReleaseDir, parseAndroidRelease } from '../src/app-release.js';

const run = promisify(execFile);
const script = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../scripts/publish-android-apk.mjs');
const good = { versionCode: 5, versionName: '0.3.2', notes: '更新说明', file: 'dropit-android-0.3.2.apk', sha256: 'a'.repeat(64), size: 10, publishedAt: null };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-app-update-'));
  const backend = createBackend({ config: { ...loadConfig({}), origin: 'http://localhost:3000', dataDir: directory }, providers: {},
    remoteAddress: () => '203.0.113.7' });
  return { ...backend, directory, async dispose() { await backend.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('RHEA-190 au: manifest validation', () => {
  assert.deepEqual(parseAndroidRelease(good), good);
  assert.equal(parseAndroidRelease({ ...good, notes: undefined })?.notes, '');
  for (const bad of [
    { ...good, versionCode: 0 }, { ...good, versionCode: 1.5 }, { ...good, versionCode: '5' },
    { ...good, versionName: '' }, { ...good, versionName: '0.3.2 beta' },
    { ...good, file: '../etc/passwd.apk' }, { ...good, file: 'x.zip' }, { ...good, file: '.hidden.apk' }, { ...good, file: 'a/b.apk' },
    { ...good, sha256: 'A'.repeat(64) }, { ...good, sha256: 'abc' }, { ...good, size: 0 }, { ...good, size: 300 * 1024 * 1024 },
    { ...good, notes: 'x'.repeat(4001) }, null, [], 'x',
  ]) assert.equal(parseAndroidRelease(bad), null, JSON.stringify(bad)?.slice(0, 80));
});

test('RHEA-190 au: no release yet is a 404 NO_RELEASE, not an error', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const r = await f.app.request('/api/app/android/latest');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'NO_RELEASE');
  assert.equal((await f.app.request('/api/app/android/download/dropit-android-0.3.2.apk')).status, 404);
});

test('RHEA-190 au: publish script + latest + download (public, exact bytes, only the published file)', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const apk = Buffer.from('PK\u0003\u0004 fake apk bytes for the test');
  const src = join(f.directory, 'in.apk');
  await writeFile(src, apk);
  const dir = androidReleaseDir(f.directory);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'dropit-android-0.3.1.apk'), 'old');
  const out = await run(process.execPath, [script, src, '--code', '5', '--name', '0.3.2', '--notes', '自动检查更新\n头像菜单修复', '--dir', dir]);
  assert.match(out.stdout, /published/);
  assert.deepEqual((await readdir(dir)).sort(), ['dropit-android-0.3.2.apk', 'latest.json']);
  const sha = createHash('sha256').update(apk).digest('hex');
  const manifest = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8'));
  assert.equal(manifest.sha256, sha);

  const r = await f.app.request('/api/app/android/latest');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  assert.deepEqual({ ...body, publishedAt: typeof body.publishedAt }, {
    versionCode: 5, versionName: '0.3.2', notes: '自动检查更新\n头像菜单修复', size: apk.length, sha256: sha,
    publishedAt: 'string', url: '/api/app/android/download/dropit-android-0.3.2.apk',
  });
  const d = await f.app.request(body.url);
  assert.equal(d.status, 200);
  assert.equal(d.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(d.headers.get('content-length'), String(apk.length));
  assert.match(d.headers.get('content-disposition') ?? '', /attachment; filename="dropit-android-0.3.2.apk"/);
  assert.deepEqual(Buffer.from(await d.arrayBuffer()), apk);
  // Anything but the published name is a 404 (no directory listing, no traversal).
  for (const path of ['dropit-android-0.3.1.apk', 'latest.json', '..%2Flatest.json', '%2E%2E%2Fapp.apk']) {
    assert.equal((await f.app.request(`/api/app/android/download/${path}`)).status, 404, path);
  }
  // A manifest whose APK went missing or has another size is treated as no release.
  await writeFile(join(dir, 'dropit-android-0.3.2.apk'), 'truncated');
  assert.equal((await f.app.request('/api/app/android/latest')).status, 404);
});

test('RHEA-190 au: publish script rejects bad input', async () => {
  await assert.rejects(run(process.execPath, [script, '/nonexistent.apk', '--code', '5', '--name', '0.3.2', '--dir', tmpdir()]), /cannot read/);
  await assert.rejects(run(process.execPath, [script, script, '--code', 'x', '--name', '0.3.2', '--dir', tmpdir()]), /versionCode/);
  await assert.rejects(run(process.execPath, [script, script, '--code', '5', '--name', '0 3', '--dir', tmpdir()]), /versionName/);
});
