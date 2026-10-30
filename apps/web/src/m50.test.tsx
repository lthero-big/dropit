import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'
import { channelClock } from './lib/channel.ts'
import type { Item } from './lib/types.ts'

// RHEA-190 m50: space invites (read-only by default), admin 临时房间, the 房间码 popups.
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

const user = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'user' as const, disabled: 0, pending: 0, createdAt: 1 },
  usedBytes: 20,
  quotaBytes: 1000,
  maxFileBytes: 500,
  maxTextBytes: 1000,
  retentionMs: 86_400_000,
}
const admin = { ...user, user: { ...user.user, role: 'admin' as const } }
const own = { id: 's1', name: 'Private space', ownerId: 'u1', expiresAt: null, role: 'owner', ownerName: 'Ada' }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
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
function item(partial: Partial<Item> & Pick<Item, 'id' | 'text'>): Item {
  return {
    spaceId: 's2', userId: 'u9', kind: 'text', filename: null, mime: null, size: 4, hasThumbnail: false,
    createdAt: 1_700_000_000_000, expiresAt: Date.now() + 3_600_000, pinned: false, tags: [], updatedAt: 1_700_000_000_000,
    ...partial,
  }
}
const originalDelay = channelClock.delay
beforeEach(() => {
  calls.length = 0
  FakeSocket.instances = []
  channelClock.delay = () => 0
  vi.stubGlobal('WebSocket', FakeSocket)
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  channelClock.delay = originalDelay
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('space invites in 设置', () => {
  it('a normal user invites into their space (read-only by default), revokes, and manages members; no registration invites', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    let invites = [{ id: 'i1', maxUses: 3, uses: 1, expiresAt: Date.now() + 3_600_000, revoked: 0, createdAt: 1, role: 'viewer', status: 'open' }]
    let members = [
      { userId: 'u1', email: 'ada@example.com', name: 'Ada', role: 'owner' },
      { userId: 'u2', email: 'bob@example.com', name: 'Bob', role: 'viewer' },
    ]
    stubFetch((url, init) => {
      if (url === '/api/me') return json(user)
      if (url === '/api/tokens') return json({ tokens: [] })
      if (url === '/api/spaces') return json({ spaces: [own] })
      if (url === '/api/spaces/s1/invites' && init?.method === 'POST') {
        const created = { id: 'i2', maxUses: 5, uses: 0, expiresAt: Date.now() + 86_400_000, revoked: 0, createdAt: 2, role: 'viewer', status: 'active', url: 'http://dropit.lan/invite/abc' }
        invites = [...invites, { ...created, status: 'open' }]
        return json(created, 201)
      }
      if (url === '/api/spaces/s1/invites') return json({ enabled: true, limit: 5, active: invites.filter((i) => i.status === 'open').length, remaining: 3, invites })
      if (url === '/api/spaces/s1/invites/i1' && init?.method === 'DELETE') {
        invites = invites.map((i) => (i.id === 'i1' ? { ...i, status: 'revoked', revoked: 1 } : i))
        return new Response(null, { status: 204 })
      }
      if (url === '/api/spaces/s1/members/u2' && init?.method === 'PATCH') {
        members = members.map((m) => (m.userId === 'u2' ? { ...m, role: 'editor' } : m))
        return json({ members })
      }
      if (url === '/api/spaces/s1/members/u2' && init?.method === 'DELETE') {
        members = members.filter((m) => m.userId !== 'u2')
        return new Response(null, { status: 204 })
      }
      if (url === '/api/spaces/s1/members') return json({ members })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    expect(await screen.findByRole('heading', { name: '空间成员与邀请' })).toBeTruthy()
    // registration invites are admin-only now
    expect(screen.queryByRole('heading', { name: '注册邀请' })).toBeNull()
    expect(calls.some((call) => call.url === '/api/me/invites')).toBe(false)

    const form = screen.getByRole('form', { name: '生成空间邀请' })
    expect((within(form).getByLabelText('权限') as HTMLSelectElement).value).toBe('viewer')
    fireEvent.change(within(form).getByLabelText('可用次数'), { target: { value: '5' } })
    fireEvent.change(within(form).getByLabelText('有效期'), { target: { value: '24' } })
    fireEvent.click(within(form).getByRole('button', { name: '生成空间邀请' }))
    expect(await screen.findByText('http://dropit.lan/invite/abc')).toBeTruthy()
    const post = calls.find((call) => call.url === '/api/spaces/s1/invites' && call.init?.method === 'POST')
    expect(JSON.parse(String(post?.init?.body))).toEqual({ role: 'viewer', maxUses: 5, expiresInHours: 24 })

    const list = screen.getByRole('list', { name: '空间邀请' })
    fireEvent.click(within(list).getAllByRole('button', { name: '撤销' })[0]!)
    await waitFor(() => expect(within(screen.getByRole('list', { name: '空间邀请' })).getByText('已撤销')).toBeTruthy())

    const people = screen.getByRole('list', { name: '空间成员' })
    expect(within(people).getByText('Bob')).toBeTruthy()
    fireEvent.change(within(people).getByLabelText('bob@example.com 的权限'), { target: { value: 'editor' } })
    await waitFor(() => expect(calls.some((call) => call.url === '/api/spaces/s1/members/u2' && call.init?.method === 'PATCH')).toBe(true))
    fireEvent.click(within(screen.getByRole('list', { name: '空间成员' })).getByRole('button', { name: '移除' }))
    expect(await screen.findByText('只有你自己。')).toBeTruthy()
  })

  it('admins still see registration invites', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json(admin)
      if (url === '/api/tokens') return json({ tokens: [] })
      if (url === '/api/spaces') return json({ spaces: [own] })
      if (url === '/api/spaces/s1/invites') return json({ enabled: true, limit: null, active: 0, remaining: null, invites: [] })
      if (url === '/api/spaces/s1/members') return json({ members: [] })
      if (url === '/api/me/invites') return json({ enabled: true, adminOnly: true, limit: null, used: 0, remaining: null, registration: 'invite', invites: [] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    expect(await screen.findByRole('heading', { name: '注册邀请' })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: '空间成员与邀请' })).toBeTruthy()
  })
})

describe('invite page', () => {
  it('a signed-in user joins the inviter’s space with one click', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json(user)
      if (url === '/api/invites/tok') return json({ spaceName: 'Private space', inviterName: 'Bob', role: 'viewer', canRegister: false, member: false, spaceId: 's2', expiresAt: Date.now() + 3_600_000, remainingUses: 1 })
      if (url === '/api/invites/tok/accept' && init?.method === 'POST') return json({ spaceId: 's2', role: 'viewer' })
      if (url === '/api/spaces') return json({ spaces: [own] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/invite/tok')
    expect(await screen.findByRole('heading', { name: '加入「Bob 的空间」' })).toBeTruthy()
    expect(screen.getByText(/只读：可以查看和复制/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加入空间' }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(sessionStorage.getItem('dropit-space')).toBe('s2')
  })

  it('tells a signed-out visitor that a user’s space invite needs an existing account', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/site') return json({ origin: window.location.origin, expected: null })
      if (url === '/api/auth/providers') return json({ providers: [], password: true, registration: 'invite', setupRequired: false })
      if (url === '/api/invites/tok') return json({ spaceName: 'Private space', inviterName: 'Bob', role: 'viewer', canRegister: false, expiresAt: Date.now() + 3_600_000, remainingUses: 1 })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/invite/tok')
    expect(await screen.findByText(/Bob 邀请你加入「Bob 的空间」/)).toBeTruthy()
    expect(screen.getByText(/不能用来注册新账号/)).toBeTruthy()
  })
})

describe('read-only members', () => {
  it('a viewer sees the shared space but no composer or edit controls', async () => {
    const shared = { id: 's2', name: 'Private space', ownerId: 'u9', expiresAt: null, role: 'viewer', ownerName: 'Bob' }
    sessionStorage.setItem('dropit-space', 's2')
    stubFetch((url) => {
      if (url === '/api/me') return json(user)
      if (url === '/api/spaces') return json({ spaces: [own, shared] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    expect(await screen.findByText(/Bob 邀请你只读查看这个空间/)).toBeTruthy()
    const socket = FakeSocket.instances.at(-1)
    expect(socket?.url).toContain('/api/spaces/s2/ws')
    socket?.emit({ type: 'snapshot', items: [item({ id: 'x', text: 'shared note' })], serverTime: Date.now(), expiresAt: null })
    expect(await screen.findByText('shared note')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect(screen.queryByLabelText('要发送的文本')).toBeNull()
    expect(document.querySelector('[data-read-only]')).toBeTruthy()
  })
})

describe('管理', () => {
  it('shows each user’s space-invite state and count', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json(admin)
      if (url === '/api/admin/users')
        return json({ users: [{ ...user.user, usedBytes: 0, quotaBytes: 1000, spaceInvitesEnabled: true, activeSpaceInvites: 2, providers: [], hasPassword: true }] })
      if (url === '/api/admin/invites') return json({ invites: [] })
      if (url === '/api/spaces') return json({ spaces: [own] })
      if (url === '/api/admin/limits') return json({ limits: {} })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/admin?tab=users')
    const cell = await waitFor(() => {
      const found = document.querySelector('[data-space-invites]')
      if (!found) throw new Error('no cell')
      return found as HTMLElement
    })
    expect(within(cell).getByText('已开启')).toBeTruthy()
    expect(within(cell).getByText('有效 2 个')).toBeTruthy()
  })

  it('临时房间 lists metadata only and closes, unlocks and deletes rooms', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const base = { owner: 'ada@example.com', anonymous: false, createdAt: Date.now() - 3_600_000, createdAtEstimated: false, lastActiveAt: Date.now() - 60_000, expiresAt: Date.now() + 3_600_000, itemCount: 3, bytes: 2048, closedAt: null }
    let rooms = [
      { ...base, id: 'r1', code: 'k7Rm2x', hasPin: true, closed: false, lockedFor: 120 },
      { ...base, id: 'r2', code: 'Zz9yy1', hasPin: false, closed: false, lockedFor: null },
    ]
    stubFetch((url, init) => {
      if (url === '/api/me') return json(admin)
      if (url === '/api/admin/users') return json({ users: [] })
      if (url === '/api/admin/invites') return json({ invites: [] })
      if (url === '/api/spaces') return json({ spaces: [own] })
      if (url === '/api/admin/limits') return json({ limits: {} })
      if (url === '/api/admin/rooms') return json({ rooms })
      if (url === '/api/admin/rooms/r1/unlock') {
        rooms = rooms.map((r) => (r.id === 'r1' ? { ...r, lockedFor: null } : r))
        return new Response(null, { status: 204 })
      }
      if (url === '/api/admin/rooms/r1/close') {
        rooms = rooms.map((r) => (r.id === 'r1' ? { ...r, closed: true } : r))
        return new Response(null, { status: 204 })
      }
      if (url === '/api/admin/rooms/r2' && init?.method === 'DELETE') {
        rooms = rooms.filter((r) => r.id !== 'r2')
        return new Response(null, { status: 204 })
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/admin?tab=rooms')
    const table = await screen.findByRole('table', { name: '临时房间' })
    expect(within(table).getByText('k7Rm2x')).toBeTruthy()
    expect(within(table).getAllByText('3 条 · 2.0 KB').length).toBe(2)
    // no way to open a room's contents from here
    expect(within(table).queryAllByRole('link')).toHaveLength(0)
    const r1 = () => document.querySelector('[data-admin-room="k7Rm2x"]') as HTMLElement
    fireEvent.click(within(r1()).getByRole('button', { name: '解除锁定' }))
    await waitFor(() => expect(within(r1()).queryByRole('button', { name: '解除锁定' })).toBeNull())
    fireEvent.click(within(r1()).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(within(r1()).getByText('已关闭')).toBeTruthy())
    expect(within(r1()).getByRole('button', { name: '重新开放' })).toBeTruthy()
    fireEvent.click(within(document.querySelector('[data-admin-room="Zz9yy1"]') as HTMLElement).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(document.querySelector('[data-admin-room="Zz9yy1"]')).toBeNull())
    expect(calls.every((call) => !/\/api\/spaces\/r\d/.test(call.url))).toBe(true)
  })
})

describe('房间码 popup', () => {
  it('the top bar opens a popup to enter a room code; /join still works', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json(user)
      if (url === '/api/tokens') return json({ tokens: [] })
      if (url === '/api/spaces') return json({ spaces: [own] })
      if (url === '/api/spaces/s1/invites') return json({ enabled: true, limit: 5, active: 0, remaining: 5, invites: [] })
      if (url === '/api/spaces/s1/members') return json({ members: [] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    await screen.findByRole('heading', { name: '空间成员与邀请' })
    fireEvent.click(screen.getAllByRole('button', { name: '房间码' })[0]!)
    const dialog = screen.getByRole('dialog', { name: '输入房间码' })
    expect(within(dialog).getByRole('textbox')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '输入房间码' })).toBeNull()
    expect(window.location.pathname).toBe('/settings')
  })
})
