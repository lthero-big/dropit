import { randomBytes, randomInt, scrypt as scryptCallback, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { ApiError } from './domain.js';

// RHEA-190 auth step 2: email + password accounts. scrypt from node:crypto, a random
// 16-byte salt per password, parameters stored next to the hash so they can be raised later.
// Format: scrypt$N$r$p$<salt base64url>$<key base64url>
const N = 16384, R = 8, P = 1, KEY_BYTES = 64;
const MAX_MEM = 64 * 1024 * 1024;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const options: ScryptOptions = { N: n, r, p, maxmem: MAX_MEM };
  return new Promise((resolve, reject) => scryptCallback(password.normalize('NFKC'), salt, KEY_BYTES, options,
    (error, key) => error ? reject(error) : resolve(key)));
}
const encode = (salt: Buffer, key: Buffer, n = N, r = R, p = P) => `scrypt$${n}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;

/** Rejects passwords that are too short / too long (code PASSWORD_TOO_SHORT / INVALID_INPUT). */
export function checkPassword(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_INPUT');
  if ([...value].length < PASSWORD_MIN) throw new ApiError(400, 'PASSWORD_TOO_SHORT');
  if (value.length > PASSWORD_MAX) throw new ApiError(400, 'INVALID_INPUT');
  return value;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return encode(salt, await derive(password, salt, N, R, P));
}

/** Synchronous variant for one-off startup / CLI work (ADMIN_PASSWORD bootstrap, dropit-admin). */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16);
  return encode(salt, scryptSync(password.normalize('NFKC'), salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEM }));
}

// Compared against when the account does not exist or has no password, so a miss costs the same time.
const DUMMY = encode(Buffer.alloc(16), Buffer.alloc(KEY_BYTES));

/** Constant-time check. A missing or malformed stored hash returns false after the same amount of work. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? DUMMY).split('$');
  const valid = parts.length === 6 && parts[0] === 'scrypt';
  const [n, r, p] = valid ? parts.slice(1, 4).map(Number) : [N, R, P];
  const sane = valid && [n, r, p].every(Number.isSafeInteger) && n >= 1024 && n <= 1 << 20 && r >= 1 && r <= 32 && p >= 1 && p <= 16;
  const salt = sane ? Buffer.from(parts[4], 'base64url') : Buffer.alloc(16);
  const expected = sane ? Buffer.from(parts[5], 'base64url') : Buffer.alloc(KEY_BYTES);
  const key = await derive(password, salt, sane ? n : N, sane ? r : R, sane ? p : P);
  const same = key.length === expected.length && timingSafeEqual(key, expected);
  return Boolean(stored) && sane && same;
}

const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** A readable one-time password such as "k7mp-x3qa-9fhd" (≈ 59 bits). */
export function temporaryPassword(): string {
  const chars = Array.from({ length: 12 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** First-run setup code printed in the container log, e.g. "K7MP-X3QA". */
export function setupCode(): string {
  const chars = Array.from({ length: 8 }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
/** Case / dash / space-insensitive comparison of setup codes in constant time. */
export function sameSetupCode(input: unknown, code: string): boolean {
  if (typeof input !== 'string' || input.length > 32) return false;
  const a = Buffer.from(input.toUpperCase().replace(/[-\s]/g, ''));
  const b = Buffer.from(code.replace(/-/g, ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export const REGISTRATION_SETTING = 'registration';
export type RegistrationPolicy = 'closed' | 'invite' | 'open';
export const registrationPolicies: RegistrationPolicy[] = ['closed', 'invite', 'open'];
export function parsePolicy(value: unknown): RegistrationPolicy | null {
  return registrationPolicies.includes(value as RegistrationPolicy) ? value as RegistrationPolicy : null;
}
