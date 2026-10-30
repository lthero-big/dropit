// RHEA-192 m17: only admins invite people to register (管理 → 邀请, no cap). The old site-wide
// `userInvites` setting (允许普通用户邀请 / 每人默认邀请上限) is gone; a row left in app_settings is ignored.
// What remains for ordinary users is the space invite (设置 → 空间成员): it never opens registration and
// is capped per user by users.inviteLimit (null = this default, 0 = the user may not invite into their space).
export const DEFAULT_SPACE_INVITE_LIMIT = 5;
export const MAX_INVITE_LIMIT = 1000;
