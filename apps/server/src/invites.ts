import { ApiError } from './domain.js';
import type { UserInviteSettings } from './service.js';

// RHEA-190 auth step 3: 管理 → 注册 controls whether ordinary users may invite and how many.
export const USER_INVITES_SETTING = 'userInvites';
export const DEFAULT_USER_INVITES: UserInviteSettings = { enabled: true, defaultLimit: 5 };
export const MAX_INVITE_LIMIT = 1000;

export function parseUserInvites(value: string | null | undefined): UserInviteSettings {
  if (!value) return DEFAULT_USER_INVITES;
  try {
    const raw = JSON.parse(value) as Partial<UserInviteSettings>;
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_USER_INVITES.enabled,
      defaultLimit: Number.isSafeInteger(raw.defaultLimit) && raw.defaultLimit! >= 0 && raw.defaultLimit! <= MAX_INVITE_LIMIT ? raw.defaultLimit! : DEFAULT_USER_INVITES.defaultLimit,
    };
  } catch { return DEFAULT_USER_INVITES; }
}

/** Applies an admin's partial edit; throws INVALID_INPUT for anything else. */
export function editUserInvites(current: UserInviteSettings, body: unknown): UserInviteSettings {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ApiError(400, 'INVALID_INPUT');
  const edit = body as Record<string, unknown>;
  const next = { ...current };
  if ('enabled' in edit) {
    if (typeof edit.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT');
    next.enabled = edit.enabled;
  }
  if ('defaultLimit' in edit) {
    if (typeof edit.defaultLimit !== 'number' || !Number.isSafeInteger(edit.defaultLimit) || edit.defaultLimit < 0 || edit.defaultLimit > MAX_INVITE_LIMIT) throw new ApiError(400, 'INVALID_INPUT');
    next.defaultLimit = edit.defaultLimit;
  }
  return next;
}
