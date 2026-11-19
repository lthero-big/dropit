import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdir, mkdtemp, rm, writeFile, chmod} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createBackend} from '../../../apps/server/src/backend.ts';
import {loadConfig} from '../../../apps/server/src/config.ts';
import {UpdateChecker, loadUpdateSettings} from '../../../apps/server/src/update-check.ts';
import {updateOffer, shouldPrompt} from '../../../mobile/www/core.js';

const root = resolve(import.meta.dirname, '../../..');
const binary = process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server');
await mkdir(join(root, 'rust/server/data'), {recursive:true});
const dir = await mkdtemp(join(root, 'rust/server/data/rhea244-'));
const output = [];
const record = (name, reference, candidate) => {output.push({name, reference, candidate, same: JSON.stringify(reference) === JSON.stringify(candidate)});};
const build = {version:'0.3.2',commit:'aaaaaaa',buildDate:null,install:'source'};
const envBase = {PATH:process.env.PATH, NODE_ENV:'test', HOST:'127.0.0.1', UPDATE_CHECK:'false',
  DROPIT_VERSION:build.version, DROPIT_COMMIT:build.commit, DROPIT_INSTALL:build.install,
  ADMIN_EMAIL:'review@example.test', ADMIN_PASSWORD:'Review-only-password-123'};
let current;
async function stop() {
  if (current && current.child.exitCode === null) {
    if(process.env.MULTICA_CLI_PATH) {
      const daemon = JSON.parse(execFileSync(process.env.MULTICA_CLI_PATH, ['daemon','status','--output','json'], {encoding:'utf8'}));
      assert.notEqual(current.child.pid, daemon.pid);
    }
    const exited = once(current.child, 'exit');
    if(current.container) execFileSync('docker',['stop','-t','10',current.container]); else current.child.kill('SIGTERM');
    await exited;
  }
  current = null;
}
async function start(extra = {}, cache = false) {
  await stop();
  const data = await mkdtemp(join(dir,'data-'));
  if (cache) await writeFile(join(data,'update-check.json'), JSON.stringify({
    key:'source|0.3.2|aaaaaaa|lthero1/dropit|lthero-big/dropit|main',
    state:{status:'available',source:'github',checkedAt:Date.now()-1000,
      latest:{version:'0.3.3',commit:'bbbbbbb',digest:null,publishedAt:null,url:null,behindBy:1},error:null,reason:null}
  }));
  const portFinder=createServer(); portFinder.listen(0,'127.0.0.1'); await once(portFinder,'listening');
  const port=portFinder.address().port; await new Promise(r=>portFinder.close(r));
  const url=`http://127.0.0.1:${port}`;
  const env={...envBase,DATA_DIR:data,PORT:String(port),APP_ORIGIN:url,...extra};
  const container=process.env.RUST_UPDATE_CONTAINER_IMAGE ? 'rhea244-'+port : undefined;
  if(container) await chmod(data,0o777);
  const child=container
    ? spawn('docker',['run','--rm','--name',container,'-p',`127.0.0.1:${port}:8787`,'-v',data+':/data','-v',binary+':/usr/local/bin/dropit-server:ro',
        ...Object.entries({...env,DATA_DIR:'/data',PORT:'8787',HOST:'0.0.0.0'}).flatMap(([k,v])=>['-e',k+'='+v]),
        process.env.RUST_UPDATE_CONTAINER_IMAGE],{stdio:['ignore','pipe','pipe']})
    : spawn(binary,[],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let logs=''; child.stdout.on('data',d=>logs+=d); child.stderr.on('data',d=>logs+=d);
  current={child,data,url,container,logs:()=>logs};
  for(let i=0;i<400;i++) {
    if(child.exitCode!==null) return {...current,started:false};
    if(logs.includes('dropit listening')) return {...current,started:true};
    await new Promise(r=>setTimeout(r,25));
  }
  throw Error('readiness timeout '+logs);
}
async function request(server,path,opts={}) {
  const res=await fetch(server.url+path,opts); return {status:res.status,body:await res.json()};
}
const tsDir=join(dir,'ts'); await mkdir(tsDir);
const checker=new UpdateChecker(build,loadUpdateSettings({UPDATE_CHECK:'false'}));
const backend=createBackend({config:{...loadConfig({}),origin:'http://review.test',dataDir:tsDir},providers:{},update:checker,remoteAddress:()=> '127.0.0.1'});
const tsRequest=async path=>{const r=await backend.app.request(path);return {status:r.status,body:await r.json()};};
try {
  const rust=await start(); assert.ok(rust.started);
  for(const endpoint of ['/api/version','/api/app/ios/latest','/api/app/linux/latest']) {
    assert.deepEqual(await request(rust,endpoint),await tsRequest(endpoint),endpoint);
  }
  const apk=Buffer.from('review fixture APK');
  for(const data of [tsDir,rust.data]) {await mkdir(join(data,'app/android'),{recursive:true});await writeFile(join(data,'app/android/test.apk'),apk);}
  const good={versionCode:5,versionName:'0.3.2',notes:'notes',file:'test.apk',sha256:createHash('sha256').update(apk).digest('hex'),size:apk.length,publishedAt:null};
  for(const [name,patch] of [['normal',{}],['Chinese notes 2000 characters',{notes:'更'.repeat(2000)}],
    ['non-string notes',{notes:7}],['invalid version prefix',{versionName:'-0.3.2'}],['invalid publishedAt type',{publishedAt:7}],
    ['emoji 2000',{notes:'🦀'.repeat(2000)}],['emoji 2001',{notes:'🦀'.repeat(2001)}],
    ['force policy',{force:true,minVersionCode:5}],['notes null',{notes:null}],['publishedAt too long',{publishedAt:'x'.repeat(41)}],
    ['publishedAt max',{publishedAt:'x'.repeat(40)}],['name underscore',{versionName:'_1'}],
    ['file hyphen',{file:'-test.apk'}],['min code invalid',{minVersionCode:6}],['force invalid',{force:1}]]) {
    for(const data of [tsDir,rust.data]) await writeFile(join(data,'app/android/latest.json'),JSON.stringify({...good,...patch}));
    const a=await tsRequest('/api/app/android/latest'),b=await request(rust,'/api/app/android/latest');
    record(name,{status:a.status,body:JSON.stringify(a.body).length,code:a.body.error?.code},{status:b.status,body:JSON.stringify(b.body).length,code:b.body.error?.code});
    assert.deepEqual(b,a,name);
  }
  for(const data of [tsDir,rust.data]) await writeFile(join(data,'app/android/latest.json'),JSON.stringify(good));
  record('unknown APK download',await tsRequest('/api/app/android/download/old.apk'),await request(rust,'/api/app/android/download/old.apk'));
  const offer=updateOffer('https://review.test',4,200,{...good,url:'/api/app/android/download/test.apk',force:true});
  record('forced version must override earlier skip',true,shouldPrompt(offer,'5'));
  for(const extra of [{UPDATE_REPO:'Lthero-Big/Dropit'},{UPDATE_CHECK_HOURS:'6.5'},{UPDATE_REPO:''},{UPDATE_REPO:' lthero-big/dropit '}]) {
    const tsAccepted=!!loadUpdateSettings({...extra});
    const candidate=await start(extra);record('startup '+JSON.stringify(extra),tsAccepted,candidate.started);
  }
  const cached=await start({},true); assert.ok(cached.started);
  const login=await fetch(cached.url+'/api/auth/password/login',{method:'POST',headers:{origin:cached.url,'content-type':'application/json'},body:JSON.stringify({email:envBase.ADMIN_EMAIL,password:envBase.ADMIN_PASSWORD})});
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  const report=await request(cached,'/api/admin/update',{headers:{cookie}});
  record('disabled checker ignores cached availability',checker.report().check.status,report.body.check.status);

  assert.equal(report.body.check.nextCheckAt,null);
  assert.equal((await request(cached,'/api/admin/update')).status,401);
  const h={cookie,origin:cached.url,'content-type':'application/json'};
  const user=await fetch(cached.url+'/api/admin/users',{method:'POST',headers:h,body:JSON.stringify({email:'user@example.test',temporaryPassword:true,name:'User',role:'user'})});
  assert.equal(user.status,201);
  const created=await user.json();
  const userLogin=await fetch(cached.url+'/api/auth/password/login',{method:'POST',headers:{origin:cached.url,'content-type':'application/json'},body:JSON.stringify({email:'user@example.test',password:created.temporaryPassword})});
  assert.equal(userLogin.status,200);
  const uc=userLogin.headers.get('set-cookie')?.split(';')[0];
  assert.equal((await request(cached,'/api/admin/update',{headers:{cookie:uc}})).status,403);
  assert.equal((await request(cached,'/api/admin/update/check',{method:'POST',headers:{cookie,origin:'http://evil.test'}})).status,403);
  const token=await fetch(cached.url+'/api/tokens',{method:'POST',headers:h,body:JSON.stringify({name:'update test',scopes:['read','write']})});
  assert.equal(token.status,201);
  const pat=await token.json();
  assert.equal((await request(cached,'/api/admin/update',{headers:{authorization:'Bearer '+pat.token}})).status,403);
  const releaseDir=join(cached.data,'app/android');
  await mkdir(releaseDir,{recursive:true});await writeFile(join(releaseDir,'test.apk'),apk);
  await writeFile(join(releaseDir,'latest.json'),JSON.stringify(good));
  const download=await fetch(cached.url+'/api/app/android/download/test.apk');
  assert.equal(download.headers.get('content-length'),String(apk.length));
  assert.equal(download.headers.get('cache-control'),'no-store');
  assert.equal(download.headers.get('x-content-type-options'),'nosniff');
  assert.match(download.headers.get('content-disposition'),/attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),apk);
  // A sparse maximum-size APK: slow/aborted readers must not retain an open
  // file or cause the process to buffer 200 MiB before sending headers.
  const fs=await import('node:fs/promises');
  const big=await fs.open(join(releaseDir,'big.apk'),'w'); await big.truncate(200*1024*1024);await big.close();
  await writeFile(join(releaseDir,'latest.json'),JSON.stringify({...good,file:'big.apk',size:200*1024*1024}));
  const pid=cached.container ? Number(execFileSync('docker',['inspect','-f','{{.State.Pid}}',cached.container],{encoding:'utf8'}).trim()) : cached.child.pid;
  const rss=async()=>Number((await fs.readFile('/proc/'+pid+'/status','utf8')).match(/VmRSS:\s+(\d+)/)[1])*1024;
  const before=await rss();
  const abort=new AbortController();
  const large=await fetch(cached.url+'/api/app/android/download/big.apk',{signal:abort.signal});
  const reader=large.body.getReader();await reader.read();
  await new Promise(r=>setTimeout(r,200));
  assert.ok((await rss())-before<64*1024*1024,'slow reader must not allocate an entire APK');
  abort.abort();await reader.cancel().catch(()=>{});
  const handles=async()=> {
    const fds=await fs.readdir('/proc/'+pid+'/fd');
    return (await Promise.all(fds.map(f=>fs.readlink('/proc/'+pid+'/fd/'+f).catch(()=>'')))).filter(f=>f.endsWith('/big.apk'));
  };
  for(let i=0;i<100 && (await handles()).length;i++) await new Promise(r=>setTimeout(r,20));
  assert.equal((await handles()).length,0,'cancel closes APK file');
  console.log('PASS public manifest, permissions, exact download, 200 MiB slow read, abort and file release');
  console.log(JSON.stringify(output,null,2));
  assert.equal(output.filter(x=>!x.same).length,0,'TS/Rust update responses must match');
} finally {await stop();await backend.close();await rm(dir,{recursive:true,force:true});}
