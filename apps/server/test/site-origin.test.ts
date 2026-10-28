import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Identity } from '../src/domain.js';
import type { OAuthProvider } from '../src/oauth.js';
import { parseOrigin, requestOriginResolver, sameOrigin } from '../src/origin.js';

// RHEA-190 auth step 1: site address (APP_ORIGIN) = 管理 → 站点地址 > APP_ORIGIN env > request's own origin.
const LAN = 'http://dropit.lan:8787';
const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find(c => c.startsWith(`${name}=`)) ?? '';

async function setup(overrides: Partial<Config> = {}, directory?: string) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), 'dropit-site-'));
  const identities = new Map<string, Identity>();
  const redirects: string[] = [];
  const provider: OAuthProvider = {
    authorizationUrl(state, _challenge, redirect) {
      redirects.push(redirect);
      return `https://mock.example/authorize?${new URLSearchParams({ state, redirect_uri: redirect })}`;
    },
    async exchange(code) { return identities.get(code)!; },
  };
  const config = { ...loadConfig({}), dataDir: dir, ...overrides };
  const backend = createBackend({ config, providers: { github: provider }, remoteAddress: c => c.req.header('x-test-peer') ?? '203.0.113.9' });
  /** Requests addressed to `host` (the Host header) from a page at `origin`. */
  const request = (path: string, init: { method?: string; origin?: string | null; host?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { host: init.host ?? 'dropit.lan:8787', ...init.headers };
    if (init.origin !== null) headers.origin = init.origin ?? LAN;
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return backend.app.request(`http://${headers.host}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const login = async (subject: string, host = 'dropit.lan:8787') => {
    identities.set(subject, { provider: 'github', subject, email: `${subject}@example.com`, name: subject });
    const start = await request('/api/auth/github', { origin: null, host });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const flow = start.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const done = await request(`/api/auth/github/callback?${new URLSearchParams({ state, code: subject })}`, { origin: null, host, cookie: flow });
    assert.equal(done.status, 302);
    return { response: done, cookie: done.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
  };
  return { backend, request, login, redirects, dir,
    async close(keep = false) { await backend.close(); if (!keep) await rm(dir, { recursive: true, force: true }); } };
}

test('parseOrigin accepts scheme + host [+ port] only', () => {
  assert.equal(parseOrigin('https://Dropit.Example.com/'), 'https://dropit.example.com');
  assert.equal(parseOrigin(' http://1.2.3.4:8787 '), 'http://1.2.3.4:8787');
  assert.equal(parseOrigin('https://dropit.example:443'), 'https://dropit.example');
  for (const bad of ['', 'dropit.example', 'ftp://dropit.example', 'https://dropit.example/app', 'https://dropit.example/?a=1',
    'https://dropit.example#x', 'https://user:pw@dropit.example', 'https://', 'javascript:alert(1)', 'https://a b.example'])
    assert.equal(parseOrigin(bad), null, bad);
});

test('request origin trusts X-Forwarded-* only from TRUST_PROXY peers; https upgrade of the same host is same-origin', () => {
  const untrusted = requestOriginResolver([]);
  const facts = { url: 'http://dropit.lan:8787/api/rooms', remote: '127.0.0.1', host: 'dropit.lan:8787', forwardedProto: 'https', forwardedHost: 'evil.example' };
  assert.equal(untrusted(facts), 'http://dropit.lan:8787');
  const trusted = requestOriginResolver(['loopback']);
  assert.equal(trusted(facts), 'https://evil.example');
  assert.equal(trusted({ ...facts, forwardedHost: undefined }), 'https://dropit.lan:8787');
  assert.equal(trusted({ ...facts, remote: '198.51.100.1' }), 'http://dropit.lan:8787');
  assert.equal(untrusted({ ...facts, host: 'bad/host' }), null);
  assert.ok(sameOrigin('http://a.example', 'http://a.example'));
  assert.ok(sameOrigin('https://a.example', 'http://a.example'));
  assert.ok(!sameOrigin('http://a.example', 'https://a.example'));
  assert.ok(!sameOrigin('https://a.example.evil', 'http://a.example'));
  assert.ok(!sameOrigin('https://evil.example', 'http://a.example'));
});

test('APP_ORIGIN is optional and plain http no longer refuses to start in production', () => {
  assert.equal(loadConfig({}).origin, '');
  assert.equal(loadConfig({ APP_ORIGIN: 'http://1.2.3.4:8787', NODE_ENV: 'production' }).origin, 'http://1.2.3.4:8787');
  assert.equal(loadConfig({ APP_ORIGIN: 'https://dropit.example/' }).origin, 'https://dropit.example');
  assert.throws(() => loadConfig({ APP_ORIGIN: 'https://dropit.example/path' }), /APP_ORIGIN/);
  assert.equal(loadConfig({ RESET_APP_ORIGIN: '1' }).resetOrigin, true);
});

test('fallback: same-origin writes pass, cross-site and missing Origin are rejected with the expected address', async t => {
  const f = await setup(); t.after(() => f.close());
  const room = await f.request('/api/rooms', { method: 'POST' });
  assert.equal(room.status, 201);
  assert.match((await room.json()).url, /^http:\/\/dropit\.lan:8787\/r\//);
  // Another address of the same server works too (IP, other hostname) without configuration.
  const ip = await f.request('/api/rooms', { method: 'POST', host: '192.0.2.10:8787', origin: 'http://192.0.2.10:8787' });
  assert.equal(ip.status, 201);
  assert.match((await ip.json()).url, /^http:\/\/192\.0\.2\.10:8787\/r\//);
  for (const origin of ['https://evil.example', 'http://dropit.lan:8788', 'http://dropit.lan', 'null']) {
    const denied = await f.request('/api/rooms', { method: 'POST', origin });
    assert.equal(denied.status, 403, origin);
    assert.deepEqual(await denied.json(), { error: { code: 'ORIGIN_REJECTED', expected: LAN, received: origin, source: 'request' } });
  }
  assert.equal((await f.request('/api/rooms', { method: 'POST', origin: null })).status, 403);
  // TLS proxy not listed in TRUST_PROXY: the https page of the same host is accepted.
  assert.equal((await f.request('/api/rooms', { method: 'POST', origin: 'https://dropit.lan:8787' })).status, 201);
  // Forwarding headers from an untrusted peer do not change the address.
  const spoofed = await f.request('/api/rooms', { method: 'POST', origin: 'https://evil.example', headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } });
  assert.equal(spoofed.status, 403);
  // OAuth callback follows the address the browser used.
  await f.request('/api/auth/github', { origin: null });
  assert.equal(f.redirects.at(-1), `${LAN}/api/auth/github/callback`);
  const site = await (await f.request('/api/site', { origin: null })).json();
  assert.deepEqual(site, { origin: null, source: 'request', requestOrigin: LAN });
});

test('fallback behind a trusted proxy uses X-Forwarded-Proto and rejects the downgraded origin', async t => {
  const f = await setup({ trustProxy: ['loopback'] }); t.after(() => f.close());
  const headers = { 'x-test-peer': '127.0.0.1', 'x-forwarded-proto': 'https' };
  const ok = await f.request('/api/rooms', { method: 'POST', host: 'drop.example', origin: 'https://drop.example', headers });
  assert.equal(ok.status, 201);
  assert.match((await ok.json()).url, /^https:\/\/drop\.example\/r\//);
  assert.equal((await f.request('/api/rooms', { method: 'POST', host: 'drop.example', origin: 'http://drop.example', headers })).status, 403);
});

test('admin site address: validation, confirm, precedence over env, persistence and RESET_APP_ORIGIN', async t => {
  const f = await setup({ origin: '' });
  const admin = await f.login('owner');
  assert.equal((await f.request('/api/admin/users', { method: 'POST', body: { email: 'member@example.com' }, cookie: admin.cookie })).status, 201);
  const member = await f.login('member');
  const put = (body: unknown, cookie = admin.cookie, origin = LAN) => f.request('/api/admin/site', { method: 'PUT', body, cookie, origin });
  const view = await (await f.request('/api/admin/site', { cookie: admin.cookie })).json();
  assert.equal(view.source, 'request');
  assert.equal(view.origin, null);
  assert.equal(view.effectiveOrigin, LAN);
  assert.deepEqual(view.callbacks.map((c: { url: string }) => c.url), [`${LAN}/api/auth/github/callback`, `${LAN}/api/auth/google/callback`]);
  assert.equal((await put({ origin: 'https://dropit.example' }, member.cookie)).status, 403);
  assert.equal((await put({ origin: 'https://dropit.example' }, '')).status, 401);
  for (const bad of ['https://dropit.example/path', 'dropit.example', 'ftp://x.example'])
    assert.deepEqual(await (await put({ origin: bad })).json(), { error: { code: 'INVALID_ORIGIN' } });
  assert.equal((await put({ origin: 42 })).status, 400);
  // Same address as this browser: saved without confirm.
  const same = await put({ origin: `${LAN}/` });
  assert.equal(same.status, 200);
  assert.equal((await same.json()).source, 'admin');
  // A different address needs confirm (otherwise the admin locks this browser out).
  const ask = await put({ origin: 'https://dropit.example' });
  assert.equal(ask.status, 409);
  assert.deepEqual(await ask.json(), { error: { code: 'ORIGIN_CONFIRM_REQUIRED', origin: 'https://dropit.example', current: LAN } });
  const saved = await (await put({ origin: 'https://dropit.example', confirm: true })).json();
  assert.equal(saved.origin, 'https://dropit.example');
  assert.equal(saved.callbacks[0].url, 'https://dropit.example/api/auth/github/callback');
  // Now pinned: the old address is rejected with a hint, the new one works and links use it.
  const denied = await f.request('/api/rooms', { method: 'POST' });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: { code: 'ORIGIN_REJECTED', expected: 'https://dropit.example', received: LAN, source: 'admin' } });
  const room = await f.request('/api/rooms', { method: 'POST', origin: 'https://dropit.example' });
  assert.equal(room.status, 201);
  assert.match((await room.json()).url, /^https:\/\/dropit\.example\/r\//);
  assert.deepEqual(await (await f.request('/api/site', { origin: null })).json(), { origin: 'https://dropit.example', source: 'admin', requestOrigin: LAN });
  await f.close(true);
  // Restart with APP_ORIGIN set: the admin setting still wins.
  const g = await setup({ origin: 'https://env.example' }, f.dir);
  assert.equal((await (await g.request('/api/site', { origin: null })).json()).origin, 'https://dropit.example');
  assert.ok(g.backend.originWarnings().some(w => w.includes('overridden')));
  // Clearing falls back to the environment value.
  const cleared = await (await g.request('/api/admin/site', { method: 'PUT', body: { origin: null, confirm: true }, cookie: admin.cookie, origin: 'https://dropit.example' })).json();
  assert.equal(cleared.source, 'env');
  assert.equal(cleared.origin, 'https://env.example');
  assert.equal((await g.request('/api/admin/site', { method: 'PUT', body: { origin: 'https://dropit.example', confirm: true }, cookie: admin.cookie, origin: 'https://env.example' })).status, 200);
  await g.close(true);
  // RESET_APP_ORIGIN clears the saved value at startup (lock-out recovery).
  const h = await setup({ origin: 'https://env.example', resetOrigin: true }, f.dir);
  t.after(() => h.close());
  assert.equal((await (await h.request('/api/site', { origin: null })).json()).source, 'env');
});

test('production cookies: Secure/__Host- over https, a plain http deploy still gets a working cookie', async t => {
  const http = await setup({ production: true }); t.after(() => http.close());
  const plain = await http.login('owner');
  const session = cookieOf(plain.response, 'dropit_session');
  assert.ok(session && !/;\s*Secure/i.test(session), session);
  assert.equal(plain.response.headers.get('strict-transport-security'), null);
  assert.ok(http.backend.originWarnings().some(w => w.includes('Production mode without a site address')));
  const https = await setup({ production: true, origin: 'https://dropit.example' }); t.after(() => https.close());
  const secure = await https.login('owner', 'dropit.example');
  assert.match(cookieOf(secure.response, '__Host-dropit_session'), /;\s*Secure/i);
  assert.equal(secure.response.headers.get('strict-transport-security'), 'max-age=31536000');
});
