import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { ApiError, type Identity } from './domain.js';

export const DEFAULT_GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const DEFAULT_TTL_MS = 3600 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 86400 * 1000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 10 * 1000;
const MAX_JWKS_BYTES = 256 * 1024;
const CLOCK_SKEW_SECS = 60;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

interface JwksCacheEntry {
  keys: Map<string, KeyObject>;
  expiresAt: number;
  lastRefreshAt: number;
}

export interface GoogleIdTokenVerifierOptions {
  jwksUrl?: string;
  request?: typeof fetch;
  now?: () => number;
  minRefreshIntervalMs?: number;
}

function parseMaxAgeMs(cacheControl: string | null): number {
  if (!cacheControl) return DEFAULT_TTL_MS;
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl);
  if (!match) return DEFAULT_TTL_MS;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return DEFAULT_TTL_MS;
  return Math.min(Math.max(seconds * 1000, MIN_TTL_MS), MAX_TTL_MS);
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  if (!BASE64URL_SEGMENT.test(segment)) throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
  }
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class GoogleIdTokenVerifier {
  private readonly jwksUrl: string;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly minRefreshIntervalMs: number;
  private cache: JwksCacheEntry | null = null;
  private inFlight: Promise<JwksCacheEntry> | null = null;

  constructor(options: GoogleIdTokenVerifierOptions = {}) {
    this.jwksUrl = options.jwksUrl || DEFAULT_GOOGLE_JWKS_URL;
    this.request = options.request ?? fetch;
    this.now = options.now ?? Date.now;
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS;
  }

  private async refreshKeys(): Promise<JwksCacheEntry> {
    if (this.inFlight) return this.inFlight;
    const run = (async () => {
      const startedAt = this.now();
      let response: Response;
      try {
        response = await this.request(this.jwksUrl, {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': 'dropit' },
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
      }
      if (!response.ok) throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
      let parsed: unknown;
      try {
        const raw = await readBoundedText(response, MAX_JWKS_BYTES);
        parsed = JSON.parse(raw);
      } catch {
        throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
      }
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { keys?: unknown }).keys)) {
        throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
      }
      const keys = new Map<string, KeyObject>();
      for (const item of (parsed as { keys: unknown[] }).keys) {
        if (typeof item !== 'object' || item === null) continue;
        const jwk = item as Record<string, unknown>;
        if (jwk.kty !== 'RSA') continue;
        if (jwk.use !== undefined && jwk.use !== 'sig') continue;
        if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
        if (typeof jwk.kid !== 'string' || jwk.kid.length === 0 || jwk.kid.length > 256) continue;
        if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
        if (!BASE64URL_SEGMENT.test(jwk.n) || !BASE64URL_SEGMENT.test(jwk.e)) continue;
        try {
          const key = createPublicKey({
            key: { kty: 'RSA', n: jwk.n, e: jwk.e },
            format: 'jwk',
          });
          const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
          if (bits < 2048 || bits > 8192) continue;
          keys.set(jwk.kid, key);
        } catch {
          // Ignore malformed individual JWKs while keeping valid ones.
        }
      }
      if (keys.size === 0) throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
      const ttlMs = parseMaxAgeMs(response.headers.get('cache-control'));
      const entry: JwksCacheEntry = {
        keys,
        expiresAt: startedAt + ttlMs,
        lastRefreshAt: startedAt,
      };
      this.cache = entry;
      return entry;
    })();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async getKey(kid: string): Promise<KeyObject | undefined> {
    const currentTime = this.now();
    let entry = this.cache;
    if (!entry || entry.expiresAt <= currentTime) {
      entry = await this.refreshKeys();
      return entry.keys.get(kid);
    }
    const cached = entry.keys.get(kid);
    if (cached) return cached;
    // Unknown kid: trigger one debounced refresh guarded by minRefreshIntervalMs to avoid forged-kid DoS.
    if (currentTime - entry.lastRefreshAt >= this.minRefreshIntervalMs) {
      entry = await this.refreshKeys();
      return entry.keys.get(kid);
    }
    return undefined;
  }

  async verify(idToken: string, expectedClientId: string): Promise<Identity> {
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some(part => part.length === 0)) {
      throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    if (!BASE64URL_SEGMENT.test(signatureB64)) {
      throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
    }
    const header = decodeBase64UrlJson(headerB64);
    if (header.alg !== 'RS256') throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
    if (header.typ !== undefined && header.typ !== 'JWT') throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
    if (typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 256) {
      throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
    }

    const publicKey = await this.getKey(header.kid);
    if (!publicKey) throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');

    const signature = Buffer.from(signatureB64, 'base64url');
    if (signature.length === 0) throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');

    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
    const validSignature = verify('RSA-SHA256', signingInput, publicKey, signature);
    if (!validSignature) throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');

    const payload = decodeBase64UrlJson(payloadB64);
    if (typeof payload.iss !== 'string' || !VALID_ISSUERS.has(payload.iss)) {
      throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
    }
    if (typeof payload.aud !== 'string' || payload.aud !== expectedClientId) {
      throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
    }

    const nowSec = this.now() / 1000;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp + CLOCK_SKEW_SECS <= nowSec) {
      throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
    }
    if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat < 0 || payload.iat > nowSec + CLOCK_SKEW_SECS) {
      throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
    }
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > nowSec + CLOCK_SKEW_SECS) {
        throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
      }
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) {
      throw new ApiError(401, 'OAUTH_PROVIDER_ERROR');
    }
    const rawEmail = typeof payload.email === 'string' ? payload.email.trim() : '';
    if (!rawEmail || rawEmail.length > 320 || payload.email_verified !== true) {
      throw new ApiError(403, 'VERIFIED_EMAIL_REQUIRED');
    }
    const rawName = typeof payload.name === 'string' && payload.name.trim().length > 0 ? payload.name.trim() : 'User';

    return {
      provider: 'google',
      subject: payload.sub,
      email: rawEmail.toLowerCase(),
      name: rawName.slice(0, 200),
    };
  }
}
