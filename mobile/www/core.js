// Pure logic for the dropit Android shell (RHEA-190). No built-in server:
// the user types their own https URL on first run.
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

/** One-line label for an item in the recent list. */
export function itemTitle(item, max = 140) {
  if (!item) return '';
  const raw = item.kind === 'text' ? String(item.text ?? '') : String(item.filename ?? '文件');
  const line = raw.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line;
}

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function timeAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
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
