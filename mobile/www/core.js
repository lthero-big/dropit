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
