/** Lets one tab own a restored upload so a second tab does not draw the same paused row. */

export const CLAIMS_KEY = 'dropit-upload-claims'
export const CLAIM_TTL_MS = 15_000
const TAB_KEY = 'dropit-tab'

type Claim = { tabId: string; until: number }
type ClaimMap = Record<string, Claim>

function readClaims(): ClaimMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLAIMS_KEY) || '{}') as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const claims: ClaimMap = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      const claim = value as Claim
      if (typeof claim.tabId === 'string' && Number.isSafeInteger(claim.until)) claims[id] = claim
    }
    return claims
  } catch {
    return {}
  }
}

function writeClaims(claims: ClaimMap) {
  try {
    localStorage.setItem(CLAIMS_KEY, JSON.stringify(claims))
  } catch {
    // A tab that cannot persist a lock still draws the row; the other tab can take over after the TTL.
  }
}

export function tabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_KEY)
    if (existing) return existing
    const id = globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`
    sessionStorage.setItem(TAB_KEY, id)
    return id
  } catch {
    return 'tab-memory'
  }
}

/** True when this tab now owns the session. A live foreign lock is left alone. Expired locks can be taken over. */
export function claimUpload(uploadId: string, owner: string, now = Date.now(), ttl = CLAIM_TTL_MS): boolean {
  const claims = readClaims()
  const current = claims[uploadId]
  if (current && current.tabId !== owner && current.until > now) return false
  claims[uploadId] = { tabId: owner, until: now + ttl }
  writeClaims(claims)
  return true
}

export function ownsUpload(uploadId: string, owner: string, now = Date.now()): boolean {
  const current = readClaims()[uploadId]
  return Boolean(current && current.tabId === owner && current.until > now)
}

export function heartbeatUploads(uploadIds: string[], owner: string, now = Date.now(), ttl = CLAIM_TTL_MS) {
  if (uploadIds.length === 0) return
  const claims = readClaims()
  let changed = false
  for (const id of uploadIds) {
    const current = claims[id]
    if (!current || current.tabId !== owner) continue
    claims[id] = { tabId: owner, until: now + ttl }
    changed = true
  }
  if (changed) writeClaims(claims)
}

export function releaseUploads(uploadIds: string[], owner: string) {
  if (uploadIds.length === 0) return
  const claims = readClaims()
  let changed = false
  for (const id of uploadIds) {
    if (claims[id]?.tabId !== owner) continue
    delete claims[id]
    changed = true
  }
  if (changed) writeClaims(claims)
}
