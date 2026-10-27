import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceSessions } from './device-sessions.tsx'
import type { DeviceSession } from '@/lib/types.ts'

const now = Date.now()
function session(patch: Partial<DeviceSession>): DeviceSession {
  return { id: 's', current: false, online: false, createdAt: now - 86_400_000, lastSeenAt: now - 120_000, expiresAt: now + 86_400_000,
    ipSummary: '203.0.113.0/24', browser: 'Chrome 131', os: 'macOS', device: null, ...patch }
}

let sessions: DeviceSession[] = []
const calls: { url: string; method: string }[] = []

function stub() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if ((url === '/api/sessions' || url.startsWith('/api/admin/users/')) && method === 'GET') return Response.json({ sessions })
    if (url === '/api/sessions/revoke-others' && method === 'POST') {
      const revoked = sessions.filter((s) => !s.current).length
      sessions = sessions.filter((s) => s.current)
      return Response.json({ revoked })
    }
    const match = /^\/api\/(?:admin\/)?sessions\/([^/]+)$/.exec(url)
    if (match && method === 'DELETE') {
      sessions = sessions.filter((s) => s.id !== match[1])
      return new Response(null, { status: 204 })
    }
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
  }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  calls.length = 0
})

describe('登录设备 (RHEA-190 r4)', () => {
  it('names every signed-in device, marks this one and online ones', async () => {
    sessions = [
      session({ id: 'a', current: true, online: true, device: { id: 'web-a', name: 'Mac · Chrome', kind: 'mac' } }),
      session({ id: 'b', online: true, browser: 'Safari 18', os: 'iPhone', ipSummary: '198.51.100.0/24' }),
      session({ id: 'c', browser: 'Firefox 132', os: 'Windows', lastSeenAt: now - 3 * 86_400_000 }),
    ]
    stub()
    render(<DeviceSessions />)
    const list = await screen.findByRole('list', { name: '登录设备' })
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3))
    const [a, b, c] = within(list).getAllByRole('listitem')
    expect(a.textContent).toContain('Mac · Chrome')
    expect(a.textContent).toContain('本设备')
    expect(a.textContent).toContain('在线')
    expect(b.textContent).toContain('iPhone · Safari 18')
    expect(b.textContent).toContain('IP 198.51.100.0/24')
    expect(b.textContent).toContain('最近活动 2 分钟前')
    expect(c.textContent).toContain('Windows · Firefox 132')
    expect(c.textContent).not.toContain('在线')
    expect(screen.getByText('3 台已登录 · 2 台正在打开 dropit')).toBeTruthy()
  })

  it('signs out a single device after confirmation', async () => {
    sessions = [session({ id: 'a', current: true }), session({ id: 'b', os: 'iPhone', browser: 'Safari 18' })]
    stub()
    render(<DeviceSessions />)
    fireEvent.click(await screen.findByRole('button', { name: '登出 iPhone · Safari 18' }))
    fireEvent.click(screen.getByRole('button', { name: '确认登出' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/sessions/b' && call.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(screen.queryByText('iPhone · Safari 18')).toBeNull())
    expect(calls.some((call) => call.url === '/api/sessions/a' && call.method === 'DELETE')).toBe(false)
  })

  it('logs out all other devices and tells the page when this device signs out', async () => {
    sessions = [session({ id: 'a', current: true }), session({ id: 'b', os: 'iPhone' }), session({ id: 'c', os: 'Windows' })]
    stub()
    const onSelf = vi.fn()
    render(<DeviceSessions onSelfSignedOut={onSelf} />)
    fireEvent.click(await screen.findByRole('button', { name: '登出其他所有设备' }))
    fireEvent.click(screen.getByRole('button', { name: '确认登出其他 2 台' }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: '登录设备' })).getAllByRole('listitem')).toHaveLength(1))
    expect(screen.queryByRole('button', { name: '登出其他所有设备' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /登出 macOS/ }))
    fireEvent.click(screen.getByRole('button', { name: '确认登出' }))
    await waitFor(() => expect(onSelf).toHaveBeenCalledTimes(1))
  })

  it('uses the admin endpoints for another user and hides 登出其他', async () => {
    sessions = [session({ id: 'x' }), session({ id: 'y', os: 'iPhone' })]
    stub()
    render(<DeviceSessions userId="u9" />)
    fireEvent.click(await screen.findByRole('button', { name: /登出 iPhone/ }))
    fireEvent.click(screen.getByRole('button', { name: '确认登出' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/admin/sessions/y' && call.method === 'DELETE')).toBe(true))
    expect(calls[0].url).toBe('/api/admin/users/u9/sessions')
    expect(screen.queryByRole('button', { name: '登出其他所有设备' })).toBeNull()
  })
})
