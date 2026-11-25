import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, NORMALIZED_PASSWORD } from './fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68';
await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const temporary = await mkdtemp(resolve(root, 'rust/server/data/realtime-'));
const children = new Set();
const sockets = new Set();
let checks = 0;
let Sqlite, WebSocket;
const origin = 'http://dropit.test';
const build = { version: '2.3.4', commit: 'abc1234', buildDate: '2026-11-18T12:00:00.000Z', install: 'docker-build' };

async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
  }
  children.delete(child);
}
async function start(kind, data, extra = {}) {
  const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const child = spawn(kind === 'rust' ? (process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server')) : process.execPath,
    kind === 'rust' ? [] : [resolve(temporary, 'reference/apps/server/dist/index.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: 'test',
        DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: origin, UPDATE_CHECK: '0',
        RATE_GENERAL: '100000', RATE_AUTH: '10000', RATE_UPLOAD: '10000',
        DROPIT_VERSION: 'v2.3.4', DROPIT_COMMIT: 'ABC1234abcdef', DROPIT_BUILD_DATE: '2026-11-18T12:00:00Z', DROPIT_INSTALL: 'docker-build', ...extra },
    });
  children.add(child); let output = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  for (let n = 0; n < 200; n++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
    if (output.includes('dropit listening on port')) {
      // The TS entry point logs before Node's actual listen callback.
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, {signal:AbortSignal.timeout(1000)});
        await response.text();
        if (response.status === 200) return { url: `http://127.0.0.1:${port}`, child, data };
      } catch { /* readiness has not arrived yet */ }
    }
    await delay(25);
  }
  throw new Error('Readiness timeout: ' + output);
}
async function request(server, path, {cookie, method = 'GET', json} = {}) {
  const response = await fetch(server.url + path, { method, headers: {origin, ...(cookie ? {cookie} : {}), ...(json ? {'content-type':'application/json'} : {})}, body: json ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(15000) });
  const body = await response.text(); checks++;
  return { status: response.status, body: body ? JSON.parse(body) : null, headers: response.headers };
}
async function login(server, email = 'alice@example.test') {
  const r = await request(server, '/api/auth/password/login', { method: 'POST', json: {email, password: NORMALIZED_PASSWORD} });
  assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0];
}
function connect(server, path, cookie, extra = {}, options = {}) {
  const socket = new WebSocket(server.url.replace('http:', 'ws:') + path, { headers: {origin, cookie, ...extra}, handshakeTimeout: 10000, ...options });
  sockets.add(socket); socket.messages = []; socket.closure = null;
  socket.on('message', bytes => socket.messages.push(JSON.parse(String(bytes))));
  socket.on('close', (code, reason) => { socket.closure = {code, reason: String(reason)}; sockets.delete(socket); });
  socket.on('error', () => {});
  return socket;
}
async function until(predicate, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = predicate(); if (result) { checks++; return result; } await delay(20); }
  throw new Error('Timed out: ' + label);
}
async function message(socket, predicate) {
  return until(() => { const index = socket.messages.findIndex(predicate); return index < 0 ? null : socket.messages.splice(index, 1)[0]; }, 'WS message');
}
async function closed(socket, code, reason) {
  await until(() => socket.closure, 'WS close');
  assert.equal(socket.closure.code, code);
  if (reason) assert.equal(socket.closure.reason, reason);
}
async function handshakeError(server, path, cookie, headers, status, code) {
  const ws = connect(server, path, cookie, headers);
  const [, response] = await once(ws, 'unexpected-response');
  let body = ''; for await (const bytes of response) body += bytes;
  assert.equal(response.statusCode, status);
  // Node's TS upgrade adapter sends status/headers but discards the error body.
  if (body) assert.equal(JSON.parse(body).error.code, code);
  ws.terminate(); checks++;
}

async function flow(kind, seed, meta) {
  const data = resolve(temporary, kind); await cp(seed, data, {recursive: true});
  const server = await start(kind, data);
  const db = new Sqlite(resolve(data, 'dropit.sqlite'));
  const path = '/api/spaces/' + meta.aliceSpace;
  const wsPath = path + '/ws';
  const cookie = await login(server);
  const viewer = await login(server, 'viewer@example.test');
  try {
    for (const [endpoint, expected] of [
      ['/api/auth/providers', {providers: [], password: true, registration: 'invite', setupRequired: false}],
      ['/api/setup', {required: false, providers: []}], ['/api/version', build],
    ]) { const r = await request(server, endpoint); assert.equal(r.status, 200); assert.deepEqual(r.body, expected); assert.equal(r.headers.get('cache-control'), 'no-store'); }
    const site = await request(server, '/api/site'); assert.deepEqual(site.body, {origin, source: 'env', requestOrigin: server.url});
    db.prepare("INSERT INTO app_settings (key,value,updatedAt) VALUES ('registration','closed',?)").run(Date.now());
    assert.equal((await request(server, '/api/auth/providers')).body.registration, 'closed');
    db.prepare("INSERT INTO oauth_apps (provider,clientId,clientSecret,enabled,updatedAt) VALUES ('github','synthetic-id','synthetic-secret',1,?)").run(Date.now());
    assert.deepEqual((await request(server, '/api/auth/providers')).body.providers, ['github']);
    db.prepare("UPDATE oauth_apps SET enabled=0").run();
    assert.deepEqual((await request(server, '/api/auth/providers')).body.providers, []);
    await handshakeError(server, wsPath, cookie, {origin: 'http://evil.test'}, 403, 'ORIGIN_REJECTED');
    await handshakeError(server, wsPath, '', {}, 401, 'UNAUTHENTICATED');
    await handshakeError(server, '/api/spaces/' + meta.bobSpace + '/ws', cookie, {}, 404, 'NOT_FOUND');
    const one = connect(server, wsPath + '?device=web-first&name=Browser%20%25%20%E4%B8%80&kind=pc', cookie);
    const two = connect(server, wsPath + '?device=web-second&name=Browser%20two&kind=mac', viewer);
    const initial = await message(one, m => m.type === 'snapshot');
    const http = (await request(server, path + '/items', {cookie})).body;
    assert.deepEqual({...initial, serverTime: 0}, {...http, serverTime: 0});
    await message(two, m => m.type === 'snapshot');
    const presence = await message(one, m => m.type === 'presence' && m.devices === 2);
    assert.deepEqual(presence.peers.map(p => p.id).sort(), ['web-first','web-second']);
    assert.equal(presence.peers.find(p => p.id === 'web-first').name, 'Browser % 一');
    assert.equal(db.prepare('SELECT deviceName FROM sessions WHERE sessionHash=?').get((await import('node:crypto')).createHash('sha256').update(cookie.split('=')[1]).digest('base64url')).deviceName, 'Browser % 一');
    const text = 'real socket text 🦀 ' + kind;
    const posted = await request(server, path + '/items/text', {cookie, method:'POST', json:{text, group:'新分组'}});
    assert.equal(posted.status, 201);
    for (const ws of [one,two]) {
      assert.ok((await message(ws, m => m.type === 'groups')).groups.includes('新分组'));
      assert.deepEqual((await message(ws, m => m.type === 'item.created')).item, posted.body.item);
    }
    // Two tabs with one device retain two sockets but one named peer; unnamed clients are others.
    const duplicate = connect(server, wsPath + '?device=web-first&name=duplicate&kind=pc', cookie);
    await message(duplicate, m=>m.type==='snapshot');
    const unnamed = connect(server, wsPath, cookie); await message(unnamed,m=>m.type==='snapshot');
    const named = await message(two,m=>m.type==='presence' && m.devices===4);
    assert.equal(named.peers.length,2); assert.equal(named.others,1);
    duplicate.close(); unnamed.close(); await closed(duplicate,1005); await closed(unnamed,1005);
    two.close(); await closed(two, 1005);
    await message(one, m => m.type === 'presence' && m.devices === 1);
    const offlineText = 'during disconnect ' + kind;
    await request(server, path + '/items/text', {cookie, method:'POST', json:{text:offlineText}});
    const reconnected = connect(server, wsPath, viewer);
    assert.ok((await message(reconnected, m => m.type === 'snapshot')).items.some(i => i.text === offlineText));
    // Read-only application data and the protocol payload cap.
    reconnected.send('write denied'); await closed(reconnected, 1008, 'Read-only channel');
    const oversized = connect(server, wsPath, cookie); await message(oversized, m => m.type === 'snapshot');
    oversized.send('x'.repeat(1025)); await closed(oversized, 1009);
    const ping = once(one, 'pong'); one.ping('client-ping'); await ping; checks++;
    // Eager per-send authorization: revoke membership, then publish before the timer.
    const revoked = connect(server, wsPath, viewer); await message(revoked, m => m.type === 'snapshot');
    db.prepare('DELETE FROM members WHERE spaceId=? AND userId=?').run(meta.aliceSpace, meta.viewer.id);
    await request(server, path + '/items/text', {cookie, method:'POST', json:{text:'after membership revoked'}});
    await closed(revoked, 1008, 'Authorization expired');
    assert.ok(!revoked.messages.some(m => m.type === 'item.created'));
    // Disabled user and logout close otherwise idle channels within the validation tick.
    const bobCookie = await login(server, 'bob@example.test');
    const bob = connect(server, '/api/spaces/' + meta.bobSpace + '/ws', bobCookie); await message(bob, m => m.type === 'snapshot');
    db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(meta.bob.id);
    await closed(bob, 1008, 'Authorization expired');
    const logout = await request(server, '/api/auth/logout', {cookie, method:'POST'}); assert.equal(logout.status,204);
    await closed(one, 1008, 'Authorization expired');
    const expiredCookie = await login(server);
    const expired = connect(server, wsPath, expiredCookie); await message(expired, m => m.type === 'snapshot');
    db.prepare('UPDATE sessions SET expiresAt=? WHERE userId=?').run(Date.now()-1, meta.alice.id);
    await closed(expired, 1008, 'Authorization expired');
    // Reservations enforce the same eight-socket cap. Closing frees a slot.
    const capCookie = await login(server); const cap = [];
    for (let i=0;i<8;i++) { const ws=connect(server,wsPath,capCookie); await message(ws,m=>m.type==='snapshot'); cap.push(ws); }
    await handshakeError(server,wsPath,capCookie,{},429,'SOCKET_LIMIT');
    cap[0].close(); await closed(cap[0],1005); await delay(50);
    const replacement=connect(server,wsPath,capCookie); await message(replacement,m=>m.type==='snapshot'); replacement.close();
    for (const ws of cap.slice(1)) ws.close();
    await until(()=>[...sockets].length===0,'all sockets closed');
    for (let i=0;i<5;i++) {
      const racing=connect(server,wsPath,capCookie);
      const r=await request(server,path+'/items/text',{cookie:capCookie,method:'POST',json:{text:'snapshot race '+i}});
      const snapshot=await message(racing,m=>m.type==='snapshot');
      if(!snapshot.items.some(item=>item.id===r.body.item.id)) {
        await message(racing,m=>m.type==='item.created' && m.item.id===r.body.item.id);
      }
      racing.close(); await closed(racing,1005);
    }
    console.log('PASS '+kind+' bootstrap, snapshot/events, presence, reconnect, authorization, payload and connection limits');
    return server;
  } finally { db.close(); await stop(server.child); }
}

async function emptySetup(kind) {
  const data = resolve(temporary,kind+'-empty'); await mkdir(data);
  const {SqliteRepository}=await import(resolve(temporary,'reference/apps/server/dist/repository.js'));
  new SqliteRepository(resolve(data,'dropit.sqlite')).close();
  const server=await start(kind,data,{GOOGLE_CLIENT_ID:'synthetic',GOOGLE_CLIENT_SECRET:'synthetic'});
  try {
    const setup=await request(server,'/api/setup');
    assert.deepEqual(setup.body,{required:true,providers:['google']});
    const providers=await request(server,'/api/auth/providers');
    const expectedProviders = kind === 'rust'
      ? {setupRequired:true,providers:['google'],registration:'invite',password:true,googleClientId:'synthetic'}
      : {setupRequired:true,providers:['google'],registration:'invite',password:true};
    assert.deepEqual(providers.body, expectedProviders);
  } finally { await stop(server.child); }
}

async function stress(kind, seed, meta) {
  const data = resolve(temporary, kind + '-stress'); await cp(seed, data, {recursive:true});
  const server = await start(kind, data);
  const path = '/api/spaces/' + meta.aliceSpace;
  try {
    const cookie = await login(server);
    const alive = connect(server,path+'/ws',cookie);
    await message(alive,m=>m.type==='snapshot');
    let pings = 0; alive.on('ping',()=>pings++);
    const dead = connect(server,path+'/ws',cookie,{}, {autoPong:false});
    await message(dead,m=>m.type==='snapshot');
    const slow = connect(server,path+'/ws',cookie);
    await message(slow,m=>m.type==='snapshot');
    slow._socket.pause();
    for(let i=0;i<180;i++) {
      const r=await request(server,path+'/items/text',{cookie,method:'POST',json:{text:'x'.repeat(65000)+i}});
      assert.equal(r.status,201);
    }
    slow._socket.resume();
    await closed(slow,1013,'Slow consumer');
    // A healthy connection receives a second ping after automatically ponging the first.
    // A client suppressing pongs must be terminated at the second heartbeat.
    await until(()=>pings>=2,'two server heartbeats with healthy pong',70000);
    await until(()=>dead.closure,'silent heartbeat timeout',10000);
    assert.equal(dead.closure.code,1006);
    alive.close(); await closed(alive,1005);
    console.log('PASS '+kind+' real slow consumer 1013, two 30s heartbeats and no-pong termination');
  } finally { await stop(server.child); }
}

try {
  const reference = resolve(temporary,'reference'); await mkdir(reference);
  const archive=execFileSync('git',['archive',baseline,'--','apps/server','package.json','pnpm-workspace.yaml','pnpm-lock.yaml'],{cwd:root,maxBuffer:16*1024*1024});
  execFileSync('tar',['-x','-C',reference],{input:archive});
  execFileSync('pnpm',['install','--frozen-lockfile','--prefer-offline','--filter','@dropit/server...'],{cwd:reference,stdio:'pipe'});
  execFileSync('pnpm',['--filter','@dropit/server','build'],{cwd:reference,stdio:'pipe'});
  const require = createRequire(resolve(reference,'apps/server/package.json'));
  Sqlite=require('better-sqlite3'); WebSocket=require('ws');
  const seed=resolve(temporary,'seed'); const meta=await fixture(seed,{referenceRoot:reference});
  for(const kind of ['ts','rust']) { await flow(kind,seed,meta); await emptySetup(kind); }
  const stressResults = await Promise.allSettled(['ts','rust'].map(kind=>stress(kind,seed,meta)));
  for (const result of stressResults) if (result.status === 'rejected') throw result.reason;
  console.log(`PASS ${checks} real HTTP/WebSocket checks against fixed TS and Rust`);
} finally {
  for(const ws of sockets) ws.terminate();
  for(const child of children) await stop(child);
  await rm(temporary,{recursive:true,force:true});
}
