import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fixture, PASSWORD } from './fixture.mjs';

const root = resolve(new URL('../../..', import.meta.url).pathname);
const binary = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
const data = await mkdtemp(resolve(tmpdir(), 'dropit-rust-rooms-'));
const metadata = await fixture(data);
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));

const child = spawn(binary, [], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test', DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: 'http://dropit.test', UPDATE_CHECK: '0', RATE_GENERAL: '10000', RATE_AUTH: '1000', RATE_UPLOAD: '1000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', bytes => { output += bytes; });
child.stderr.on('data', bytes => { output += bytes; });
const url = `http://127.0.0.1:${port}`;
for (let i = 0; i < 200 && !output.includes('dropit listening on port '); i++) await new Promise(resolve => setTimeout(resolve, 25));
if (!output.includes('dropit listening on port ')) throw new Error(`Rust server did not start: ${output}`);

const request = async (path, options = {}) => {
  const headers = { origin: 'http://dropit.test', ...(options.headers ?? {}) };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.json !== undefined) { headers['content-type'] = 'application/json'; options.body = JSON.stringify(options.json); }
  const response = await fetch(url + path, { ...options, headers, redirect: 'manual' });
  const text = await response.text();
  let body = text;
  if (response.headers.get('content-type')?.startsWith('application/json')) body = JSON.parse(text);
  return { response, body };
};

const login = async (email, invite) => {
  const { response } = await request('/api/auth/password/login', { method: 'POST', json: { email, password: PASSWORD, ...(invite ? { invite } : {}) } });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
};

try {
  const alice = await login('alice@example.test');
  const spacePath = `/api/spaces/${metadata.aliceSpace}`;
  const roomCreated = await request('/api/rooms', { method: 'POST', json: { deviceKey: 'k'.repeat(43), pin: '1234' } });
  assert.equal(roomCreated.response.status, 201);
  assert.match(roomCreated.body.token, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  const room = roomCreated.body;
  assert.equal((await request(`/api/rooms/${room.token}`)).response.status, 200);
  assert.equal((await request('/api/rooms/enter', { method: 'POST', json: { code: room.code } })).response.status, 401);
  assert.equal((await request('/api/rooms/enter', { method: 'POST', json: { code: room.code, pin: '1234' } })).response.status, 200);

  const roomText = await request(`/api/rooms/${room.token}/items/text`, { method: 'POST', json: { text: 'room secret' } });
  assert.equal(roomText.response.status, 201);
  const roomItem = roomText.body.item;
  const roomShare = await request(`/api/rooms/${room.token}/items/${roomItem.id}/shares`, { method: 'POST', json: { expiresIn: '1d', maxViews: 1 } });
  if (roomShare.response.status !== 201) console.log('room share failure', roomShare.body, output);
  assert.equal(roomShare.response.status, 201);
  const openedRoom = await request(`/api/s/${roomShare.body.token}`);
  assert.equal(openedRoom.body.item.text, 'room secret');
  assert.equal((await request(`/api/s/${roomShare.body.token}`)).response.status, 404);

  const invite = await request(`${spacePath}/invites`, { method: 'POST', cookie: alice, json: { role: 'viewer', maxUses: 1 } });
  assert.equal(invite.response.status, 201);
  const bob = await login('bob@example.test', invite.body.token);
  const sharedSpaces = await request('/api/spaces', { cookie: bob });
  assert.equal(sharedSpaces.response.status, 200);
  assert.equal((await request(`${spacePath}/items/text`, { method: 'POST', cookie: bob, json: { text: 'blocked' } })).response.status, 403);

  const privateText = await request(`${spacePath}/items/text`, { method: 'POST', cookie: alice, json: { text: 'shared text' } });
  const privateShare = await request(`${spacePath}/items/${privateText.body.item.id}/shares`, { method: 'POST', cookie: alice, json: { expiresIn: 'never', maxViews: 2 } });
  assert.equal(privateShare.response.status, 201);
  const openedPrivate = await request(`/api/s/${privateShare.body.token}`);
  assert.equal(openedPrivate.body.item.text, 'shared text');
  const managed = await request('/api/shares', { cookie: alice });
  assert.equal(managed.response.status, 200);
  assert.ok(managed.body.shares.some(share => share.id === privateShare.body.id));
  assert.equal((await request(`/api/shares/${privateShare.body.id}/link`, { cookie: alice })).response.status, 200);

  const file = await request(`/api/rooms/${room.token}/items/file`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-file-name': 'room.txt' }, body: '0123456789' });
  assert.equal(file.response.status, 201);
  const fileShare = await request(`/api/rooms/${room.token}/items/${file.body.item.id}/shares`, { method: 'POST', json: { expiresIn: 'never', maxViews: 1 } });
  const direct = await request(`/api/s/${fileShare.body.token}/file`);
  assert.equal(direct.response.status, 200);
  assert.equal(direct.body, '0123456789');
  const access = direct.response.headers.get('x-share-access');
  assert.match(access, /^[A-Za-z0-9_-]{43}$/);
  const range = await request(`/api/s/${fileShare.body.token}/file?access=${access}`, { headers: { range: 'bytes=2-4' } });
  assert.equal(range.response.status, 206);
  assert.equal(range.body, '234');

  console.log('PASS rooms, PIN, viewer membership, share views, managed links and room file access');
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit');
  await rm(data, { recursive: true, force: true });
}
