import { fileURLToPath } from 'node:url';
import { validateLimits } from './limits.js';
import { parseOrigin } from './origin.js';

export interface Config {
  /**
   * APP_ORIGIN from the environment, '' when unset. The effective site address is
   * 管理 → 站点地址 > APP_ORIGIN > each request's own origin (see backend.ts).
   */
  origin: string;
  /** RESET_APP_ORIGIN=1 clears the address saved in 管理 → 站点地址 at startup (lock-out recovery). */
  resetOrigin: boolean;
  production: boolean; port: number; dataDir: string; adminEmails: string[];
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
  // Optional. Plain http is allowed even in production (a fresh docker deploy on an IP);
  // index.ts logs a warning and session cookies are only marked Secure over https.
  const rawOrigin = env.APP_ORIGIN?.trim() ?? '';
  const origin = rawOrigin ? parseOrigin(rawOrigin) : '';
  if (origin === null) throw new Error('APP_ORIGIN must be an origin such as https://dropit.example.com (scheme + host [+ port], no path)');
  const config: Config = {
    origin, resetOrigin: ['1', 'true', 'yes'].includes((env.RESET_APP_ORIGIN ?? '').trim().toLowerCase()), production, port, dataDir: env.DATA_DIR || fileURLToPath(new URL('../../../data', import.meta.url)),
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
