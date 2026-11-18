// Run the existing Web smoke against only Rust, using a TS-created schema-19 fixture.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, NORMALIZED_PASSWORD } from './fixture.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(resolve(root, 'rust/server/data'), { recursive: true });
const data = await mkdtemp(resolve(root, 'rust/server/data/browser-'));
let backend;
try {
  await fixture(data);
  backend = spawn(process.env.RUST_SERVER_BIN || resolve(root, 'rust/server/target/debug/dropit-server'), [], {
    cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: {
      PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '18878',
      DATA_DIR: data, APP_ORIGIN: 'http://127.0.0.1:15173',
    },
  });
  await new Promise((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('Rust readiness timeout')), 10000);
    backend.stdout.on('data', bytes => { if (String(bytes).includes('dropit listening on port')) { clearTimeout(timeout); done(); } });
    backend.once('exit', code => { clearTimeout(timeout); fail(new Error('Rust exited '+code)); });
    backend.once('error', fail);
  });
  console.log('Browser HTTP/WS target: Rust process pid=' + backend.pid + ' at http://127.0.0.1:18878; no TS server started');
  const smoke = spawn('pnpm', ['--filter', '@dropit/web', 'smoke'], {cwd: root, stdio: 'inherit', env: {
    ...process.env, DROPIT_DEV_BACKEND_ORIGIN: 'http://127.0.0.1:18878',
    DROPIT_SMOKE_EMAIL: 'alice@example.test', DROPIT_SMOKE_PASSWORD: NORMALIZED_PASSWORD,
  }});
  const [code] = await once(smoke, 'exit');
  if (code !== 0) throw new Error('Rust browser smoke failed, exit=' + code);
} finally {
  if (backend && backend.exitCode === null && backend.signalCode === null) { const exit = once(backend, 'exit'); backend.kill('SIGTERM'); await exit; }
  await rm(data, {recursive: true, force: true});
}
