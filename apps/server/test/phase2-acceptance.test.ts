// Independent phase-2 acceptance probes. These exercise the running backend
// rather than re-checking the implementers' own assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import { createBackend } from '../src/backend.js';
import { loadConfig, type Config } from '../src/config.js';
import { hash, token, type AccessToken } from '../src/domain.js';

const origin = 'http://localhost:3000';
const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });
type Created = AccessToken & { token: string };
type DeviceFlow = {
  device_code: string; user_code: string; verification_uri: string;
  verification_uri_complete: string; verification_id: string; expires_in: number; interval: number;
};

async function fixture(overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dropit-p2-'));
  let time = Date.now();
  const logs: string[] = [];
  const original = console.error;
  const capture = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = capture;
  const backend = createBackend({
    config: { ...loadConfig({}), origin, dataDir: directory, rateGeneral: 500, rateAuth: 80, rateUpload: 80, rateToken: 80, ...overrides },
    providers: {}, now: () => time, remoteAddress: c => c.req.header('x-test-ip') ?? '203.0.113.10',
  });
  function login(subject: string) {
    const raw = token();
    if (backend.repo.users().length) {
      backend.repo.provisionUser({ email: `${subject}@example.com`, name: subject, role: 'user', quotaBytes: null, now: time });
    }
    const user = backend.repo.login(
      { provider: 'mock', subject, email: `${subject}@example.com`, name: subject },
      null, [], hash(raw), time + 86_400_000, time,
    );
    return { user, cookie: `dropit_session=${raw}`, raw, space: backend.repo.spaces(user.id)[0]! };
  }
  const admin = login('admin');
  const member = login('member');
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => backend.app.request(path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const browser = (path: string, method = 'GET', body?: unknown, cookie = member.cookie) =>
    request(path, method, body, { cookie, origin });
  const pat = async (body: Record<string, unknown> = {}, cookie = member.cookie): Promise<Created> => {
    const response = await browser('/api/tokens', 'POST', { name: 'Terminal', ...body }, cookie);
    assert.equal(response.status, 201);
    return response.json() as Promise<Created>;
  };
  const device = async (body: Record<string, unknown> = {}): Promise<DeviceFlow> => {
    const response = await request('/api/auth/device/authorize', 'POST', { name: 'Laptop', ...body });
    assert.equal(response.status, 200);
    return response.json() as Promise<DeviceFlow>;
  };
  return {
    ...backend, directory, admin, member, request, browser, pat, device, logs,
    advance(ms: number) { time += ms; },
    async dispose() {
      if (console.error === capture) console.error = original;
      await backend.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function databaseBytes(directory: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const name of await readdir(directory)) {
    if (!name.includes('sqlite')) continue;
    chunks.push(await readFile(join(directory, name)));
  }
  return Buffer.concat(chunks);
}

function starName(header: string | null): string {
  const match = /filename\*=UTF-8''([^;]+)/.exec(header ?? '');
  assert.ok(match);
  return decodeURIComponent(match[1]!);
}

test('AC-J1/J7: plaintext exists only in the create response; lists, errors, and SQLite do not have it', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const created = await f.pat({ scopes: ['read'] });
  assert.equal(Buffer.from(created.token, 'base64url').length, 32);
  assert.equal(created.token.includes('='), false);
  const listed = await (await f.browser('/api/tokens')).json() as { tokens: Array<Record<string, unknown>> };
  const adminListed = await (await f.browser('/api/admin/tokens', 'GET', undefined, f.admin.cookie)).json() as { tokens: Array<Record<string, unknown>> };
  for (const body of [listed, adminListed]) {
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(created.token), false);
    assert.equal(serialized.includes('tokenHash'), false);
    for (const entry of body.tokens) assert.equal(entry.token, undefined);
  }
  assert.equal((await f.browser('/api/admin/tokens')).status, 403);
  const wrong = await f.request('/api/me', 'GET', undefined, bearer(created.token + 'x'));
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.text()).includes(created.token), false);
  assert.equal((await f.request(`/api/me?access_token=${created.token}`)).status, 401);
  const db = await databaseBytes(f.directory);
  assert.equal(db.includes(Buffer.from(created.token)), false);
  assert.equal(db.includes(Buffer.from(hash(created.token))), true);
  const original = f.repo.createAccessToken.bind(f.repo);
  f.repo.createAccessToken = () => { throw new Error(`stored ${created.token}`); };
  try {
    const failed = await f.browser('/api/tokens', 'POST', { name: 'boom' });
    assert.equal(failed.status, 500);
    assert.equal((await failed.text()).includes(created.token), false);
  } finally { f.repo.createAccessToken = original; }
  assert.equal(f.logs.some(line => line.includes(created.token)), false);
  assert.equal((await f.browser(`/api/tokens/${created.id}`, 'DELETE', undefined, f.admin.cookie)).status, 404);
  assert.equal((await f.browser(`/api/admin/tokens/${created.id}`, 'DELETE', undefined, f.admin.cookie)).status, 204);
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(created.token))).status, 401);
});

test('AC-J2/J3/J4: read bearer cannot borrow a cookie, and logout paths stay isolated', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const read = await f.pat({ scopes: ['read'] });
  const write = await f.pat({ scopes: ['write'], expiresInDays: null });
  assert.equal(read.expiresAt! - write.createdAt, 90 * 86_400_000);
  assert.equal(write.expiresAt, null);
  const path = `/api/spaces/${f.member.space.id}/items/text`;
  const escalated = await f.request(path, 'POST', { text: 'from-cookie' }, {
    cookie: f.member.cookie, origin, ...bearer(read.token),
  });
  assert.equal(escalated.status, 403);
  const snapshot = await (await f.browser(`/api/spaces/${f.member.space.id}/items`)).json() as { items: unknown[] };
  assert.equal(snapshot.items.length, 0);
  assert.equal((await f.request('/api/admin/users', 'GET', undefined, { cookie: f.admin.cookie, ...bearer(read.token) })).status, 403);
  assert.equal((await f.request(`/api/admin/tokens/${read.id}`, 'DELETE', undefined, {
    cookie: f.admin.cookie, origin, ...bearer(write.token),
  })).status, 403);
  for (const authorization of [`bearer ${read.token}`, `BEARER ${read.token}`]) {
    assert.equal((await f.request('/api/me', 'GET', undefined, { authorization })).status, 200);
  }
  assert.equal((await f.request('/api/me', 'GET', undefined, { authorization: 'Bearer', cookie: f.admin.cookie })).status, 401);
  assert.equal((await f.request(path, 'POST', { text: 'no-origin' }, { cookie: f.member.cookie })).status, 403);
  assert.equal((await f.request(path, 'POST', { text: 'machine' }, bearer(write.token))).status, 201);
  const seen = await (await f.browser('/api/tokens')).json() as { tokens: AccessToken[] };
  assert.ok(seen.tokens.find(entry => entry.id === read.id)?.lastUsedAt);
  assert.ok(seen.tokens.find(entry => entry.id === write.id)?.lastUsedAt);
  assert.equal((await f.request('/api/auth/logout', 'POST', undefined, bearer(write.token))).status, 204);
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(write.token))).status, 401);
  assert.equal((await f.browser('/api/me')).status, 200);
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(read.token))).status, 200);
  assert.equal((await f.browser('/api/auth/logout', 'POST')).status, 204);
  assert.equal((await f.browser('/api/me')).status, 401);
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(read.token))).status, 200);
});

test('AC-J5/J6: device secrets stay server-side, and abuse does not mint a token', async t => {
  const f = await fixture({ rateWindowMs: 1000 });
  t.after(() => f.dispose());
  const flow = await f.device({ scopes: ['read'], expiresInDays: null, name: '<script>alert(1)</script>' });
  assert.equal(Buffer.from(flow.device_code, 'base64url').length, 32);
  assert.match(flow.user_code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  assert.equal(flow.expires_in, 600);
  assert.equal(flow.verification_uri, `${origin}/device`);
  assert.equal(flow.verification_uri_complete.includes(flow.device_code), false);
  assert.equal(flow.verification_uri_complete.includes(flow.user_code), true);
  const dbBefore = await databaseBytes(f.directory);
  assert.equal(dbBefore.includes(Buffer.from(flow.device_code)), false);
  assert.equal(dbBefore.includes(Buffer.from(flow.user_code.replace('-', ''))), false);
  f.advance(5000);
  assert.equal((await (await f.request('/api/auth/device/token', 'POST', { device_code: flow.device_code })).json() as { error: string }).error, 'authorization_pending');
  assert.equal(f.repo.accessTokens().length, 0);
  const early = await f.request('/api/auth/device/token', 'POST', { device_code: flow.device_code }, { 'x-test-ip': '198.51.100.8' });
  assert.deepEqual(await early.json(), { error: 'slow_down', interval: 10 });
  assert.equal((await f.request('/api/auth/device', 'GET', undefined, { origin })).status, 401);
  assert.equal((await f.request('/api/auth/device/approve', 'GET', undefined, { cookie: f.member.cookie, origin })).status, 404);
  const preview = await f.browser(`/api/auth/device?${new URLSearchParams({ user_code: flow.user_code.toLowerCase(), verification_id: flow.verification_id })}`);
  assert.equal(preview.status, 200);
  const previewBody = await preview.json() as { name: string; ipSummary: string; scopes: string[] };
  assert.equal(previewBody.name.includes('<script>'), true);
  assert.equal(previewBody.ipSummary, '203.0.113.0/24');
  assert.deepEqual(previewBody.scopes, ['read']);
  assert.equal((await f.request('/api/auth/device/approve', 'POST', {
    user_code: flow.user_code, verification_id: flow.verification_id, scopes: ['read', 'write'], userId: f.admin.user.id,
  }, { cookie: f.member.cookie, origin: 'https://evil.example' })).status, 403);
  const pat = await f.pat();
  assert.equal((await f.request('/api/auth/device/approve', 'POST', {
    user_code: flow.user_code, verification_id: flow.verification_id,
  }, { ...bearer(pat.token), cookie: f.member.cookie, origin })).status, 403);
  assert.equal((await f.browser('/api/auth/device/approve', 'POST', {
    user_code: flow.user_code, verification_id: flow.verification_id, scopes: ['write'], userId: f.admin.user.id,
  })).status, 204);
  f.advance(10_000);
  const issued = await (await f.request('/api/auth/device/token', 'POST', { device_code: flow.device_code })).json() as {
    access_token: string; scope: string; token: AccessToken & { token?: string };
  };
  assert.equal(issued.scope, 'read');
  assert.equal(issued.token.userId, f.member.user.id);
  assert.equal(issued.token.token, undefined);
  assert.equal((await f.request(pathOf(f.member.space.id), 'POST', { text: 'nope' }, bearer(issued.access_token))).status, 403);
  assert.equal((await (await f.request('/api/auth/device/token', 'POST', { device_code: flow.device_code })).json() as { error: string }).error, 'expired_token');
  assert.equal((await (await f.request('/api/auth/device/token', 'POST', { device_code: flow.user_code })).json() as { error: string }).error, 'expired_token');
  const burned = await f.device();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    f.advance(1001);
    assert.equal((await f.browser('/api/auth/device/approve', 'POST', {
      user_code: 'AAAA-AAAA', verification_id: burned.verification_id,
    })).status, 404);
  }
  f.advance(1001);
  assert.equal((await f.browser('/api/auth/device/approve', 'POST', {
    user_code: burned.user_code, verification_id: burned.verification_id,
  })).status, 404);
  assert.equal((await (await f.request('/api/auth/device/token', 'POST', { device_code: burned.device_code })).json() as { error: string }).error, 'access_denied');
  const survivor = await f.device();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    f.advance(1001);
    assert.equal((await f.browser('/api/auth/device/approve', 'POST', { user_code: `ZZZ${attempt}-ZZZZ` })).status, 404);
  }
  f.advance(1001);
  assert.equal((await f.browser('/api/auth/device/approve', 'POST', { user_code: survivor.user_code })).status, 204);
  const disabled = await f.device({ scopes: ['read', 'write'] });
  f.advance(5000);
  assert.equal((await f.browser('/api/auth/device/approve', 'POST', {
    user_code: disabled.user_code, verification_id: disabled.verification_id,
  })).status, 204);
  assert.equal((await f.browser(`/api/admin/users/${f.member.user.id}`, 'PATCH', { disabled: true }, f.admin.cookie)).status, 204);
  f.advance(5000);
  assert.equal((await (await f.request('/api/auth/device/token', 'POST', { device_code: disabled.device_code })).json() as { error: string }).error, 'access_denied');
  const secrets = [flow.device_code, issued.access_token, pat.token];
  const stored = await databaseBytes(f.directory);
  for (const secret of secrets) assert.equal(stored.includes(Buffer.from(secret)), false);
  assert.equal(f.logs.some(line => secrets.some(secret => line.includes(secret))), false);
  assert.equal((await f.request('/api/auth/device/token', 'POST', { device_code: "' OR 1=1 --" })).status, 400);
});

function pathOf(spaceId: string) {
  return `/api/spaces/${spaceId}/items/text`;
}

test('AC-J8: WebSocket uses bearer identity, ignores URL tokens, and closes on revoke', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0, websocket: f.websocket }) as Server;
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/api/spaces/${f.member.space.id}/ws`;
  const read = await f.pat({ scopes: ['read'] });
  const write = await f.pat({ scopes: ['write'] });
  await assert.rejects(connect(url, { cookie: f.member.cookie }), /403/);
  await assert.rejects(connect(url, { cookie: f.member.cookie, origin: 'https://evil.example' }), /403/);
  await assert.rejects(connect(`${url}?access_token=${encodeURIComponent(read.token)}`, { origin }), /401/);
  await assert.rejects(connect(url, bearer(write.token)), /403/);
  await assert.rejects(connect(
    `ws://127.0.0.1:${address.port}/api/spaces/${f.admin.space.id}/ws`,
    { ...bearer(read.token), cookie: f.admin.cookie, origin },
  ), /404/);
  const socket = await connect(url, { ...bearer(read.token), cookie: f.admin.cookie, origin: 'https://evil.example' });
  t.after(() => socket.ws.terminate());
  assert.equal((await socket.next()).type, 'snapshot');
  const closed = once(socket.ws, 'close');
  assert.equal((await f.browser(`/api/tokens/${read.id}`, 'DELETE')).status, 204);
  assert.equal((await closed)[0], 1008);
  await assert.rejects(connect(url, bearer(read.token)), /401/);
});

test('AC-K1: ranged downloads stay attachment-only, and a one-view share spends one view', async t => {
  const f = await fixture();
  t.after(() => f.dispose());
  const write = await f.pat();
  const hostile = encodeURIComponent('../../etc/passwd\r\nX-Evil: 1');
  const uploaded = await f.app.request(`/api/spaces/${f.member.space.id}/items/file`, {
    method: 'POST', headers: { ...bearer(write.token), 'x-file-name': hostile }, body: '0123456789',
  });
  assert.equal(uploaded.status, 201);
  const { item } = await uploaded.json() as { item: { id: string; filename: string } };
  assert.equal(item.filename.includes('/'), false);
  assert.equal(item.filename.includes('\\'), false);
  assert.equal(item.filename.includes('\n'), false);
  assert.equal(item.filename.includes('\r'), false);
  assert.equal(item.filename.startsWith('.'), false);
  const fullwidth = await f.app.request(`/api/spaces/${f.member.space.id}/items/file`, {
    method: 'POST',
    headers: { ...bearer(write.token), 'x-file-name': encodeURIComponent('\uFF0E\uFF0E\uFF0Fetc\uFF0Fpasswd') },
    body: '0123456789',
  });
  const wide = (await fullwidth.json() as { item: { filename: string } }).item.filename;
  assert.equal(wide.includes('/'), false);
  assert.equal(wide.startsWith('.'), false);
  const download = await f.request(`/api/spaces/${f.member.space.id}/items/${item.id}/download`, 'GET', undefined, {
    ...bearer(write.token), range: 'bytes=0-3',
  });
  assert.equal(download.status, 206);
  assert.equal(await download.text(), '0123');
  assert.equal(download.headers.get('accept-ranges'), 'bytes');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  const disposition = download.headers.get('content-disposition');
  assert.match(disposition ?? '', /^attachment;/);
  assert.equal(disposition?.includes('\r'), false);
  assert.equal(disposition?.includes('\n'), false);
  assert.equal(starName(disposition).includes('/'), false);
  const missing = await f.request(`/api/spaces/${f.member.space.id}/items/${item.id}/download`, 'GET', undefined, {
    ...bearer(write.token), range: 'bytes=10-12',
  });
  assert.equal(missing.status, 416);
  assert.equal(missing.headers.get('content-range'), 'bytes */10');
  const share = await (await f.browser(`/api/spaces/${f.member.space.id}/items/${item.id}/shares`, 'POST', { expiresIn: '1h', maxViews: 1 })).json() as { id: string; token: string };
  assert.equal((await f.request('/api/me', 'GET', undefined, bearer(share.token))).status, 401);
  const path = `/api/s/${share.token}/file`;
  const first = await f.request(path, 'GET', undefined, { range: 'bytes=0-1' });
  assert.equal(first.status, 206);
  assert.equal(await first.text(), '01');
  const access = first.headers.get('x-share-access');
  assert.ok(access);
  const second = await f.request(`${path}?access=${access}`, 'GET', undefined, { range: 'bytes=2-4' });
  assert.equal(second.status, 206);
  assert.equal(await second.text(), '234');
  assert.match(second.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal(f.repo.sharesForItem(item.id).find(entry => entry.id === share.id)?.views, 1);
  assert.equal((await f.request(path)).status, 404);
});

async function connect(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const messages: Array<{ type?: string }> = [];
  const waiting: Array<(message: { type?: string }) => void> = [];
  ws.on('message', raw => {
    const data = JSON.parse(raw.toString()) as { type?: string };
    const resolve = waiting.shift();
    if (resolve) resolve(data);
    else messages.push(data);
  });
  await once(ws, 'open');
  return {
    ws,
    next: () => {
      const queued = messages.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<{ type?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Socket timed out')), 2000);
        waiting.push(data => { clearTimeout(timeout); resolve(data); });
      });
    },
  };
}
