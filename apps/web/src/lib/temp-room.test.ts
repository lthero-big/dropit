import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isOwnTempRoom, openTempRoom, roomDeviceKey } from './temp-room.ts'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('temporary room per browser', () => {
  it('keeps one secret room key per browser', () => {
    const key = roomDeviceKey()
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(roomDeviceKey()).toBe(key)
    expect(localStorage.getItem('dropit-room-key')).toBe(key)
    localStorage.setItem('dropit-room-key', 'not a key')
    expect(roomDeviceKey()).not.toBe('not a key')
  })

  it('sends the key on every open and remembers the room it got back', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
        return bodies.length === 1
          ? json({ token: 'r1', expiresAt: Date.now() + 60_000, code: 'r1code', url: '/r/r1code', reused: false }, 201)
          : json({ token: 'r1', expiresAt: Date.now() + 60_000, code: 'r1code', url: '/r/r1code', reused: true })
      }),
    )
    expect(isOwnTempRoom('r1')).toBe(false)
    const first = await openTempRoom()
    const again = await openTempRoom()
    expect(first.token).toBe('r1')
    expect(again.reused).toBe(true)
    expect(bodies).toEqual([{ deviceKey: roomDeviceKey() }, { deviceKey: roomDeviceKey() }])
    expect(isOwnTempRoom('r1')).toBe(true)
    expect(isOwnTempRoom('other')).toBe(false)
  })
})
