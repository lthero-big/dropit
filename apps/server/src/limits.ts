import type { Config } from './config.js';
import { ApiError } from './domain.js';
import type { Repository } from './repository.js';

// Code-level ceilings also apply to environment defaults. Raising them requires a release.
export const limitRanges = {
  maxFileBytes: { min: 1, max: 1024 ** 3 },
  maxTextBytes: { min: 1, max: 1024 ** 2 },
  maxItems: { min: 1, max: 100000 },
  userQuotaBytes: { min: 1, max: 100 * 1024 ** 3 },
  retentionMs: { min: 1, max: 365 * 86400000 },
  roomQuotaBytes: { min: 1, max: 100 * 1024 ** 3 },
  roomMaxFileBytes: { min: 1, max: 1024 ** 3 },
  roomRetentionMs: { min: 1, max: 86400000 },
  rateWindowMs: { min: 1, max: 3600000 },
  rateGeneral: { min: 1, max: 1000000 },
  rateAuth: { min: 1, max: 1000000 },
  rateInvite: { min: 1, max: 1000000 },
  rateUpload: { min: 1, max: 1000000 },
  rateRoom: { min: 1, max: 1000000 },
  sessionMs: { min: 1, max: 365 * 86400000 },
} as const;
export type LimitKey = keyof typeof limitRanges;
export type LimitValues = Pick<Config, LimitKey>;
export type LimitOverrides = Partial<LimitValues>;
export interface LimitChange {
  key: LimitKey; oldValue: number; newValue: number;
  oldOverride: number | null; newOverride: number | null;
}
export interface LimitAudit extends LimitChange {
  id: number; actorId: string; actorEmail: string; createdAt: number;
}
const keys = Object.keys(limitRanges) as LimitKey[];
const isKey = (key: string): key is LimitKey => Object.hasOwn(limitRanges, key);

export function validateLimits(values: LimitValues) {
  for (const key of keys) {
    const { min, max } = limitRanges[key];
    if (!Number.isSafeInteger(values[key]) || values[key] < min || values[key] > max) throw new ApiError(400, 'INVALID_LIMITS');
  }
  if (values.roomRetentionMs > values.retentionMs ||
      values.roomMaxFileBytes >= values.maxFileBytes || values.roomQuotaBytes >= values.userQuotaBytes ||
      values.rateAuth >= values.rateGeneral || values.rateInvite >= values.rateGeneral ||
      values.rateUpload >= values.rateGeneral || values.rateRoom >= values.rateUpload) throw new ApiError(400, 'INVALID_LIMITS');
}

export class RuntimeLimits {
  private defaults: LimitValues;
  private overrides: LimitOverrides;
  constructor(private config: Config, private repo: Repository) {
    this.defaults = Object.fromEntries(keys.map(key => [key, config[key]])) as LimitValues;
    this.overrides = repo.limitOverrides();
    if (Object.keys(this.overrides).length) {
      if (Object.keys(this.overrides).some(key => !isKey(key))) throw new Error('Unknown persisted limit');
      const values = { ...this.defaults, ...this.overrides };
      validateLimits(values);
      Object.assign(config, values);
    }
  }
  describe() {
    return Object.fromEntries(keys.map(key => [key, {
      value: this.config[key], default: this.defaults[key],
      overridden: Object.hasOwn(this.overrides, key), ...limitRanges[key],
    }]));
  }
  update(patch: Record<string, unknown>, actor: { id: string; email: string }, now: number) {
    if (!Object.keys(patch).length) throw new ApiError(400, 'INVALID_LIMITS');
    const overrides = { ...this.overrides };
    for (const [key, value] of Object.entries(patch)) {
      if (!isKey(key) || (value !== null && typeof value !== 'number')) throw new ApiError(400, 'INVALID_LIMITS');
      if (value === null) delete overrides[key];
      else overrides[key] = value;
    }
    const values = { ...this.defaults, ...overrides };
    // Validate the complete candidate, including resets, before any durable or in-memory write.
    validateLimits(values);
    const changes: LimitChange[] = keys.filter(key => this.overrides[key] !== overrides[key]).map(key => ({
      key, oldValue: this.config[key], newValue: values[key],
      oldOverride: this.overrides[key] ?? null, newOverride: overrides[key] ?? null,
    }));
    this.repo.saveLimitChanges(changes, actor, now);
    Object.assign(this.config, values);
    this.overrides = overrides;
    return this.describe();
  }
}
