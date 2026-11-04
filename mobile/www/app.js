import {
  normalizeServerUrl, isDropitVersion, deviceName, pollOutcome,
  pickSpace, itemTitle, formatSize, timeAgo, sharedText, newDeviceId, deviceHeaders, apiError,
} from './core.js';
const cap = window.Capacitor;
const Http = cap?.Plugins?.CapacitorHttp;
const Prefs = cap?.Plugins?.Preferences;
const Browser = cap?.Plugins?.Browser;
const Clipboard = cap?.Plugins?.Clipboard;
const Share = cap?.Plugins?.DropitShare;
const Device = { model: navigator.userAgent.match(/;\s*([^;)]+)\sBuild/)?.[1] };
const $ = id => document.getElementById(id);
const show = id => { for (const s of ['setup', 'login', 'home']) $(s).hidden = s !== id; };

async function get(key) { return Prefs ? (await Prefs.get({ key })).value : localStorage.getItem(key); }
async function set(key, value) { return Prefs ? Prefs.set({ key, value }) : localStorage.setItem(key, value); }
async function del(key) { return Prefs ? Prefs.remove({ key }) : localStorage.removeItem(key); }

async function request(method, url, data, token, extra = {}) {
  const headers = { 'content-type': 'application/json', ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  if (Http) {
    const r = await Http.request({ method, url, headers, data, connectTimeout: 10000, readTimeout: 20000 });
    return { status: r.status, body: typeof r.data === 'string' ? safeJson(r.data) : r.data };
  }
  const r = await fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
  return { status: r.status, body: safeJson(await r.text()) };
}
function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

async function checkServer() {
  $('setup-msg').textContent = '';
  try {
    const server = normalizeServerUrl($('url').value);
    const r = await request('GET', `${server}/api/version`);
    if (r.status !== 200 || !isDropitVersion(r.body)) throw new Error('这个地址不是 dropit 服务器（/api/version 没有正确响应）');
    await set('server', server);
    await startLogin(server);
  } catch (e) { $('setup-msg').textContent = e.message || '连接失败'; }
}

let polling = null;
async function startLogin(server) {
  session = null;
  show('login');
  $('login-msg').textContent = '';
  const r = await request('POST', `${server}/api/auth/device/authorize`, { name: deviceName(Device.model), scopes: ['read', 'write'], expiresInDays: 365 });
  if (r.status !== 200 || !r.body?.device_code) { $('login-msg').textContent = '无法开始登录'; return; }
  const { device_code, user_code, verification_uri_complete } = r.body;
  let interval = (r.body.interval || 5) * 1000;
  $('user-code').textContent = user_code;
  const open = () => Browser ? Browser.open({ url: verification_uri_complete }) : window.open(verification_uri_complete, '_blank');
  $('open').onclick = open;
  open();
  clearTimeout(polling);
  const tick = async () => {
    const p = pollOutcome(...Object.values(await request('POST', `${server}/api/auth/device/token`, { device_code })));
    if (p.kind === 'token') { await set('token', p.token); Browser?.close?.().catch(() => {}); return ready(server); }
    if (p.kind === 'slow') interval += 5000;
    if (p.kind === 'pending' || p.kind === 'slow') { polling = setTimeout(tick, interval); return; }
    $('login-msg').textContent = p.kind === 'denied' ? '已拒绝' : p.kind === 'expired' ? '验证码已过期，请重试' : `登录失败（${p.code}）`;
  };
  polling = setTimeout(tick, interval);
}

// ---- signed-in home: recent items, paste, share target ----
let session = null; // { server, token, spaceId, me, device }

async function deviceId() {
  let id = await get('deviceId');
  if (!id) { id = newDeviceId(); await set('deviceId', id); }
  return id;
}

async function ready(server) {
  const token = await get('token');
  const me = await request('GET', `${server}/api/me`, null, token);
  if (me.status === 401) { await del('token'); return startLogin(server); }
  if (me.status !== 200 || !me.body?.user) { show('home'); $('home-msg').textContent = `无法连接 ${new URL(server).host}`; return; }
  const sp = await request('GET', `${server}/api/spaces`, null, token);
  const space = pickSpace(sp.body?.spaces, me.body.user.id);
  if (!space) { show('home'); $('home-msg').textContent = '没有可用的空间'; return; }
  session = { server, token, spaceId: space.id, me: me.body, device: deviceHeaders(await deviceId(), deviceName(Device.model)) };
  await Share?.setServer?.({ url: server }).catch(() => {});
  show('home');
  $('home-msg').textContent = `已连接 ${new URL(server).host}`;
  await loadItems();
  await drainShares();
}

const base = () => `${session.server}/api/spaces/${encodeURIComponent(session.spaceId)}`;

let loading = false;
async function loadItems() {
  if (!session || loading) return;
  loading = true;
  try {
    const r = await request('GET', `${base()}/items`, null, session.token);
    if (r.status === 401) { await del('token'); return startLogin(session.server); }
    if (r.status !== 200) { toast(apiError(r.status, r.body)); return; }
    renderItems(Array.isArray(r.body?.items) ? r.body.items.slice(0, 50) : []);
  } catch (e) { toast(`刷新失败：${e.message || e}`); }
  finally { loading = false; }
}

function renderItems(items) {
  const ul = $('items');
  ul.textContent = '';
  $('empty').hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement('li');
    if (item.kind === 'file' && item.hasThumbnail) {
      const img = document.createElement('img');
      img.alt = '';
      li.append(img);
      loadThumb(item, img);
    }
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = itemTitle(item);
    const m = document.createElement('div');
    m.className = 'm';
    const from = item.device?.name ? ` · 来自 ${item.device.name}` : '';
    m.textContent = item.kind === 'text' ? `${timeAgo(item.createdAt)}${from} · 点按复制` : `${formatSize(item.size)} · ${timeAgo(item.createdAt)}${from}`;
    t.append(m);
    li.append(t);
    li.onclick = () => copyItem(item);
    ul.append(li);
  }
}

async function loadThumb(item, img) {
  if (!Http) return;
  try {
    const r = await Http.request({ method: 'GET', url: `${base()}/items/${encodeURIComponent(item.id)}/thumbnail`, headers: { authorization: `Bearer ${session.token}` }, responseType: 'blob', readTimeout: 15000 });
    if (r.status === 200 && typeof r.data === 'string') img.src = `data:image/webp;base64,${r.data}`;
  } catch { /* thumbnail is optional */ }
}

async function copyItem(item) {
  if (item.kind !== 'text') { toast('文件不能复制到剪贴板，可以在网页版里下载'); return; }
  try {
    if (Clipboard) await Clipboard.write({ string: item.text ?? '' });
    else await navigator.clipboard.writeText(item.text ?? '');
    toast('已复制');
  } catch (e) { toast(`复制失败：${e.message || e}`); }
}

async function sendText(text) {
  const r = await request('POST', `${base()}/items/text`, { text }, session.token, session.device);
  if (r.status === 201) return true;
  toast(apiError(r.status, r.body));
  return false;
}

async function pasteFromClipboard() {
  if (!session) return;
  try {
    const c = Clipboard ? await Clipboard.read() : { value: await navigator.clipboard.readText() };
    const text = String(c?.value ?? '');
    if (!text.trim()) { toast('剪贴板里没有文字'); return; }
    if (c?.type && !/^text\//.test(c.type)) { toast('剪贴板里不是文字（图片请用「分享 → dropit」）'); return; }
    if (await sendText(text)) { toast('已发送到 dropit'); await loadItems(); }
  } catch (e) { toast(`读取剪贴板失败：${e.message || e}`); }
}

let draining = false;
async function drainShares() {
  if (!Share || !session || draining) return;
  draining = true;
  try {
    const p = await Share.getPending();
    const files = Array.isArray(p?.files) ? p.files : [];
    const text = sharedText(p);
    if (!text && !files.length) return;
    let ok = 0, failed = 0;
    if (text) { if (await sendText(text)) ok++; else failed++; }
    for (const f of files) {
      toast(`正在发送 ${f.name}…`);
      try {
        const r = await Share.uploadFile({ id: f.id, url: `${base()}/items/file`, token: session.token, headers: { ...session.device, 'X-File-Name': encodeURIComponent(f.name || 'shared') } });
        if (r.status === 201) ok++;
        else { failed++; toast(`${f.name}：${apiError(r.status, safeJson(r.body))}`); }
      } catch (e) { failed++; toast(`${f.name}：${e.message || e}`); }
    }
    if (ok && !failed) toast(ok > 1 ? `已发送 ${ok} 项到 dropit` : '已发送到 dropit');
    else if (ok) toast(`已发送 ${ok} 项，${failed} 项失败`);
    await loadItems();
  } finally { draining = false; }
}

async function openWeb() {
  if (!session) return;
  // DropitShare.shouldOverrideLoad keeps this host inside the app WebView (Android back returns here).
  await Share?.setServer?.({ url: session.server }).catch(() => {});
  location.href = `${session.server}/`;
}

async function reset() {
  clearTimeout(polling);
  session = null;
  await del('token'); await del('server');
  await Share?.setServer?.({ url: '' }).catch(() => {});
  show('setup');
}
$('check').onclick = checkServer;
$('reset1').onclick = reset;
$('logout').onclick = reset;
$('refresh').onclick = () => loadItems();
$('paste').onclick = pasteFromClipboard;
$('web').onclick = openWeb;
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadItems(); });
Share?.addListener?.('shareReceived', () => drainShares());

(async () => {
  const server = await get('server');
  if (!server) return show('setup');
  return (await get('token')) ? ready(server) : startLogin(server);
})();
