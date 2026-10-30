import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'
import type { Invite } from './lib/types.ts'

// RHEA-192 m17: registration invites are admin-only and live in 管理 → 邀请; 设置 and 管理 → 注册 have no user-invite controls.
const user = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'user' as 'user' | 'admin', disabled: 0, pending: 0, createdAt: 1 },
  usedBytes: 20,
  quotaBytes: 1000,
  maxFileBytes: 500,
  maxTextBytes: 1000,
  retentionMs: 86_400_000,
}
const admin = { ...user, user: { ...user.user, role: 'admin' as 'user' | 'admin' } }
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
beforeEach(() => {
  calls.length = 0
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const settingsRoutes = (me: typeof user) => (url: string) => {
  if (url === '/api/me') return json(me)
  if (url === '/api/tokens') return json({ tokens: [] })
  if (url === '/api/spaces') return json({ spaces: [own] })
  if (url === '/api/spaces/s1/invites') return json({ enabled: true, limit: me.user.role === 'admin' ? null : 5, active: 0, remaining: me.user.role === 'admin' ? null : 5, invites: [] })
  if (url === '/api/spaces/s1/members') return json({ members: [] })
  return json({ error: { code: 'NOT_FOUND' } }, 404)
}

describe('设置 has no registration invites', () => {
  for (const [who, me] of [['an ordinary user', user], ['an admin', admin]] as const) {
    it(`for ${who}: no 注册邀请 / 用户邀请 section, no /api/me/invites call, space invites still there`, async () => {
      stubFetch(settingsRoutes(me))
      renderAt('/settings')
      expect(await screen.findByRole('heading', { name: '空间成员与邀请' })).toBeTruthy()
      for (const name of ['注册邀请', '用户邀请']) expect(screen.queryByRole('heading', { name })).toBeNull()
      expect(screen.queryByText(/允许普通用户邀请|每人默认邀请上限/)).toBeNull()
      expect(screen.getByRole('button', { name: '生成空间邀请' })).toBeTruthy()
      expect(calls.some((call) => call.url.startsWith('/api/me/invites'))).toBe(false)
    })
  }
})

describe('管理', () => {
  const adminRoutes = (state: { invites: Invite[] }) => (url: string, init?: RequestInit) => {
    if (url === '/api/me') return json(admin)
    if (url === '/api/admin/registration') return json({ policy: 'invite', default: 'invite', updatedAt: null, updatedBy: null })
    if (url === '/api/admin/users') return json({ users: [] })
    if (url === '/api/admin/invites' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { kind: string; maxUses: number; expiresInHours: number }
      const created = { id: `r${state.invites.length + 1}`, spaceId: 's1', maxUses: body.maxUses, uses: 0, expiresAt: Date.now() + body.expiresInHours * 3_600_000, revoked: 0, createdBy: 'u1', joinSpace: 0, kind: 'registration' as const, createdByEmail: 'ada@example.com', creatorAdmin: true }
      state.invites = [created, ...state.invites]
      return json({ ...created, token: 'tok', url: 'http://dropit.lan/invite/tok' }, 201)
    }
    if (url.startsWith('/api/admin/invites/') && init?.method === 'DELETE') {
      const id = url.split('/').pop()
      state.invites = state.invites.map((invite) => (invite.id === id ? { ...invite, revoked: 1 } : invite))
      return new Response(null, { status: 204 })
    }
    if (url === '/api/admin/invites') return json({ invites: state.invites })
    if (url === '/api/spaces') return json({ spaces: [own] })
    if (url === '/api/admin/limits') return json({ limits: {} })
    return json({ error: { code: 'NOT_FOUND' } }, 404)
  }

  it('注册 has no 用户邀请 switch or default cap and says registration invites are admin-only', async () => {
    stubFetch(adminRoutes({ invites: [] }))
    renderAt('/admin?tab=registration')
    expect(await screen.findByText(/注册邀请只有管理员能生成/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '用户邀请' })).toBeNull()
    expect(screen.queryByText(/允许普通用户邀请|每人默认邀请上限/)).toBeNull()
  })

  it('邀请: an admin creates a registration invite (no space), sees it listed, and revokes it', async () => {
    const legacy: Invite = { id: 'old', spaceId: 's9', maxUses: 1, uses: 0, expiresAt: Date.now() + 3_600_000, revoked: 0, createdBy: 'u7', joinSpace: 0, kind: 'registration', createdByEmail: 'bob@example.com', creatorAdmin: false }
    const state = { invites: [legacy] }
    stubFetch(adminRoutes(state))
    renderAt('/admin?tab=invites')
    const form = await screen.findByRole('form', { name: '生成邀请' })
    expect((within(form).getByLabelText('类型') as HTMLSelectElement).value).toBe('registration')
    expect(within(form).queryByLabelText('空间')).toBeNull()
    expect(await screen.findByText(/bob@example.com（普通用户创建，已不能注册）/)).toBeTruthy()
    fireEvent.change(within(form).getByLabelText('次数'), { target: { value: '3' } })
    fireEvent.click(within(form).getByRole('button', { name: '生成邀请' }))
    expect(await screen.findByText('http://dropit.lan/invite/tok')).toBeTruthy()
    const post = calls.find((call) => call.url === '/api/admin/invites' && call.init?.method === 'POST')
    expect(JSON.parse(String(post?.init?.body))).toEqual({ kind: 'registration', maxUses: 3, expiresInHours: 168 })
    await waitFor(() => expect(screen.getByText('注册邀请 · ada@example.com')).toBeTruthy())
    const row = screen.getByText('注册邀请 · ada@example.com').closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(within(screen.getByText('注册邀请 · ada@example.com').closest('tr')!).getByText('已撤销')).toBeTruthy())
    expect(calls.some((call) => call.url === '/api/admin/invites/r2' && call.init?.method === 'DELETE')).toBe(true)
  })

  it('邀请: switching to 空间邀请 asks for the space and sends it', async () => {
    stubFetch(adminRoutes({ invites: [] }))
    renderAt('/admin?tab=invites')
    const form = await screen.findByRole('form', { name: '生成邀请' })
    fireEvent.change(within(form).getByLabelText('类型'), { target: { value: 'space' } })
    expect((within(form).getByLabelText('空间') as HTMLSelectElement).value).toBe('s1')
    fireEvent.click(within(form).getByRole('button', { name: '生成邀请' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/admin/invites' && call.init?.method === 'POST')).toBe(true))
    const post = calls.find((call) => call.url === '/api/admin/invites' && call.init?.method === 'POST')
    expect(JSON.parse(String(post?.init?.body))).toEqual({ kind: 'space', spaceId: 's1', maxUses: 1, expiresInHours: 168 })
  })
})
