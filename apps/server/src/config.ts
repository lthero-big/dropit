import { fileURLToPath } from 'node:url';

export interface Config {
  origin: string; production: boolean; port: number; dataDir: string; adminEmails: string[];
  trustProxy: string[]; maxFileBytes: number; userQuotaBytes: number; retentionMs: number;
  roomQuotaBytes: number; roomMaxFileBytes: number; roomRetentionMs: number;
  sessionMs: number; cleanupMs: number; maxTextBytes: number; maxItems: number;
  rateWindowMs: number; rateGeneral: number; rateAuth: number; rateInvite: number;
  rateUpload: number; rateRoom: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const number = (key: string, fallback: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${key}`);
    return value;
  };
  const production = env.NODE_ENV === 'production';
  const port = number('PORT', 8787);
  if (port > 65535) throw new Error('Invalid PORT');
  const url = new URL(env.APP_ORIGIN ?? `http://localhost:${port}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== url.href.replace(/\/$/, '') ||
      (production && url.protocol !== 'https:')) throw new Error('APP_ORIGIN must be an origin (HTTPS in production)');
  const config: Config = {
    origin: url.origin, production, port, dataDir: env.DATA_DIR || fileURLToPath(new URL('../../../data', import.meta.url)),
    adminEmails: (env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    trustProxy: (env.TRUST_PROXY ?? '').split(',').map(s => s.trim()).filter(Boolean),
    maxFileBytes: number('MAX_FILE_BYTES', 25 * 1024 ** 2), userQuotaBytes: number('USER_QUOTA_BYTES', 1024 ** 3),
    retentionMs: number('RETENTION_HOURS', 168) * 3600000,
    roomQuotaBytes: number('ROOM_QUOTA_BYTES', 50 * 1024 ** 2),
    roomMaxFileBytes: number('ROOM_MAX_FILE_BYTES', 5 * 1024 ** 2),
    roomRetentionMs: number('ROOM_RETENTION_HOURS', 24) * 3600000,
    sessionMs: number('SESSION_HOURS', 168) * 3600000, cleanupMs: number('CLEANUP_INTERVAL_MS', 60000),
    maxTextBytes: number('MAX_TEXT_BYTES', 65536), maxItems: number('MAX_ITEMS', 1000),
    rateWindowMs: number('RATE_WINDOW_MS', 60000), rateGeneral: number('RATE_GENERAL', 240),
    rateAuth: number('RATE_AUTH', 20), rateInvite: number('RATE_INVITE', 10),
    rateUpload: number('RATE_UPLOAD', 30), rateRoom: number('RATE_ROOM', 10),
  };
  for (const value of [config.retentionMs, config.roomRetentionMs, config.sessionMs]) {
    if (!Number.isSafeInteger(value)) throw new Error('Retention/session duration is too large');
  }
  if (config.roomRetentionMs > 86400000 || config.roomRetentionMs > config.retentionMs ||
      config.roomMaxFileBytes >= config.maxFileBytes || config.roomQuotaBytes >= config.userQuotaBytes ||
      config.rateAuth >= config.rateGeneral || config.rateInvite >= config.rateGeneral ||
      config.rateUpload >= config.rateGeneral || config.rateRoom >= config.rateUpload) {
    throw new Error('Room retention must be <=24h; room quotas and sensitive rate limits must be stricter');
  }
  return config;
}
