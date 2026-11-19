import assert from 'node:assert/strict';
import {execFileSync, spawnSync, spawn} from 'node:child_process';
import {mkdtemp, mkdir, cp, rm, symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {fixture} from './fixture.mjs';
const root = resolve(import.meta.dirname, '../../..');
await mkdir(resolve(root,'rust/server/data'),{recursive:true});
const temp = await mkdtemp(resolve(root, 'rust/server/data/admin-'));
const reference = resolve(temp, 'reference');
const children = new Set();
try {
  await mkdir(reference);
  execFileSync('tar', ['-x', '-C', reference], {input: execFileSync('git', ['archive', '37ce06ebfab2cd98b81e49ce54fb24ec5daeec68', '--', 'apps/server', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], {cwd: root, maxBuffer: 16e6})});
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@dropit/server...'], {cwd: reference, stdio: 'pipe'});
  execFileSync('pnpm', ['--filter', '@dropit/server', 'build'], {cwd: reference, stdio: 'pipe'});
  const load = name => import(pathToFileURL(resolve(reference, 'apps/server/dist/'+name+'.js')));
  const {SqliteRepository} = await load('repository');
  const {verifyPassword} = await load('password');
  const {hash} = await load('domain');
  const seed = resolve(temp, 'seed');
  const f = await fixture(seed, {referenceRoot: reference});
  const repo = new SqliteRepository(resolve(seed, 'dropit.sqlite'));
  repo.provisionUser({email: 'oauth@example.test', name: 'OAuth only', role: 'user', quotaBytes: null, now: Date.now()+10});
  repo.close();
  if (process.env.ADMIN_FIXTURE_OUT) {
    await cp(seed, resolve(process.env.ADMIN_FIXTURE_OUT), {recursive:true});
    const history=resolve(process.env.ADMIN_FIXTURE_OUT,'historical15'); await mkdir(history,{recursive:true});
    const Sqlite=createRequire(resolve(reference,'apps/server/package.json'))('better-sqlite3');
    const old=new Sqlite(resolve(history,'dropit.sqlite'));
    const migrations=await load('migrations');
    for(let version=1;version<=15;version++) old.exec(migrations['migration'+version]);
    old.prepare("INSERT INTO spaces(id,name,ownerId,expiresAt,roomHash) VALUES ('legacy-room','Historical room',NULL,NULL,'legacy')").run(); old.close();
  }
  const rust = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
  const admin = resolve(temp, 'dropit-admin');
  await symlink(rust, admin);
  function run(kind, args, data) {
    return spawnSync(kind === 'rust' ? admin : process.execPath, kind === 'rust' ? args : [resolve(reference, 'apps/server/dist/admin-cli.js'), ...args], {
      env: {...process.env, DATA_DIR: data}, encoding: 'utf8', timeout: 30000,
    });
  }
  let checks = 0;
  for (const args of [[], ['help'], ['--help'], ['-h'], ['wat'], ['reset-password'], ['list-users'], ['reset-password','missing@example.test']]) {
    const data = resolve(temp, 'basic-'+checks); await cp(seed, data, {recursive:true});
    const ts = run('ts', args, data), rs = run('rust', args, data);
    assert.deepEqual([rs.status,rs.stdout,rs.stderr], [ts.status,ts.stdout,ts.stderr], JSON.stringify(args)); checks++;
  }
  for (const kind of ['ts', 'rust']) {
    const data = resolve(temp, 'empty-'+kind); await mkdir(data);
    const result = run(kind, ['list-users'], data);
    assert.equal(result.status,0); assert.equal(result.stdout, 'No accounts yet. Open /setup (the setup code is in the server log).\n');
  }
  async function start(kind,data) {
    const socket=createServer(); socket.listen(0,'127.0.0.1'); await once(socket,'listening'); const port=socket.address().port; await new Promise(r=>socket.close(r));
    const url='http://127.0.0.1:'+port;
    const child=spawn(kind==='rust'?rust:process.execPath,kind==='rust'?[]:[resolve(reference,'apps/server/dist/index.js')],{env:{...process.env,DATA_DIR:data,HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:url,NODE_ENV:'test',UPDATE_CHECK:'0'},stdio:['ignore','pipe','pipe']});
    children.add(child); let logs=''; child.stdout.on('data',b=>logs+=b); child.stderr.on('data',b=>logs+=b);
    for(let i=0;i<400;i++) { if(child.exitCode!==null) throw Error(logs); try {const r=await fetch(url+'/healthz');await r.text();if(r.ok)return {child,url};}catch{} await new Promise(r=>setTimeout(r,25)); }
    throw Error('readiness: '+logs);
  }
  for (const email of ['  ALICE@EXAMPLE.TEST  ','\uFEFFALICE@example.test\uFEFF','oauth@example.test','disabled@example.test','pending@example.test']) {
    const outputs=[];
    for (const kind of ['ts','rust']) {
      const data=resolve(temp,'reset-'+checks+'-'+kind); await cp(seed,data,{recursive:true});
      const before=Date.now(); const result=run(kind,['reset-password',email],data); assert.equal(result.status,0,result.stderr);
      const match=result.stdout.match(/: ([abcdefghjkmnpqrstuvwxyz23456789]{4}-[abcdefghjkmnpqrstuvwxyz23456789]{4}-[abcdefghjkmnpqrstuvwxyz23456789]{4})\n/); assert.ok(match,result.stdout);
      outputs.push([result.stdout.replace(match[1],'<random>'),result.stderr]);
      const repo=new SqliteRepository(resolve(data,'dropit.sqlite')); const account=repo.passwordAccount(email.trim().toLowerCase());
      assert.ok(await verifyPassword(match[1],account.passwordHash)); assert.equal(account.mustChangePassword,1);
      assert.ok(account.passwordUpdatedAt>=before && account.passwordUpdatedAt<=Date.now());
      if(email.includes('ALICE')) assert.equal(repo.session(hash(f.oldCookie),Date.now()),undefined);
      repo.close();
      const server=await start(kind,data);
      try {
        const r=await fetch(server.url+'/api/auth/password/login',{method:'POST',headers:{origin:server.url,'content-type':'application/json'},body:JSON.stringify({email:email.trim(),password:match[1]})});
        const body=await r.json();
        if(email.startsWith('disabled')) { assert.equal(r.status,403); }
        else { assert.equal(r.status,200,JSON.stringify(body)); assert.equal(body.mustChangePassword,true);
          const cookie=r.headers.get('set-cookie').split(';')[0];
          const blocked=await fetch(server.url+'/api/spaces',{headers:{cookie}}); assert.equal(blocked.status,403); assert.equal((await blocked.json()).error.code,'PASSWORD_CHANGE_REQUIRED');
          const changed=await fetch(server.url+'/api/me/password',{method:'PUT',headers:{origin:server.url,cookie,'content-type':'application/json'},body:JSON.stringify({currentPassword:match[1],newPassword:'Changed-secure-password-246'})});
          assert.equal(changed.status,200); assert.equal((await changed.json()).mustChangePassword,false);
          const allowed=await fetch(server.url+'/api/spaces',{headers:{cookie}}); assert.equal(allowed.status,200); await allowed.text(); }
        if(email.includes('ALICE')) {const old=await fetch(server.url+'/api/me',{headers:{cookie:'dropit_session='+f.oldCookie}});assert.equal(old.status,401);await old.text();}
      } finally {const exit=once(server.child,'exit');server.child.kill('SIGTERM');await exit;children.delete(server.child);}
    }
    assert.deepEqual(outputs[1],outputs[0]); checks++;
  }
  console.log(`PASS offline admin: ${checks} TS/Rust command comparisons, empty databases, TS scrypt verification, forced change, disabled/pending/OAuth-only accounts and revoked sessions`);
} finally {
  for(const child of children) {const exit=once(child,'exit');child.kill('SIGTERM');await exit;}
  await rm(temp,{recursive:true,force:true});
}
