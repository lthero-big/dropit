// One source revision, one immutable Rust image. No deployment or external publish.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, NORMALIZED_PASSWORD } from '../rust/server/tests/fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const [revision, destination] = process.argv.slice(2);
if (!revision || !destination) throw new Error('usage: node scripts/rust-final-acceptance.mjs COMMIT OUTSIDE_REPO_REPORT_DIR');
const out = resolve(destination);
assert(!out.startsWith(root + '/') && out !== root, 'keep reports outside the source tree');
await mkdir(out, { recursive: false }); // never overwrite evidence from another run
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--verify', revision + '^{commit}');
const report = { commit, finalAcceptance: 'pending parent rerun after PR #97 integration', startedAt: new Date().toISOString(), groups: [],
  limits: ['Mobile coverage is HTTP/WS protocol only; no physical phone UI.',
    'A green baseline does not accept unmerged RHEA-243 / PR #97. Parent must rerun after integration.',
    'Mock OAuth is a real local HTTP flow against a synthetic provider, not live GitHub/Google.'] };
const save = () => writeFile(join(out, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
function fixedSource() {
  assert.equal(git('rev-parse', 'HEAD'), commit, 'source revision drift');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'source must remain clean (including untracked files)');
}
// Do not inherit binary/container overrides or fixture-retention flags from another run.
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(DROPIT_|RUST_SERVER_BIN|RUST_UPDATE_CONTAINER_IMAGE|CARGO_TARGET_DIR|KEEP_|ADMIN_FIXTURE_OUT|UNICODE_REPORT)/.test(key)) delete env[key];
env.CARGO_BUILD_JOBS = '2';
let scratch;
let image;
let tsImage;
const containers = [];
const tags = [];
async function group(name, command, args, extra = {}, cwd = root) {
  fixedSource();
  const entry = { name, command: [command, ...args], cwd, startedAt: new Date().toISOString(), status: 'running', log: name + '.log' };
  report.groups.push(entry);
  await save();
  const log = createWriteStream(join(out, entry.log));
  try {
    const child = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    const [code, signal] = await once(child, 'close');
    entry.exitCode = code; entry.signal = signal; entry.status = code === 0 ? 'passed' : 'failed';
    fixedSource();
  } catch (error) { entry.status = 'failed'; entry.error = String(error); }
  finally { await new Promise(done => log.end(done)); entry.finishedAt = new Date().toISOString(); await save(); }
  console.log(`${entry.status.toUpperCase()} ${name} (exit ${entry.exitCode ?? 'none'})`);
  return entry.status === 'passed';
}
async function required(...args) { if (!await group(...args)) throw new Error('prerequisite failed: ' + args[0]); }
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
async function archive(sha, dir) {
  await mkdir(dir);
  execFileSync('tar', ['-x', '-C', dir], { input: execFileSync('git', ['archive', sha], { cwd: root, maxBuffer: 64e6 }) });
}
try {
  fixedSource();
  report.worktree = 'clean';
  scratch = await mkdtemp(join(tmpdir(), 'dropit-rhea251-'));
  env.CARGO_TARGET_DIR = join(scratch, 'target'); // never reuse a binary from another checkout
  await required('dependencies', 'pnpm', ['install', '--frozen-lockfile']);
  await required('ts-clients', 'pnpm', ['build']);
  await required('playwright-install', 'pnpm', ['--filter', '@dropit/web', 'exec', 'playwright', 'install', 'chromium']);
  await required('rust-build', 'cargo', ['build', '--locked', '--manifest-path', 'rust/server/Cargo.toml']);
  const binary = join(env.CARGO_TARGET_DIR, 'debug/dropit-server');
  env.RUST_SERVER_BIN = binary;
  report.binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const context = join(scratch, 'rust-context');
  await archive(commit, context);
  const tag = 'dropit:rhea251-' + randomUUID(); tags.push(tag);
  const date = new Date().toISOString();
  const version = JSON.parse(await readFile(join(root, 'package.json'))).version;
  await required('rust-image-build', 'docker', ['build', '--build-arg', 'DROPIT_COMMIT=' + commit,
    '--build-arg', 'DROPIT_VERSION=' + version, '--build-arg', 'DROPIT_BUILD_DATE=' + date, '-t', tag, context]);
  const inspection = JSON.parse(docker('image', 'inspect', tag))[0];
  image = inspection.Id;
  assert.equal(inspection.Config.Labels['org.opencontainers.image.revision'], commit);
  assert.deepEqual(inspection.Config.Cmd, ['/usr/local/bin/dropit-server']);
  report.image = { id: image, revision: commit, version, date, dockerfile: 'Dockerfile', context: 'git archive ' + commit };
  await save();
  // Each default Rust integration target uses the fresh binary and its own fixed TS fixture.
  await group('rust-tests', 'cargo', ['test', '--no-fail-fast', '--locked', '--manifest-path', 'rust/server/Cargo.toml', '--', '--test-threads=1']);
  await group('image-runtime', 'sh', ['scripts/check-rust-image.sh', image], { DROPIT_COMMIT: commit, DROPIT_VERSION: version, DROPIT_BUILD_DATE: date });
  await group('docker-blackbox', 'node', ['scripts/acceptance-docker.mjs', out], {
    DROPIT_IMAGE: image, DROPIT_EXPECTED_IMAGE_ID: image, DROPIT_EXPECTED_COMMIT: commit });
  // Real browsers use the static Web and Rust runtime from this exact image.
  const data = join(scratch, 'browser-data');
  await fixture(data);
  const name = 'dropit-rhea251-web-' + randomUUID();
  const socket = createServer(); socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  const origin = 'http://127.0.0.1:' + port;
  docker('create', '--name', name, '-p', `127.0.0.1:${port}:8787`, '-e', 'APP_ORIGIN=' + origin, '-e', 'UPDATE_CHECK=0', image);
  containers.push(name);
  docker('start', name);
  await group('browser-setup', 'node', ['scripts/acceptance-browser.mjs', origin, out, 'setup'], { DROPIT_BROWSER_SETUP_ONLY: '1' });
  docker('rm', '-fv', name); containers.pop();
  docker('create', '--name', name, '-p', `127.0.0.1:${port}:8787`, '-e', 'APP_ORIGIN=' + origin, '-e', 'UPDATE_CHECK=0', image);
  containers.push(name);
  docker('cp', data + '/.', name + ':/data');
  docker('run', '--rm', '--user', '0', '--volumes-from', name, '--entrypoint', 'sh', image, '-ec', 'chown -R 1000:1000 /data; chmod 700 /data');
  docker('start', name);
  for (let n = 0; ; n++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch { /* starting */ }
    assert(n < 100, 'image readiness timeout');
    await new Promise(done => setTimeout(done, 100));
  }
  await group('browser-smoke', 'pnpm', ['--filter', '@dropit/web', 'smoke', '--reporter=line,json'], {
    DROPIT_SMOKE_ORIGIN: origin, DROPIT_DEV_BACKEND_ORIGIN: origin,
    DROPIT_SMOKE_EMAIL: 'alice@example.test', DROPIT_SMOKE_PASSWORD: NORMALIZED_PASSWORD,
    DROPIT_PLAYWRIGHT_OUTPUT_DIR: join(out, 'playwright'), PLAYWRIGHT_JSON_OUTPUT_NAME: join(out, 'playwright.json'),
    PLAYWRIGHT_HTML_OPEN: 'never' });
  await group('browser-files', 'node', ['scripts/acceptance-browser.mjs', origin, out, 'rust']);
  const smoke = JSON.parse(await readFile(join(out, 'playwright.json'), 'utf8'));
  report.browserStats = smoke.stats;
  report.browserSkips = [];
  function collect(suites) { for (const suite of suites) {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) if (test.status === 'skipped') report.browserSkips.push({ title: spec.title, annotations: test.annotations });
    collect(suite.suites ?? []);
  } }
  collect(smoke.suites);
  docker('stop', '-t', '15', name);
  assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', name), '0');
  docker('start', name);
  for (let n = 0; ; n++) {
    try { if ((await fetch(origin + '/api/version')).ok) break; } catch {}
    assert(n < 100, 'restart readiness timeout');
    await new Promise(done => setTimeout(done, 100));
  }
  assert.equal(docker('inspect', '--format', '{{.Image}}', name), image);
  report.browserContainer = { image, origin, restarted: true };
  // Reuse the offline upgrade / backup / rollback rehearsal, with an explicitly separate historical TS image.
  const adminFixture = join(scratch, 'admin-fixture');
  if (await group('admin-fixture', 'node', ['rust/server/tests/admin.mjs'], { ADMIN_FIXTURE_OUT: adminFixture })) {
    const baseline = '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68';
    const tsContext = join(scratch, 'ts-context'); await archive(baseline, tsContext);
    const tsTag = 'dropit:rhea251-ts-' + randomUUID(); tags.push(tsTag);
    if (await group('historical-ts-image', 'docker', ['build', '-t', tsTag, tsContext])) {
      tsImage = docker('image', 'inspect', '--format', '{{.Id}}', tsTag);
      report.rollbackReference = { commit: baseline, image: tsImage };
      await group('volume-rehearsal', 'python3', ['scripts/check-rust-volume.py', adminFixture, image, tsImage]);
    } else report.groups.push({ name: 'volume-rehearsal', status: 'skipped', reason: 'historical TS image build failed' });
  } else report.groups.push({ name: 'volume-rehearsal', status: 'skipped', reason: 'admin fixture failed' });
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), report.binarySha256, 'binary drift');
  assert.equal(docker('image', 'inspect', '--format', '{{.Id}}', image), image);
  fixedSource();
} catch (error) { report.error = String(error); console.error(report.error); }
finally {
  const planned = ['dependencies', 'ts-clients', 'playwright-install', 'rust-build', 'rust-image-build', 'rust-tests', 'image-runtime', 'docker-blackbox', 'browser-setup', 'browser-smoke', 'browser-files', 'admin-fixture', 'historical-ts-image', 'volume-rehearsal'];
  for (const name of planned) if (!report.groups.some(g => g.name === name)) report.groups.push({ name, status: 'skipped', reason: report.error ?? 'prerequisite did not complete' });
  report.cleanup = [];
  for (const name of containers.reverse()) {
    try { docker('rm', '-fv', name); report.cleanup.push({ container: name, removed: true }); }
    catch (error) { report.cleanup.push({ container: name, removed: false, error: String(error) }); }
  }
  for (const tag of tags) {
    try { docker('image', 'rm', tag); } catch (error) { report.cleanup.push({ tag, error: String(error) }); }
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.passed = !report.error && report.groups.every(g => g.status === 'passed') && report.cleanup.every(c => !c.error);
  await save();
}
if (!report.passed) process.exitCode = 1;
