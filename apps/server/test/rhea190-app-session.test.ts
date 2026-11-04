import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { hash, token, type AccessToken } from '../src/domain.js';

const origin = 'http://localhost:3000';
const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });
type CreatedToken = AccessToken & { token: string };
async function fixture(overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-machine-'));
  let time = Date.now();
  const backend = createBackend({ config: { ...loadConfig({}), origin, dataDir: directory, ...overrides },
    providers: {}, now: () => time, remoteAddress: c => c.req.header('x-test-ip') ?? '203.0.113.42' });
  function login(subject: string) {
    const raw = token();
    if (backend.repo.users().length) backend.repo.provisionUser({ email: `${subject}@example.com`, name: subject, role: 'user', quotaBytes: null, now: time });
    const user = backend.repo.login({ provider: 'mock', subject, email: `${subject}@example.com`, name: subject }, null, [], hash(raw), time + 86400000, time);
    return { user, cookie: `dropit_session=${raw}`, space: backend.repo.spaces(user.id)[0] };
  }
  const admin = login('admin');
  const member = login('member');
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => backend.app.request(path, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const browser = (path: string, method = 'GET', body?: unknown, cookie = member.cookie) => request(path, method, body, { cookie, origin });
  const pat = async (body: Record<string, unknown> = {}, cookie = member.cookie): Promise<CreatedToken> => {
    const response = await browser('/api/tokens', 'POST', { name: 'Test terminal', ...body }, cookie);
    assert.equal(response.status, 201);
    return response.json();
  };
  const device = async (body: Record<string, unknown> = {}) => {
    const response = await request('/api/auth/device/authorize', 'POST', { name: 'My laptop', ...body });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { ...backend, directory, admin, member, request, browser, pat, device, time: () => time,
    advance(ms: number) { time += ms; },
    async dispose() { await backend.close(); await rm(directory, { recursive: true, force: true }); } };
}


async function appToken(f: Awaited<ReturnType<typeof fixture>>, scopes = ['read', 'write', 'web']) {
  const d = await f.device({ name: 'dropit Android · Pixel', scopes, expiresInDays: 365 });
  const query = new URLSearchParams({ user_code: d.user_code, verification_id: d.verification_id });
  const info = await (await f.browser(`/api/auth/device?${query}`)).json();
  assert.deepEqual(info.scopes, scopes);
  assert.equal((await f.browser('/api/auth/device/approve', 'POST', Object.fromEntries(query))).status, 204);
  f.advance(5000);
  const issued = await (await f.request('/api/auth/device/token', 'POST', { device_code: d.device_code })).json();
  assert.equal(typeof issued.access_token, 'string');
  return issued as { access_token: string; token: AccessToken };
}
const cookieOf = (response: Response) => /dropit_session=([^;]*)/.exec(response.headers.get('set-cookie') ?? '')?.[1];

test('RHEA-190 ui: an app token with the web scope opens a normal browser session through a one-time ticket', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const issued = await appToken(f);
  assert.equal(issued.token.scopes.includes('web'), true);
  const ticket = await f.request('/api/app-session/ticket', 'POST', undefined, bearer(issued.access_token));
  assert.equal(ticket.status, 200);
  const body = await ticket.json();
  assert.equal(Buffer.from(body.ticket, 'base64url').length, 32);
  assert.equal(body.expires_in, 60);
  assert.equal(body.path, `/api/app-session?ticket=${body.ticket}`);
  // The WebView opens the ticket URL as a plain navigation: no Authorization header, no Origin, no cookie.
  const opened = await f.request(body.path);
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.get('location'), '/');
  assert.match(opened.headers.get('set-cookie') ?? '', /HttpOnly/i);
  const raw = cookieOf(opened);
  assert(raw && raw.length >= 43);
  const me = await (await f.request('/api/me', 'GET', undefined, { cookie: `dropit_session=${raw}` })).json();
  assert.equal(me.user.id, f.member.user.id);
  // It is a real browser session: listed under 登录设备, can manage sessions, can send with Origin.
  const sessions = await f.request('/api/sessions', 'GET', undefined, { cookie: `dropit_session=${raw}` });
  assert.equal(sessions.status, 200);
  assert.equal((await sessions.json()).sessions.filter((s: { current: boolean }) => s.current).length, 1);
  assert.equal((await f.browser(`/api/spaces/${f.member.space.id}/items/text`, 'POST', { text: '应用内网页版' }, `dropit_session=${raw}`)).status, 201);
  // One use only; the raw ticket is never a session.
  const again = await f.request(body.path);
  assert.equal(again.status, 302);
  assert.equal(again.headers.get('location'), '/login?error=APP_SESSION_EXPIRED');
  assert.equal(cookieOf(again), undefined);
  assert.equal((await f.request('/api/me', 'GET', undefined, { cookie: `dropit_session=${body.ticket}` })).status, 401);
});

test('RHEA-190 ui: tickets need the web scope, a bearer token, are short-lived and die with the token', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  // Only the device flow may ask for 'web', and only together with read and write.
  assert.equal((await f.browser('/api/tokens', 'POST', { name: 'Script', scopes: ['read', 'write', 'web'] })).status, 400);
  assert.equal((await f.request('/api/auth/device/authorize', 'POST', { name: 'x', scopes: ['read', 'web'] })).status, 400);
  assert.equal((await f.request('/api/auth/device/authorize', 'POST', { name: 'x', scopes: ['web'] })).status, 400);
  assert.equal((await f.request('/api/auth/device/authorize', 'POST', { name: 'x', scopes: ['read', 'write', 'web', 'web'] })).status, 400);
  // Old app tokens (read+write) and PATs cannot mint a browser session.
  const old = await appToken(f, ['read', 'write']);
  const denied = await f.request('/api/app-session/ticket', 'POST', undefined, bearer(old.access_token));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'INSUFFICIENT_SCOPE');
  const pat = await f.pat({ scopes: ['read', 'write'] });
  assert.equal((await f.request('/api/app-session/ticket', 'POST', undefined, bearer(pat.token))).status, 403);
  // A browser session cannot mint tickets either.
  const fromCookie = await f.browser('/api/app-session/ticket', 'POST');
  assert.equal(fromCookie.status, 403);
  assert.equal((await fromCookie.json()).error.code, 'BEARER_REQUIRED');
  assert.equal((await f.request('/api/app-session/ticket', 'POST', undefined, { origin })).status, 401);
  // Garbage and missing tickets.
  for (const path of ['/api/app-session', '/api/app-session?ticket=nope', `/api/app-session?ticket=${'A'.repeat(43)}`]) {
    const r = await f.request(path);
    assert.equal(r.headers.get('location'), '/login?error=APP_SESSION_EXPIRED');
    assert.equal(cookieOf(r), undefined);
  }
  const issued = await appToken(f);
  const auth = bearer(issued.access_token);
  // Expired after 60 seconds.
  const late = await (await f.request('/api/app-session/ticket', 'POST', undefined, auth)).json();
  f.advance(60001);
  assert.equal((await f.request(late.path)).headers.get('location'), '/login?error=APP_SESSION_EXPIRED');
  // Revoking the device token (app logout) kills tickets that were not used yet.
  const pending = await (await f.request('/api/app-session/ticket', 'POST', undefined, auth)).json();
  assert.equal((await f.request('/api/auth/logout', 'POST', undefined, auth)).status, 204);
  const dead = await f.request(pending.path);
  assert.equal(dead.headers.get('location'), '/login?error=APP_SESSION_EXPIRED');
  assert.equal(cookieOf(dead), undefined);
});

test('RHEA-190 ui: a ticket never replaces an existing browser session (no account swap, no session pile-up)', async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const issued = await appToken(f);
  const auth = bearer(issued.access_token);
  const before = (await (await f.browser('/api/sessions')).json()).sessions.length;
  // Same account already signed in (the app is reopened): keep the cookie, no new session row.
  const same = await (await f.request('/api/app-session/ticket', 'POST', undefined, auth)).json();
  const kept = await f.request(same.path, 'GET', undefined, { cookie: f.member.cookie });
  assert.equal(kept.status, 302);
  assert.equal(kept.headers.get('location'), '/');
  assert.equal(cookieOf(kept), undefined);
  assert.equal((await (await f.browser('/api/sessions')).json()).sessions.length, before);
  // Another account is signed in: it stays signed in as itself.
  const other = await (await f.request('/api/app-session/ticket', 'POST', undefined, auth)).json();
  const swap = await f.request(other.path, 'GET', undefined, { cookie: f.admin.cookie });
  assert.equal(cookieOf(swap), undefined);
  assert.equal((await (await f.request('/api/me', 'GET', undefined, { cookie: f.admin.cookie })).json()).user.id, f.admin.user.id);
});
