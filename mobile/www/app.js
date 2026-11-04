// RHEA-190 ui: the app only does server setup, device login and Android shares. After login it opens
// the server's full web UI inside the app WebView, signed in through a one-time ticket
// (POST /api/app-session/ticket with the device token, then GET /api/app-session?ticket=…).
import {
  normalizeServerUrl, isDropitVersion, deviceName, pollOutcome, pickSpace, sharedText,
  newDeviceId, deviceHeaders, apiError, webEntry, LOGIN_SCOPES, LEGACY_SCOPES, versionLabel,
  updateOffer, shouldPrompt, formatSize,
} from './core.js';
import { BUILD } from './build-info.js';
const cap = window.Capacitor;
const Http = cap?.Plugins?.CapacitorHttp;
const Prefs = cap?.Plugins?.Preferences;
const Browser = cap?.Plugins?.Browser;
const Share = cap?.Plugins?.DropitShare;
const Device = { model: navigator.userAgent.match(/;\s*([^;)]+)\sBuild/)?.[1] };
const $ = id => document.getElementById(id);
$('version').textContent = versionLabel(BUILD);
const show = id => { for (const s of ['setup', 'login', 'boot', 'update']) $(s).hidden = s !== id; };

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

function status(msg, { retry = false, settings = false } = {}) {
  show('boot');
  $('boot-msg').textContent = msg;
  $('retry').hidden = !retry;
  $('settings').hidden = !settings;
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
async function startLogin(server, note = '') {
  show('login');
  $('login-msg').textContent = note;
  const body = scopes => ({ name: deviceName(Device.model), scopes, expiresInDays: 365 });
  let r = await request('POST', `${server}/api/auth/device/authorize`, body(LOGIN_SCOPES));
  // A server without in-app web login rejects the 'web' scope; fall back to a plain read/write token.
  if (r.status === 400) r = await request('POST', `${server}/api/auth/device/authorize`, body(LEGACY_SCOPES));
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
    if (p.kind === 'token') { await set('token', p.token); Browser?.close?.().catch(() => {}); return enter(server); }
    if (p.kind === 'slow') interval += 5000;
    if (p.kind === 'pending' || p.kind === 'slow') { polling = setTimeout(tick, interval); return; }
    $('login-msg').textContent = p.kind === 'denied' ? '已拒绝' : p.kind === 'expired' ? '验证码已过期，请重试' : `登录失败（${p.code}）`;
  };
  polling = setTimeout(tick, interval);
}

async function deviceId() {
  let id = await get('deviceId');
  if (!id) { id = newDeviceId(); await set('deviceId', id); }
  return id;
}

// ---- Android share target: send what was shared, then go (back) to the web UI ----
async function sendShares(server, token) {
  if (!Share) return null;
  const p = (await Share.take().catch(() => null))?.share;
  const files = Array.isArray(p?.files) ? p.files : [];
  const text = sharedText(p);
  if (!text && !files.length) return null;
  status('正在发送到 dropit…');
  const me = await request('GET', `${server}/api/me`, null, token);
  if (me.status === 401) return { relogin: true };
  const sp = await request('GET', `${server}/api/spaces`, null, token);
  const space = pickSpace(sp.body?.spaces, me.body?.user?.id);
  if (!space) return { ok: 0, failed: 1, msg: '没有可用的空间' };
  const base = `${server}/api/spaces/${encodeURIComponent(space.id)}`;
  const device = deviceHeaders(await deviceId(), deviceName(Device.model));
  let ok = 0, failed = 0, msg = '';
  if (text) {
    const r = await request('POST', `${base}/items/text`, { text }, token, device);
    if (r.status === 201) ok++; else { failed++; msg = apiError(r.status, r.body); }
  }
  for (const f of files) {
    status(`正在发送 ${f.name}…`);
    try {
      const r = await Share.uploadFile({ id: f.id, url: `${base}/items/file`, token, name: f.name, mime: f.mime, headers: { ...device, 'X-File-Name': encodeURIComponent(f.name || 'shared') } });
      if (r.status === 201) ok++; else { failed++; msg = `${f.name}：${r.error || apiError(r.status, safeJson(r.body))}`; }
    } catch (e) { failed++; msg = `${f.name}：${e.message || e}`; }
  }
  return { ok, failed, msg };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- RHEA-190 au: app updates published on the dropit server (GET /api/app/android/latest) ----
let installedName = BUILD.version;
async function installedCode() {
  try {
    const info = await Share?.appInfo?.();
    if (typeof info?.versionName === 'string' && info.versionName) installedName = info.versionName;
    if (Number.isSafeInteger(info?.versionCode)) return info.versionCode;
  } catch { /* old shell without appInfo: use the build file */ }
  return BUILD.code || 0;
}
async function checkUpdate(server) {
  const r = await request('GET', `${server}/api/app/android/latest`);
  return updateOffer(server, await installedCode(), r.status, r.body);
}
let progressHooked = false;
async function installUpdate(offer) {
  const msg = $('upd-msg');
  if (!Share?.installUpdate) {
    // Not inside the Android shell (or an old one): let the browser download it.
    if (Browser) await Browser.open({ url: offer.url }); else window.open(offer.url, '_blank');
    return;
  }
  if (!progressHooked) {
    progressHooked = true;
    Share.addListener?.('updateProgress', ({ received, total }) => {
      if (total > 0) $('upd-msg').textContent = `正在下载… ${Math.min(100, Math.floor((received / total) * 100))}%`;
    });
  }
  $('upd-install').disabled = true;
  msg.className = '';
  msg.textContent = '正在下载…';
  try {
    const r = await Share.installUpdate({ url: offer.url, sha256: offer.sha256, size: offer.size });
    msg.textContent = r?.needsPermission
      ? '请在打开的系统设置里允许 dropit「安装未知应用」，然后回到这里再点一次「下载并安装」。'
      : '已打开系统安装程序，确认「更新」即可；装好后重新打开 dropit，登录会保留。';
  } catch (e) {
    msg.className = 'err';
    msg.textContent = `更新失败：${e?.message || e}`;
  } finally { $('upd-install').disabled = false; }
}
/** Shows the update page; resolves when the user picks 稍后 / 跳过这个版本. */
function offerUpdate(offer, { auto }) {
  show('update');
  $('upd-title').textContent = `发现新版本 ${offer.versionName}`;
  $('upd-meta').textContent = `当前 ${installedName} · 安装包 ${formatSize(offer.size)}`;
  $('upd-notes').textContent = offer.notes || '';
  $('upd-msg').textContent = '';
  $('upd-skip').hidden = !auto;
  $('upd-install').onclick = () => installUpdate(offer);
  return new Promise(resolve => {
    $('upd-later').onclick = () => resolve();
    $('upd-skip').onclick = async () => { await set('skipUpdate', String(offer.versionCode)); resolve(); };
  });
}
/** Once per app start (sessionStorage survives the trips to the web UI and back). Never blocks for long. */
async function autoCheckUpdate(server) {
  if (sessionStorage.getItem('dropit-update-checked')) return;
  sessionStorage.setItem('dropit-update-checked', '1');
  const offer = await Promise.race([checkUpdate(server).catch(() => null), wait(5000).then(() => null)]);
  if (shouldPrompt(offer, await get('skipUpdate'))) await offerUpdate(offer, { auto: true });
}
async function manualCheckUpdate() {
  const server = await get('server');
  if (!server) return;
  const line = $('update-line');
  line.textContent = '正在检查更新…';
  try {
    const offer = await checkUpdate(server);
    if (offer.kind === 'update') { await offerUpdate(offer, { auto: false }); return enter(server, { stay: true }); }
    line.textContent = offer.kind === 'latest' ? `已是最新版本（${installedName}）`
      : offer.kind === 'none' ? '这个服务器还没有发布 Android 安装包（管理员可用 scripts/publish-android-apk.mjs 发布）' : offer.note;
  } catch (e) { line.textContent = `检查更新失败：${e?.message || e}`; }
}

async function enter(server, { stay = false } = {}) {
  clearTimeout(polling);
  const token = await get('token');
  if (!token) return startLogin(server);
  await Share?.setServer?.({ url: server }).catch(() => {});
  $('server-line').textContent = `服务器：${server}`;
  if (stay) return status('dropit 应用设置', { settings: true });
  status('正在打开 dropit…');
  try {
    const shared = await sendShares(server, token);
    if (shared?.relogin) { await del('token'); return startLogin(server, '登录已失效，请重新确认'); }
    if (shared) {
      const { ok, failed, msg } = shared;
      status(failed ? (ok ? `已发送 ${ok} 项，${failed} 项失败：${msg}` : `发送失败：${msg}`) : (ok > 1 ? `已发送 ${ok} 项到 dropit` : '已发送到 dropit'));
      await wait(failed ? 2500 : 1000);
    } else {
      await autoCheckUpdate(server);
      status('正在打开 dropit…');
    }
    const r = await request('POST', `${server}/api/app-session/ticket`, null, token);
    const next = webEntry(server, r.status, r.body);
    if (next.kind === 'relogin') {
      // Old token (no 'web' scope) or revoked: drop it and confirm once more.
      if (r.status === 403) await request('POST', `${server}/api/auth/logout`, null, token).catch(() => {});
      await del('token');
      return startLogin(server, next.note);
    }
    if (next.kind === 'error') return status(next.note, { retry: true, settings: true });
    location.replace(next.url);
  } catch (e) {
    status(`无法连接 ${new URL(server).host}：${e.message || e}`, { retry: true, settings: true });
  }
}

async function reset() {
  clearTimeout(polling);
  const server = await get('server');
  const token = await get('token');
  // Revoke this device's token on the server; the WebView's web session cookie is dropped by setServer('').
  if (server && token) await request('POST', `${server}/api/auth/logout`, null, token).catch(() => {});
  await del('token'); await del('server');
  await Share?.setServer?.({ url: '' }).catch(() => {});
  show('setup');
}
$('check').onclick = checkServer;
$('reset1').onclick = reset;
$('logout').onclick = reset;
$('retry').onclick = async () => enter(await get('server'));
$('web').onclick = async () => enter(await get('server'));
$('check-update').onclick = manualCheckUpdate;
Share?.addListener?.('share', async () => { const server = await get('server'); if (server && await get('token')) enter(server); });

(async () => {
  const server = await get('server');
  if (!server) return show('setup');
  if (!(await get('token'))) return startLogin(server);
  if (location.hash === '#update') { await enter(server, { stay: true }); return manualCheckUpdate(); }
  return enter(server, { stay: location.hash === '#settings' });
})();
