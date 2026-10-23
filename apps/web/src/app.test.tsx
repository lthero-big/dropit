import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'
import { channelClock } from './lib/channel.ts'
import type { Item } from './lib/types.ts'

class FakeSocket {
  static instances: FakeSocket[] = []
  url: string
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readyState = 0

  constructor(url: string | URL) {
    this.url = String(url)
    FakeSocket.instances.push(this)
  }

  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }

  send() {}

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

const me = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'admin' as const, disabled: 0, createdAt: 1 },
  usedBytes: 20,
  quotaBytes: 1000,
  maxFileBytes: 500,
  maxTextBytes: 1000,
  retentionMs: 86_400_000,
}

const space = { id: 's1', name: 'Private space', ownerId: 'u1', expiresAt: null }

function item(partial: Partial<Item> & Pick<Item, 'id' | 'text'>): Item {
  return {
    spaceId: 's1',
    userId: 'u1',
    kind: 'text',
    filename: null,
    mime: null,
    size: 4,
    hasThumbnail: false,
    createdAt: 1_700_000_000_000,
    expiresAt: Date.now() + 3_600_000,
    ...partial,
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

const calls: { url: string; init?: RequestInit }[] = []

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init })
      return handler(url, init)
    }),
  )
}

function renderAt(path: string) {
  window.history.pushState({}, '', path)
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  )
}

const originalDelay = channelClock.delay

beforeEach(() => {
  calls.length = 0
  FakeSocket.instances = []
  channelClock.delay = () => 0
  vi.stubGlobal('WebSocket', FakeSocket)
  window.WebSocket = FakeSocket as unknown as typeof WebSocket
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  channelClock.delay = originalDelay
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dropit web', () => {
  it('shows configured OAuth providers and starts a temporary room', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/auth/providers') return json({ providers: ['github', 'google'] })
      if (url === '/api/rooms' && init?.method === 'POST') return json({ token: 'room-token', expiresAt: Date.now() + 1000, url: '/rooms/room-token' }, 201)
      if (url.startsWith('/api/rooms/room-token')) return json({ id: 'room', name: 'Temporary room', expiresAt: Date.now() + 60_000, maxFileBytes: 100, quotaBytes: 200 })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    expect(await screen.findByRole('link', { name: '使用 GitHub 继续' })).toHaveProperty('href', expect.stringContaining('/api/auth/github'))
    expect(screen.getByRole('link', { name: '使用 Google 继续' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '创建临时房间' }))
    expect(await screen.findByRole('heading', { name: '临时房间' })).toBeTruthy()
    expect(screen.getByText(/\/rooms\/room-token/)).toBeTruthy()
  })

  it('keeps invitation text out of HTML and joins through the invite token', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/auth/providers') return json({ providers: ['github'] })
      if (url === '/api/invites/tok') return json({ spaceName: 'Private space', expiresAt: Date.now() + 3_600_000, remainingUses: 2 })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/invite/tok')
    const link = await screen.findByRole('link', { name: '使用 GitHub 继续' })
    expect(link.getAttribute('href')).toBe('/api/auth/github?invite=tok')
    expect(screen.getByText(/私人空间/)).toBeTruthy()
    expect(screen.getByText(/剩余 2 次/)).toBeTruthy()
  })

  it('renders clipboard text as text, applies live events, and refetches after reconnect', async () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>'
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      if (url === '/api/spaces/s1/items/text' && init?.method === 'POST') {
        return json({ item: item({ id: 'sent', text: 'hello' }) }, 201)
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    expect(await screen.findByRole('button', { name: '发送' })).toBeTruthy()
    const socket = FakeSocket.instances.at(-1)
    expect(socket?.url).toContain('/api/spaces/s1/ws')
    socket?.emit({
      type: 'snapshot',
      items: [item({ id: 'danger', text: payload })],
      serverTime: Date.now(),
      expiresAt: null,
    })
    expect(await screen.findByText(payload)).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()

    socket?.emit({ type: 'item.deleted', id: 'danger' })
    await waitFor(() => expect(screen.queryByText(payload)).toBeNull())

    socket?.close(1006)
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(1))
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [item({ id: 'fresh', text: '补拉到了' })],
      serverTime: Date.now(),
      expiresAt: null,
    })
    expect(await screen.findByText('补拉到了')).toBeTruthy()
    expect(screen.queryByText(payload)).toBeNull()

    fireEvent.change(screen.getByLabelText('要发送的文本'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy())
    const post = calls.find((call) => call.url === '/api/spaces/s1/items/text')
    expect(post?.init?.body).toBe(JSON.stringify({ text: 'hello' }))
  })

  it('stops reconnecting when the socket is rejected', async () => {
    let meCalls = 0
    stubFetch((url) => {
      if (url === '/api/me') {
        meCalls += 1
        return meCalls === 1 ? json(me) : json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      }
      if (url === '/api/auth/providers') return json({ providers: [] })
      if (url === '/api/spaces') return json({ spaces: [space] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await screen.findByRole('button', { name: '发送' })
    const count = FakeSocket.instances.length
    expect(count).toBeGreaterThan(0)
    FakeSocket.instances.at(-1)?.close(1008)
    expect(await screen.findByText('尚未配置 GitHub / Google。凭据通过环境变量提供，配置后刷新此页。')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(FakeSocket.instances.length).toBe(count)
  })

  it('shows quota errors and admin user controls', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      if (url === '/api/admin/users') {
        return json({
          users: [{ ...me.user, usedBytes: 20, quotaBytes: 1000 }, { id: 'u2', email: 'be@example.com', name: 'Bea', role: 'user', disabled: 0, createdAt: 2, usedBytes: 5, quotaBytes: 1000 }],
        })
      }
      if (url === '/api/admin/invites') return json({ invites: [] })
      if (url === '/api/admin/users/u2' && init?.method === 'PATCH') return new Response(null, { status: 204 })
      if (url === '/api/spaces/s1/items/text') return json({ error: { code: 'QUOTA_EXCEEDED' } }, 413, { 'Retry-After': '3' })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/admin')
    expect(await screen.findByRole('heading', { name: '管理' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '用户' }))
    expect(await screen.findByText('Bea')).toBeTruthy()
    expect(screen.getByText('20 B / 1000 B')).toBeTruthy()
    const stop = screen.getAllByRole('button', { name: '停用' })
    fireEvent.click(stop[1]!)
    await waitFor(() => expect(calls.some((call) => call.url === '/api/admin/users/u2' && call.init?.body === JSON.stringify({ disabled: true }))).toBe(true))
  })

  it('shows the quota error from the API', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      if (url === '/api/spaces/s1/items/text') return json({ error: { code: 'QUOTA_EXCEEDED' } }, 413, { 'Retry-After': '3' })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    fireEvent.change(await screen.findByLabelText('要发送的文本'), { target: { value: 'too much' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/已超过配额，3 秒后再试/)).toBeTruthy()
  })

  it('says when an invite or room is gone', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/auth/providers') return json({ providers: [] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/invite/missing')
    expect(await screen.findByRole('heading', { name: '邀请无效' })).toBeTruthy()
    renderAt('/rooms/missing')
    expect(await screen.findByRole('heading', { name: '房间不存在或已过期' })).toBeTruthy()
  })
})
