// Headless Chrome smoke against a local dropit origin. Saves PNG evidence next to the report.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const target = process.argv[2];
const outDir = process.argv[3];
const label = process.argv[4] ?? 'browser';
if (!target || !outDir) {
  console.error('usage: node scripts/acceptance-browser.mjs <origin> <outdir> [label]');
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
const results = [];
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${detail}`);
}

const profile = await mkdtemp(join(tmpdir(), 'dropit-chrome-'));
const chrome = spawn('google-chrome', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--remote-debugging-port=9333',
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeLog = '';
chrome.stderr.on('data', (chunk) => { chromeLog += chunk; });
chrome.stdout.on('data', (chunk) => { chromeLog += chunk; });

async function waitForDebugger() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:9333/json/version');
      if (response.ok) return response.json();
    } catch { /* chrome still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`chrome debugger did not start: ${chromeLog.slice(-500)}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 20000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const version = await waitForDebugger();
const browser = new WebSocket(version.webSocketDebuggerUrl);
await once(browser, 'open');
const cdp = new Cdp(browser);
const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
const session = attached.sessionId;
await cdp.send('Page.enable', {}, session);
await cdp.send('Runtime.enable', {}, session);
await cdp.send('Network.enable', {}, session);

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || 'evaluate failed');
  }
  return result.result?.value;
}
async function goto(url) {
  await cdp.send('Page.navigate', { url }, session);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const ready = await evaluate('document.readyState');
    const text = await evaluate('document.body ? document.body.innerText.slice(0, 80) : ""');
    if (ready === 'complete' && text) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
async function shot(name) {
  const image = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
  const path = join(outDir, `${label}-${name}.png`);
  await writeFile(path, Buffer.from(image.data, 'base64'));
  return path;
}
async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 }, session);
}
async function clickBox(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, session);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, session);
}
async function boxFor(selector, text) {
  return evaluate(`(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.textContent.includes(${JSON.stringify(text)}));
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const files = await mkdtemp(join(tmpdir(), 'dropit-files-'));
await writeFile(join(files, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=1"><script>window.__xss=1</script></svg>');
await writeFile(join(files, 'page.html'), '<html><body><script>window.__xss=1</script><h1>owned</h1></body></html>');
await writeFile(join(files, 'shot.png'), png);

try {
  await setViewport(1280, 800);
  await goto(`${target}/login`);
  const loginText = await evaluate('document.body.innerText');
  record('AC-I1 login', loginText.includes('dropit') && loginText.includes('没有密码'), loginText.slice(0, 120).replaceAll('\n', ' '));
  await shot('login-desktop');

  await setViewport(1280, 800);
  await goto(`${target}/`);
  const buttonDeadline = Date.now() + 8000;
  let clicked = false;
  let lastText = '';
  while (Date.now() < buttonDeadline) {
    const outcome = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '创建临时房间');
      if (!button) return document.body.innerText.slice(0, 120);
      button.click();
      return 'clicked';
    })()`);
    if (outcome === 'clicked') { clicked = true; break; }
    lastText = String(outcome);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!clicked) throw new Error(`no room button: ${lastText}`);
  const deadline = Date.now() + 8000;
  let roomUrl = '';
  while (Date.now() < deadline) {
    roomUrl = await evaluate('location.pathname');
    if (roomUrl.startsWith('/rooms/')) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  record('AC-E1 browser room', roomUrl.startsWith('/rooms/') && roomUrl.length > '/rooms/'.length + 20, roomUrl);
  const shell = await evaluate(`Boolean([...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '登录'))`);
  record('AC-I1 room shell', shell === true, `login button ${shell}`);
  await setViewport(390, 844);
  await goto(`${target}${roomUrl}`);
  await shot('room-mobile');
  const bottom = await evaluate(`(() => {
    const nav = [...document.querySelectorAll('nav')].find((node) => getComputedStyle(node).position === 'fixed');
    if (!nav) return 'missing';
    const box = nav.getBoundingClientRect();
    return box.height > 20 && box.bottom > window.innerHeight - 4 ? 'visible' : 'hidden';
  })()`);
  record('AC-I1 mobile bar', bottom === 'visible', bottom);
  await setViewport(1280, 800);
  await goto(`${target}${roomUrl}`);
  const draftReady = Date.now() + 8000;
  let hasDraft = false;
  while (Date.now() < draftReady) {
    hasDraft = await evaluate(`Boolean(document.querySelector('#draft'))`);
    if (hasDraft) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  record('AC-D2 composer', hasDraft === true, `draft ${hasDraft}`);
  await evaluate(`(() => new Promise((resolve) => {
    const area = document.querySelector('#draft');
    const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    const text = '<script>window.__xss=1</script><img src=x onerror="window.__xss=1">\\n\\n# 标题\\n[坏](javascript:alert(1))';
    proto.set.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[type=submit]').click();
    const timer = setInterval(() => {
      if (document.body.innerText.includes('alert(1)')) { clearInterval(timer); resolve(true); }
    }, 100);
    setTimeout(() => { clearInterval(timer); resolve(false); }, 4000);
  }))()`);
  const xss = await evaluate(`(() => ({
    flag: window.__xss ?? null,
    scripts: document.querySelectorAll('script').length,
    onerror: document.querySelectorAll('img[onerror], svg[onload]').length,
    javascript: [...document.querySelectorAll('a')].some((node) => (node.getAttribute('href') || '').startsWith('javascript:')),
  }))()`);
  record('AC-G2 plain text', xss.flag == null && xss.onerror === 0 && xss.javascript === false, JSON.stringify(xss));
  const rendered = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '渲染');
    if (!button) return 'no-toggle';
    button.click();
    return 'clicked';
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterRender = await evaluate(`(() => ({
    flag: window.__xss ?? null,
    heading: Boolean(document.querySelector('h3,h4,h5')),
    javascript: [...document.querySelectorAll('a')].filter((node) => (node.getAttribute('href') || '').startsWith('javascript:')).map((node) => node.getAttribute('href')),
    scripts: [...document.querySelectorAll('script')].map((node) => node.src || 'inline'),
  }))()`);
  record('AC-G2 markdown', rendered === 'clicked' && afterRender.flag == null && afterRender.javascript.length === 0 && afterRender.heading === true && afterRender.scripts.every((src) => src !== 'inline'),
    JSON.stringify({ rendered, ...afterRender }));
  await shot('room-xss');

  await evaluate(`(() => {
    window.__copied = null;
    if (!navigator.clipboard) { window.__copied = 'missing-clipboard'; return; }
    navigator.clipboard.writeText = async (text) => { window.__copied = text; };
  })()`);
  const copyClicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '复制' || node.textContent.trim() === '复制');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const copied = await evaluate('window.__copied');
  record('AC-D2 copy', copyClicked === true && typeof copied === 'string' && copied.includes('alert(1)'), JSON.stringify(copied)?.slice(0, 120) ?? 'null');

  const pasted = await evaluate(`(() => new Promise((resolve) => {
    const bytes = Uint8Array.from(atob('${png.toString('base64')}'), (char) => char.charCodeAt(0));
    const file = new File([bytes], 'pasted.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    const timer = setInterval(() => {
      if (document.body.innerText.includes('pasted.png')) { clearInterval(timer); resolve('pasted'); }
    }, 150);
    setTimeout(() => { clearInterval(timer); resolve('timeout'); }, 5000);
  }))()`);
  record('AC-D2 paste screenshot', pasted === 'pasted', String(pasted));

  const doc = await cdp.send('DOM.getDocument', {}, session);
  const input = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }, session);
  await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [join(files, 'evil.svg'), join(files, 'page.html'), join(files, 'shot.png')] }, session);
  await evaluate(`(() => new Promise((resolve) => {
    const timer = setInterval(() => {
      if (document.body.innerText.includes('.svg') || document.body.innerText.includes('svg') || document.body.innerText.includes('PNG')) {
        clearInterval(timer); resolve(true);
      }
    }, 150);
    setTimeout(() => { clearInterval(timer); resolve(false); }, 5000);
  }))()`);
  const preview = await evaluate(`(() => ({
    flag: window.__xss ?? null,
    hostileSvg: [...document.querySelectorAll('svg')].some((node) => /onload|__xss|<script/i.test(node.outerHTML)),
    video: document.querySelectorAll('video').length,
    object: document.querySelectorAll('object,embed,iframe').length,
    images: [...document.querySelectorAll('img')].map((node) => node.getAttribute('src')),
    text: document.body.innerText.includes('owned'),
  }))()`);
  const rawSvgPreview = preview.images.some((src) => (src ?? '').includes('/download') || (src ?? '').endsWith('.svg'));
  const thumbnailOnly = preview.images.filter((src) => (src ?? '').includes('/thumbnail'));
  record('AC-G3 browser inline', preview.flag == null && preview.hostileSvg === false && preview.object === 0 && preview.video === 0 && preview.text === false && rawSvgPreview === false,
    JSON.stringify({ ...preview, thumbnailOnly: thumbnailOnly.length }));
  await shot('room-files');

  if (label === 'mock') {
    await goto(`${target}/login`);
    const linkDeadline = Date.now() + 8000;
    let linkReady = false;
    while (Date.now() < linkDeadline) {
      linkReady = await evaluate(`Boolean(document.querySelector('a[href="/api/auth/github"]'))`);
      if (linkReady) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    record('AC-A1 browser provider', linkReady === true, `github link ${linkReady}`);
    await evaluate(`document.querySelector('a[href="/api/auth/github"]').click()`);
    const loggedIn = Date.now() + 8000;
    let home = '';
    while (Date.now() < loggedIn) {
      home = await evaluate('document.body.innerText');
      if (home.includes('Browser Admin') || home.includes('私人')) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    record('AC-A3/B3 browser login', home.includes('Browser Admin') || home.includes('管理'), home.slice(0, 160).replaceAll('\n', ' '));
    await shot('home-admin');
    await goto(`${target}/admin`);
    const admin = await evaluate('document.body.innerText');
    record('AC-B4 browser admin', admin.includes('邀请') || admin.includes('用户') || admin.includes('配额'), admin.slice(0, 160).replaceAll('\n', ' '));
    await shot('admin');
    const trigger = await boxFor('button', 'Browser Admin');
    if (trigger) await clickBox(trigger.x, trigger.y);
    let themeItem = null;
    const themeDeadline = Date.now() + 2000;
    while (Date.now() < themeDeadline) {
      themeItem = await boxFor('[role="menuitem"]', '深色');
      if (themeItem) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (themeItem) await clickBox(themeItem.x, themeItem.y);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const dark = await evaluate('document.documentElement.classList.contains("dark")');
    record('AC-I1 dark theme', Boolean(trigger) && Boolean(themeItem) && dark === true, `trigger=${Boolean(trigger)} item=${Boolean(themeItem)} dark=${dark}`);
    await shot('dark');
  }
} finally {
  await writeFile(join(outDir, `${label}.json`), JSON.stringify(results, null, 2));
  chrome.kill('SIGTERM');
  await once(chrome, 'close').catch(() => {});
  await rm(profile, { recursive: true, force: true });
  await rm(files, { recursive: true, force: true });
}

if (results.some((item) => !item.pass)) process.exit(1);
