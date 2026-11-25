// Exercise real Docker failure paths; recover only exact IDs created by this child.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const [image, destination] = process.argv.slice(2);
if (!image || !destination) throw new Error('usage: node scripts/acceptance-docker-cleanup.mjs IMAGE REPORT_DIR');
const root = resolve(import.meta.dirname, '..');
const out = resolve(destination); await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'dropit-cleanup-regression-'));
const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync(realDocker, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exists = (kind, id) => { try { docker(kind, 'inspect', id); return true; } catch { return false; } };
const results = [];
// All calls reach the real daemon, except one deliberately failed rm. Its sibling
// must still be removed and the failed removal must be reported, not swallowed.
await writeFile(join(scratch, 'docker'), `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const {appendFileSync,writeFileSync}=require('node:fs');
const args=process.argv.slice(2),log=value=>appendFileSync(process.env.ACCEPTANCE_DOCKER_TRACE,JSON.stringify(value)+'\\n');
if(args[0]==='rm' && process.env.ACCEPTANCE_DOCKER_FAULT){
 let inject=false;
 try{writeFileSync(process.env.ACCEPTANCE_DOCKER_FAULT,'injected',{flag:'wx'});inject=true;}catch(e){if(e.code!=='EEXIST')throw e;}
 if(inject){log({action:'rm',id:args.at(-1),injected:true});process.stderr.write('injected cleanup failure\\n');process.exit(73);}
}
const r=spawnSync(process.env.ACCEPTANCE_REAL_DOCKER,args,{encoding:'utf8'});
if(args[0]==='create' && r.status===0){
 const id=r.stdout.trim(),c=JSON.parse(spawnSync(process.env.ACCEPTANCE_REAL_DOCKER,['inspect',id],{encoding:'utf8'}).stdout)[0];
 log({action:'create',id,name:c.Name,volumes:c.Mounts.filter(m=>m.Type==='volume').map(m=>m.Name)});
}
if(args[0]==='rm')log({action:'rm',id:args.at(-1),exitCode:r.status});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)process.stderr.write(String(r.error));process.exit(r.status??1);
`, { mode: 0o755 });
try {
  for (const scenario of ['busy-prod', 'busy-dev', 'wrong-image', 'report-error', 'cleanup-error', 'ordinary']) {
    const dir = join(out, scenario); await mkdir(dir);
    const trace = join(dir, 'docker-trace.jsonl'); await writeFile(trace, '');
    const entry = { scenario, image, harnessRecovery: [] }; results.push(entry);
    let socket;
    try {
      const env = { ...process.env, PATH: scratch + ':' + process.env.PATH, DROPIT_IMAGE: image,
        DROPIT_EXPECTED_IMAGE_ID: image, ACCEPTANCE_REAL_DOCKER: realDocker, ACCEPTANCE_DOCKER_TRACE: trace };
      for (const key of ['DROPIT_ACCEPT_PROD_PORT', 'DROPIT_ACCEPT_DEV_PORT', 'DROPIT_EXPECTED_COMMIT', 'ACCEPTANCE_DOCKER_FAULT']) delete env[key];
      if (scenario.startsWith('busy-')) {
        socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
        env[scenario === 'busy-prod' ? 'DROPIT_ACCEPT_PROD_PORT' : 'DROPIT_ACCEPT_DEV_PORT'] = String(socket.address().port);
      }
      if (scenario === 'wrong-image') env.DROPIT_EXPECTED_IMAGE_ID = 'sha256:' + '0'.repeat(64);
      if (scenario === 'cleanup-error') env.ACCEPTANCE_DOCKER_FAULT = join(dir, 'fault-marker');
      const reportPath = join(dir, 'report');
      if (scenario === 'report-error') await writeFile(reportPath, 'intentionally not a directory');
      const child = spawn(process.execPath, ['scripts/acceptance-docker.mjs', reportPath], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
      [entry.exitCode] = await once(child, 'close'); await writeFile(join(dir, 'command.log'), output);
      const actions = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      entry.created = actions.filter(a => a.action === 'create');
      assert.equal(entry.created.length, ['busy-prod', 'wrong-image'].includes(scenario) ? 1 : 2);
      assert(entry.created.every(c => c.volumes.length > 0), 'inspect actual anonymous volumes');
      assert(entry.created.every(c => c.name.startsWith('/dropit-accept-' + child.pid + '-')));
      entry.remaining = entry.created.filter(c => exists('container', c.id));
      if (scenario === 'cleanup-error') {
        assert.equal(entry.exitCode, 1); assert.match(output, /injected cleanup failure/);
        assert.equal(entry.remaining.length, 1, 'only the injected removal may remain');
        assert.equal(actions.filter(a => a.action === 'rm').length, 2);
        const cleanup = JSON.parse(await readFile(join(reportPath, 'docker-cleanup.json'), 'utf8'));
        assert.equal(cleanup.filter(c => c.removed).length, 1); assert.equal(cleanup.filter(c => !c.removed).length, 1);
      } else {
        assert.equal(entry.remaining.length, 0, 'unexpected container leak');
        assert(entry.created.every(c => c.volumes.every(v => !exists('volume', v))), 'anonymous volume leak');
        if (scenario !== 'ordinary') assert.equal(entry.exitCode, 1);
      }
      if (scenario.startsWith('busy-')) assert.match(output, /address already in use|port is already allocated/i);
      if (scenario === 'wrong-image') assert.match(output, /image drift/);
      if (scenario === 'report-error') assert.match(output, /EEXIST|ENOTDIR/);
      if (scenario === 'ordinary') {
        const assertions = JSON.parse(await readFile(join(reportPath, 'docker.json'), 'utf8'));
        assert.equal(assertions.length, 27); // optional commit assertion is absent in this invocation
        const failures = assertions.filter(a => !a.pass); entry.assertionFailures = failures;
        assert(failures.every(a => a.id === 'AC-F1/G6 docker 429 ignores XFF'), 'unrelated black-box failure');
        assert.equal(entry.exitCode, failures.length ? 1 : 0);
      }
      entry.passed = true;
    } finally {
      if (socket) await new Promise(done => socket.close(done));
      const actions = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      for (const c of actions.filter(a => a.action === 'create')) {
        if (exists('container', c.id)) { docker('rm', '-fv', c.id); entry.harnessRecovery.push(c.id); }
        assert(!exists('container', c.id)); assert(c.volumes.every(v => !exists('volume', v)));
      }
      entry.afterRecovery = 'no owned containers or volumes';
      await writeFile(join(out, 'cleanup-regression.json'), JSON.stringify(results, null, 2));
    }
    console.log('PASS Docker cleanup ' + scenario);
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
