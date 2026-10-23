import { createHash, randomBytes } from 'node:crypto';

export class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503, public code: string) { super(code); }
}
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
export interface User { id: string; email: string; name: string; role: 'admin' | 'user'; disabled: number; pending: number; createdAt: number }
export interface Space { id: string; name: string; ownerId: string | null; expiresAt: number | null; roomHash: string | null }
export interface Invite { id: string; tokenHash: string; spaceId: string; maxUses: number; uses: number; expiresAt: number; revoked: number; createdBy: string }
export interface Item {
  id: string; spaceId: string; userId: string | null; kind: 'text' | 'file'; text: string | null;
  filename: string | null; mime: string | null; size: number; storedBytes: number;
  fileKey: string | null; thumbnailKey: string | null; createdAt: number; expiresAt: number;
}
export interface Flow { stateHash: string; browserHash: string; provider: string; verifier: string; inviteHash: string | null; expiresAt: number }
export interface Identity { provider: string; subject: string; email: string; name: string }
export interface Session { user: User; sessionHash: string; expiresAt: number }

export function cleanFilename(input: string): string {
  // eslint-disable-next-line no-control-regex -- filenames must strip control characters
  return input.normalize('NFKC').replace(/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^\.+/, '').trim().slice(0, 180) || 'download';
}
export function publicItem(item: Item) {
  const { fileKey: _file, thumbnailKey, storedBytes: _bytes, ...rest } = item;
  return { ...rest, hasThumbnail: Boolean(thumbnailKey) };
}
