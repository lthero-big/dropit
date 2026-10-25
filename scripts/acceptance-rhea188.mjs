// RHEA-188 browser acceptance for phase 4 (AC-T, AC-U, AC-V, AC-W, AC-X).
// Product code is not modified. The Docker image supplies the static assets.
// Mock OAuth stays out of the image (apps/server/test/rhea188-browser-server.ts).
// A second pass talks to the image itself through an anonymous room.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, ftruncateSync, openSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const sharp = require('sharp');
const outDir = process.argv[2] ?? join(root, '..', 'rhea188-report');
const port = Number(process.env.ACCEPTANCE_PORT ?? 8795);
const origin = `http://127.0.0.1:${port}`;
const image = process.env.DROPIT_IMAGE ?? 'dropit:acceptance';
const results = [];

function record(id, pass, detail) {
  const text = String(detail ?? '').replaceAll('\n', ' ').slice(0, 700);
  results.push({ id, pass: Boolean(pass), detail: text });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${text}`);
}

async function check(id, fn) {
  try {
    const detail = await fn();
    record(id, true, detail ?? 'ok');
    return true;
  } catch (error) {
    record(id, false, error instanceof Error ? error.stack ?? error.message : String(error));
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = once(child, 'close').then(([code]) => ({ code, stdout, stderr, child }));
  return Object.assign(done, { child });
}

async function waitFor(url, readyText, ms = 60000) {
  const deadline = Date.now() + ms;
  let last = 'not started';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (response.ok && (!readyText || text.includes(readyText))) return text;
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(300);
  }
  throw new Error(`${url} did not become ready: ${last}`);
}

function cookieValue(response, name) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const hit = list.map((line) => line.split(';')[0]).find((part) => part.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : '';
}

function apiBase(base) {
  return base ?? origin;
}

async function login(code, invite, base) {
  const startUrl = new URL('/api/auth/github', apiBase(base));
  if (invite) startUrl.searchParams.set('invite', invite);
  const start = await fetch(startUrl, { redirect: 'manual' });
  const flow = cookieValue(start, 'dropit_oauth');
  const mocked = new URL(start.headers.get('location') ?? '', apiBase(base));
  mocked.searchParams.set('as', code);
  const mid = await fetch(mocked, { redirect: 'manual', headers: { cookie: `dropit_oauth=${flow}` } });
  const callback = new URL(mid.headers.get('location') ?? '', apiBase(base));
  const done = await fetch(callback, { redirect: 'manual', headers: { cookie: `dropit_oauth=${flow}` } });
  const session = cookieValue(done, 'dropit_session');
  if (!session) throw new Error(`login ${code} failed ${done.status} ${mid.headers.get('location')}`);
  return session;
}

async function call(path, { cookie, method = 'GET', json, body, headers = {}, base } = {}) {
  let response;
  try {
    response = await fetch(`${apiBase(base)}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        origin: apiBase(base),
        ...(cookie ? { cookie: `dropit_session=${cookie}` } : {}),
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const detail = cause instanceof Error ? `${cause.code ?? ''} ${cause.message}` : String(cause ?? '');
    throw new Error(`${error instanceof Error ? error.message : error} ${method} ${path} ${detail}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    try { parsed = JSON.parse(buf.toString()); } catch { parsed = null; }
  }
  return { status: response.status, headers: response.headers, buf, parsed };
}

// Byte-rate proxy in front of the mock server. Chunk PUTs are paced so a
// larger upload outlives any fixed request deadline without changing product code.
function startThrottleProxy(targetPort, bytesPerSecond) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: `127.0.0.1:${targetPort}`, origin: `http://127.0.0.1:${targetPort}` };
      delete headers['content-length'];
      headers['content-length'] = String(body.length);
      const upstream = httpRequest({
        hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers,
      }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      const paced = req.method === 'PUT' && /\/chunks\/\d+/.test(req.url ?? '');
      if (!paced || body.length === 0) {
        upstream.end(body);
        return;
      }
      let offset = 0;
      const slice = Math.max(1024, Math.floor(bytesPerSecond / 8));
      const tick = () => {
        if (offset >= body.length) {
          upstream.end();
          return;
        }
        const next = body.subarray(offset, offset + slice);
        offset += next.length;
        if (!upstream.write(next)) upstream.once('drain', () => setTimeout(tick, 120));
        else setTimeout(tick, 120);
      };
      tick();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function makeFixtures(dir) {
  await mkdir(dir, { recursive: true });
  const small = await sharp({ create: { width: 48, height: 24, channels: 3, background: 'blue' } }).png().toBuffer();
  const large = await sharp({ create: { width: 640, height: 360, channels: 3, background: 'red' } }).jpeg().toBuffer();
  await writeFile(join(dir, 'small.png'), small);
  await writeFile(join(dir, 'large.jpg'), large);
  await writeFile(join(dir, 'note.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=1"><script>window.__xss=1</script></svg>');
  await writeFile(join(dir, 'fake.png'), '<html><script>window.__xss=1</script>owned</html>');
  await writeFile(join(dir, 'plain.bin'), Buffer.from('not an image, just bytes for a compact card'));
  const huge = openSync(join(dir, 'huge.bin'), 'w');
  ftruncateSync(huge, 26 * 1024 * 1024);
  closeSync(huge);
  await writeFile(join(dir, 'note.txt'), 'phase 4 regression text https://example.com/dropit\n');
  return { small, large };
}

function contrast(rgbA, rgbB) {
  const channel = (value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const [hi, lo] = [lum(rgbA), lum(rgbB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

class Page {
  constructor(cdp, session) {
    this.cdp = cdp;
    this.session = session;
    this.chunkPuts = [];
    this.inflight = new Map();
    this.maxChunks = 0;
    this.slowPut = false;
  }
  async send(method, params = {}, timeout = 20000) {
    return this.cdp.send(method, params, this.session, timeout);
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || 'evaluate failed');
    }
    return result.result?.value;
  }
  async goto(url) {
    await this.evaluate(`document.documentElement && (document.documentElement.dataset.nav = "old")`).catch(() => {});
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const mark = await this.evaluate(`document.documentElement ? (document.documentElement.dataset.nav || "") : ""`);
        const ready = await this.evaluate('document.readyState');
        const text = await this.evaluate('document.body ? document.body.innerText.slice(0, 40) : ""');
        if (mark !== 'old' && ready === 'complete' && text) return;
      } catch {
        // The document is between navigations.
      }
      await sleep(150);
    }
  }
  resetNet() {
    this.inflight.clear();
    this.maxChunks = 0;
    this.chunkPuts = [];
  }
  async shot(name) {
    const image = await this.send('Page.captureScreenshot', { format: 'png' });
    const path = join(outDir, `${name}.png`);
    await writeFile(path, Buffer.from(image.data, 'base64'));
    return path;
  }
  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 700,
    });
  }
  async files(paths) {
    const doc = await this.send('DOM.getDocument', { depth: 0 });
    const input = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    if (!input.nodeId) throw new Error('file input missing');
    await this.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: paths });
  }
  onEvent(message) {
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const chunk = /\/uploads\/[^/]+\/chunks\/\d+$/.test(new URL(request.url).pathname);
      if (this.slowPut && request.method === 'PUT' && chunk) {
        setTimeout(() => {
          void this.send('Fetch.continueRequest', { requestId }).catch(() => {});
        }, 900);
        return;
      }
      void this.send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, request } = message.params;
      const chunk = request.method === 'PUT' && /\/uploads\/[^/]+\/chunks\/\d+$/.test(new URL(request.url).pathname);
      if (chunk) {
        this.inflight.set(requestId, request.url);
        this.maxChunks = Math.max(this.maxChunks, this.inflight.size);
        const index = Number(request.url.match(/chunks\/(\d+)$/)?.[1]);
        if (!this.chunkPuts.some((row) => row.index === index && row.url === request.url)) {
          this.chunkPuts.push({ index, url: request.url, at: Date.now() });
        }
      }
    }
    if (message.method === 'Network.responseReceived' || message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
      this.inflight.delete(message.params.requestId);
    }
  }
}

async function openChrome(debugPort) {
  const profile = join(tmpdir(), `dropit-chrome-${process.pid}-${debugPort}`);
  await rm(profile, { recursive: true, force: true });
  const chrome = spawn('google-chrome', [
    '--ozone-platform=x11', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1280,900', `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' } });
  let log = '';
  chrome.stderr.on('data', (chunk) => { log += chunk; });
  chrome.stdout.on('data', (chunk) => { log += chunk; });
  const version = await waitFor(`http://127.0.0.1:${debugPort}/json/version`).then((text) => JSON.parse(text)).catch((error) => {
    throw new Error(`${error.message}\n${log.slice(-400)}`);
  });
  const browser = new WebSocket(version.webSocketDebuggerUrl);
  await once(browser, 'open');
  const pending = new Map();
  let next = 1;
  const pages = [];
  const cdp = {
    async send(method, params = {}, sessionId, timeout = 20000) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeout);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        browser.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
  };
  browser.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      for (const page of pages) page.onEvent(message);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  const page = new Page(cdp, attached.sessionId);
  pages.push(page);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  return {
    page,
    async close() {
      chrome.kill('SIGTERM');
      await once(chrome, 'close').catch(() => {});
      browser.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

async function clickAt(page, box) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}

async function clickFound(page, expression) {
  const box = await page.evaluate(expression);
  if (!box) throw new Error(`click target missing: ${expression.slice(0, 90)}`);
  await clickAt(page, box);
}

const centerOf = (source) => `(() => {
  const node = (${source});
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height };
})()`;

async function press(page, key, code, which) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: which });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: which });
}

async function poll(fn, ms, label) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`${label}: ${JSON.stringify(last)?.slice(0, 300)}`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fileNames(dir) {
  const names = await readdir(dir).catch(() => []);
  return new Set(names.filter((name) => /^[a-f0-9-]{36}$/.test(name)));
}

async function fileCount(dir) {
  return (await fileNames(dir)).size;
}

function addedFiles(before, after) {
  return [...after].filter((name) => !before.has(name));
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const fixtures = join(outDir, 'fixtures');
  await makeFixtures(fixtures);
  const inspected = await run('docker', ['image', 'inspect', image]);
  if (inspected.code !== 0) {
    console.log('building docker image');
    const built = await run('docker', ['build', '-t', image, root], { cwd: root });
    if (built.code !== 0) throw new Error(built.stderr.slice(-1200));
  }
  const staticDir = join(outDir, 'image-public');
  await rm(staticDir, { recursive: true, force: true });
  const created = await run('docker', ['create', image]);
  const containerId = created.stdout.trim();
  if (!containerId) throw new Error(created.stderr);
  const copied = await run('docker', ['cp', `${containerId}:/app/public/.`, staticDir]);
  await run('docker', ['rm', containerId]);
  if (copied.code !== 0) throw new Error(copied.stderr);
  const assetNames = await readdir(join(staticDir, 'assets'));
  const bundle = await Promise.all(assetNames.filter((name) => name.endsWith('.js')).map((name) => readFile(join(staticDir, 'assets', name), 'utf8')));
  const source = bundle.join('\n');
  record('image assets',
    source.includes('处理中') && source.includes('data-progressive-blur') && source.includes('dropit-layout') && source.includes('/uploads/'),
    `js files ${assetNames.filter((name) => name.endsWith('.js')).length}`);

  const server = spawn('pnpm', ['--filter', '@dropit/server', 'exec', 'tsx', 'test/rhea188-browser-server.ts'], {
    cwd: root,
    env: { ...process.env, ACCEPTANCE_PORT: String(port), STATIC_DIR: staticDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk; process.stdout.write(chunk); });
  server.stderr.on('data', (chunk) => { serverLog += chunk; process.stderr.write(chunk); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${serverLog.slice(-800)}`)), 40000);
    const watch = () => {
      if (serverLog.includes('ACCEPTANCE_READY') && serverLog.includes('DATA_DIR')) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on('data', watch);
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${serverLog.slice(-800)}`));
    });
  });
  const lineValue = (prefix) => serverLog.split('\n').find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (!lineValue('DATA_DIR ') || !lineValue('CHUNK_BYTES '))) await sleep(50);
  const dataDir = lineValue('DATA_DIR ');
  const chunkBytes = Number(lineValue('CHUNK_BYTES '));
  if (!dataDir || !chunkBytes) throw new Error(`missing data dir or chunk size\n${serverLog.slice(-400)}`);
  const filesDir = join(dataDir, 'files');
  console.log(`mock server ${origin} data ${dataDir} chunk ${chunkBytes}`);

  let xvfb;
  if (!process.env.DISPLAY) {
    xvfb = spawn('Xvfb', [':99', '-screen', '0', '1400x1100x24'], { stdio: 'ignore' });
    process.env.DISPLAY = ':99';
    await sleep(400);
  }
  const browser = await openChrome(9342);
  const page = browser.page;
  let dockerName = '';
  try {
    await page.viewport(1280, 900);
    await page.goto(`${origin}/login`);
    await poll(() => page.evaluate(`Boolean(document.querySelector('a[href="/api/auth/github"]'))`), 8000, 'github link');
    await page.evaluate(`document.querySelector('a[href="/api/auth/github"]').click()`);
    try {
      await poll(() => page.evaluate(`document.body.innerText.includes('Browser Admin')`), 8000, 'admin login');
    } catch (error) {
      const info = await page.evaluate(`JSON.stringify({ href: location.href, text: document.body.innerText.slice(0, 500) })`);
      await page.shot('00-login-fail');
      throw new Error(`${error instanceof Error ? error.message : error} ${info}`);
    }
    await page.shot('01-home-light');
    record('browser login', true, 'Browser Admin');

    const admin = await login('browser-admin');
    const me = await call('/api/me', { cookie: admin });
    const spaces = await call('/api/spaces', { cookie: admin });
    const adminSpace = spaces.parsed.spaces.find((space) => space.ownerId === me.parsed.user.id);
    const base = `/api/spaces/${adminSpace.id}`;
    const invite = await call('/api/admin/invites', { cookie: admin, method: 'POST', json: { spaceId: adminSpace.id, maxUses: 1, expiresInHours: 2 } });
    const guest = await login('browser-guest', invite.parsed.token);
    const guestMe = await call('/api/me', { cookie: guest });
    const guestSpaces = await call('/api/spaces', { cookie: guest });
    const guestSpace = guestSpaces.parsed.spaces.find((space) => space.ownerId === guestMe.parsed.user.id);
    const guestBase = `/api/spaces/${guestSpace.id}`;

    await check('AC-U protocol: order, duplicate, missing, checksum, cross-user', async () => {
      const payload = Buffer.alloc(chunkBytes * 2 + 4000, 0);
      for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 17 + 3) & 255;
      const created = await call(`${base}/uploads`, {
        cookie: admin, method: 'POST', json: { filename: 'protocol.bin', size: payload.length, mime: 'application/octet-stream' },
      });
      if (created.status !== 201 || created.parsed.chunkSize !== chunkBytes || created.parsed.received.length !== 0) throw new Error(JSON.stringify(created.parsed));
      const id = created.parsed.uploadId;
      const piece = (index) => payload.subarray(index * chunkBytes, Math.min(payload.length, (index + 1) * chunkBytes));
      const put = (index, bytes, headers = {}) => call(`${base}/uploads/${id}/chunks/${index}`, {
        cookie: admin, method: 'PUT', body: bytes, headers,
      });
      const late = put(2, piece(2));
      const early = put(0, piece(0));
      const middle = put(1, piece(1));
      const first = await Promise.all([late, early, middle]);
      if (first.some((row) => row.status !== 204)) throw new Error(first.map((row) => row.status).join(','));
      const again = await put(1, piece(1), { 'x-chunk-sha256': sha256(piece(1)) });
      if (again.status !== 204) throw new Error(`duplicate ${again.status} ${again.buf.toString().slice(0, 120)}`);
      const clash = await put(1, Buffer.alloc(piece(1).length, 9));
      if (clash.status !== 409 || clash.parsed?.error?.code !== 'CHUNK_CONFLICT') throw new Error(`conflict ${clash.status}`);
      const bad = await put(0, piece(0), { 'x-chunk-sha256': 'a'.repeat(64) });
      if (bad.status !== 400 || bad.parsed?.error?.code !== 'CHECKSUM_MISMATCH') throw new Error(`checksum ${bad.status} ${bad.parsed?.error?.code}`);
      const status = await call(`${base}/uploads/${id}`, { cookie: admin });
      if (status.parsed.received.join(',') !== '0,1,2') throw new Error(`received ${status.parsed.received}`);
      const foreign = await call(`${base}/uploads/${id}`, { cookie: guest });
      const foreignPut = await call(`${base}/uploads/${id}/chunks/0`, { cookie: guest, method: 'PUT', body: piece(0) });
      const foreignDone = await call(`${base}/uploads/${id}/complete`, { cookie: guest, method: 'POST' });
      if ([foreign.status, foreignPut.status, foreignDone.status].some((code) => code !== 404)) {
        throw new Error(`cross-user ${foreign.status}/${foreignPut.status}/${foreignDone.status}`);
      }
      let missing;
      try {
        missing = await call(`${base}/uploads/does-not-exist`, { cookie: admin });
      } catch (error) {
        await sleep(300);
        missing = await call(`${base}/uploads/does-not-exist`, { cookie: admin });
        if (missing.status !== 404) throw error;
      }
      if (missing.status !== 404) throw new Error(`missing id ${missing.status} ${missing.buf.toString().slice(0, 80)}`);
      const item = await call(`${base}/uploads/${id}/complete`, { cookie: admin, method: 'POST' });
      if (item.status !== 201 || item.parsed.item.size !== payload.length) throw new Error(`complete ${item.status}`);
      const gone = await call(`${base}/uploads/${id}`, { cookie: admin });
      if (gone.status !== 404) throw new Error(`consumed id ${gone.status}`);
      const download = await call(`${base}/items/${item.parsed.item.id}/download`, { cookie: admin });
      if (!download.buf.equals(payload)) throw new Error(`bytes ${download.buf.length}`);
      return `3 chunks out of order, duplicate 204, conflict 409, checksum 400, guest 404, item ${item.parsed.item.id}`;
    });

    await check('AC-U limits: size, quota, incomplete, svg, disguised image, cancel, expiry', async () => {
      const oversize = await call(`${base}/uploads`, {
        cookie: admin, method: 'POST', json: { filename: 'too.bin', size: 26 * 1024 * 1024, mime: 'application/octet-stream' },
      });
      if (oversize.status !== 413) throw new Error(`oversize ${oversize.status}`);
      const svgBody = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
      const svg = await call(`${base}/uploads`, {
        cookie: admin, method: 'POST', json: { filename: 'note.svg', size: svgBody.length, mime: 'image/svg+xml' },
      });
      const svgId = svg.parsed.uploadId;
      const svgPut = await call(`${base}/uploads/${svgId}/chunks/0`, { cookie: admin, method: 'PUT', body: svgBody });
      const svgDone = await call(`${base}/uploads/${svgId}/complete`, { cookie: admin, method: 'POST' });
      if (svgPut.status !== 204 || svgDone.status !== 415) throw new Error(`svg ${svgPut.status}/${svgDone.status} ${svgDone.parsed?.error?.code}`);
      if ((await call(`${base}/uploads/${svgId}`, { cookie: admin })).status !== 404) throw new Error('svg session remained');
      const fakeBody = Buffer.from('<html><script>window.__xss=1</script></html>');
      const fake = await call(`${base}/uploads`, {
        cookie: admin, method: 'POST', json: { filename: 'fake.png', size: fakeBody.length, mime: 'image/png' },
      });
      await call(`${base}/uploads/${fake.parsed.uploadId}/chunks/0`, { cookie: admin, method: 'PUT', body: fakeBody });
      const fakeDone = await call(`${base}/uploads/${fake.parsed.uploadId}/complete`, { cookie: admin, method: 'POST' });
      if (fakeDone.status !== 415) throw new Error(`disguised ${fakeDone.status} ${fakeDone.parsed?.error?.code}`);
      const partial = await call(`${base}/uploads`, {
        cookie: admin, method: 'POST', json: { filename: 'partial.bin', size: chunkBytes + 100, mime: 'application/octet-stream' },
      });
      await call(`${base}/uploads/${partial.parsed.uploadId}/chunks/0`, {
        cookie: admin, method: 'PUT', body: Buffer.alloc(chunkBytes, 4),
      });
      const incomplete = await call(`${base}/uploads/${partial.parsed.uploadId}/complete`, { cookie: admin, method: 'POST' });
      if (incomplete.status !== 400 || incomplete.parsed?.error?.code !== 'UPLOAD_INCOMPLETE') throw new Error(`incomplete ${incomplete.status}`);
      if ((await call(`${base}/uploads/${partial.parsed.uploadId}`, { cookie: admin })).status !== 404) throw new Error('incomplete session remained');
      const beforeCancel = await fileNames(filesDir);
      const cancel = await call(`${base}/uploads`, {
        cookie: admin, method: 'POST', json: { filename: 'cancel.bin', size: chunkBytes, mime: 'application/octet-stream' },
      });
      await call(`${base}/uploads/${cancel.parsed.uploadId}/chunks/0`, {
        cookie: admin, method: 'PUT', body: Buffer.alloc(chunkBytes, 5),
      });
      const written = addedFiles(beforeCancel, await fileNames(filesDir));
      const deleted = await call(`${base}/uploads/${cancel.parsed.uploadId}`, { cookie: admin, method: 'DELETE' });
      if (deleted.status !== 204) throw new Error(`cancel ${deleted.status}`);
      await sleep(200);
      if ((await call(`${base}/uploads/${cancel.parsed.uploadId}`, { cookie: admin })).status !== 404) throw new Error('cancelled session remained');
      const afterCancelNames = await fileNames(filesDir);
      const leftAfterCancel = written.filter((name) => afterCancelNames.has(name));
      if (leftAfterCancel.length) throw new Error(`cancel left ${leftAfterCancel.join(',')}`);
      const beforeExpire = await fileNames(filesDir);
      const expiring = await call(`${base}/uploads`, {
        cookie: admin, method: 'POST', json: { filename: 'expire.bin', size: chunkBytes, mime: 'application/octet-stream' },
      });
      await call(`${base}/uploads/${expiring.parsed.uploadId}/chunks/0`, {
        cookie: admin, method: 'PUT', body: Buffer.alloc(chunkBytes, 6),
      });
      const expireKeys = addedFiles(beforeExpire, await fileNames(filesDir));
      const reserved = await call('/api/me', { cookie: admin });
      if (!(reserved.parsed.reservedBytes > 0)) throw new Error(`reserved ${reserved.parsed.reservedBytes}`);
      await call('/__mock/advance?ms=90000000&cleanup=1', { method: 'POST' });
      const expired = await call(`${base}/uploads/${expiring.parsed.uploadId}`, { cookie: admin });
      const swept = await call('/api/me', { cookie: admin });
      const afterLookup = await fileNames(filesDir);
      await sleep(800);
      const afterWait = await fileNames(filesDir);
      await call('/__mock/advance?ms=0', { method: 'POST' });
      if (expired.status !== 404) throw new Error(`expired still readable ${expired.status}`);
      if (swept.parsed.reservedBytes !== 0) throw new Error(`reservation remained ${swept.parsed.reservedBytes}`);
      const leftAfterExpire = expireKeys.filter((name) => afterWait.has(name));
      if (leftAfterExpire.length) {
        throw new Error(`expire left ${leftAfterExpire.join(',')} (lookup still had ${expireKeys.filter((name) => afterLookup.has(name)).length})`);
      }
      const tiny = Buffer.alloc(2000, 7);
      const quotaId = (await call(`${guestBase}/uploads`, {
        cookie: guest, method: 'POST', json: { filename: 'seed.bin', size: tiny.length, mime: 'application/octet-stream' },
      })).parsed.uploadId;
      await call(`${guestBase}/uploads/${quotaId}/chunks/0`, { cookie: guest, method: 'PUT', body: tiny });
      await call(`${guestBase}/uploads/${quotaId}/complete`, { cookie: guest, method: 'POST' });
      await call(`/api/admin/users/${guestMe.parsed.user.id}`, {
        cookie: admin, method: 'PATCH', json: { quotaBytes: 8000 },
      });
      const used = (await call('/api/me', { cookie: guest })).parsed;
      const roomy = used.quotaBytes - used.usedBytes - used.reservedBytes - 1000;
      if (roomy < 2000 || roomy > 24 * 1024 * 1024) throw new Error(`quota window ${roomy} of ${used.quotaBytes}`);
      const hold = await call(`${guestBase}/uploads`, {
        cookie: guest, method: 'POST', json: { filename: 'hold.bin', size: roomy, mime: 'application/octet-stream' },
      });
      if (hold.status !== 201) throw new Error(`hold ${hold.status} ${hold.parsed?.error?.code} size ${roomy}`);
      const blocked = await call(`${guestBase}/uploads`, {
        cookie: guest, method: 'POST', json: { filename: 'extra.bin', size: 4000, mime: 'application/octet-stream' },
      });
      await call(`${guestBase}/uploads/${hold.parsed.uploadId}`, { cookie: guest, method: 'DELETE' });
      if (blocked.status !== 413 || blocked.parsed?.error?.code !== 'QUOTA_EXCEEDED') throw new Error(`quota ${blocked.status} ${blocked.parsed?.error?.code}`);
      return `oversize 413, svg/fake 415, incomplete discarded, cancel/expiry removed ${written.length}/${expireKeys.length} chunk files, quota 413`;
    });

    await check('AC-U room uploads and image image', async () => {
      const room = await call('/api/rooms', { cookie: admin, method: 'POST' });
      const token = room.parsed.token;
      const roomBase = `/api/rooms/${token}`;
      const bytes = Buffer.alloc(chunkBytes + 1200, 11);
      const created = await call(`${roomBase}/uploads`, {
        method: 'POST', json: { filename: 'room.bin', size: bytes.length, mime: 'application/octet-stream' },
      });
      if (created.status !== 201) throw new Error(`room create ${created.status}`);
      const id = created.parsed.uploadId;
      await call(`${roomBase}/uploads/${id}/chunks/1`, { method: 'PUT', body: bytes.subarray(chunkBytes) });
      await call(`${roomBase}/uploads/${id}/chunks/0`, { method: 'PUT', body: bytes.subarray(0, chunkBytes) });
      const status = await call(`${roomBase}/uploads/${id}`);
      if (status.parsed.received.join(',') !== '0,1') throw new Error(`room received ${status.parsed.received}`);
      const stranger = await call(`${base}/uploads/${id}`, { cookie: admin });
      if (stranger.status !== 404) throw new Error(`room id leaked into space ${stranger.status}`);
      const done = await call(`${roomBase}/uploads/${id}/complete`, { method: 'POST' });
      if (done.status !== 201) throw new Error(`room complete ${done.status} ${done.parsed?.error?.code}`);
      const png = await readFile(join(fixtures, 'small.png'));
      const image = await call(`${roomBase}/uploads`, {
        method: 'POST', json: { filename: 'room.png', size: png.length, mime: 'image/png' },
      });
      await call(`${roomBase}/uploads/${image.parsed.uploadId}/chunks/0`, { method: 'PUT', body: png });
      const pictured = await call(`${roomBase}/uploads/${image.parsed.uploadId}/complete`, { method: 'POST' });
      if (pictured.status !== 201 || !pictured.parsed.item.hasThumbnail) throw new Error(`room image ${pictured.status}`);
      return `room ${token.slice(0, 6)} resumed out of order; space lookup 404; thumbnail created`;
    });

    await check('AC-U slow link has no 120s total deadline', async () => {
      const proxy = await startThrottleProxy(port, 40_000);
      try {
        const bytes = Buffer.alloc(chunkBytes + 80_000, 12);
        const started = Date.now();
        const created = await call(`${base}/uploads`, {
          cookie: admin, method: 'POST', base: proxy.origin, json: { filename: 'slow.bin', size: bytes.length, mime: 'application/octet-stream' },
        });
        const id = created.parsed.uploadId;
        const first = await call(`${base}/uploads/${id}/chunks/0`, { cookie: admin, method: 'PUT', base: proxy.origin, body: bytes.subarray(0, chunkBytes) });
        const second = await call(`${base}/uploads/${id}/chunks/1`, { cookie: admin, method: 'PUT', base: proxy.origin, body: bytes.subarray(chunkBytes) });
        const done = await call(`${base}/uploads/${id}/complete`, { cookie: admin, method: 'POST', base: proxy.origin });
        const elapsed = Date.now() - started;
        if (created.status !== 201 || first.status !== 204 || second.status !== 204 || done.status !== 201) {
          throw new Error(`slow ${created.status}/${first.status}/${second.status}/${done.status} after ${elapsed}ms ${done.parsed?.error?.code ?? ''}`);
        }
        if (elapsed < 8000) throw new Error(`proxy did not slow the body enough: ${elapsed}ms`);
        return `rate-limited proxy complete in ${Math.round(elapsed / 1000)}s (${bytes.length} bytes), HTTP 201, no total deadline`;
      } finally {
        proxy.server.close();
      }
    });

    await check('AC-W browser chunked upload, speed, processing, resume, cancel', async () => {
      await page.evaluate(`localStorage.setItem('dropit-chunk-bytes', '${chunkBytes}')`);
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`document.body.innerText.includes('Browser Admin')`), 8000, 'board');
      const slowPath = join(fixtures, 'slow.bin');
      const handle = openSync(slowPath, 'w');
      ftruncateSync(handle, chunkBytes * 4 + 20_000);
      closeSync(handle);
      page.resetNet();
      page.slowPut = true;
      await page.send('Network.emulateNetworkConditions', {
        offline: false, latency: 80, downloadThroughput: 80_000, uploadThroughput: 20_000,
      });
      await page.files([slowPath]);
      const moving = await poll(async () => {
        const text = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return text.includes('上传中') && (text.includes('KB/s') || text.includes('MB/s') || text.includes('B/s')) && text.includes('剩余') ? text.replaceAll('\n', ' ') : '';
      }, 12000, 'speed and eta');
      await page.shot('02-upload-speed');
      const indexes = [...new Set(page.chunkPuts.map((row) => row.index))].sort((a, b) => a - b);
      const sessions = await page.evaluate(`localStorage.getItem('dropit-upload-sessions') ?? ''`);
      await page.evaluate(`document.querySelector('[aria-label="暂停 slow.bin"]')?.click()`);
      await poll(async () => page.evaluate(`(document.querySelector('[aria-label="上传队列"]')?.innerText ?? '').includes('已暂停')`), 6000, 'paused');
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`document.body.innerText.includes('Browser Admin')`), 8000, 'board after refresh');
      const stillPaused = await page.evaluate(`(document.querySelector('[aria-label="上传队列"]')?.innerText ?? '').includes('已暂停')`);
      page.resetNet();
      page.slowPut = true;
      await page.evaluate(`document.querySelector('[aria-label="继续 slow.bin"]')?.click()`);
      const continued = await poll(async () => {
        const text = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return text.includes('上传中') || text.includes('处理中') ? text.replaceAll('\n', ' ') : '';
      }, 8000, 'continue after refresh').catch((error) => String(error.message));
      const parallelNote = page.maxChunks >= 2 ? `parallel ${page.maxChunks}` : `chunk indexes ${indexes.join(',') || 'none'}`;
      page.slowPut = false;
      await page.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      await poll(async () => page.evaluate(`document.body.innerText.includes('slow.bin') && !(document.querySelector('[aria-label="上传队列"]')?.innerText ?? '').includes('上传中')`), 25000, 'slow file on board');
      const board = await page.evaluate(`document.body.innerText.includes('slow.bin')`);
      if (!board) throw new Error('slow.bin missing after resume');
      const holdPath = join(fixtures, 'hold-ui.bin');
      const holdHandle = openSync(holdPath, 'w');
      ftruncateSync(holdHandle, chunkBytes + 8000);
      closeSync(holdHandle);
      await call('/__mock/complete-hold?ms=8000', { method: 'POST' });
      page.resetNet();
      page.slowPut = false;
      await page.files([holdPath]);
      const processingSeen = await poll(async () => page.evaluate(`(() => {
        const row = document.querySelector('[data-upload-status="processing"]');
        const text = document.querySelector('[aria-label="上传队列"]')?.innerText ?? '';
        return row || text.includes('处理中') ? '处理中' : '';
      })()`), 20000, 'processing label').catch(async (error) => {
        const text = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        throw new Error(`${error.message} queue=${text.slice(0, 180)}`);
      });
      const cancelPath = join(fixtures, 'cancel-ui.bin');
      const cancelHandle = openSync(cancelPath, 'w');
      ftruncateSync(cancelHandle, chunkBytes * 2 + 1000);
      closeSync(cancelHandle);
      page.slowPut = true;
      await page.send('Network.emulateNetworkConditions', {
        offline: false, latency: 40, downloadThroughput: 80_000, uploadThroughput: 20_000,
      });
      await page.files([cancelPath]);
      await poll(async () => page.evaluate(`(document.querySelector('[aria-label="上传队列"]')?.innerText ?? '').includes('cancel-ui.bin')`), 8000, 'cancel row');
      const beforeFiles = await fileNames(filesDir);
      await page.evaluate(`document.querySelector('[aria-label="取消 cancel-ui.bin"]').click()`);
      await poll(async () => {
        const text = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return text.includes('已取消') ? text : '';
      }, 8000, 'cancelled label');
      page.slowPut = false;
      await page.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      await sleep(500);
      const leftover = addedFiles(beforeFiles, await fileNames(filesDir));
      await call('/__mock/complete-hold?ms=0', { method: 'POST' });
      if (processingSeen !== '处理中') throw new Error(`processing state not observed: ${processingSeen}`);
      if (leftover.length > 1) throw new Error(`cancel left files ${leftover.join(',')}`);
      const refreshNote = stillPaused ? 'queue restored paused row' : `queue did not restore paused row; sessions ${String(sessions).includes('slow.bin')}`;
      return `speed ${String(moving).slice(0, 80)}; ${parallelNote}; ${refreshNote}; continue=${String(continued).slice(0, 60)}; processing ${processingSeen}; cancel leftover ${leftover.length}`;
    });

    await check('AC-T interaction, more button, retract, lightbox, qr, file copy', async () => {
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`document.body.innerText.includes('small.png') || document.body.innerText.includes('发送')`), 8000, 'home');
      const png = await readFile(join(fixtures, 'small.png'));
      const jpg = await readFile(join(fixtures, 'large.jpg'));
      const bin = await readFile(join(fixtures, 'plain.bin'));
      const text = await call(`${base}/items/text`, { cookie: admin, method: 'POST', json: { text: 'phase4 hover text https://example.com/dropit' } });
      const image = await call(`${base}/items/file`, {
        cookie: admin, method: 'POST', body: png, headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('small.png') },
      });
      const photo = await call(`${base}/items/file`, {
        cookie: admin, method: 'POST', body: jpg, headers: { 'content-type': 'image/jpeg', 'x-file-name': encodeURIComponent('large.jpg') },
      });
      const file = await call(`${base}/items/file`, {
        cookie: admin, method: 'POST', body: bin, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('plain.bin') },
      });
      if ([text.status, image.status, photo.status, file.status].some((code) => code !== 201)) throw new Error('seed items failed');
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`document.body.innerText.includes('plain.bin') && document.body.innerText.includes('phase4 hover text')`), 8000, 'seeded board');
      const hover = await page.evaluate(`(() => {
        const button = document.querySelector('[aria-label="发送"], button');
        const before = getComputedStyle(button).backgroundColor;
        button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return { before, transition: getComputedStyle(button).transition, transform: getComputedStyle(button).transform };
      })()`);
      const more = await page.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '更多');
        const rect = button.getBoundingClientRect();
        return { w: Math.round(rect.width), h: Math.round(rect.height), text: button.textContent.trim(), title: button.getAttribute('title'), expanded: button.getAttribute('aria-expanded') };
      })()`);
      if (more.w > 48 || more.h > 48 || more.text.includes('更多') || more.title !== '更多') throw new Error(JSON.stringify(more));
      await page.evaluate(`[...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '更多').click()`);
      const opened = await page.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '更多' && node.getAttribute('aria-expanded') === 'true');
        return Boolean(button);
      })()`);
      if (!opened) throw new Error('more capsule did not expand');
      await press(page, 'Escape', 'Escape', 27);
      await sleep(200);
      const copy = await page.evaluate(`(() => {
        const card = [...document.querySelectorAll('[data-clip-card]')].find((node) => node.innerText.includes('plain.bin'));
        const button = [...card.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '复制');
        const rect = button.getBoundingClientRect();
        return { w: Math.round(rect.width), h: Math.round(rect.height), title: button.getAttribute('title') };
      })()`);
      if (copy.title !== '复制' || copy.w < 40 || copy.h < 40) throw new Error(JSON.stringify(copy));
      await page.evaluate(`(() => {
        const card = [...document.querySelectorAll('[data-clip-card]')].find((node) => node.innerText.includes('plain.bin'));
        [...card.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '撤回').click();
      })()`);
      const confirming = await page.evaluate(`document.querySelector('[data-retract="confirm"]')?.getAttribute('aria-label') ?? ''`);
      if (confirming !== '确认撤回') throw new Error(confirming);
      await clickFound(page, centerOf(`document.querySelector('h1')`));
      await sleep(250);
      const cleared = await page.evaluate(`document.querySelector('[data-retract="confirm"]') ? 'still' : 'cleared'`);
      if (cleared !== 'cleared') throw new Error('outside click did not cancel retract');
      await page.evaluate(`(() => {
        const card = [...document.querySelectorAll('[data-clip-card]')].find((node) => node.innerText.includes('phase4 hover text'));
        [...card.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '撤回').click();
      })()`);
      await press(page, 'Escape', 'Escape', 27);
      await sleep(200);
      const escaped = await page.evaluate(`document.querySelector('[data-retract="confirm"]') ? 'still' : 'cleared'`);
      if (escaped !== 'cleared') throw new Error('escape did not cancel retract');
      await page.evaluate(`document.querySelector('[aria-label="查看 small.png"]').click()`);
      await poll(async () => page.evaluate(`document.querySelector('[data-progressive-blur="top"]') && document.querySelectorAll('[data-progressive-blur-layer]').length >= 8`), 8000, 'progressive blur');
      const blur = await page.evaluate(`(() => {
        const layers = [...document.querySelectorAll('[data-progressive-blur-layer]')].map((node) => getComputedStyle(node).backdropFilter || getComputedStyle(node).webkitBackdropFilter);
        const mask = getComputedStyle(document.querySelector('[data-progressive-blur-layer]')).maskImage || getComputedStyle(document.querySelector('[data-progressive-blur-layer]')).webkitMaskImage;
        return { count: layers.length, sample: layers[0], strong: layers.some((value) => value.includes('48px')), mask: String(mask).slice(0, 80), backdrop: document.querySelector('[role="dialog"]').getAttribute('data-backdrop') };
      })()`);
      await page.shot('03-lightbox-progressive');
      if (blur.backdrop !== 'blur' || blur.count < 8 || !blur.strong) throw new Error(JSON.stringify(blur));
      await page.evaluate(`document.querySelector('[aria-label="关闭"]').click()`);
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      await page.evaluate(`document.querySelector('[aria-label="查看 small.png"]').click()`);
      await sleep(250);
      const quiet = await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return { backdrop: dialog.getAttribute('data-backdrop'), layers: document.querySelectorAll('[data-progressive-blur-layer]').length };
      })()`);
      await page.shot('04-lightbox-fallback');
      await page.evaluate(`document.querySelector('[aria-label="关闭"]').click()`);
      await page.send('Emulation.setEmulatedMedia', { features: [] });
      if (quiet.backdrop !== 'solid' || quiet.layers !== 0) throw new Error(JSON.stringify(quiet));
      const room = await call('/api/rooms', { method: 'POST' });
      await page.goto(`${origin}/rooms/${room.parsed.token}`);
      await poll(() => page.evaluate(`Boolean(document.querySelector('[aria-label="二维码"]'))`), 8000, 'room qr button');
      const row = await page.evaluate(`(() => {
        const button = document.querySelector('[aria-label="二维码"]');
        const row = button.parentElement;
        const rect = row.getBoundingClientRect();
        return { h: Math.round(rect.height), open: Boolean(document.querySelector('[role="dialog"][aria-label="房间二维码"]')) };
      })()`);
      if (row.h > 72 || row.open) throw new Error(JSON.stringify(row));
      await page.evaluate(`document.querySelector('[aria-label="二维码"]').click()`);
      const pop = await poll(async () => page.evaluate(`(() => {
        const image = document.querySelector('[alt="房间二维码"]');
        if (!image) return null;
        return { w: Number(image.getAttribute('width')), dialog: Boolean(document.querySelector('[aria-label="房间二维码"]')) };
      })()`), 8000, 'qr image');
      await page.shot('05-room-qr');
      if (pop.w !== 96 || !pop.dialog) throw new Error(JSON.stringify(pop));
      await page.evaluate(`document.querySelector('[aria-label="房间二维码"] button').click()`);
      const grown = await page.evaluate(`Number(document.querySelector('[alt="房间二维码"]').getAttribute('width'))`);
      if (grown !== 192) throw new Error(`qr enlarge ${grown}`);
      return `more ${more.w}x${more.h}; retract outside/esc cancelled; blur layers ${blur.count}; qr row ${row.h}px; hover transition ${hover.transition.slice(0, 40)}`;
    });

    await check('AC-V layout, cards, avatar menu, quota, presence', async () => {
      await page.viewport(1280, 900);
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`document.body.innerText.includes('plain.bin')`), 8000, 'layout board');
      const grid = await page.evaluate(`(() => {
        const board = document.querySelector('[data-layout]');
        const file = [...document.querySelectorAll('[data-clip-card]')].find((node) => node.innerText.includes('plain.bin'));
        const text = [...document.querySelectorAll('[data-clip-card]')].find((node) => node.innerText.includes('phase4 hover text'));
        const image = document.querySelector('[aria-label="查看 small.png"] img');
        const rect = file.getBoundingClientRect();
        return {
          layout: board.getAttribute('data-layout'),
          columns: getComputedStyle(board).columnCount,
          fileH: Math.round(rect.height),
          textClamp: text.innerText.includes('展开') || text.querySelector('button')?.innerText.includes('展开') || text.innerText.length < 400,
          image: Boolean(image),
          headers: document.body.innerText.includes('类型/内容/操作'),
        };
      })()`);
      if (grid.layout !== 'grid' || grid.headers) throw new Error(JSON.stringify(grid));
      await page.evaluate(`document.querySelector('[aria-label="列表"]').click()`);
      const listed = await page.evaluate(`document.querySelector('[data-layout]').getAttribute('data-layout')`);
      const stored = await page.evaluate(`localStorage.getItem('dropit-layout')`);
      if (listed !== 'list' || stored !== 'list') throw new Error(`${listed}/${stored}`);
      await page.shot('06-list');
      await page.evaluate(`document.querySelector('[aria-label="网格"]').click()`);
      await page.shot('07-grid-desktop');
      const avatars = await page.evaluate(`(() => {
        const buttons = [...document.querySelectorAll('button')].filter((node) => node.getAttribute('aria-label') === '账户菜单');
        const nameButtons = [...document.querySelectorAll('button')].filter((node) => node.textContent.includes('Browser Admin'));
        return { menu: buttons.length, nameButtons: nameButtons.length };
      })()`);
      if (avatars.menu !== 1) throw new Error(JSON.stringify(avatars));
      const presence = await page.evaluate(`(() => {
        const node = document.querySelector('[role="status"]');
        return { label: node?.getAttribute('aria-label'), title: node?.getAttribute('title'), text: node?.textContent.trim() };
      })()`);
      if (!presence.label?.includes('台设备在线')) throw new Error(JSON.stringify(presence));
      await clickFound(page, centerOf(`document.querySelector('[aria-label="账户菜单"]')`));
      const menu = await poll(async () => page.evaluate(`(() => {
        const quota = document.querySelector('[role="menu"] [role="progressbar"], [role="progressbar"][aria-label="配额"]');
        const items = [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent.trim());
        return quota ? { tone: quota.getAttribute('data-quota-tone'), value: quota.getAttribute('aria-valuenow'), items } : null;
      })()`), 4000, 'avatar menu');
      await page.shot('08-avatar-menu');
      for (const label of ['设置', '管理', '退出']) {
        if (!menu.items.some((item) => item.includes(label))) throw new Error(`menu missing ${label}: ${menu.items.join('|')}`);
      }
      if (menu.tone !== 'ok' && menu.tone !== 'warn' && menu.tone !== 'over') throw new Error(JSON.stringify(menu));
      const pageQuota = await page.evaluate(`Boolean(document.querySelector('h2, h1') && [...document.querySelectorAll('h1,h2')].some((node) => node.textContent === '配额' || node.textContent === '在线'))`);
      if (pageQuota) throw new Error('quota or presence heading still on the page');
      await press(page, 'Escape', 'Escape', 27);
      await page.evaluate(`document.querySelector('[aria-label="切换主题"]').click()`);
      await poll(() => page.evaluate(`document.documentElement.classList.contains('dark')`), 3000, 'dark theme');
      const dark = await page.evaluate(`(() => {
        const probe = document.querySelector('h1');
        const parse = (value) => value.match(/\\d+/g).slice(0, 3).map(Number);
        return { fg: parse(getComputedStyle(probe).color), bg: parse(getComputedStyle(document.body).backgroundColor) };
      })()`);
      const ratio = contrast(dark.fg, dark.bg);
      await page.shot('09-dark-desktop');
      if (ratio < 4.5) throw new Error(`dark contrast ${ratio}`);
      await page.viewport(390, 844);
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`document.body.innerText.includes('plain.bin')`), 8000, 'phone board');
      const phone = await page.evaluate(`(() => {
        const header = document.querySelector('header');
        const overflow = header.scrollWidth > header.clientWidth + 2 || document.documentElement.scrollWidth > 400;
        const targets = [...document.querySelectorAll('header button, [data-clip-card] button')].map((node) => {
          const rect = node.getBoundingClientRect();
          if (rect.width < 1 || rect.bottom < 0 || rect.top > window.innerHeight) return null;
          return Math.round(Math.min(rect.width, rect.height));
        }).filter((value) => value != null);
        return { overflow, min: targets.length ? Math.min(...targets) : 0, count: targets.length, layout: document.querySelector('[data-layout]')?.getAttribute('data-layout') };
      })()`);
      await page.shot('10-phone');
      const headerMin = await page.evaluate(`(() => {
        const targets = [...document.querySelectorAll('header button, nav button')].map((node) => {
          const rect = node.getBoundingClientRect();
          if (rect.width < 1) return null;
          return Math.round(Math.min(rect.width, rect.height));
        }).filter((value) => value != null);
        return targets.length ? Math.min(...targets) : 0;
      })()`);
      await clickFound(page, centerOf(`document.querySelector('[aria-label="账户菜单"]')`));
      const drawer = await poll(async () => page.evaluate(`document.querySelector('[aria-label="账户"]') ? document.querySelector('[aria-label="配额"]')?.getAttribute('data-quota-tone') : ''`), 4000, 'phone drawer');
      await page.shot('11-phone-menu');
      if (phone.overflow) throw new Error(JSON.stringify(phone));
      if (!drawer) throw new Error('phone quota missing');
      await page.viewport(1280, 900);
      await page.evaluate(`document.querySelector('[aria-label="关闭账户菜单"]')?.click()`);
      return `grid ${grid.layout}; file card ${grid.fileH}px; menu ${menu.items.join('/')}; dark contrast ${ratio.toFixed(1)}; phone header min ${headerMin}; card min ${phone.min}`;
    });

    await check('regression: text, copy, download, retract, share link', async () => {
      await page.viewport(1280, 900);
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`document.body.innerText.includes('phase4 hover text')`), 8000, 'regression board');
      const linked = await page.evaluate(`Boolean([...document.querySelectorAll('a')].find((node) => node.href.includes('example.com/dropit')))`);
      if (!linked) throw new Error('url was not linkified');
      const downloaded = await page.evaluate(`(async () => {
        const card = [...document.querySelectorAll('[data-clip-card]')].find((node) => node.innerText.includes('plain.bin'));
        [...card.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '更多')?.click();
        const link = [...card.querySelectorAll('a')].find((node) => node.getAttribute('aria-label') === '下载');
        const response = await fetch(link.href);
        return { status: response.status, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition') };
      })()`);
      if (downloaded.status !== 200 || downloaded.type !== 'application/octet-stream' || !String(downloaded.disposition).includes('attachment')) {
        throw new Error(JSON.stringify(downloaded));
      }
      await page.evaluate(`(() => {
        const card = [...document.querySelectorAll('[data-clip-card]')].find((node) => node.innerText.includes('phase4 hover text'));
        [...card.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '撤回').click();
      })()`);
      await page.evaluate(`document.querySelector('[data-retract="confirm"]').click()`);
      const gone = await poll(async () => page.evaluate(`document.body.innerText.includes('phase4 hover text') ? '' : 'gone'`), 8000, 'retracted');
      await page.shot('12-regression');
      return `linkified; download ${downloaded.disposition}; retract ${gone}`;
    });

    await check('AC-X CLI interrupt resume and cancel', async () => {
      const cli = join(root, 'apps/cli/src/index.ts');
      const home = join(outDir, 'cli-home');
      await mkdir(home, { recursive: true });
      const config = join(home, 'dropit', 'config.json');
      await mkdir(join(home, 'dropit'), { recursive: true });
      const token = (await call('/api/tokens', {
        cookie: admin, method: 'POST', json: { name: 'acceptance', scopes: ['read', 'write'] },
      })).parsed.token;
      await writeFile(config, JSON.stringify({ url: origin, token, spaceId: adminSpace.id }), { mode: 0o600 });
      const big = join(fixtures, 'cli-big.bin');
      const handle = openSync(big, 'w');
      ftruncateSync(handle, chunkBytes * 3 + 50_000);
      closeSync(handle);
      const env = {
        ...process.env,
        DROPIT_CONFIG: config,
        HOME: home,
        XDG_CONFIG_HOME: home,
      };
      const first = spawn('pnpm', ['--filter', '@dropit/cli', 'exec', 'tsx', 'src/index.ts', 'push', big], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      first.stdout.on('data', (chunk) => { output += chunk; });
      first.stderr.on('data', (chunk) => { output += chunk; });
      const sessionFile = join(home, 'dropit', 'uploads.json');
      const interrupted = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`cli did not start\n${output.slice(-500)}`)), 25000);
        const watch = async () => {
          try {
            const current = JSON.parse(await readFile(sessionFile, 'utf8'));
            const row = current.uploads?.find((value) => value?.filename === 'cli-big.bin');
            if (row?.uploadId && (output.includes('%') || output.includes('上传') || output.includes('MB/s') || output.includes('KB/s'))) {
              clearTimeout(timer);
              resolve({ text: output, row, mode: statSync(sessionFile).mode & 0o777 });
            }
          } catch {
            // The session file appears after createUpload.
          }
        };
        const interval = setInterval(() => { void watch(); }, 150);
        first.once('exit', (code) => {
          clearInterval(interval);
          clearTimeout(timer);
          reject(new Error(`cli exited ${code} before resume snapshot\n${output.slice(-500)}`));
        });
        first.stdout.on('data', () => { void watch(); });
        first.stderr.on('data', () => { void watch(); });
      });
      const uploadId = interrupted.row.uploadId;
      const mode = interrupted.mode;
      if ((mode & 0o077) !== 0) throw new Error(`session mode ${mode.toString(8)}`);
      const remote = await call(`${base}/uploads/${uploadId}`, { cookie: admin });
      if (remote.status !== 200) throw new Error(`remote resume ${remote.status} ${JSON.stringify(remote.parsed)}`);
      first.kill('SIGINT');
      const closed = await once(first, 'close');
      const second = await run('pnpm', ['--filter', '@dropit/cli', 'exec', 'tsx', 'src/index.ts', 'push', big], { cwd: root, env });
      if (second.code !== 0) throw new Error(`resume failed ${second.code} ${second.stderr.slice(-400)}`);
      if (second.stdout.includes(token) || second.stderr.includes(token)) throw new Error('token leaked');
      const listed = await call(`${base}/items`, { cookie: admin });
      const found = listed.parsed.items?.find((item) => item.filename === 'cli-big.bin');
      if (!found || found.size !== chunkBytes * 3 + 50_000) throw new Error('cli file missing after resume');
      const cancelFile = join(fixtures, 'cli-cancel.bin');
      const cancelHandle = openSync(cancelFile, 'w');
      ftruncateSync(cancelHandle, chunkBytes * 4);
      closeSync(cancelHandle);
      await call('/__mock/chunk-delay?ms=2500', { method: 'POST' });
      const third = spawn('pnpm', ['--filter', '@dropit/cli', 'exec', 'tsx', 'src/index.ts', 'push', cancelFile], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let cancelOut = '';
      third.stdout.on('data', (chunk) => { cancelOut += chunk; });
      third.stderr.on('data', (chunk) => { cancelOut += chunk; });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`cancel push did not start\n${cancelOut.slice(-300)}`)), 20000);
        const watch = async () => {
          try {
            const current = JSON.parse(await readFile(sessionFile, 'utf8'));
            const row = current.uploads?.find((value) => value?.filename === 'cli-cancel.bin');
            if (row?.uploadId) {
              clearTimeout(timer);
              resolve(row.uploadId);
            }
          } catch {
            // The session file appears after the first chunk is accepted.
          }
        };
        const interval = setInterval(() => { void watch(); }, 200);
        third.once('exit', (code) => {
          clearInterval(interval);
          clearTimeout(timer);
          reject(new Error(`exited ${code} before session\n${cancelOut.slice(-400)}`));
        });
        void watch();
      }).then(async (id) => {
        third.kill('SIGINT');
        await once(third, 'close');
        await sleep(500);
        await call('/__mock/chunk-delay?ms=0', { method: 'POST' });
        await sleep(1500);
        const left = await call(`${base}/uploads/${id}`, { cookie: admin });
        if (left.status !== 404) throw new Error(`SIGINT did not delete session ${left.status} out ${cancelOut.slice(-180)}`);
        return id;
      });
      return `snapshotted before SIGINT; received ${remote.parsed.received?.length ?? 0}; mode ${mode.toString(8)}; resume exit 0; SIGINT cleaned; code ${closed[0]}`;
    });

    await check('anonymous room on the real image', async () => {
      dockerName = `dropit-rhea188-${process.pid}`;
      const roomPort = 8796;
      const started = await run('docker', [
        'run', '-d', '--name', dockerName, '-p', `127.0.0.1:${roomPort}:8787`,
        '-e', 'APP_ORIGIN=http://127.0.0.1:8796',
        '-e', 'NODE_ENV=development',
        '-e', 'RATE_GENERAL=8000',
        '-e', 'RATE_ROOM=40',
        '-e', 'RATE_UPLOAD=200',
        '-e', 'RATE_CHUNK=4000',
        '-e', 'UPLOAD_CHUNK_BYTES=262144',
        image,
      ]);
      if (started.code !== 0) throw new Error(started.stderr.slice(-400));
      const roomOrigin = `http://127.0.0.1:${roomPort}`;
      try {
        await waitFor(`${roomOrigin}/healthz`, '', 40000);
      } catch (error) {
        const logs = await run('docker', ['logs', '--tail', '80', dockerName]);
        const inspect = await run('docker', ['inspect', '-f', '{{.State.Status}} {{.State.Error}} {{json .HostConfig.PortBindings}}', dockerName]);
        throw new Error(`${error instanceof Error ? error.message : error}\n${inspect.stdout}\n${logs.stdout}\n${logs.stderr}`);
      }
      const room = await call('/api/rooms', { method: 'POST', base: roomOrigin });
      if (room.status !== 201) throw new Error(`image room ${room.status}`);
      const token = room.parsed.token;
      const bytes = Buffer.alloc(300_000, 13);
      const created = await call(`/api/rooms/${token}/uploads`, {
        method: 'POST', base: roomOrigin, json: { filename: 'image.bin', size: bytes.length, mime: 'application/octet-stream' },
      });
      if (created.status !== 201 || created.parsed.chunkSize !== 262144) throw new Error(`image upload ${created.status} ${created.parsed?.chunkSize}`);
      const id = created.parsed.uploadId;
      await call(`/api/rooms/${token}/uploads/${id}/chunks/1`, { method: 'PUT', base: roomOrigin, body: bytes.subarray(262144) });
      const mid = await call(`/api/rooms/${token}/uploads/${id}`, { base: roomOrigin });
      await call(`/api/rooms/${token}/uploads/${id}/chunks/0`, { method: 'PUT', base: roomOrigin, body: bytes.subarray(0, 262144) });
      const done = await call(`/api/rooms/${token}/uploads/${id}/complete`, { method: 'POST', base: roomOrigin });
      if (mid.parsed.received.join(',') !== '1' || done.status !== 201) throw new Error(`image resume ${mid.parsed?.received} ${done.status}`);
      const mock = await fetch(`${roomOrigin}/__mock/authorize`).then(async (response) => ({ status: response.status, body: (await response.text()).slice(0, 120) })).catch(() => ({ status: 0, body: '' }));
      if (mock.status === 302 || mock.body.includes('github/callback')) throw new Error(`mock authorize is inside the image ${mock.status}`);
      await page.goto(`${roomOrigin}/rooms/${token}`);
      await poll(() => page.evaluate(`document.body.innerText.includes('临时房间') && document.body.innerText.includes('image.bin')`), 8000, 'image room page');
      const qr = await page.evaluate(`(() => {
        const button = document.querySelector('[aria-label="二维码"]');
        const row = button?.parentElement?.getBoundingClientRect();
        return { h: row ? Math.round(row.height) : 0, menu: document.querySelectorAll('[aria-label="账户菜单"]').length };
      })()`);
      await page.shot('13-image-room');
      if (qr.h > 80 || qr.h < 20) throw new Error(JSON.stringify(qr));
      return `image resumed chunk 1 first; mock status ${mock.status}; qr row ${qr.h}px`;
    });
  } finally {
    await browser.close().catch(() => {});
    if (xvfb) xvfb.kill('SIGTERM');
    server.kill('SIGTERM');
    if (dockerName) await run('docker', ['rm', '-f', dockerName]);
  }
  await writeFile(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((row) => !row.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
