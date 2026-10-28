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

export type TempRoom = { token: string; expiresAt: number; url: string; reused?: boolean; code?: string | null; hasPin?: boolean }
export type RoomEntry = { token: string; expiresAt: number; code: string | null; hasPin: boolean }

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

/** Enter a room by its code (and PIN). The returned token works wherever a room link token does. */
export function enterRoomByCode(code: string, pin?: string): Promise<RoomEntry> {
  return api<RoomEntry>('/api/rooms/enter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, ...(pin ? { pin } : {}) }),
  })
}

/** Owner only: change the room's code (blank = a fresh random one) and PIN. */
export function setRoomCode(token: string, code?: string, pin?: string): Promise<{ code: string; hasPin: boolean }> {
  return api(`/api/rooms/${encodeURIComponent(token)}/code`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceKey: roomDeviceKey(), ...(code ? { code } : {}), ...(pin ? { pin } : {}) }),
  })
}
