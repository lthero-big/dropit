import { compareVersions, normalizeCommit, normalizeVersion, type BuildInfo, type InstallKind } from './version.js';

export interface UpdateSettings {
  enabled: boolean; intervalMs: number; image: string; repo: string; branch: string;
}
export type UpdateStatus = 'disabled' | 'pending' | 'up-to-date' | 'available' | 'unknown' | 'error';
export interface LatestRelease {
  version: string | null; commit: string | null; digest: string | null;
  publishedAt: string | null; url: string | null; behindBy: number | null;
}
export interface UpdateState {
  status: UpdateStatus; source: 'dockerhub' | 'github' | null; checkedAt: number | null;
  latest: LatestRelease | null; error: string | null; reason: string | null;
}
export interface UpdateReport {
  current: BuildInfo;
  check: UpdateState & { enabled: boolean; intervalHours: number; nextCheckAt: number | null; image: string; repo: string; branch: string };
  upgrade: { install: InstallKind; command: string; docs: string };
}
/** Persistence port for the last result (a JSON file in DATA_DIR in production). */
export interface UpdateCache { load(): unknown; save(value: unknown): void }
interface UpdateOptions {
  fetch?: typeof fetch; now?: () => number; cache?: UpdateCache; timeoutMs?: number;
  firstDelayMs?: number; minManualGapMs?: number; log?: (message: string) => void;
}

export const UPDATE_HOURS = { min: 6, max: 168, fallback: 12 } as const;
const imagePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const repoPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const branchPattern = /^[A-Za-z0-9._/-]{1,100}$/;

export function loadUpdateSettings(env: NodeJS.ProcessEnv = process.env): UpdateSettings {
  const flag = (env.UPDATE_CHECK ?? '').trim().toLowerCase();
  const enabled = !['0', 'false', 'off', 'no', 'disabled'].includes(flag);
  const hours = Number(env.UPDATE_CHECK_HOURS ?? UPDATE_HOURS.fallback);
  if (!Number.isFinite(hours) || hours < UPDATE_HOURS.min || hours > UPDATE_HOURS.max) {
    throw new Error(`Invalid UPDATE_CHECK_HOURS (${UPDATE_HOURS.min}-${UPDATE_HOURS.max})`);
  }
  const image = env.UPDATE_IMAGE?.trim() || 'lthero1/dropit';
  const repo = env.UPDATE_REPO?.trim() || 'lthero-big/dropit';
  const branch = env.UPDATE_BRANCH?.trim() || 'main';
  if (!imagePattern.test(image)) throw new Error('Invalid UPDATE_IMAGE (namespace/name on Docker Hub)');
  if (!repoPattern.test(repo)) throw new Error('Invalid UPDATE_REPO (owner/name on GitHub)');
  if (!branchPattern.test(branch) || branch.includes('..')) throw new Error('Invalid UPDATE_BRANCH');
  return { enabled, intervalMs: Math.round(hours * 3600000), image, repo, branch };
}

export function upgradeCommand(install: InstallKind): string {
  if (install === 'docker') return 'docker compose pull && docker compose up -d';
  if (install === 'docker-build') return './scripts/update.sh --docker';
  return './scripts/update.sh';
}

class HttpError extends Error {
  constructor(readonly status: number) { super(`HTTP_${status}`); }
}
const emptyLatest = (): LatestRelease => ({ version: null, commit: null, digest: null, publishedAt: null, url: null, behindBy: null });
const initial = (enabled: boolean): UpdateState => ({ status: enabled ? 'pending' : 'disabled', source: null, checkedAt: null, latest: null, error: null, reason: null });
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 200) => typeof value === 'string' && value.length <= max ? value : null;

/**
 * Periodically asks Docker Hub (docker installs) or GitHub (source builds) whether a newer
 * build exists. Results are cached in memory and in DATA_DIR so restarts do not re-query.
 * Every failure is swallowed into `status: 'error'`: offline or firewalled hosts keep working.
 */
export class UpdateChecker {
  private current: UpdateState;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<UpdateState> | undefined;
  private nextAt: number | null = null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly key: string;

  constructor(readonly build: BuildInfo, readonly settings: UpdateSettings, private readonly options: UpdateOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.key = `${build.install}|${build.version}|${build.commit ?? '-'}|${settings.image}|${settings.repo}|${settings.branch}`;
    this.current = initial(settings.enabled);
    if (settings.enabled) this.restore();
  }

  state(): UpdateState { return structuredClone(this.current); }

  report(): UpdateReport {
    const { settings, build } = this;
    return {
      current: { ...build },
      check: {
        ...this.state(), enabled: settings.enabled, intervalHours: settings.intervalMs / 3600000,
        nextCheckAt: settings.enabled ? this.nextAt : null, image: settings.image, repo: settings.repo, branch: settings.branch,
      },
      upgrade: { install: build.install, command: upgradeCommand(build.install), docs: `https://github.com/${settings.repo}/blob/main/docs/wiki/Deployment.md#upgrading` },
    };
  }

  /** Starts the schedule. A fresh cached result delays the first network call. */
  start() {
    if (!this.settings.enabled || this.timer) return;
    const cachedAge = this.current.checkedAt === null ? Infinity : this.now() - this.current.checkedAt;
    const firstDelay = cachedAge < this.settings.intervalMs ? this.settings.intervalMs - cachedAge : (this.options.firstDelayMs ?? 30000);
    this.schedule(firstDelay);
  }

  stop() { clearTimeout(this.timer); this.timer = undefined; this.nextAt = null; }

  /** Manual "check now"; repeated clicks within the gap reuse the last result. */
  async checkNow(): Promise<UpdateState> {
    if (!this.settings.enabled) return this.state();
    const gap = this.options.minManualGapMs ?? 60000;
    if (this.current.checkedAt !== null && this.now() - this.current.checkedAt < gap && this.current.status !== 'error') return this.state();
    return this.check();
  }

  async check(): Promise<UpdateState> {
    if (!this.settings.enabled) return this.state();
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.nextAt = this.now() + delay;
    this.timer = setTimeout(() => {
      void this.check().finally(() => { if (this.timer) this.schedule(this.settings.intervalMs); });
    }, delay);
    this.timer.unref();
  }

  private async run(): Promise<UpdateState> {
    let next: UpdateState;
    try {
      next = this.build.install === 'docker' ? await this.fromDockerHub() : await this.fromGitHub();
      next = await this.withRelease(next);
    } catch (error) {
      const code = error instanceof HttpError ? ([403, 429].includes(error.status) ? 'RATE_LIMITED' : error.message)
        : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK';
      (this.options.log ?? console.warn)(`Update check failed (${code}); will retry later`);
      next = { ...this.current, status: 'error', checkedAt: this.now(), error: code };
    }
    this.current = next;
    this.persist();
    return this.state();
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.fetcher(url, {
      headers: { accept: 'application/json, application/vnd.github+json', 'user-agent': 'dropit-update-check' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000), redirect: 'follow',
    });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new HttpError(response.status); }
    const body = await response.text();
    if (body.length > 2 * 1024 * 1024) throw new HttpError(502);
    return JSON.parse(body);
  }

  /** GitHub compare: how many commits `target` is ahead of the running commit. null = unknown. */
  private async behindBy(commit: string, target: string): Promise<{ behind: number; head: string | null; url: string | null } | null> {
    try {
      const body = record(await this.getJson(`https://api.github.com/repos/${this.settings.repo}/compare/${commit}...${encodeURIComponent(target)}`));
      const ahead = typeof body.ahead_by === 'number' ? body.ahead_by : null;
      if (ahead === null) return null;
      const commits = Array.isArray(body.commits) ? body.commits : [];
      const head = normalizeCommit(record(commits.at(-1)).sha) ?? (ahead === 0 ? commit : null);
      return { behind: ahead, head, url: text(body.html_url, 500) };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  private async fromGitHub(): Promise<UpdateState> {
    const base: UpdateState = { status: 'unknown', source: 'github', checkedAt: this.now(), latest: null, error: null, reason: null };
    if (!this.build.commit) return { ...base, reason: 'NO_LOCAL_COMMIT' };
    const result = await this.behindBy(this.build.commit, this.settings.branch);
    if (!result) return { ...base, reason: 'COMMIT_NOT_ON_GITHUB' };
    return {
      ...base, status: result.behind > 0 ? 'available' : 'up-to-date',
      latest: { ...emptyLatest(), commit: result.head, behindBy: result.behind, url: result.url ?? `https://github.com/${this.settings.repo}/commits/${this.settings.branch}` },
    };
  }

  private async fromDockerHub(): Promise<UpdateState> {
    const repo = `https://hub.docker.com/v2/repositories/${this.settings.image}`;
    const latestTag = record(await this.getJson(`${repo}/tags/latest`));
    const digest = text(latestTag.digest);
    const tags = record(await this.getJson(`${repo}/tags?page_size=50&ordering=last_updated`));
    const siblings = (Array.isArray(tags.results) ? tags.results : []).map(record)
      .filter(tag => tag.name !== 'latest' && digest !== null && tag.digest === digest).map(tag => text(tag.name, 128)).filter((name): name is string => !!name);
    const latest: LatestRelease = {
      ...emptyLatest(), digest, publishedAt: text(latestTag.last_updated),
      commit: siblings.map(normalizeCommit).find(Boolean) ?? null,
      version: siblings.map(normalizeVersion).find(Boolean) ?? null,
      url: `https://hub.docker.com/r/${this.settings.image}/tags`,
    };
    const base: UpdateState = { status: 'unknown', source: 'dockerhub', checkedAt: this.now(), latest, error: null, reason: null };
    const { commit, version } = this.build;
    if (commit && latest.commit) {
      if (latest.commit === commit) return { ...base, status: 'up-to-date', latest: { ...latest, behindBy: 0 } };
      const result = await this.behindBy(commit, latest.commit).catch(() => null);
      if (result) return { ...base, status: result.behind > 0 ? 'available' : 'up-to-date', latest: { ...latest, behindBy: result.behind } };
      return { ...base, status: 'available', reason: 'COMPARE_UNAVAILABLE' };
    }
    if (latest.version && version !== '0.0.0') return { ...base, status: compareVersions(latest.version, version) > 0 ? 'available' : 'up-to-date' };
    return { ...base, reason: commit ? 'REMOTE_UNTAGGED' : 'NO_LOCAL_COMMIT' };
  }

  /** GitHub Releases are informational; a newer semver release also counts as an update. */
  private async withRelease(state: UpdateState): Promise<UpdateState> {
    let release: Record<string, unknown>;
    try { release = record(await this.getJson(`https://api.github.com/repos/${this.settings.repo}/releases/latest`)); }
    catch { return state; }
    const version = normalizeVersion(release.tag_name);
    if (!version) return state;
    const latest = { ...(state.latest ?? emptyLatest()) };
    latest.version ??= version;
    if (compareVersions(version, this.build.version) <= 0 || this.build.version === '0.0.0') return { ...state, latest };
    return { ...state, status: 'available', latest: { ...latest, version, url: text(release.html_url, 500) ?? latest.url, publishedAt: text(release.published_at) ?? latest.publishedAt } };
  }

  private restore() {
    if (!this.options.cache) return;
    try {
      const saved = record(this.options.cache.load());
      if (saved.key !== this.key) return;
      const state = record(saved.state);
      const statuses: UpdateStatus[] = ['up-to-date', 'available', 'unknown', 'error'];
      if (!statuses.includes(state.status as UpdateStatus) || typeof state.checkedAt !== 'number' || state.checkedAt > this.now()) return;
      this.current = {
        status: state.status as UpdateStatus, checkedAt: state.checkedAt,
        source: state.source === 'dockerhub' || state.source === 'github' ? state.source : null,
        latest: state.latest ? { ...emptyLatest(), ...record(state.latest) } as LatestRelease : null,
        error: text(state.error, 40), reason: text(state.reason, 40),
      };
    } catch { /* no cache yet */ }
  }

  private persist() {
    if (!this.options.cache) return;
    try { this.options.cache.save({ key: this.key, state: this.current }); }
    catch { /* cache is best effort */ }
  }
}
