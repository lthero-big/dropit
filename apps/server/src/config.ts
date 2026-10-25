import { fileURLToPath } from 'node:url';
import { validateLimits } from './limits.js';

export interface Config {
  origin: string; production: boolean; port: number; dataDir: string; adminEmails: string[];
  trustProxy: string[]; maxFileBytes: number; userQuotaBytes: number; retentionMs: number;
  roomQuotaBytes: number; roomMaxFileBytes: number; roomRetentionMs: number;
  sessionMs: number; cleanupMs: number; maxTextBytes: number; maxItems: number;
  rateWindowMs: number; rateGeneral: number; rateAuth: number; rateInvite: number;
  rateUpload: number; rateRoom: number; rateToken: number;
  uploadChunkBytes: number; uploadChunkTimeoutMs: number; rateChunk: number;
  uploadChunksPerSession: number; uploadChunksPerUser: number; uploadChunksGlobal: number;
  uploadSessionsPerUser: number; uploadSessionsGlobal: number;
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
    rateToken: number('RATE_TOKEN', 120),
    uploadChunkBytes: number('UPLOAD_CHUNK_BYTES', 8 * 1024 ** 2),
    uploadChunkTimeoutMs: number('UPLOAD_CHUNK_TIMEOUT_MS', 120000),
    rateChunk: number('RATE_CHUNK', 2000),
    uploadChunksPerSession: number('UPLOAD_CHUNKS_PER_SESSION', 3),
    uploadChunksPerUser: number('UPLOAD_CHUNKS_PER_USER', 6),
    uploadChunksGlobal: number('UPLOAD_CHUNKS_GLOBAL', 16),
    uploadSessionsPerUser: number('UPLOAD_SESSIONS_PER_USER', 8),
    uploadSessionsGlobal: number('UPLOAD_SESSIONS_GLOBAL', 128),
  };
  validateLimits(config);
  return config;
}
