// Writes apps/server/build-info.json during `pnpm build` so /api/version knows what is running.
// DROPIT_VERSION / DROPIT_COMMIT / DROPIT_BUILD_DATE / DROPIT_INSTALL override detection.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = fileURLToPath(new URL('../build-info.json', import.meta.url));
const env = (name) => process.env[name]?.trim() || null;
let commit = env('DROPIT_COMMIT');
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim(); }
  catch { commit = null; }
}
let version = env('DROPIT_VERSION');
if (!version) {
  try { version = JSON.parse(readFileSync(new URL('package.json', `file://${root}`), 'utf8')).version ?? null; }
  catch { version = null; }
}
const info = { version: version ?? '0.0.0', commit, buildDate: env('DROPIT_BUILD_DATE') ?? new Date().toISOString(), install: env('DROPIT_INSTALL') ?? 'source' };
writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
console.info(`build-info: ${info.version} ${info.commit ?? 'unknown'} (${info.install})`);
