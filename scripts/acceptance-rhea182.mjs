// RHEA-182 browser acceptance. Product code is not modified.
// The Docker image supplies the static assets. Mock OAuth stays out of the image
// (see apps/server/test/rhea182-browser-server.ts) and only this process uses it.
// A second pass talks to the image itself through an anonymous room.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, ftruncateSync, openSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const sharp = require('sharp');
const outDir = process.argv[2] ?? join(root, '..', 'rhea182-report');
const port = Number(process.env.ACCEPTANCE_PORT ?? 8794);
const origin = `http://127.0.0.1:${port}`;
const image = process.env.DROPIT_IMAGE ?? 'dropit:acceptance';
const results = [];

function record(id, pass, detail) {
  const text = String(detail ?? '').replaceAll('\n', ' ').slice(0, 500);
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

async function waitFor(url, readyText) {
  const deadline = Date.now() + 60000;
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

async function login(code, invite) {
  const startUrl = new URL('/api/auth/github', origin);
  if (invite) startUrl.searchParams.set('invite', invite);
  const start = await fetch(startUrl, { redirect: 'manual' });
  const flow = cookieValue(start, 'dropit_oauth');
  const mocked = new URL(start.headers.get('location') ?? '', origin);
  mocked.searchParams.set('as', code);
  const mid = await fetch(mocked, { redirect: 'manual', headers: { cookie: `dropit_oauth=${flow}` } });
  const callback = new URL(mid.headers.get('location') ?? '', origin);
  const done = await fetch(callback, { redirect: 'manual', headers: { cookie: `dropit_oauth=${flow}` } });
  const session = cookieValue(done, 'dropit_session');
  if (!session) throw new Error(`login ${code} failed ${done.status} ${mid.headers.get('location')}`);
  return session;
}

async function call(path, { cookie, method = 'GET', json, body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      origin,
      ...(cookie ? { cookie: `dropit_session=${cookie}` } : {}),
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  const buf = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    try { parsed = JSON.parse(buf.toString()); } catch { parsed = null; }
  }
  return { status: response.status, headers: response.headers, buf, parsed };
}

async function makeFixtures(dir) {
  await mkdir(dir, { recursive: true });
  const small = await sharp({ create: { width: 48, height: 24, channels: 3, background: 'blue' } }).png().toBuffer();
  const large = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: 'red' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const pixels = Buffer.alloc(32 * 32 * 3);
  for (let pixel = 0; pixel < 32 * 32; pixel += 1) pixels[pixel * 3 + (pixel < 32 * 16 ? 0 : 2)] = 255;
  const gif = await sharp(pixels, { raw: { width: 32, height: 32, channels: 3, pageHeight: 16 } }).gif({ delay: [100, 100] }).toBuffer();
  await writeFile(join(dir, 'small.png'), small);
  await writeFile(join(dir, 'large.jpg'), large);
  await writeFile(join(dir, 'anim.gif'), gif);
  await writeFile(join(dir, 'note.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=1"><script>window.__xss=1</script></svg>');
  await writeFile(join(dir, 'fake.png'), '<html><script>window.__xss=1</script>owned</html>');
  await writeFile(join(dir, 'plain.bin'), Buffer.from('not an image'));
  const huge = openSync(join(dir, 'huge.bin'), 'w');
  ftruncateSync(huge, 26 * 1024 * 1024);
  closeSync(huge);
  await writeFile(join(dir, 'chunky.bin'), Buffer.alloc(512 * 1024, 7));
  await writeFile(join(dir, 'hold.bin'), Buffer.alloc(512 * 1024, 8));
  for (let index = 0; index < 4; index += 1) await writeFile(join(dir, `cancel${index}.bin`), Buffer.alloc(512 * 1024, index + 3));
  for (let index = 0; index < 6; index += 1) await writeFile(join(dir, `q${index}.txt`), `queue file ${index}\n`);
  for (let index = 0; index < 4; index += 1) await writeFile(join(dir, `cli${index}.txt`), `cli ${index}\n`);
  for (let index = 0; index < 4; index += 1) await writeFile(join(dir, `pace${index}.bin`), Buffer.alloc(256 * 1024, index + 1));
  await writeFile(join(dir, 'cli-bad.png'), '<html>not a png</html>');
  await writeFile(join(dir, 'cli-slow.bin'), Buffer.alloc(768 * 1024, 9));
  return { small, large, gif };
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
    this.dialogs = [];
    this.dialogMode = 'accept';
    this.uploads = [];
    this.maxUploads = 0;
    this.inflight = new Map();
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
    this.maxUploads = 0;
    this.uploads = [];
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
    if (message.method === 'Page.javascriptDialogOpening') {
      this.dialogs.push({ type: message.params.type, message: message.params.message });
      const accept = this.dialogMode !== 'dismiss';
      void this.send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
    }
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, request } = message.params;
      if (request.method === 'POST' && request.url.includes('/items/file')) {
        this.inflight.set(requestId, request.url);
        this.maxUploads = Math.max(this.maxUploads, this.inflight.size);
      }
    }
    if (message.method === 'Network.responseReceived') {
      const { requestId, response } = message.params;
      if (this.inflight.has(requestId) || (response.url ?? '').includes('/items/file')) {
        this.uploads.push(response.status);
      }
      // Drop the request when headers arrive. loadingFinished lags behind the
      // client starting its next upload and inflates the overlap count.
      this.inflight.delete(requestId);
    }
    if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
      this.inflight.delete(message.params.requestId);
    }
  }
}

async function openChrome() {
  const profile = join(tmpdir(), `dropit-chrome-${process.pid}`);
  await rm(profile, { recursive: true, force: true });
  const chrome = spawn('google-chrome', [
    '--ozone-platform=x11', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1280,800', '--remote-debugging-port=9341', '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' } });
  let log = '';
  chrome.stderr.on('data', (chunk) => { log += chunk; });
  chrome.stdout.on('data', (chunk) => { log += chunk; });
  const version = await waitFor('http://127.0.0.1:9341/json/version').then((text) => JSON.parse(text)).catch((error) => {
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
  if (!box) throw new Error(`click target missing: ${expression.slice(0, 80)}`);
  await clickAt(page, box);
}

const centerOf = (source) => `(() => {
  const node = (${source});
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`;

async function poll(fn, ms, label) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`${label}: ${JSON.stringify(last)?.slice(0, 240)}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const fixtures = join(outDir, 'fixtures');
  const bytes = await makeFixtures(fixtures);
  const inspected = await run('docker', ['image', 'inspect', image]);
  if (inspected.code !== 0) {
    console.log('building docker image');
    const built = await run('docker', ['build', '-t', image, root], { cwd: root });
    if (built.code !== 0) throw new Error(built.stderr.slice(-800));
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
  const bundle = await Promise.all(assetNames.filter((name) => name.endsWith('.js')).map(async (name) => {
    const { readFile } = await import('node:fs/promises');
    return readFile(join(staticDir, 'assets', name), 'utf8');
  }));
  const source = bundle.join('\n');
  record('image assets', source.includes('blur(8px)') && source.includes('上传队列') && source.includes('下载原图'),
    `js files ${assetNames.filter((name) => name.endsWith('.js')).length}`);

  const server = spawn('pnpm', ['--filter', '@dropit/server', 'exec', 'tsx', 'test/rhea182-browser-server.ts'], {
    cwd: root,
    env: { ...process.env, ACCEPTANCE_PORT: String(port), STATIC_DIR: staticDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${serverLog.slice(-800)}`)), 40000);
    server.stdout.on('data', () => {
      if (serverLog.includes('ACCEPTANCE_READY') && serverLog.includes('DATA_DIR')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${serverLog.slice(-800)}`));
    });
  });
  void ready;
  const dataDir = serverLog.split('\n').find((line) => line.startsWith('DATA_DIR '))?.slice('DATA_DIR '.length).trim();
  if (!dataDir) throw new Error('missing data dir');
  console.log(`mock server ${origin} data ${dataDir}`);

  let xvfb;
  if (!process.env.DISPLAY) {
    xvfb = spawn('Xvfb', [':99', '-screen', '0', '1400x1000x24'], { stdio: 'ignore' });
    process.env.DISPLAY = ':99';
    await sleep(400);
  }
  const browser = await openChrome();
  const page = browser.page;
  try {
    await page.viewport(1280, 800);
    await page.goto(`${origin}/login`);
    await poll(() => page.evaluate(`Boolean(document.querySelector('a[href="/api/auth/github"]'))`), 8000, 'github link');
    await page.evaluate(`document.querySelector('a[href="/api/auth/github"]').click()`);
    try {
      await poll(() => page.evaluate(`document.body.innerText.toLowerCase().includes('browser admin')`), 8000, 'admin login');
    } catch (error) {
      const info = await page.evaluate(`JSON.stringify({ href: location.href, text: document.body.innerText.slice(0, 600) })`);
      await page.shot('00-login-fail');
      throw new Error(`${error instanceof Error ? error.message : error} ${info}`);
    }
    await page.shot('01-home-admin');
    record('AC-R browser login', true, 'Browser Admin');

    const admin = await login('browser-admin');
    const me = await call('/api/me', { cookie: admin });
    const spaces = await call('/api/spaces', { cookie: admin });
    const adminSpace = spaces.parsed.spaces.find((space) => space.ownerId === me.parsed.user.id);
    const base = `/api/spaces/${adminSpace.id}`;

    await check('AC-R1 oversize stays local', async () => {
      const before = await call('/__mock/stats');
      await page.files([join(fixtures, 'huge.bin')]);
      const text = await poll(async () => {
        const value = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return value.includes('huge.bin') && value.includes('失败') ? value : '';
      }, 6000, 'oversize row');
      const after = await call('/__mock/stats');
      if (after.parsed.started !== before.parsed.started) throw new Error(`server saw the oversize file ${after.parsed.started - before.parsed.started}`);
      if (!text.includes('超过大小上限')) throw new Error(text);
      return 'failed locally, server upload count unchanged';
    });

    await check('AC-R1/R2 queue, isolation, retry', async () => {
      await call('/__mock/pace?ms=250', { method: 'POST' });
      await call('/__mock/stats/reset', { method: 'POST' });
      page.resetNet();
      await page.files(['small.png', 'fake.png', 'large.jpg', 'anim.gif', 'note.svg', 'plain.bin'].map((name) => join(fixtures, name)));
      const mixed = await poll(async () => {
        const value = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return value.includes('排队中') && value.includes('上传中') ? value : '';
      }, 4000, 'queued and uploading');
      await page.shot('02-upload-queue');
      const done = await poll(async () => {
        const value = await page.evaluate(`document.body.innerText`);
        const failed = value.includes('fake.png') && value.includes('图片无法处理') && value.includes('重试');
        const arrived = ['small.png', 'large.jpg', 'anim.gif', 'note.svg', 'plain.bin'].every((name) => value.includes(name));
        return failed && arrived ? value : '';
      }, 20000, 'uploads settled');
      const stats = await call('/__mock/stats');
      if (stats.parsed.max > 3) throw new Error(`server concurrency ${stats.parsed.max}`);
      if (page.maxUploads > 3) throw new Error(`browser concurrency ${page.maxUploads}`);
      await page.evaluate(`document.querySelector('[aria-label="重试 fake.png"]').click()`);
      const retried = await poll(async () => {
        const value = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return value.includes('fake.png') && value.includes('失败') && value.includes('图片无法处理') ? value : '';
      }, 8000, 'manual retry');
      await call('/__mock/pace?ms=0', { method: 'POST' });
      if (await page.evaluate('window.__xss ?? null') != null) throw new Error('svg script ran');
      return `max server ${stats.parsed.max}, max browser ${page.maxUploads}; ${mixed.includes('排队中') ? 'queued' : ''} ${done.includes('small.png') ? 'kept siblings' : ''} ${retried.includes('重试') ? 'retry kept' : ''}`;
    });

    await check('AC-S5/S7 member lightbox', async () => {
      await page.viewport(1280, 800);
      await poll(async () => page.evaluate(`Boolean([...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '查看 small.png'))`), 8000, 'thumbnail');
      const opener = await page.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '查看 small.png');
        button.focus();
        button.click();
        return document.activeElement?.getAttribute('aria-label') ?? '';
      })()`);
      await poll(async () => page.evaluate(`document.querySelector('[data-lightbox-image="preview"]')?.complete && document.querySelector('[data-testid="lightbox-meta"]')?.textContent.includes('48')`), 8000, 'small preview');
      const opened = await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const backdrop = document.querySelector('[data-testid="lightbox-backdrop"]');
        const style = getComputedStyle(backdrop);
        const link = document.querySelector('[data-testid="lightbox-toolbar"] a');
        return {
          label: dialog?.getAttribute('aria-label'),
          modal: dialog?.getAttribute('aria-modal'),
          backdrop: dialog?.getAttribute('data-backdrop'),
          filter: style.backdropFilter || style.webkitBackdropFilter,
          background: style.backgroundColor,
          transition: style.transition,
          meta: document.querySelector('[data-testid="lightbox-meta"]')?.textContent,
          src: document.querySelector('[data-lightbox-image="preview"]')?.getAttribute('src'),
          href: link?.getAttribute('href'),
          text: link?.textContent,
          locked: document.body.style.overflow,
          focus: document.activeElement?.getAttribute('aria-label'),
          opener,
        };
      })()`);
      if (opened.modal !== 'true' || opened.backdrop !== 'blur' || !String(opened.filter).includes('blur(8px)')) throw new Error(JSON.stringify(opened));
      if (!opened.src?.endsWith('/preview') || !opened.href?.includes('/download') || opened.href.includes('/preview')) throw new Error(JSON.stringify(opened));
      if (opened.locked !== 'hidden') throw new Error(`scroll lock ${opened.locked}`);
      await page.shot('03-lightbox');
      await page.evaluate(`document.querySelector('[aria-label="放大"]').click()`);
      const zoomed = await page.evaluate(`document.querySelector('[role="dialog"]').getAttribute('data-scale')`);
      await page.evaluate(`document.querySelector('[data-testid="lightbox-frame"]').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))`);
      const wheeled = await page.evaluate(`document.querySelector('[role="dialog"]').getAttribute('data-scale')`);
      const panFrom = await page.evaluate(centerOf(`document.querySelector('[data-testid="lightbox-frame"]')`));
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: panFrom.x, y: panFrom.y, button: 'left', clickCount: 1, buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panFrom.x + 70, y: panFrom.y + 24, button: 'left', buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panFrom.x + 70, y: panFrom.y + 24, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(150);
      const dragged = await page.evaluate(`document.querySelector('[data-testid="lightbox-frame"]')?.getAttribute('data-pan-x')`);
      await page.evaluate(`document.querySelector('[data-testid="lightbox-frame"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`);
      const doubled = await page.evaluate(`document.querySelector('[role="dialog"]').getAttribute('data-scale')`);
      for (let step = 0; step < 8; step += 1) await page.evaluate(`document.querySelector('[aria-label="放大"]')?.click()`);
      const capped = await page.evaluate(`document.querySelector('[role="dialog"]').getAttribute('data-scale')`);
      await page.evaluate(`document.querySelector('[aria-label="缩小"]').click()`);
      for (let step = 0; step < 8; step += 1) {
        const scale = await page.evaluate(`document.querySelector('[role="dialog"]').getAttribute('data-scale')`);
        if (Number(scale) <= 1) break;
        await page.evaluate(`document.querySelector('[aria-label="缩小"]').click()`);
      }
      await page.evaluate(`document.querySelector('[data-testid="lightbox-frame"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`);
      const doubledOn = await page.evaluate(`document.querySelector('[role="dialog"]').getAttribute('data-scale')`);
      await page.evaluate(`document.querySelector('[data-testid="lightbox-frame"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`);
      const doubledOff = await page.evaluate(`document.querySelector('[role="dialog"]').getAttribute('data-scale')`);
      const beforeLabel = await page.evaluate(`document.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? ''`);
      const step = async (key, code, which) => {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: which });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: which });
      };
      await step('ArrowRight', 'ArrowRight', 39);
      await sleep(250);
      let next = await page.evaluate(`document.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? ''`);
      if (next === beforeLabel) {
        await step('ArrowLeft', 'ArrowLeft', 37);
        await sleep(250);
        next = await page.evaluate(`document.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? ''`);
      }
      if (!next || next === beforeLabel) throw new Error(`arrow did not change ${beforeLabel}`);
      const downloaded = await page.evaluate(`(async () => {
        const link = document.querySelector('[data-testid="lightbox-toolbar"] a');
        const response = await fetch(link.href);
        return { status: response.status, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition'), length: Number(response.headers.get('content-length')) };
      })()`);
      if (downloaded.type !== 'application/octet-stream' || !String(downloaded.disposition).startsWith('attachment')) throw new Error(JSON.stringify(downloaded));
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      const trapped = await page.evaluate(`Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement))`);
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      const back = await poll(async () => page.evaluate(`document.querySelector('[role="dialog"]') ? '' : (document.activeElement?.getAttribute('aria-label') ?? 'none')`), 4000, 'escape close');
      if (!String(back).includes('查看')) throw new Error(`focus returned to ${back}`);
      await page.evaluate(`document.querySelector('[aria-label="查看 large.jpg"]').click()`);
      await poll(async () => page.evaluate(`(document.querySelector('[data-testid="lightbox-meta"]')?.textContent ?? '').includes('2048')`), 8000, 'large meta');
      await page.evaluate(`document.querySelector('[data-testid="lightbox-backdrop"]').click()`);
      await poll(async () => page.evaluate(`document.querySelector('[role="dialog"]') ? '' : 'closed'`), 4000, 'backdrop close');
      if (Number(zoomed) <= 1 || Number(wheeled) <= Number(zoomed) || Number(capped) !== 4 || Number(doubledOn) !== 2 || Number(doubledOff) !== 1 || Number(dragged) === 0) {
        throw new Error(`zoom button ${zoomed} wheel ${wheeled} double ${doubled}/${doubledOn}/${doubledOff} cap ${capped} pan ${dragged}`);
      }
      if (!trapped) throw new Error('focus left the dialog');
      return `opened ${opened.meta}; zoom ${zoomed} wheel ${wheeled} double ${doubled} cap ${capped} pan ${dragged}; next ${next}; download ${downloaded.length}`;
    });

    await check('AC-S6 backdrop fallbacks', async () => {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      await page.evaluate(`document.querySelector('[aria-label="查看 small.png"]').click()`);
      await sleep(200);
      const quiet = await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const style = getComputedStyle(document.querySelector('[data-testid="lightbox-backdrop"]'));
        return { backdrop: dialog.getAttribute('data-backdrop'), filter: style.backdropFilter, transition: style.transition, background: style.backgroundColor };
      })()`);
      await page.evaluate(`document.querySelector('[aria-label="关闭"]').click()`);
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await page.evaluate(`document.querySelector('[aria-label="查看 small.png"]').click()`);
      await sleep(200);
      const motion = await page.evaluate(`(() => {
        const style = getComputedStyle(document.querySelector('[data-testid="lightbox-backdrop"]'));
        return { backdrop: document.querySelector('[role="dialog"]').getAttribute('data-backdrop'), transition: style.transition, filter: style.backdropFilter };
      })()`);
      await page.evaluate(`document.querySelector('[aria-label="关闭"]').click()`);
      await page.send('Emulation.setEmulatedMedia', { features: [] });
      await page.evaluate(`(() => {
        const original = CSS.supports.bind(CSS);
        CSS.supports = (property, value) => String(property).includes('backdrop-filter') ? false : original(property, value);
      })()`);
      await page.evaluate(`document.querySelector('[aria-label="查看 small.png"]').click()`);
      await sleep(200);
      const unsupported = await page.evaluate(`(() => {
        const style = getComputedStyle(document.querySelector('[data-testid="lightbox-backdrop"]'));
        return { backdrop: document.querySelector('[role="dialog"]').getAttribute('data-backdrop'), filter: style.backdropFilter, background: style.backgroundColor };
      })()`);
      await page.shot('04-lightbox-fallback');
      await page.evaluate(`document.querySelector('[aria-label="关闭"]').click()`);
      if (quiet.backdrop !== 'solid' || motion.backdrop !== 'solid' || unsupported.backdrop !== 'solid') {
        throw new Error(JSON.stringify({ quiet, motion, unsupported }));
      }
      if (String(quiet.filter).includes('blur(8px)') || String(motion.filter).includes('blur(8px)')) throw new Error(JSON.stringify({ quiet, motion }));
      return JSON.stringify({ quiet: quiet.background, motion: motion.transition, unsupported: unsupported.background });
    });

    await check('AC-S6/S8 theme, phone, swipe', async () => {
      await page.send('Emulation.setEmulatedMedia', { features: [] });
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`document.body.innerText.includes('small.png')`), 8000, 'board back');
      await clickFound(page, centerOf(`[...document.querySelectorAll('button')].find((node) => node.textContent.includes('Browser Admin'))`));
      await poll(() => page.evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes('深色')))`), 3000, 'theme menu');
      await clickFound(page, centerOf(`[...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes('深色'))`));
      await poll(() => page.evaluate(`document.documentElement.classList.contains('dark')`), 3000, 'dark class');
      const darkPage = await page.evaluate(`(() => {
        const probe = document.querySelector('h1, p');
        const style = getComputedStyle(probe);
        const parse = (value) => value.match(/\\d+/g).slice(0, 3).map(Number);
        return { fg: parse(style.color), bg: parse(getComputedStyle(document.body).backgroundColor), text: probe.textContent.slice(0, 20) };
      })()`);
      await page.evaluate(`document.querySelector('[aria-label="查看 small.png"]').click()`);
      await sleep(300);
      const chrome = await page.evaluate(`(() => {
        const node = document.querySelector('[data-testid="lightbox-chrome"]');
        const style = getComputedStyle(node);
        const parse = (value) => value.match(/\\d+/g).slice(0, 3).map(Number);
        return { fg: parse(style.color), bg: parse(style.backgroundColor) };
      })()`);
      await page.shot('05-lightbox-dark');
      await page.evaluate(`document.querySelector('[aria-label="关闭"]').click()`);
      await clickFound(page, centerOf(`[...document.querySelectorAll('button')].find((node) => node.textContent.includes('Browser Admin'))`));
      await poll(() => page.evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.startsWith('浅色')))`), 3000, 'light menu');
      await clickFound(page, centerOf(`[...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.startsWith('浅色'))`));
      const lightPage = await page.evaluate(`(() => {
        const probe = document.querySelector('h1');
        const style = getComputedStyle(probe);
        const parse = (value) => value.match(/\\d+/g).slice(0, 3).map(Number);
        return { fg: parse(style.color), bg: parse(getComputedStyle(document.body).backgroundColor) };
      })()`);
      const darkRatio = contrast(darkPage.fg, darkPage.bg);
      const lightRatio = contrast(lightPage.fg, lightPage.bg);
      const chromeRatio = contrast(chrome.fg, chrome.bg);
      if (darkRatio < 4.5 || lightRatio < 4.5 || chromeRatio < 4.5) throw new Error(JSON.stringify({ darkRatio, lightRatio, chromeRatio, darkPage, lightPage, chrome }));
      await page.viewport(390, 844);
      await page.evaluate(`document.querySelector('[aria-label="查看 small.png"]').click()`);
      await sleep(250);
      const phone = await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const box = dialog.getBoundingClientRect();
        const safe = [...document.styleSheets].some((sheet) => {
          try { return [...sheet.cssRules].some((rule) => rule.cssText.includes('safe-area-inset')); }
          catch { return false; }
        });
        return {
          safeClass: dialog.className.includes('lightbox-safe'),
          safe,
          overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
          close: Boolean(document.querySelector('[aria-label="关闭"]')),
          box: box.width <= 390 && box.height <= 844,
        };
      })()`);
      await page.shot('06-lightbox-phone');
      const swipeFrom = await page.evaluate(centerOf(`document.querySelector('[data-testid="lightbox-frame"]')`));
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: swipeFrom.x, y: swipeFrom.y, button: 'left', clickCount: 1, buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: swipeFrom.x, y: swipeFrom.y + 140, button: 'left', buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: swipeFrom.x, y: swipeFrom.y + 140, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(200);
      const swiped = await page.evaluate(`document.querySelector('[role="dialog"]') ? 'open' : 'closed'`);
      if (!phone.safeClass || !phone.safe || !phone.overflow || !phone.close || swiped !== 'closed') throw new Error(JSON.stringify({ phone, swiped }));
      await page.viewport(1280, 800);
      return `dark ${darkRatio.toFixed(2)} light ${lightRatio.toFixed(2)} chrome ${chromeRatio.toFixed(2)} swipe ${swiped}`;
    });

    await check('AC-S5 room and share lightbox', async () => {
      await page.evaluate(`([...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '临时房间')).click()`);
      const roomPath = await poll(async () => {
        const path = await page.evaluate('location.pathname');
        return path.startsWith('/rooms/') ? path : '';
      }, 8000, 'room route');
      await poll(() => page.evaluate(`Boolean(document.querySelector('#draft'))`), 8000, 'room composer');
      await page.files([join(fixtures, 'small.png'), join(fixtures, 'anim.gif')]);
      await poll(() => page.evaluate(`Boolean(document.querySelector('[aria-label="查看 small.png"]')) && Boolean(document.querySelector('[aria-label="查看 anim.gif"]'))`), 20000, 'room images');
      await page.evaluate(`document.querySelector('[aria-label="查看 small.png"]').click()`);
      const roomLight = await poll(async () => {
        const src = await page.evaluate(`document.querySelector('[data-lightbox-image="preview"]')?.getAttribute('src') ?? ''`);
        const arrows = await page.evaluate(`Boolean(document.querySelector('[aria-label="下一张"]'))`);
        return src.includes('/preview') && arrows ? src : '';
      }, 8000, 'room lightbox');
      await page.shot('07-room-lightbox');
      await page.evaluate(`document.querySelector('[aria-label="关闭"]').click()`);
      const items = await call(`${base}/items`, { cookie: admin });
      const small = items.parsed.items.find((item) => item.filename === 'small.png');
      const share = await call(`${base}/items/${small.id}/shares`, { cookie: admin, method: 'POST', json: { expiresIn: 'never', maxViews: null } });
      await page.goto(share.parsed.url);
      await poll(() => page.evaluate(`document.body.innerText.includes('small.png')`), 8000, 'share page');
      await page.evaluate(`document.querySelector('[aria-label="查看 small.png"]').click()`);
      const shareLight = await page.evaluate(`(() => ({
        src: document.querySelector('[data-lightbox-image="preview"]')?.getAttribute('src') ?? '',
        next: Boolean(document.querySelector('[aria-label="下一张"]')),
        download: document.querySelector('[data-testid="lightbox-toolbar"] a')?.getAttribute('href') ?? '',
      }))()`);
      await page.shot('08-share-lightbox');
      if (!shareLight.src.includes('/preview') || shareLight.next || !shareLight.download.includes('/file')) throw new Error(JSON.stringify(shareLight));
      await page.evaluate(`document.querySelector('[aria-label="关闭"]').click()`);
      const once = await call(`${base}/items/${small.id}/shares`, { cookie: admin, method: 'POST', json: { expiresIn: '1d', maxViews: 1 } });
      await page.goto(once.parsed.url);
      await poll(() => page.evaluate(`document.body.innerText.includes('分享的内容')`), 8000, 'one-view share');
      await page.goto(once.parsed.url);
      const exhausted = await poll(async () => {
        const text = await page.evaluate('document.body.innerText');
        return text.includes('链接无效') ? text : '';
      }, 8000, 'views exhausted');
      await page.shot('09-share-exhausted');
      return `room ${roomPath} ${roomLight}; share single; exhausted ${exhausted.includes('链接无效')}`;
    });

    await check('AC-S1/S4 preview bytes and denials', async () => {
      const items = await call(`${base}/items`, { cookie: admin });
      const byName = (name) => items.parsed.items.find((item) => item.filename === name);
      const expectSize = async (name, width, height) => {
        const item = byName(name);
        const preview = await call(`${base}/items/${item.id}/preview`, { cookie: admin });
        if (preview.status !== 200 || preview.headers.get('content-type') !== 'image/webp') throw new Error(`${name} ${preview.status} ${preview.headers.get('content-type')}`);
        const meta = await sharp(preview.buf).metadata();
        if (meta.format !== 'webp' || meta.width !== width || meta.height !== height) throw new Error(`${name} ${meta.width}x${meta.height} ${meta.format}`);
        return meta;
      };
      await expectSize('small.png', 48, 24);
      const oriented = await sharp(bytes.large).metadata();
      const largeMeta = await expectSize('large.jpg', 1024, 2048);
      if (largeMeta.exif || largeMeta.orientation) throw new Error('metadata kept');
      const gifItem = byName('anim.gif');
      const gifPreview = await call(`${base}/items/${gifItem.id}/preview`, { cookie: admin });
      const gifMeta = await sharp(gifPreview.buf, { animated: true }).metadata();
      if (gifMeta.width !== 32 || gifMeta.height !== 16 || (gifMeta.pages ?? 1) !== 1) throw new Error(`gif ${gifMeta.width}x${gifMeta.height} pages ${gifMeta.pages}`);
      const red = await sharp(gifPreview.buf).raw().toBuffer();
      if (red[0] < 200 || red[2] > 40) throw new Error('gif preview is not the first red frame');
      for (const name of ['note.svg', 'plain.bin']) {
        const item = byName(name);
        const preview = await call(`${base}/items/${item.id}/preview`, { cookie: admin });
        if (preview.status !== 404) throw new Error(`${name} preview ${preview.status}`);
      }
      const fake = await call(`${base}/items/file`, {
        cookie: admin,
        method: 'POST',
        body: Buffer.from('<html><script>alert(1)</script></html>'),
        headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('disguised.png') },
      });
      if (fake.status !== 415) throw new Error(`disguised ${fake.status} ${fake.buf.toString().slice(0, 120)}`);
      const invite = await call('/api/admin/invites', { cookie: admin, method: 'POST', json: { spaceId: adminSpace.id, maxUses: 2, expiresInHours: 4 } });
      const guest = await login('browser-guest', invite.parsed.token);
      const guestSpaces = await call('/api/spaces', { cookie: guest });
      const guestMe = await call('/api/me', { cookie: guest });
      const own = guestSpaces.parsed.spaces.find((space) => space.ownerId === guestMe.parsed.user.id);
      const guestUpload = await call(`/api/spaces/${own.id}/items/file`, {
        cookie: guest,
        method: 'POST',
        body: bytes.small,
        headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('guest.png') },
      });
      const guestItem = guestUpload.parsed.item;
      const outsider = await call(`/api/spaces/${own.id}/items/${guestItem.id}/preview`, { cookie: admin });
      if (guestUpload.status !== 201 || outsider.status !== 404) throw new Error(`non-member upload ${guestUpload.status} preview ${outsider.status} ${guestUpload.buf.toString().slice(0, 160)}`);
      const room = await call('/api/rooms', { method: 'POST' });
      const roomUpload = await call(`/api/rooms/${room.parsed.token}/items/file`, {
        method: 'POST',
        body: bytes.small,
        headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('room.png') },
      });
      const roomPreview = await call(`/api/rooms/${room.parsed.token}/items/${roomUpload.parsed.item.id}/preview`);
      if (roomPreview.status !== 200) throw new Error(`room preview ${roomPreview.status}`);
      const expiring = await call(`${base}/items/${byName('large.jpg').id}/shares`, { cookie: admin, method: 'POST', json: { expiresIn: '1h', maxViews: null } });
      await call('/__mock/advance?ms=7200000', { method: 'POST' });
      const expired = await call(`/api/s/${expiring.parsed.token}/preview`);
      const revokedShare = await call(`${base}/items/${byName('anim.gif').id}/shares`, { cookie: admin, method: 'POST', json: { expiresIn: 'never', maxViews: null } });
      await call(`${base}/shares/${revokedShare.parsed.id}`, { cookie: admin, method: 'DELETE' });
      const revoked = await call(`/api/s/${revokedShare.parsed.token}/preview`);
      if (expired.status !== 404 || revoked.status !== 404) throw new Error(`expired ${expired.status} revoked ${revoked.status}`);
      if (!oriented.exif) throw new Error('fixture lost exif before upload');
      return `small 48x24 large ${largeMeta.width}x${largeMeta.height} gif 32x16 first-frame; svg/plain 404; disguised 415; non-member 404; room 200; expired/revoked 404`;
    });

    await check('AC-R3 cancel, quota, leave, switch', async () => {
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`Boolean(document.querySelector('#draft'))`), 8000, 'composer');
      const before = await call('/api/me', { cookie: admin });
      const beforeFiles = (await readdir(join(dataDir, 'files'))).length;
      await call('/__mock/pace?ms=250', { method: 'POST' });
      await call('/__mock/stats/reset', { method: 'POST' });
      await page.files([0, 1, 2, 3].map((index) => join(fixtures, `cancel${index}.bin`)));
      await poll(async () => {
        const text = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return text.includes('排队中') ? text : '';
      }, 4000, 'queue visible');
      const queuedName = await page.evaluate(`(() => {
        const row = [...document.querySelectorAll('[aria-label="上传队列"] li')].find((node) => node.innerText.includes('排队中'));
        return row?.querySelector('p')?.textContent ?? '';
      })()`);
      await page.evaluate(`document.querySelector(${JSON.stringify(`[aria-label="取消 ${queuedName}"]`)}).click()`);
      const removed = await poll(async () => {
        const text = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return text.includes(queuedName) ? '' : 'removed';
      }, 3000, 'queued row removed');
      page.dialogs = [];
      page.dialogMode = 'dismiss';
      // In-app links are client-side routes and do not unload the document.
      // A real cross-origin navigation is what fires beforeunload.
      await page.evaluate(`(() => {
        const link = document.createElement('a');
        link.id = 'leave-probe';
        link.href = 'https://example.com/';
        link.textContent = 'leave';
        link.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99999';
        document.body.append(link);
      })()`);
      await clickFound(page, centerOf(`document.getElementById('leave-probe')`));
      await poll(() => page.dialogs.length ? 'dialog' : '', 4000, 'beforeunload dialog');
      const leave = page.dialogs[0];
      if (leave?.type !== 'beforeunload') throw new Error(JSON.stringify(page.dialogs));
      await page.shot('10-leave-prompt');
      const uploadingName = await page.evaluate(`(() => {
        const row = [...document.querySelectorAll('[aria-label="上传队列"] li')].find((node) => node.innerText.includes('上传中'));
        return row?.querySelector('p')?.textContent ?? '';
      })()`);
      await page.evaluate(`document.querySelector(${JSON.stringify(`[aria-label="取消 ${uploadingName}"]`)}).click()`);
      await poll(async () => {
        const text = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return text.includes(uploadingName) && text.includes('已取消') ? 'cancelled' : '';
      }, 3000, 'uploading cancelled');
      await page.evaluate(`([...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '全部取消')).click()`);
      await poll(async () => {
        const text = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return !text.includes('上传中') && !text.includes('排队中') ? 'idle' : '';
      }, 4000, 'cancel all');
      await poll(async () => ((await readdir(join(dataDir, 'files'))).length === beforeFiles ? 'clean' : ''), 12000, 'partial files removed').catch(() => {});
      const after = await call('/api/me', { cookie: admin });
      const names = (await readdir(join(dataDir, 'files')));
      const items = await call(`${base}/items`, { cookie: admin });
      const leaked = ['cancel0.bin', 'cancel1.bin', 'cancel2.bin', 'cancel3.bin'].filter((name) => items.parsed.items.some((item) => item.filename === name));
      if (leaked.length) throw new Error(`cancelled items kept ${leaked.join(',')}`);
      if (after.parsed.usedBytes !== before.parsed.usedBytes) throw new Error(`quota ${before.parsed.usedBytes} -> ${after.parsed.usedBytes}`);
      if (names.length !== beforeFiles) throw new Error(`partial files kept ${beforeFiles} -> ${names.length} (${removed})`);
      const invite = await call('/api/admin/invites', { cookie: admin, method: 'POST', json: { spaceId: adminSpace.id, maxUses: 1, expiresInHours: 2 } });
      const guest = await login('browser-guest', invite.parsed.token);
      await page.send('Network.setCookie', { name: 'dropit_session', value: guest, url: origin });
      page.dialogMode = 'accept';
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`document.body.innerText.toLowerCase().includes('browser guest')`), 8000, 'guest home');
      await call('/__mock/pace?ms=500', { method: 'POST' });
      await page.files([join(fixtures, 'hold.bin')]);
      await poll(async () => page.evaluate(`(document.querySelector('[aria-label="上传队列"]')?.innerText ?? '').includes('上传中')`), 4000, 'guest uploading');
      page.dialogs = [];
      page.dialogMode = 'dismiss';
      const spaceTrigger = centerOf(`[...document.querySelectorAll('button')].find((node) => node.textContent.includes('私人空间') || node.textContent.includes('受邀空间'))`);
      const otherSpace = `(() => {
        const trigger = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('私人空间') || node.textContent.includes('受邀空间'));
        const current = trigger ? trigger.textContent.trim() : '';
        const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => {
          const label = node.textContent.trim();
          return label !== current && (label.includes('私人空间') || label.includes('受邀空间'));
        });
        if (!item) return null;
        const rect = item.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`;
      await clickFound(page, spaceTrigger);
      await poll(() => page.evaluate(`Boolean(document.querySelector('[role="menuitem"]'))`), 3000, 'space menu');
      await clickFound(page, otherSpace);
      await poll(() => page.dialogs.some((dialog) => dialog.type === 'confirm') ? 'confirm' : '', 4000, 'space confirm');
      const confirm = page.dialogs.find((dialog) => dialog.type === 'confirm');
      if (!confirm?.message.includes('未完成的上传')) throw new Error(JSON.stringify(page.dialogs));
      const stayed = await page.evaluate(`(document.querySelector('[aria-label="上传队列"]')?.innerText ?? '').includes('上传')`);
      if (!stayed) throw new Error('dismissed confirm cancelled the queue');
      page.dialogMode = 'accept';
      page.dialogs = [];
      await clickFound(page, spaceTrigger);
      await poll(() => page.evaluate(`Boolean(document.querySelector('[role="menuitem"]'))`), 3000, 'space menu again');
      await clickFound(page, otherSpace);
      await sleep(800);
      await call('/__mock/pace?ms=0', { method: 'POST' });
      await page.send('Network.deleteCookies', { name: 'dropit_session', url: origin });
      await page.shot('11-cancel');
      return `queued ${queuedName} removed; uploading ${uploadingName} cancelled; quota unchanged; confirm ${confirm.message}`;
    });

    await check('regression copy share capsule edit retract links limits', async () => {
      await page.send('Network.setCookie', { name: 'dropit_session', value: admin, url: origin });
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`document.body.innerText.toLowerCase().includes('browser admin')`), 8000, 'admin back');
      await page.evaluate(`(() => {
        const area = document.querySelector('#draft');
        const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        proto.set.call(area, '看 https://example.com/docs 结尾。');
        area.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('button[type=submit]').click();
      })()`);
      await poll(() => page.evaluate(`Boolean(document.querySelector('a[href="https://example.com/docs"]'))`), 8000, 'link');
      const link = await page.evaluate(`(() => {
        const node = document.querySelector('a[href="https://example.com/docs"]');
        return { target: node.target, rel: node.rel, text: node.textContent };
      })()`);
      if (link.target !== '_blank' || !link.rel.includes('noopener') || !link.rel.includes('nofollow') || link.text !== 'https://example.com/docs') throw new Error(JSON.stringify(link));
      await page.evaluate(`(() => {
        if (!navigator.clipboard) navigator.clipboard = {};
        navigator.clipboard.writeText = async (text) => { window.__copied = text; };
        document.querySelector('[aria-label="复制"]').click();
      })()`);
      await sleep(300);
      const copied = await page.evaluate('window.__copied');
      if (!String(copied).includes('example.com')) throw new Error(String(copied));
      await page.evaluate(`document.querySelector('[aria-label="分享"]').click()`);
      await poll(() => page.evaluate(`document.body.innerText.includes('生成链接')`), 4000, 'share panel');
      await page.evaluate(`([...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '生成链接')).click()`);
      await poll(() => page.evaluate(`Boolean(document.querySelector('[aria-label="分享链接"]'))`), 6000, 'share url');
      await page.evaluate(`document.querySelector('[aria-label="更多"]').click()`);
      await poll(() => page.evaluate(`Boolean(document.querySelector('[aria-label="编辑"]'))`), 4000, 'capsule edit');
      await page.evaluate(`document.querySelector('[aria-label="编辑"]').click()`);
      await page.evaluate(`(() => {
        const area = document.querySelector('textarea[id^="edit-"]');
        const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        proto.set.call(area, '改过的文本 https://example.com/docs');
        area.dispatchEvent(new Event('input', { bubbles: true }));
        ([...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '保存')).click();
      })()`);
      await poll(() => page.evaluate(`document.body.innerText.includes('已编辑')`), 6000, 'edited');
      await page.evaluate(`document.querySelector('[aria-label="撤回"]').click()`);
      await page.evaluate(`document.querySelector('[aria-label="确认撤回"]').click()`);
      await poll(async () => {
        const text = await page.evaluate('document.body.innerText');
        return text.includes('改过的文本') ? '' : 'retracted';
      }, 6000, 'retract');
      await page.goto(`${origin}/admin`);
      await poll(() => page.evaluate(`Boolean([...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.trim() === '限制'))`), 8000, 'limits tab');
      await page.evaluate(`([...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent.trim() === '限制')).click()`);
      await poll(() => page.evaluate(`Boolean(document.querySelector('#limit-maxItems'))`), 8000, 'limits');
      await page.evaluate(`(() => {
        const input = document.querySelector('#limit-maxItems');
        const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        proto.set.call(input, '1001');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-limit="maxItems"] button[type="submit"]').click();
      })()`);
      await poll(() => page.evaluate(`document.querySelector('[data-limit="maxItems"]').innerText.includes('已覆盖')`), 6000, 'limit saved');
      await page.evaluate(`([...document.querySelector('[data-limit="maxItems"]').querySelectorAll('button')].find((node) => node.textContent.trim() === '恢复默认')).click()`);
      await poll(() => page.evaluate(`document.querySelector('[data-limit="maxItems"]').innerText.includes('未覆盖')`), 6000, 'limit restored');
      await page.shot('12-regression');
      return 'link, copy, share, capsule edit, retract, limits restore';
    });

    await check('AC-R2 browser 429 retries without failing siblings', async () => {
      await page.goto(`${origin}/`);
      await poll(() => page.evaluate(`Boolean(document.querySelector('#draft'))`), 8000, 'composer');
      const patched = await call('/api/admin/limits', {
        cookie: admin,
        method: 'PATCH',
        json: { rateWindowMs: 2000, rateUpload: 2, rateRoom: 1 },
      });
      if (patched.status !== 200) throw new Error(`limits ${patched.status} ${patched.buf.toString().slice(0, 180)}`);
      await call('/__mock/advance?ms=120000', { method: 'POST' });
      await call('/__mock/pace?ms=0', { method: 'POST' });
      page.resetNet();
      await page.files([join(fixtures, 'q0.txt'), join(fixtures, 'q1.txt'), join(fixtures, 'q2.txt')]);
      const settled = await poll(async () => {
        const text = await page.evaluate('document.body.innerText');
        const names = ['q0.txt', 'q1.txt', 'q2.txt'].every((name) => text.includes(name));
        const queue = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return names && !queue.includes('失败') && !queue.includes('上传中') ? 'done' : '';
      }, 15000, '429 retry settled');
      const saw429 = page.uploads.includes(429);
      const restored = await call('/api/admin/limits', {
        cookie: admin,
        method: 'PATCH',
        json: { rateWindowMs: null, rateUpload: null, rateRoom: null },
      });
      await call('/__mock/advance?ms=120000', { method: 'POST' });
      if (!saw429) throw new Error(`statuses ${page.uploads.join(',')} ${settled}`);
      if (restored.status !== 200) throw new Error('limit restore failed');
      await page.shot('13-retry');
      return `statuses ${page.uploads.join(',')}`;
    });

    await check('AC-R5 CLI push progress, concurrency, failure, SIGINT', async () => {
      await run('pnpm', ['--filter', '@dropit/cli', 'build'], { cwd: root });
      const token = await call('/api/tokens', { cookie: admin, method: 'POST', json: { name: 'rhea182', scopes: ['read', 'write'], expiresInDays: 1 } });
      const secret = token.parsed.token;
      if (!secret) throw new Error(`token ${token.status}`);
      const env = { ...process.env, DROPIT_URL: origin, DROPIT_TOKEN: secret, DROPIT_CONFIG: join(outDir, 'cli-config.json') };
      const cli = join(root, 'apps/cli/dist/index.js');
      await call('/__mock/pace?ms=200', { method: 'POST' });
      await call('/__mock/stats/reset', { method: 'POST' });
      const batch = await run(process.execPath, [cli, 'push', ...[0, 1, 2, 3].map((index) => join(fixtures, `pace${index}.bin`))], { env });
      const stats = await call('/__mock/stats');
      if (batch.code !== 0) throw new Error(batch.stderr.slice(-400));
      if (!batch.stderr.includes('排队') || !batch.stderr.includes('完成')) throw new Error(batch.stderr.slice(0, 300));
      if (stats.parsed.max !== 3) throw new Error(`cli concurrency ${stats.parsed.max}`);
      const ttyFile = join(outDir, 'tty-out.txt');
      const ttyCode = `
import os, pty, select, sys
out_path = sys.argv[1]
cmd = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
data = b''
code = 1

def finish(status):
    global code, data
    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
    while True:
        try:
            chunk = os.read(fd, 8192)
        except OSError:
            break
        if not chunk:
            break
        data += chunk

while True:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 8192)
        except OSError:
            _, status = os.waitpid(pid, 0)
            finish(status)
            break
        if not chunk:
            _, status = os.waitpid(pid, 0)
            finish(status)
            break
        data += chunk
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        finish(status)
        break
open(out_path, 'wb').write(data)
raise SystemExit(code)
`;
      await call('/__mock/stats/reset', { method: 'POST' });
      const tty = await run('python3', ['-c', ttyCode, ttyFile, process.execPath, cli, 'push', join(fixtures, 'cli0.txt'), join(fixtures, 'cli1.txt')], { env });
      const { readFile } = await import('node:fs/promises');
      const ttyText = await readFile(ttyFile, 'utf8');
      if (tty.code !== 0 || !ttyText.includes('%')) throw new Error(`tty ${tty.code} ${ttyText.slice(0, 200)}`);
      const mixed = await run(process.execPath, [cli, 'push', join(fixtures, 'cli2.txt'), join(fixtures, 'cli-bad.png'), join(fixtures, 'cli3.txt')], { env });
      const listed = await run(process.execPath, [cli, 'ls'], { env });
      if (mixed.code === 0) throw new Error('bad png should fail the command');
      if (!listed.stdout.includes('cli2.txt') || !listed.stdout.includes('cli3.txt') || listed.stdout.includes('cli-bad.png')) {
        throw new Error(listed.stdout.slice(0, 400));
      }
      const usageBefore = await call('/api/me', { cookie: admin });
      const filesBefore = (await readdir(join(dataDir, 'files'))).length;
      await call('/__mock/pace?ms=300', { method: 'POST' });
      const slow = spawn(process.execPath, [cli, 'push', join(fixtures, 'cli-slow.bin'), join(fixtures, 'chunky.bin')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let slowErr = '';
      slow.stderr.on('data', (chunk) => { slowErr += chunk; });
      await poll(async () => slowErr.includes('上传') ? 'started' : '', 8000, 'cli started');
      slow.kill('SIGINT');
      const [slowCode] = await once(slow, 'close');
      await call('/__mock/pace?ms=0', { method: 'POST' });
      await poll(async () => ((await readdir(join(dataDir, 'files'))).length === filesBefore ? 'clean' : ''), 4000, 'cli file cleanup').catch(() => {});
      let filesAfter = (await readdir(join(dataDir, 'files'))).length;
      let usageAfter = await call('/api/me', { cookie: admin });
      if (filesAfter !== filesBefore) {
        await sleep(20000);
        filesAfter = (await readdir(join(dataDir, 'files'))).length;
        usageAfter = await call('/api/me', { cookie: admin });
      }
      const slowListed = await run(process.execPath, [cli, 'ls'], { env });
      if (slowCode !== 130) throw new Error(`sigint exit ${slowCode} ${slowErr.slice(-200)}`);
      if (slowListed.stdout.includes('cli-slow.bin') || slowListed.stdout.includes('chunky.bin')) throw new Error('cancelled cli files were kept');
      if (usageAfter.parsed.usedBytes !== usageBefore.parsed.usedBytes || filesAfter !== filesBefore) {
        throw new Error(`cleanup quota ${usageBefore.parsed.usedBytes}->${usageAfter.parsed.usedBytes} files ${filesBefore}->${filesAfter}`);
      }
      return `non-tty lines, concurrency ${stats.parsed.max}, tty progress, sibling kept, sigint 130 cleaned`;
    });

    await dockerRoom(page, bytes);
  } finally {
    await browser.close().catch(() => {});
    xvfb?.kill('SIGTERM');
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
    await writeFile(join(outDir, 'report.json'), JSON.stringify(results, null, 2));
    await writeFile(join(outDir, 'server.log'), serverLog);
  }
}

async function dockerRoom(page, bytes) {
  const dockerPort = 18791;
  const dockerOrigin = `http://127.0.0.1:${dockerPort}`;
  const name = 'dropit-rhea182';
  await run('docker', ['rm', '-f', name]);
  const started = await run('docker', [
    'run', '-d', '--name', name, '-p', `127.0.0.1:${dockerPort}:8787`,
    '-e', 'NODE_ENV=development', '-e', 'HOST=0.0.0.0', '-e', 'PORT=8787',
    '-e', `APP_ORIGIN=${dockerOrigin}`, '-e', 'DATA_DIR=/data', '-e', 'STATIC_DIR=/app/public',
    image,
  ]);
  try {
    if (started.code !== 0) throw new Error(started.stderr);
    await waitFor(`${dockerOrigin}/healthz`);
    await check('docker image has no mock login', async () => {
      const providers = await fetch(`${dockerOrigin}/api/auth/providers`);
      const body = await providers.json();
      const mock = await fetch(`${dockerOrigin}/__mock/authorize`, { redirect: 'manual' });
      const mockBody = await mock.text();
      if (body.providers?.length) throw new Error(JSON.stringify(body));
      if ((mock.status >= 300 && mock.status < 400) || mockBody.includes('browser-admin')) throw new Error(`mock route ${mock.status}`);
      if (!mockBody.includes('id="root"')) throw new Error(`unexpected ${mock.status} ${mockBody.slice(0, 80)}`);
      return 'providers empty; /__mock/authorize is the SPA, not an OAuth redirect';
    });
    await check('docker room queue and lightbox', async () => {
      await page.viewport(1280, 800);
      await page.goto(`${dockerOrigin}/`);
      await poll(() => page.evaluate(`Boolean([...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '进入临时房间'))`), 8000, 'room button');
      await page.evaluate(`([...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '进入临时房间')).click()`);
      const roomPath = await poll(async () => {
        const path = await page.evaluate('location.pathname');
        return path.startsWith('/rooms/') ? path : '';
      }, 8000, 'docker room');
      const token = roomPath.split('/').pop();
      await poll(() => page.evaluate(`Boolean(document.querySelector('input[type=file]'))`), 8000, 'docker file input');
      await page.send('Network.emulateNetworkConditions', {
        offline: false, latency: 40, downloadThroughput: 200000, uploadThroughput: 24000,
      });
      page.resetNet();
      const files = [];
      for (let index = 0; index < 4; index += 1) {
        const path = join(outDir, 'fixtures', `docker${index}.bin`);
        await writeFile(path, Buffer.alloc(80 * 1024, index + 1));
        files.push(path);
      }
      await page.files(files);
      const queued = await poll(async () => {
        const text = await page.evaluate(`document.querySelector('[aria-label="上传队列"]')?.innerText ?? ''`);
        return text.includes('排队中') || text.includes('上传中') ? text : '';
      }, 6000, 'docker queue');
      await page.shot('14-docker-queue');
      const dockerPeak = page.maxUploads;
      if (dockerPeak > 3) throw new Error(`docker browser concurrency ${dockerPeak}`);
      const cancelName = await page.evaluate(`(() => {
        const row = [...document.querySelectorAll('[aria-label="上传队列"] li')].find((node) => node.innerText.includes('排队中') || node.innerText.includes('上传中'));
        return row?.querySelector('p')?.textContent ?? '';
      })()`);
      if (cancelName) await page.evaluate(`document.querySelector(${JSON.stringify(`[aria-label="取消 ${cancelName}"]`)}).click()`);
      await page.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      await poll(async () => {
        const text = await page.evaluate('document.body.innerText');
        return text.includes('docker') ? text : '';
      }, 20000, 'docker upload landed');
      const smallPath = join(outDir, 'fixtures', 'small.png');
      const largePath = join(outDir, 'fixtures', 'large.jpg');
      await page.files([smallPath, largePath]);
      await poll(() => page.evaluate(`Boolean(document.querySelector('[aria-label="查看 large.jpg"]'))`), 20000, 'docker images');
      await page.evaluate(`document.querySelector('[aria-label="查看 large.jpg"]').click()`);
      const meta = await poll(async () => {
        const text = await page.evaluate(`document.querySelector('[data-testid="lightbox-meta"]')?.textContent ?? ''`);
        return text.includes('2048') ? text : '';
      }, 8000, 'docker preview meta');
      const filter = await page.evaluate(`getComputedStyle(document.querySelector('[data-testid="lightbox-backdrop"]')).backdropFilter`);
      await page.shot('15-docker-lightbox');
      const list = await fetch(`${dockerOrigin}/api/rooms/${token}/items`);
      const body = await list.json();
      const large = body.items.find((item) => item.filename === 'large.jpg');
      const preview = await fetch(`${dockerOrigin}/api/rooms/${token}/items/${large.id}/preview`);
      const previewBytes = Buffer.from(await preview.arrayBuffer());
      const info = await sharp(previewBytes).metadata();
      if (preview.status !== 200 || info.width !== 1024 || info.height !== 2048 || info.format !== 'webp') {
        throw new Error(`preview ${preview.status} ${info.width}x${info.height}`);
      }
      const stored = await run('docker', ['exec', name, 'node', '-e', "const fs=require('fs'); console.log(fs.readdirSync('/data/files').length)"]);
      const expected = body.items.filter((item) => item.kind === 'file').reduce((sum, item) => sum + (item.hasThumbnail ? 2 : 1), 0);
      if (Number(stored.stdout.trim()) !== expected) throw new Error(`stored ${stored.stdout.trim()} expected ${expected}`);
      if (!String(filter).includes('blur(8px)')) throw new Error(filter);
      return `queue seen, concurrency ${dockerPeak}, ${meta}, files match items; ${queued.slice(0, 40)}`;
    });
  } finally {
    await run('docker', ['rm', '-f', name]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(() => {
  const failed = results.filter((item) => !item.pass);
  if (failed.length) {
    console.error(`acceptance failed: ${failed.map((item) => item.id).join(', ')}`);
    process.exitCode = 1;
  }
});
