export interface User {
  id: string
  email: string
  name: string
  role: 'admin' | 'user'
  disabled: number
  pending: number
  createdAt: number
}

export interface Me {
  user: User
  usedBytes: number
  quotaBytes: number
  maxFileBytes: number
  maxTextBytes: number
  retentionMs: number
  /** RHEA-190 auth step 2: the account can sign in with email + password. */
  hasPassword?: boolean
  /** A temporary password is in use; everything else waits until it is changed. */
  mustChangePassword?: boolean
}

/** GET /api/auth/providers */
export interface AuthInfo {
  providers: string[]
  password?: boolean
  registration?: 'closed' | 'invite' | 'open'
  setupRequired?: boolean
}

export interface SpaceSummary {
  id: string
  name: string
  ownerId: string | null
  expiresAt: number | null
  /** RHEA-190 m50: the caller's role here. viewer = read-only (view and copy). */
  role?: SpaceRole
  ownerName?: string | null
}

export type MemberRole = 'viewer' | 'editor'
export type SpaceRole = MemberRole | 'owner'

/** RHEA-190 m50: an invite into the owner's private space. */
export interface SpaceInvite {
  id: string
  maxUses: number
  uses: number
  expiresAt: number
  revoked: number
  createdAt: number | null
  role: MemberRole
  status: 'open' | 'used' | 'expired' | 'revoked' | 'active'
  token?: string
  url?: string
}

export interface SpaceInvites {
  enabled: boolean
  limit: number | null
  active: number
  remaining: number | null
  invites: SpaceInvite[]
}

export interface SpaceMember {
  userId: string
  email: string
  name: string
  role: SpaceRole
}

/** RHEA-190 m50: 管理 → 临时房间 (metadata only). */
export interface AdminRoom {
  id: string
  code: string | null
  owner: string | null
  anonymous: boolean
  createdAt: number
  createdAtEstimated: boolean
  lastActiveAt: number | null
  expiresAt: number
  itemCount: number
  bytes: number
  hasPin: boolean
  closed: boolean
  closedAt: number | null
  /** Seconds until the PIN lockout ends; null = not locked. */
  lockedFor: number | null
}

export interface ScopeInfo {
  id: string
  name: string
  expiresAt: number | null
  /** Temporary rooms only (auth step 3/4): the code is also the link /r/<code>. */
  code?: string | null
  hasPin?: boolean
  url?: string
  maxFileBytes: number
  quotaBytes: number
}

export interface Item {
  id: string
  spaceId: string
  userId: string | null
  kind: 'text' | 'file'
  text: string | null
  filename: string | null
  mime: string | null
  size: number
  hasThumbnail: boolean
  createdAt: number
  updatedAt: number
  expiresAt: number
  pinned: boolean
  tags: string[]
  /** RHEA-190 step 5: demo-style group (null = 未分组). Older servers omit it. */
  group?: string | null
  /** The device that sent it, when it identified itself. */
  device?: ItemDevice | null
}

export type ItemDevice = { id: string; name: string; kind: 'mac' | 'phone' | 'pad' | 'pc' | 'cli' }

export interface Invite {
  id: string
  spaceId: string
  maxUses: number
  uses: number
  expiresAt: number
  revoked: number
  createdBy: string
  /** Auth step 3: 0 = personal invite (opens registration only). Older servers omit it. */
  joinSpace?: number
  createdByEmail?: string | null
  /** RHEA-192 m17: registration = opens registration only (admin-made); space = joins a space. */
  kind?: 'registration' | 'space'
  /** RHEA-192 m17: false for older registration invites made by non-admins (they no longer open registration). */
  creatorAdmin?: boolean
  status?: PersonalInvite['status']
}

export interface PersonalInvite {
  id: string
  maxUses: number
  uses: number
  expiresAt: number
  revoked: number
  createdAt: number | null
  status: 'open' | 'used' | 'expired' | 'revoked'
}

export interface InviteCreated extends Invite {
  token: string
  url: string
}

export interface InvitePreview {
  /** Auth step 3: a personal invite only opens registration (no space). */
  personal?: boolean
  inviterName?: string | null
  spaceName: string | null
  expiresAt: number
  remainingUses: number
  /** RHEA-190 m50 (space invites). */
  role?: MemberRole
  canRegister?: boolean
  member?: boolean
  spaceId?: string | null
}

export interface AdminUser extends User {
  usedBytes: number
  quotaBytes: number
  quotaOverride: number | null
  /** RHEA-192 m17: per-user cap on open space invites (null = default 5, 0 = none). Registration invites are admin-only. */
  inviteLimit?: number | null
  inviteLimitEffective?: number
  /** RHEA-190 m50: 空间邀请 column. */
  spaceInvitesEnabled?: boolean
  activeSpaceInvites?: number
  hasPassword?: boolean
  mustChangePassword?: boolean
  providers?: string[]
  /** Only in the response that created it; never shown again. */
  temporaryPassword?: string
}

export const LIMIT_KEYS = [
  'maxFileBytes',
  'maxTextBytes',
  'maxItems',
  'userQuotaBytes',
  'retentionMs',
  'roomQuotaBytes',
  'roomMaxFileBytes',
  'roomRetentionMs',
  'rateWindowMs',
  'rateGeneral',
  'rateAuth',
  'rateInvite',
  'rateUpload',
  'rateRoom',
  'sessionMs',
  'uploadChunkBytes',
  'uploadChunkTimeoutMs',
  'rateChunk',
  'uploadChunksPerSession',
  'uploadChunksPerUser',
  'uploadChunksGlobal',
  'uploadSessionsPerUser',
  'uploadSessionsGlobal',
] as const

export type LimitKey = (typeof LIMIT_KEYS)[number]

export interface LimitField {
  value: number
  default: number
  overridden: boolean
  min: number
  max: number
}

export type AdminLimits = Record<LimitKey, LimitField>

export interface LimitAuditEntry {
  id: number
  actorId: string
  actorEmail: string
  createdAt: number
  key: LimitKey
  oldValue: number
  newValue: number
  oldOverride: number | null
  newOverride: number | null
}

export interface AccessToken {
  id: string
  userId: string
  name: string
  scopes: ('read' | 'write')[]
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revoked: number
}

export interface DeviceRequest {
  name: string
  ipSummary: string
  scopes: ('read' | 'write')[]
  expiresAt: number
  tokenExpiresInDays: number | null
}

export interface ShareLink {
  id: string
  itemId: string
  expiresAt: number | null
  maxViews: number | null
  views: number
  revoked: number
  createdAt: number
}

export interface ShareCreated extends ShareLink {
  token: string
  url: string
}

export interface PublicShare {
  item: {
    kind: 'text' | 'file'
    text: string | null
    filename: string | null
    mime: string | null
    size: number
    hasThumbnail: boolean
    createdAt: number
    expiresAt: number
    pinned?: boolean
    tags?: string[]
  }
  linkExpiresAt: number | null
  views: number
  maxViews: number | null
  access: string
}

export type ServerMessage =
  | { type: 'snapshot'; items: Item[]; groups?: string[]; serverTime: number; expiresAt: number | null }
  | { type: 'item.created'; item: Item }
  | { type: 'item.updated'; item: Item }
  | { type: 'item.deleted'; id: string }
  | { type: 'presence'; devices: number; peers?: ItemDevice[]; others?: number }
  | { type: 'groups'; groups: string[] }

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stopped'

/** RHEA-190 r4: one browser login as listed under 登录设备. */
export interface DeviceSession {
  id: string
  current: boolean
  online: boolean
  createdAt: number | null
  lastSeenAt: number | null
  expiresAt: number
  ipSummary: string | null
  browser: string
  os: string
  device: { id: string; name: string; kind: 'mac' | 'phone' | 'pad' | 'pc' | 'cli' } | null
}

export type InstallKind = 'docker' | 'docker-build' | 'source'
export type UpdateStatus = 'disabled' | 'pending' | 'up-to-date' | 'available' | 'unknown' | 'error'

export interface BuildInfo {
  version: string
  commit: string | null
  buildDate: string | null
  install: InstallKind
}

export interface UpdateReport {
  current: BuildInfo
  check: {
    enabled: boolean
    status: UpdateStatus
    source: 'dockerhub' | 'github' | null
    checkedAt: number | null
    nextCheckAt: number | null
    intervalHours: number
    error: string | null
    reason: string | null
    image: string
    repo: string
    branch: string
    latest: {
      version: string | null
      commit: string | null
      digest: string | null
      publishedAt: string | null
      url: string | null
      behindBy: number | null
    } | null
  }
  upgrade: { install: InstallKind; command: string; docs: string }
}
