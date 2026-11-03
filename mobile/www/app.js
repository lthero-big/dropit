import { normalizeServerUrl, isDropitVersion, deviceName, pollOutcome } from './core.js';
const cap = window.Capacitor;
const Http = cap?.Plugins?.CapacitorHttp;
const Prefs = cap?.Plugins?.Preferences;
const Browser = cap?.Plugins?.Browser;
const Device = { model: navigator.userAgent.match(/;\s*([^;)]+)\sBuild/)?.[1] };
const $ = id => document.getElementById(id);
const show = id => { for (const s of ['setup', 'login', 'ready']) $(s).hidden = s !== id; };

async function get(key) { return Prefs ? (await Prefs.get({ key })).value : localStorage.getItem(key); }
async function set(key, value) { return Prefs ? Prefs.set({ key, value }) : localStorage.setItem(key, value); }
async function del(key) { return Prefs ? Prefs.remove({ key }) : localStorage.removeItem(key); }

async function request(method, url, data, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (Http) {
    const r = await Http.request({ method, url, headers, data, connectTimeout: 10000, readTimeout: 15000 });
    return { status: r.status, body: typeof r.data === 'string' ? safeJson(r.data) : r.data };
  }
  const r = await fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined });
  return { status: r.status, body: safeJson(await r.text()) };
}
function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }

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
    if (p.kind === 'token') { await set('token', p.token); return ready(server); }
    if (p.kind === 'slow') interval += 5000;
    if (p.kind === 'pending' || p.kind === 'slow') { polling = setTimeout(tick, interval); return; }
    $('login-msg').textContent = p.kind === 'denied' ? '已拒绝' : p.kind === 'expired' ? '验证码已过期，请重试' : `登录失败（${p.code}）`;
  };
  polling = setTimeout(tick, interval);
}

async function ready(server) {
  show('ready');
  const token = await get('token');
  const r = await request('GET', `${server}/api/me`, null, token);
  if (r.status === 401) { await del('token'); return startLogin(server); }
  $('ready-msg').textContent = `已连接 ${new URL(server).host}`;
  $('enter').onclick = () => { location.href = server; };
}

async function reset() { clearTimeout(polling); await del('token'); await del('server'); show('setup'); }
$('check').onclick = checkServer;
$('reset1').onclick = reset;
$('logout').onclick = reset;

(async () => {
  const server = await get('server');
  if (!server) return show('setup');
  return (await get('token')) ? ready(server) : startLogin(server);
})();
