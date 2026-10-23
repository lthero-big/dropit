import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AppConfig {
  nodeEnv: string
  host: string
  port: number
  appUrl: string
  sessionSecret: string
  githubClientId: string
  githubClientSecret: string
  googleClientId: string
  googleClientSecret: string
  adminEmails: string[]
  dataDir: string
  databasePath: string
  staticDir: string | null
  maxUploadBytes: number
  userQuotaBytes: number
  retentionHours: number
  guestRetentionHours: number
  trustProxy: boolean
}

const DEV_SESSION_SECRET = 'dev-only-change-me'
const WEAK_SECRETS = new Set(['', 'change-me', 'changeme', DEV_SESSION_SECRET])

export function repoRootFrom(importMetaUrl: string): string {
  return fileURLToPath(new URL('../../..', importMetaUrl))
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  options: { repoRoot?: string } = {},
): AppConfig {
  const nodeEnv = env.NODE_ENV || 'development'
  const host = env.HOST || '0.0.0.0'
  const port = readInt(env, 'PORT', 8787, 1, 65535)
  const repoRoot = options.repoRoot ?? repoRootFrom(import.meta.url)
  const dataDir = path.resolve(env.DATA_DIR || path.join(repoRoot, 'data'))
  const databasePath = path.resolve(env.DATABASE_PATH || path.join(dataDir, 'dropit.sqlite'))
  const staticDir = blankToNull(env.STATIC_DIR)
  const sessionSecret = env.SESSION_SECRET || (nodeEnv === 'production' ? '' : DEV_SESSION_SECRET)

  if (nodeEnv === 'production' && WEAK_SECRETS.has(sessionSecret)) {
    throw new Error('SESSION_SECRET must be set to a unique value in production')
  }

  return {
    nodeEnv,
    host,
    port,
    appUrl: stripTrailingSlash(env.APP_URL || `http://localhost:${port}`),
    sessionSecret,
    githubClientId: env.GITHUB_CLIENT_ID ?? '',
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? '',
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    adminEmails: (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
    dataDir,
    databasePath,
    staticDir: staticDir ? path.resolve(staticDir) : null,
    maxUploadBytes: readInt(env, 'MAX_UPLOAD_BYTES', 100 * 1024 * 1024, 1, 10 * 1024 * 1024 * 1024),
    userQuotaBytes: readInt(env, 'USER_QUOTA_BYTES', 1024 * 1024 * 1024, 1, 1024 * 1024 * 1024 * 1024),
    retentionHours: readInt(env, 'RETENTION_HOURS', 168, 1, 24 * 365),
    guestRetentionHours: readInt(env, 'GUEST_RETENTION_HOURS', 24, 1, 24 * 30),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY?.toLowerCase() === 'true',
  }
}

function readInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`)
  }
  return value
}

function blankToNull(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null
  return value
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
