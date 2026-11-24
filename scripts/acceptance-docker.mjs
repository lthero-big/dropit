// Black-box checks against the local dropit image. Nothing is published beyond loopback.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(import.meta.url));
const WebSocket = require('../apps/server/node_modules/ws');
const image = process.env.DROPIT_IMAGE ?? 'dropit:acceptance';
const expectedImageId = process.env.DROPIT_EXPECTED_IMAGE_ID?.trim() || '';
const expectedCommit = process.env.DROPIT_EXPECTED_COMMIT?.trim() || '';
const results = [];
const ownedContainers = new Set();

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('unable to allocate ephemeral loopback port');
  return port;
}

function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${detail}`);
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

async function waitFor(url) {
  const deadline = Date.now() + 30000;
  let last = 'not started';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${url} did not become ready: ${last}`);
}

function containerEnv(origin, extra, tight) {
  const limits = tight ? [
    'MAX_FILE_BYTES=256',
    'USER_QUOTA_BYTES=4096',
    'ROOM_MAX_FILE_BYTES=64',
    'ROOM_QUOTA_BYTES=1024',
    'ROOM_RETENTION_HOURS=24',
    'RETENTION_HOURS=168',
    'RATE_WINDOW_MS=60000',
    'RATE_GENERAL=120',
    'RATE_AUTH=3',
    'RATE_INVITE=5',
    'RATE_UPLOAD=40',
    'RATE_ROOM=12',
  ] : [
    'ROOM_RETENTION_HOURS=24',
    'RATE_GENERAL=400',
    'RATE_AUTH=40',
    'RATE_INVITE=20',
    'RATE_UPLOAD=80',
    'RATE_ROOM=30',
  ];
  return [
    '-e', 'HOST=0.0.0.0',
    '-e', 'PORT=8787',
    '-e', `APP_ORIGIN=${origin}`,
    '-e', 'DATA_DIR=/data',
    '-e', 'STATIC_DIR=/app/public',
    ...limits.flatMap((entry) => ['-e', entry]),
    ...extra.flatMap((entry) => ['-e', entry]),
  ];
}

async function startContainer(name, port, origin, extra, tight) {
  const started = await run('docker', [
    'run', '-d', '--name', name,
    '-p', `127.0.0.1:${port}:8787`,
    ...containerEnv(origin, extra, tight),
    image,
  ]);
  if (started.code !== 0) throw new Error(started.stderr || started.stdout);
  ownedContainers.add(name);
  if (expectedImageId) {
    const actualImage = await run('docker', ['inspect', '--format', '{{.Image}}', name]);
    if (actualImage.code !== 0 || actualImage.stdout.trim() !== expectedImageId) {
      throw new Error(`image drift for ${name}: expected ${expectedImageId}, got ${actualImage.stdout.trim()}`);
    }
  }
  return `http://127.0.0.1:${port}`;
}

async function stop(name) {
  if (!ownedContainers.has(name)) return;
  const removed = await run('docker', ['rm', '-fv', name]);
  if (removed.code !== 0) throw new Error(removed.stderr);
}
async function mkdirReport(dir) {
  await mkdir(dir, { recursive: true });
}

async function codeOf(response) {
  const body = await response.json().catch(() => ({}));
  return body?.error?.code ?? '';
}

async function checkProduction(base, origin, containerName) {
  const health = await fetch(`${base}/healthz`);
  const healthBody = await health.json();
  record('AC-H1 healthz', health.status === 200 && healthBody.status === 'ok', `status ${health.status}`);
  if (expectedCommit) {
    const versionRes = await fetch(`${base}/api/version`);
    const versionBody = await versionRes.json().catch(() => ({}));
    record('AC-H1 build commit binding', versionRes.status === 200 && versionBody.commit === expectedCommit.slice(0, 7) && versionBody.install === 'docker',
      `status ${versionRes.status} commit=${versionBody.commit ?? 'missing'} install=${versionBody.install ?? 'missing'}`);
  }
  const headers = health.headers;
  const csp = headers.get('content-security-policy') ?? '';
  record('AC-G4 headers', headers.get('x-content-type-options') === 'nosniff'
    && headers.get('x-frame-options') === 'DENY'
    && headers.get('referrer-policy') === 'no-referrer'
    && csp.includes("frame-ancestors 'none'")
    && csp.includes("default-src 'self'")
    && (headers.get('strict-transport-security') ?? '').includes('max-age='),
  `csp=${csp.includes('frame-ancestors') ? 'yes' : 'no'} hsts=${headers.get('strict-transport-security') ?? 'missing'}`);
  const page = await fetch(`${base}/`);
  const html = await page.text();
  record('AC-H1 static', page.status === 200 && page.headers.get('content-type')?.includes('text/html') && html.includes('id="root"'),
    `status ${page.status} type ${page.headers.get('content-type')}`);
  const asset = html.match(/\/assets\/[^"]+\.js/);
  record('AC-H1 asset', Boolean(asset), asset?.[0] ?? 'no script asset');
  if (asset) {
    const script = await fetch(`${base}${asset[0]}`);
    record('AC-H1 asset bytes', script.ok && (script.headers.get('content-type') ?? '').includes('javascript'),
      `status ${script.status}`);
  }
  const providers = await fetch(`${base}/api/auth/providers`);
  const providerBody = await providers.json();
  record('AC-A4 no mock on image', providers.status === 200 && Array.isArray(providerBody.providers) && providerBody.providers.length === 0,
    JSON.stringify(providerBody));
  const password = await fetch(`${base}/api/auth/password`);
  record('AC-A3 no password route', password.status === 404, `status ${password.status}`);
  const authStatuses = [];
  let retryAfter = '';
  for (let i = 0; i < 4; i += 1) {
    const response = await fetch(`${base}/api/auth/github`, { redirect: 'manual', headers: { 'x-forwarded-for': `203.0.113.${i + 1}` } });
    authStatuses.push(response.status);
    retryAfter = response.headers.get('retry-after') ?? retryAfter;
  }
  record('AC-A4 github absent without env', authStatuses[0] === 404, authStatuses.join(','));
  // /api/auth/password matches /api/auth/:provider and already spent one of RATE_AUTH=3.
  // The next two GitHub calls stay 404; the third is 429. Distinct X-Forwarded-For values share that bucket.
  record('AC-F1/G6 docker 429 ignores XFF', authStatuses[0] === 404 && authStatuses[1] === 404 && authStatuses[2] === 429 && authStatuses[3] === 429 && retryAfter !== '',
    `${authStatuses.join(',')} retry ${retryAfter}`);

  const evil = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { origin: 'https://attacker.example' } });
  record('AC-G1 cross-site room', evil.status === 403 && await codeOf(evil) === 'ORIGIN_REJECTED', `status ${evil.status}`);
  const missingOrigin = await fetch(`${base}/api/rooms`, { method: 'POST' });
  record('AC-G1 missing origin', missingOrigin.status === 403, `status ${missingOrigin.status}`);
  const roomResponse = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { origin } });
  const room = await roomResponse.json();
  const capability = typeof room.token === 'string' ? room.token : '';
  const capabilityShape = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(capability);
  const roomCode = typeof room.code === 'string' ? room.code : '';
  record('AC-E1 room capability', roomResponse.status === 201 && capabilityShape
    && /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz]{6}$/.test(roomCode)
    && room.expiresAt - Date.now() <= 24 * 3600 * 1000 + 5000,
    `status ${roomResponse.status} capability ${capabilityShape ? 'UUID.proof' : 'invalid'} code ${roomCode}`);
  const list = await fetch(`${base}/api/rooms`);
  record('AC-E1 no room list', list.status === 404, `status ${list.status}`);
  const unknown = await fetch(`${base}/api/rooms/not-a-real-room/items`);
  const unknownBody = await unknown.text();
  record('AC-E1 unknown room', unknown.status === 404 && unknownBody.includes('NOT_FOUND'), `status ${unknown.status}`);

  const upload = async (name, type, bytes) => fetch(`${base}/api/rooms/${room.token}/items/file`, {
    method: 'POST',
    headers: { origin, 'content-type': type, 'x-file-name': encodeURIComponent(name) },
    body: bytes,
  });
  const hostile = await upload('../..\\etc\\passwd\u0000.svg', 'image/svg+xml', '<svg onload="alert(1)"></svg>');
  const hostileBody = await hostile.json();
  const filename = hostileBody.item?.filename ?? '';
  record('AC-G5 filename', hostile.status === 201 && !/[\\/\u0000]/.test(filename) && hostileBody.item?.fileKey === undefined,
    `status ${hostile.status} name ${JSON.stringify(filename)}`);
  const download = await fetch(`${base}/api/rooms/${room.token}/items/${hostileBody.item.id}/download`);
  record('AC-G3 svg download', download.status === 200
    && (download.headers.get('content-disposition') ?? '').startsWith('attachment;')
    && download.headers.get('content-type') === 'application/octet-stream'
    && download.headers.get('x-content-type-options') === 'nosniff',
  `disposition ${download.headers.get('content-disposition')}`);
  const thumbnail = await fetch(`${base}/api/rooms/${room.token}/items/${hostileBody.item.id}/thumbnail`);
  const media = await fetch(`${base}/api/rooms/${room.token}/items/${hostileBody.item.id}/media`);
  record('AC-G3 svg not inline', thumbnail.status === 404 && media.status === 404, `thumb ${thumbnail.status} media ${media.status}`);
  const htmlUpload = await upload('clip.mp4', 'video/mp4', '<html><script>alert(1)</script></html>');
  const htmlItem = await htmlUpload.json();
  const htmlMedia = await fetch(`${base}/api/rooms/${room.token}/items/${htmlItem.item.id}/media`);
  record('AC-G3 html sniffed away', htmlUpload.status === 201 && htmlMedia.status === 404, `upload ${htmlUpload.status} media ${htmlMedia.status}`);
  const tooBig = await upload('big.bin', 'application/octet-stream', 'x'.repeat(80));
  record('AC-F2 room file limit', tooBig.status === 413 && await codeOf(tooBig) === 'FILE_TOO_LARGE', `status ${tooBig.status}`);
  const names = await run('docker', ['exec', containerName, 'sh', '-ec', 'ls -1 /data/files 2>/dev/null || true']);
  const stored = names.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  record('AC-G5 storage keys', names.code === 0 && stored.length > 0 && stored.every((name) => /^[0-9a-f-]{36}$/.test(name)),
    names.code !== 0 ? `exec exit ${names.code}: ${names.stderr.trim()}` : (stored.join(',') || 'no files'));

  const text = await fetch(`${base}/api/rooms/${room.token}/items/text`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ text: '<script>alert(1)</script>' }),
  });
  const textBody = await text.json();
  record('AC-G2 stored as json text', text.status === 201 && text.headers.get('content-type')?.includes('application/json') && textBody.item?.text === '<script>alert(1)</script>',
    `status ${text.status}`);

  const wsUrl = `ws://127.0.0.1:${new URL(base).port}/api/rooms/${room.token}/ws`;
  const deniedWs = await new Promise((resolve) => {
    const socket = new WebSocket(wsUrl, { origin: 'https://attacker.example' });
    socket.once('unexpected-response', (_req, response) => resolve(response.statusCode));
    socket.once('error', () => resolve('error'));
  });
  record('AC-C2/G1 ws origin', deniedWs === 403, `ws ${deniedWs}`);
  let delivered = false;
  let realtimeDetail = 'no message';
  try {
    delivered = await new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { origin });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('ws timeout'));
      }, 4000);
      let started = 0;
      let armed = false;
      const fail = (error) => {
        clearTimeout(timer);
        socket.terminate();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      socket.once('unexpected-response', (_req, response) => fail(new Error(`ws http ${response.statusCode}`)));
      socket.once('error', fail);
      socket.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); }
        catch (error) { fail(error); return; }
        if (!armed) {
          if (message.type !== 'snapshot') return;
          armed = true;
          started = performance.now();
          fetch(`${base}/api/rooms/${room.token}/items/text`, {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'live from docker' }),
          }).then(async (response) => {
            if (!response.ok) fail(new Error(`post ${response.status} ${(await response.text()).slice(0, 160)}`));
          }).catch(fail);
          return;
        }
        if (message.type === 'presence') return;
        clearTimeout(timer);
        socket.close();
        resolve(message.type === 'item.created' && message.item?.text === 'live from docker' && performance.now() - started < 1000);
      });
    });
    realtimeDetail = String(delivered);
  } catch (error) {
    realtimeDetail = error instanceof Error ? error.message : String(error);
  }
  record('AC-D1 docker realtime', delivered === true, realtimeDetail);

  const env = await run('docker', ['exec', containerName, 'sh', '-ec', 'printf "%s\\n%s\\n" "${GITHUB_CLIENT_SECRET:-}" "${GOOGLE_CLIENT_SECRET:-}"']);
  record('AC-A4 empty secrets in container', env.code === 0 && env.stdout.trim() === '',
    env.code !== 0 ? `exec exit ${env.code}: ${env.stderr.trim()}` : JSON.stringify(env.stdout));
  const inspected = await run('docker', ['inspect', '--format', '{{.HostConfig.PortBindings}}', containerName]);
  record('AC-H1 loopback publish', inspected.stdout.includes('127.0.0.1'), inspected.stdout.trim());
}

async function checkDevelopment(base) {
  const health = await fetch(`${base}/healthz`);
  record('AC-G4 no HSTS on local HTTP', health.ok && !health.headers.get('strict-transport-security'),
    health.headers.get('strict-transport-security') ?? 'absent');
  const page = await fetch(`${base}/login`);
  const html = await page.text();
  record('AC-I1 spa fallback', page.ok && html.includes('id="root"'), `status ${page.status}`);
}

const prefix = `dropit-accept-${process.pid}-${randomBytes(4).toString('hex')}`;
const prodName = `${prefix}-prod`;
const devName = `${prefix}-http`;
const prodPort = Number(process.env.DROPIT_ACCEPT_PROD_PORT) || await freePort();
const devPort = Number(process.env.DROPIT_ACCEPT_DEV_PORT) || await freePort();
try {
  const prodOrigin = `https://127.0.0.1:${prodPort}`;
  const prod = await startContainer(prodName, prodPort, prodOrigin, ['NODE_ENV=production'], true);
  await waitFor(prod);
  await checkProduction(prod, prodOrigin, prodName);
  const devOrigin = `http://127.0.0.1:${devPort}`;
  const dev = await startContainer(devName, devPort, devOrigin, ['NODE_ENV=development'], false);
  await waitFor(dev);
  await checkDevelopment(dev);
  const dir = process.argv[2] ?? join(tmpdir(), 'dropit-report');
  await mkdirReport(dir);
  await writeFile(join(dir, 'docker.json'), JSON.stringify(results, null, 2));
  console.log(`DEV_READY ${dev}`);
  console.log(`REPORT ${join(dir, 'docker.json')}`);
} finally {
  const dir = process.argv[2] ?? join(tmpdir(), 'dropit-report');
  await mkdirReport(dir);
  await writeFile(join(dir, 'docker.json'), JSON.stringify(results, null, 2));
  await stop(prodName);
  await stop(devName);
}

const failed = results.filter((item) => !item.pass);
if (failed.length) {
  console.error(`docker acceptance failed: ${failed.map((item) => item.id).join(', ')}`);
  process.exit(1);
}
