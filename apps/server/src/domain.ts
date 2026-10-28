import { createHash, randomBytes, randomInt } from 'node:crypto';

export class ApiError extends Error {
  /** details are extra JSON fields next to code (for example the expected origin of ORIGIN_REJECTED). */
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503, public code: string, public details?: Record<string, string>) { super(code); }
}
export const token = () => randomBytes(32).toString('base64url');
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** RHEA-190 auth step 3: share links and room links are 6 case-sensitive base62 characters (older 43-character links keep working). */
export const SHORT_TOKEN_LENGTH = 6;
export const shortToken = () => Array.from({ length: SHORT_TOKEN_LENGTH }, () => BASE62[randomInt(BASE62.length)]).join('');
export const isShortToken = (value: string) => /^[A-Za-z0-9]{6}$/.test(value);
/** Derives a 6-character base62 token from a digest (device rooms re-derive their link from the browser's secret key). */
export const shortTokenFrom = (digest: Buffer) => {
  let n = BigInt(`0x${digest.subarray(0, 8).toString('hex')}`);
  let out = '';
  for (let i = 0; i < SHORT_TOKEN_LENGTH; i++) { out += BASE62[Number(n % 62n)]; n /= 62n; }
  return out;
};
/** Random room codes: 5 case-sensitive characters without the look-alikes 0 O o 1 I l. */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
export const RANDOM_ROOM_CODE_LENGTH = 5;
export const randomRoomCode = () => Array.from({ length: RANDOM_ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]).join('');
/** A code somebody typed: case-sensitive letters, digits, '-' and '_'. */
export const CUSTOM_CODE_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
export const PIN_MIN = 4;
export const PIN_MAX = 32;
export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
export interface User { id: string; email: string; name: string; role: 'admin' | 'user'; disabled: number; pending: number; createdAt: number }
export interface Space { id: string; name: string; ownerId: string | null; expiresAt: number | null; roomHash: string | null; deviceHash?: string | null; roomCode?: string | null; pinHash?: string | null }
export interface UploadSession {
  id: string; spaceId: string; userId: string | null; principal: string;
  filename: string; mime: string; size: number; chunkSize: number; createdAt: number; expiresAt: number;
}
export interface UploadChunk { uploadId: string; index: number; key: string; size: number; sha256: string }
export interface Invite { id: string; tokenHash: string; spaceId: string; maxUses: number; uses: number; expiresAt: number; revoked: number; createdBy: string; joinSpace?: number; createdAt?: number | null }
export interface Item {
  id: string; spaceId: string; userId: string | null; kind: 'text' | 'file'; text: string | null;
  filename: string | null; mime: string | null; size: number; storedBytes: number;
  fileKey: string | null; thumbnailKey: string | null; createdAt: number; updatedAt: number; expiresAt: number;
  pinned: number; tags: string[];
  /** Demo-style group; null/undefined = 未分组. */
  group?: string | null;
  /** The browser/CLI that created the item, when it identified itself. */
  device?: ItemDevice | null;
}
export const DEVICE_KINDS = ['mac', 'phone', 'pad', 'pc', 'cli'] as const;
export type DeviceKind = typeof DEVICE_KINDS[number];
export interface ItemDevice { id: string; name: string; kind: DeviceKind }
export interface ItemMeta { /** Unvalidated; the service checks it. */ group?: unknown; device?: ItemDevice | null }
export const MAX_GROUPS = 24;
const RESERVED_GROUPS = new Set(['全部', '未分组']);
const hasControl = (value: string) => [...value].some(char => {
  const code = char.charCodeAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
});
/** Validates a group name; throws INVALID_GROUP. */
export function cleanGroupName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_GROUP');
  const name = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  const length = [...name].length;
  if (length < 1 || length > 24 || hasControl(name) || RESERVED_GROUPS.has(name)) throw new ApiError(400, 'INVALID_GROUP');
  return name;
}
/** Lenient: a malformed device identity is ignored, never an error. */
export function parseDevice(id: unknown, rawName: unknown, kind: unknown, encoded = true): ItemDevice | null {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
  let name = typeof rawName === 'string' ? rawName : '';
  if (encoded) {
    try { name = decodeURIComponent(name); } catch { name = ''; }
  }
  name = name.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (hasControl(name)) name = '';
  name = [...name].slice(0, 40).join('');
  const safeKind = (DEVICE_KINDS as readonly string[]).includes(kind as string) ? kind as DeviceKind : 'pc';
  return { id, name: name || '未命名设备', kind: safeKind };
}
export interface ShareLink {
  id: string; tokenHash: string; itemId: string; spaceId: string; createdBy: string | null;
  expiresAt: number | null; maxViews: number | null; views: number; revoked: number; createdAt: number;
  downloadTicketHash: string | null; downloadTicketExpiresAt: number | null;
}
export interface SharePublic {
  id: string; itemId: string; expiresAt: number | null; maxViews: number | null;
  views: number; revoked: number; createdAt: number;
}
export interface Flow { stateHash: string; browserHash: string; provider: string; verifier: string; inviteHash: string | null; expiresAt: number; linkUserId?: string | null }
export interface Identity { provider: string; subject: string; email: string; name: string }
/** A login method bound to an account, as shown in 设置 → 登录方式. */
export interface LinkedIdentity { provider: string; email: string | null; linkedAt: number | null }
/** OAuth app credentials stored in the database (settings UI). */
export interface OAuthApp {
  provider: string; clientId: string; clientSecret: string; enabled: number; updatedAt: number; updatedBy: string | null;
  checkedAt: number | null; checkOk: number | null; checkCode: string | null;
}
export type TokenScope = 'read' | 'write';
export interface AccessToken {
  id: string; userId: string; name: string; scopes: TokenScope[]; createdAt: number;
  lastUsedAt: number | null; expiresAt: number | null; revoked: number;
}
export interface DeviceAuthorization {
  id: string; deviceCodeHash: string; userCodeHash: string; name: string; ipSummary: string;
  scopes: TokenScope[]; tokenLifetimeMs: number | null; expiresAt: number;
  interval: number; nextPollAt: number; attempts: number;
  status: 'pending' | 'approved' | 'denied' | 'consumed'; userId: string | null;
}
export interface Session {
  user: User; sessionHash: string; expiresAt: number;
  /** Public id of a browser session (never the cookie or its hash). */
  sessionId?: string;
  /** RHEA-190 auth step 2: a temporary password is in use; only the change-password API is open. */
  mustChangePassword?: boolean;
  bearer?: { id: string; scopes: TokenScope[] };
}

export function cleanFilename(input: string): string {
  // eslint-disable-next-line no-control-regex -- filenames must strip control characters
  return input.normalize('NFKC').replace(/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^\.+/, '').trim().slice(0, 180) || 'download';
}
export function publicItem(item: Item) {
  const { fileKey: _file, thumbnailKey, storedBytes: _bytes, pinned, group, device, ...rest } = item;
  return { ...rest, pinned: Boolean(pinned), hasThumbnail: Boolean(thumbnailKey), group: group ?? null, device: device ?? null };
}
export function publicShareItem(item: Item) {
  const pub = publicItem(item);
  return {
    kind: pub.kind, text: pub.text, filename: pub.filename, mime: pub.mime, size: pub.size,
    hasThumbnail: pub.hasThumbnail, createdAt: pub.createdAt, expiresAt: pub.expiresAt,
    pinned: pub.pinned, tags: pub.tags,
  };
}

/** What a browser login looks like in 登录设备. Never exposes the cookie or its hash. */
export interface BrowserSession {
  id: string; userId: string; createdAt: number | null; lastSeenAt: number | null; expiresAt: number;
  userAgent: string | null; ipSummary: string | null; device: ItemDevice | null;
}
export interface SessionMeta { userAgent?: string | null; ipSummary?: string | null }
