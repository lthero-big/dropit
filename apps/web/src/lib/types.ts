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
}

export interface SpaceSummary {
  id: string
  name: string
  ownerId: string | null
  expiresAt: number | null
}

export interface ScopeInfo {
  id: string
  name: string
  expiresAt: number | null
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
}

export interface Invite {
  id: string
  spaceId: string
  maxUses: number
  uses: number
  expiresAt: number
  revoked: number
  createdBy: string
}

export interface InviteCreated extends Invite {
  token: string
  url: string
}

export interface InvitePreview {
  spaceName: string
  expiresAt: number
  remainingUses: number
}

export interface AdminUser extends User {
  usedBytes: number
  quotaBytes: number
  quotaOverride: number | null
}

export interface AdminLimits {
  maxFileBytes: number
  maxTextBytes: number
  maxItems: number
  userQuotaBytes: number
  retentionMs: number
  roomQuotaBytes: number
  roomMaxFileBytes: number
  roomRetentionMs: number
  rateWindowMs: number
  rateGeneral: number
  rateAuth: number
  rateInvite: number
  rateUpload: number
  rateRoom: number
  sessionMs: number
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
  }
  linkExpiresAt: number | null
  views: number
  maxViews: number | null
  access: string
}

export type ServerMessage =
  | { type: 'snapshot'; items: Item[]; serverTime: number; expiresAt: number | null }
  | { type: 'item.created'; item: Item }
  | { type: 'item.updated'; item: Item }
  | { type: 'item.deleted'; id: string }

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stopped'
