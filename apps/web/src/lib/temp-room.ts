// RHEA-190 step 7: one temporary room per browser. The browser keeps a random
// secret room key in localStorage (its default fingerprint); POST /api/rooms
// with that key re-enters the live room it already has and only creates a new
// one when there is none (or the old one expired).
import { api } from '@/lib/api.ts'

const KEY = 'dropit-room-key'
const OWN = 'dropit-room-own'
const VALID = /^[A-Za-z0-9_-]{32,128}$/

let memoryKey: string | null = null

function randomKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** This browser's secret room key (created on first use). */
export function roomDeviceKey(): string {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && VALID.test(saved)) return saved
    const fresh = randomKey()
    localStorage.setItem(KEY, fresh)
    return fresh
  } catch {
    // private mode: one key for this tab
    memoryKey ??= randomKey()
    return memoryKey
  }
}

export type TempRoom = { token: string; expiresAt: number; url: string; reused?: boolean; code: string; hasPin?: boolean }
export type RoomEntry = { token: string; expiresAt: number; url?: string; code: string; hasPin: boolean }

// RHEA-190 auth step 4: a room has ONE code and its link is /r/<code>. The code is only typed / shared; the
// room API needs an access token, which the browser gets once (creating the room, or entering the code and
// the PIN when the room has one) and keeps here, per code, so it is not asked for the PIN again.
const ACCESS = 'dropit-room-access'
const ACCESS_LIMIT = 50
let memoryAccess: Record<string, string> = {}

function readAccess(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCESS) ?? '{}') as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {}
  } catch {
    return memoryAccess
  }
}
function writeAccess(next: Record<string, string>) {
  const entries = Object.entries(next).slice(-ACCESS_LIMIT)
  memoryAccess = Object.fromEntries(entries)
  try {
    localStorage.setItem(ACCESS, JSON.stringify(memoryAccess))
  } catch {
    // private mode: this tab only
  }
}
/** Remember the access token for a room code (the newest entry wins). */
export function rememberRoom(code: string, token: string) {
  const access = readAccess()
  delete access[code]
  writeAccess({ ...access, [code]: token })
}
export function savedRoomToken(code: string): string | null {
  const token = readAccess()[code]
  return typeof token === 'string' ? token : null
}
export function forgetRoom(code: string) {
  const access = readAccess()
  if (!(code in access)) return
  delete access[code]
  writeAccess(access)
}
/** The page of a room: /r/<code> (the only room link there is). */
export function roomPath(room: { code: string }): string {
  return `/r/${encodeURIComponent(room.code)}`
}

/** Open this browser's temporary room: the live one if it has one, otherwise a new one. */
export async function openTempRoom(options: { code?: string; pin?: string } = {}): Promise<TempRoom> {
  const room = await api<TempRoom>('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceKey: roomDeviceKey(), ...options }),
  })
  try {
    localStorage.setItem(OWN, room.token)
  } catch {
    // ignore
  }
  rememberRoom(room.code, room.token)
  return room
}

/** Is this the temporary room this browser owns (as far as it last knew)? */
export function isOwnTempRoom(token: string): boolean {
  try {
    return localStorage.getItem(OWN) === token
  } catch {
    return false
  }
}

/** Enter a room by its code (and PIN). Opening /r/<code> does the same. The access token is remembered. */
export async function enterRoomByCode(code: string, pin?: string): Promise<RoomEntry> {
  const entry = await api<RoomEntry>('/api/rooms/enter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, ...(pin ? { pin } : {}) }),
  })
  rememberRoom(entry.code, entry.token)
  return entry
}

/**
 * Owner only: change the room's code and/or PIN. code: a custom code, null = a fresh random code, absent = keep.
 * pin: a new PIN, null = remove it, absent = keep. A new code is a new link; the old one stops working.
 */
export async function setRoomCode(token: string, change: { code?: string | null; pin?: string | null }): Promise<{ code: string; hasPin: boolean; url?: string }> {
  const next = await api<{ code: string; hasPin: boolean; url?: string }>(`/api/rooms/${encodeURIComponent(token)}/code`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceKey: roomDeviceKey(), ...change }),
  })
  rememberRoom(next.code, token)
  return next
}
