// Pure logic for the dropit Android shell (RHEA-190). No built-in server:
// the user types their own https URL on first run.

/** Device-login scopes. 'web' lets the app open the web UI already signed in (RHEA-190 ui). */
export const LOGIN_SCOPES = ['read', 'write', 'web'];
/** For servers that do not know the 'web' scope yet. */
export const LEGACY_SCOPES = ['read', 'write'];
const INSTALL_KINDS = ['docker', 'docker-build', 'source'];
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/;

/** Returns the normalized origin, or throws Error with a Chinese message. */
export function normalizeServerUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('请输入服务器地址');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error('地址格式不正确'); }
  if (url.protocol !== 'https:') throw new Error('只支持 https:// 地址');
  if (url.username || url.password) throw new Error('地址里不能带用户名或密码');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** /api/version on a dropit server answers { version, commit, buildDate, install }. */
export function isDropitVersion(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (typeof body.version !== 'string' || !SEMVER.test(body.version.replace(/^v/, ''))) return false;
  if (!INSTALL_KINDS.includes(body.install)) return false;
  if (body.commit !== null && typeof body.commit !== 'string') return false;
  return true;
}

export function deviceName(model) {
  const name = String(model ?? '').trim() || 'Android';
  return [...`dropit Android · ${name}`].slice(0, 40).join('');
}

/** Interprets one /api/auth/device/token poll. */
export function pollOutcome(status, body) {
  if (status === 200 && body && typeof body.access_token === 'string') return { kind: 'token', token: body.access_token };
  const code = body?.error?.code ?? body?.error;
  if (code === 'authorization_pending' || code === 'AUTHORIZATION_PENDING') return { kind: 'pending' };
  if (code === 'slow_down' || code === 'SLOW_DOWN') return { kind: 'slow' };
  if (code === 'access_denied' || code === 'ACCESS_DENIED') return { kind: 'denied' };
  if (code === 'expired_token' || code === 'EXPIRED_TOKEN') return { kind: 'expired' };
  return { kind: 'error', code: String(code ?? status) };
}

/** The user's own private space (owner = me, never expires); falls back to the first listed space. */
export function pickSpace(spaces, userId) {
  const list = Array.isArray(spaces) ? spaces : [];
  return list.find(s => s && s.ownerId === userId && s.expiresAt == null) ?? list[0] ?? null;
}

/** Text to send for an Android share: many apps put the page title in EXTRA_SUBJECT and the link in EXTRA_TEXT. */
export function sharedText(payload) {
  const text = String(payload?.text ?? '').trim();
  const subject = String(payload?.subject ?? '').trim();
  if (!text) return null;
  return subject && !text.includes(subject) ? `${subject}\n${text}` : text;
}

/** Stable random device id for X-Dropit-Device ([A-Za-z0-9_-]{6,64}). */
export function newDeviceId(random = Math.random) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'and-';
  for (let i = 0; i < 20; i++) id += abc[Math.floor(random() * abc.length) % abc.length];
  return id;
}

export function deviceHeaders(id, name) {
  const h = { 'X-Dropit-Device-Kind': 'phone' };
  if (/^[A-Za-z0-9_-]{6,64}$/.test(String(id ?? ''))) h['X-Dropit-Device'] = id;
  if (name) h['X-Dropit-Device-Name'] = encodeURIComponent([...String(name)].slice(0, 40).join(''));
  return h;
}

/** Chinese message for an API error response. */
export function apiError(status, body) {
  const code = body?.error?.code ?? body?.error ?? '';
  const known = {
    FILE_TOO_LARGE: '文件太大，超过服务器限制',
    QUOTA_EXCEEDED: '空间已满',
    ITEM_LIMIT: '条目数量已达上限',
    INVALID_IMAGE: '图片无法识别',
    TEXT_TOO_LARGE: '文字太长',
    EMPTY_TEXT: '内容是空的',
    INVALID_INPUT: '内容无效',
    RATE_LIMITED: '操作太频繁，请稍后再试',
    INSUFFICIENT_SCOPE: '这个设备令牌没有写入权限',
    UNAUTHENTICATED: '登录已失效，请重新登录',
  };
  if (known[code]) return known[code];
  if (status === 401) return known.UNAUTHENTICATED;
  if (status === 413) return known.FILE_TOO_LARGE;
  if (status === 429) return known.RATE_LIMITED;
  return `请求失败（${code || status}）`;
}

/**
 * What to do with the answer of POST /api/app-session/ticket:
 * ticket → open the one-time sign-in URL in the app WebView; plain → server predates in-app sign-in,
 * open the web UI and let it show its own login; relogin → device token is gone or lacks 'web'.
 */
export function webEntry(server, status, body) {
  const path = typeof body?.path === 'string' ? body.path : '';
  if (status === 200 && /^\/api\/app-session\?ticket=[A-Za-z0-9_-]{43}$/.test(path)) return { kind: 'ticket', url: `${server}${path}` };
  const code = body?.error?.code ?? body?.error ?? '';
  if (status === 401) return { kind: 'relogin', note: '登录已失效，请在浏览器里重新确认' };
  if (status === 403 && code === 'INSUFFICIENT_SCOPE') return { kind: 'relogin', note: '新版应用需要再确认一次登录（这次包含「在 dropit 应用里打开网页版」权限）' };
  if (status === 404) return { kind: 'plain', url: `${server}/` };
  return { kind: 'error', note: `无法打开网页版：${apiError(status, body)}` };
}

// RHEA-190 fx: 「版本 0.3.0 · a1b2c3d · 2026-11-04」 for the setup/login/settings pages.
export function versionLabel(build) {
  const parts = [`版本 ${build?.version || '?'}`];
  const commit = String(build?.commit || '');
  if (commit) parts.push(/^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 7) : commit);
  if (build?.date) parts.push(String(build.date).slice(0, 10));
  return parts.join(' · ');
}

// RHEA-190 au: what GET /api/app/android/latest means for this app (versionCode = currentCode).
// update → newer APK on this server; latest → nothing newer; none → server publishes no APK (404);
// error → anything unexpected. Only a download path on the same server is accepted.
const DOWNLOAD_PATH = /^\/api\/app\/android\/download\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.apk$/;
export function updateOffer(server, currentCode, status, body) {
  if (status === 404) return { kind: 'none' };
  if (status !== 200 || !body || typeof body !== 'object') return { kind: 'error', note: `检查更新失败：${apiError(status, body)}` };
  const { versionCode, versionName, notes, size, sha256, url } = body;
  const valid = Number.isSafeInteger(versionCode) && versionCode > 0 && typeof versionName === 'string' && versionName.length <= 40
    && typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) && Number.isSafeInteger(size) && size > 0
    && typeof url === 'string' && DOWNLOAD_PATH.test(url) && !url.includes('..');
  if (!valid) return { kind: 'error', note: '服务器返回的更新信息无效' };
  if (!(versionCode > (Number(currentCode) || 0))) return { kind: 'latest', versionName };
  return { kind: 'update', versionCode, versionName, notes: typeof notes === 'string' ? notes.slice(0, 4000) : '', size, sha256, url: `${server}${url}` };
}

/** Prompt on launch unless the user chose 「跳过这个版本」 for exactly this versionCode. */
export function shouldPrompt(offer, skipped) {
  return offer?.kind === 'update' && String(offer.versionCode) !== String(skipped ?? '');
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
