import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type InstallKind = 'docker' | 'docker-build' | 'source';
export interface BuildInfo {
  version: string; commit: string | null; buildDate: string | null; install: InstallKind;
}

const installKinds: readonly InstallKind[] = ['docker', 'docker-build', 'source'];
/** Written by scripts/build-info.mjs during `pnpm build` (apps/server/build-info.json). */
export const buildInfoPath = fileURLToPath(new URL('../build-info.json', import.meta.url));

export function normalizeCommit(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const commit = value.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 7) : null;
}
export function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const version = value.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(version) ? version : null;
}
function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value.trim());
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function gitCommit(cwd: string): string | null {
  try {
    return normalizeCommit(execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString());
  } catch { return null; }
}

/**
 * Build metadata, in priority order: DROPIT_* environment (Docker build-args become ENV),
 * then build-info.json written by `pnpm build`, then (development only) `git rev-parse`.
 */
export function loadBuildInfo(env: NodeJS.ProcessEnv, file: unknown): BuildInfo {
  const stored = file && typeof file === 'object' && !Array.isArray(file) ? file as Record<string, unknown> : null;
  const install = (env.DROPIT_INSTALL?.trim() || stored?.install) as InstallKind;
  let commit = normalizeCommit(env.DROPIT_COMMIT) ?? normalizeCommit(stored?.commit);
  if (!commit && !stored && env.NODE_ENV !== 'production') commit = gitCommit(fileURLToPath(new URL('..', import.meta.url)));
  return {
    version: normalizeVersion(env.DROPIT_VERSION) ?? normalizeVersion(stored?.version) ?? '0.0.0',
    commit,
    buildDate: normalizeDate(env.DROPIT_BUILD_DATE) ?? normalizeDate(stored?.buildDate),
    install: installKinds.includes(install) ? install : 'source',
  };
}

/** -1 / 0 / 1, comparing only the numeric MAJOR.MINOR.PATCH core. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}
