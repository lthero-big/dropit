import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

function limitField(value: number, max = 1_000_000_000) {
  return { value, default: value, overridden: false, min: 1, max }
}

const limits = {
  maxFileBytes: limitField(500, 1024 ** 3),
  maxTextBytes: limitField(1000, 1024 ** 2),
  maxItems: limitField(1000, 100_000),
  userQuotaBytes: limitField(1000, 100 * 1024 ** 3),
  retentionMs: limitField(86_400_000, 365 * 86_400_000),
  roomQuotaBytes: limitField(200, 100 * 1024 ** 3),
  roomMaxFileBytes: limitField(100, 1024 ** 3),
  roomRetentionMs: limitField(3_600_000, 86_400_000),
  rateWindowMs: limitField(60_000, 3_600_000),
  rateGeneral: limitField(240, 1_000_000),
  rateAuth: limitField(20, 1_000_000),
  rateInvite: limitField(10, 1_000_000),
  rateUpload: limitField(30, 1_000_000),
  rateRoom: limitField(10, 1_000_000),
  sessionMs: limitField(86_400_000, 365 * 86_400_000),
  uploadChunkBytes: limitField(8388608, 25165824),
  uploadChunkTimeoutMs: limitField(120000, 3600000),
  rateChunk: limitField(2000, 1000000),
  uploadChunksPerSession: limitField(3, 16),
  uploadChunksPerUser: limitField(6, 64),
  uploadChunksGlobal: limitField(16, 256),
  uploadSessionsPerUser: limitField(8, 1000),
  uploadSessionsGlobal: limitField(128, 10000),
}

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
    pinned: false,
    tags: [],
    ...partial,
    updatedAt: partial.updatedAt ?? partial.createdAt ?? 1_700_000_000_000,
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
  it('shows a fixed Chinese message for OAuth failures and ignores unknown codes', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/auth/providers') return json({ providers: ['github'] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/login?error=INVITATION_REQUIRED')
    expect((await screen.findByRole('alert')).textContent).toContain('需要邀请才能注册')
    expect(screen.queryByText('INVITATION_REQUIRED')).toBeNull()
    cleanup()
    renderAt('/login?error=%3Cscript%3Ealert(1)%3C/script%3E')
    await screen.findByRole('link', { name: '使用 GitHub 继续' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.body.textContent).not.toContain('<script>')
    expect(document.body.textContent).not.toContain('alert(1)')
  })

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
    fireEvent.click(screen.getByRole('button', { name: '进入临时房间' }))
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
          users: [
            { ...me.user, pending: 0, usedBytes: 20, quotaBytes: 1000, quotaOverride: null },
            { id: 'u2', email: 'be@example.com', name: 'Bea', role: 'user', disabled: 0, pending: 0, createdAt: 2, usedBytes: 5, quotaBytes: 1000, quotaOverride: null },
          ],
        })
      }
      if (url === '/api/admin/invites') return json({ invites: [] })
      if (url === '/api/admin/limits') return json(limits)
      if (url === '/api/admin/users/u2' && init?.method === 'PATCH') return new Response(null, { status: 204 })
      if (url === '/api/spaces/s1/items/text') return json({ error: { code: 'QUOTA_EXCEEDED' } }, 413, { 'Retry-After': '3' })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/admin')
    expect(await screen.findByRole('heading', { name: '管理' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '用户' }))
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

  it('pre-provisions a user, edits the role, and force-logs them out', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      if (url === '/api/admin/limits') return json(limits)
      if (url === '/api/admin/invites') return json({ invites: [] })
      if (url === '/api/admin/users' && init?.method === 'POST') return json({ id: 'u3' }, 201)
      if (url === '/api/admin/users') {
        return json({
          users: [
            { ...me.user, pending: 0, usedBytes: 20, quotaBytes: 1000, quotaOverride: null },
            { id: 'u2', email: 'be@example.com', name: 'Bea', role: 'user', disabled: 0, pending: 1, createdAt: 2, usedBytes: 5, quotaBytes: 5 * 1024 * 1024, quotaOverride: 5 * 1024 * 1024 },
          ],
        })
      }
      if (url === '/api/admin/users/u2/logout' && init?.method === 'POST') return new Response(null, { status: 204 })
      if (url === '/api/admin/users/u2' && init?.method === 'PATCH') return new Response(null, { status: 204 })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/admin')
    fireEvent.click(await screen.findByRole('tab', { name: '用户' }))
    expect(await screen.findByText('待首次登录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新建用户' }))
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'new@example.com' } })
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'New' } })
    fireEvent.change(screen.getByLabelText('角色'), { target: { value: 'admin' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '使用安装默认配额' }))
    fireEvent.change(screen.getByLabelText('配额（MB）'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '创建用户' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/admin/users' && call.init?.method === 'POST')).toBe(true))
    const created = calls.find((call) => call.url === '/api/admin/users' && call.init?.method === 'POST')
    expect(created?.init?.body).toBe(JSON.stringify({ email: 'new@example.com', name: 'New', role: 'admin', quotaBytes: 2 * 1024 * 1024 }))

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]!)
    fireEvent.click(screen.getByRole('button', { name: '强制下线' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/admin/users/u2/logout' && call.init?.method === 'POST')).toBe(true))
    fireEvent.change(screen.getByLabelText('角色'), { target: { value: 'admin' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/admin/users/u2' && call.init?.method === 'PATCH')).toBe(true))
    const saved = calls.find((call) => call.url === '/api/admin/users/u2' && call.init?.method === 'PATCH')
    expect(saved?.init?.body).toBe(JSON.stringify({ name: 'Bea', role: 'admin', disabled: false, quotaBytes: 5 * 1024 * 1024 }))
  })

  it('labels invite state and shows read-only limits', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      if (url === '/api/admin/limits') return json(limits)
      if (url.startsWith('/api/admin/limits/audit')) return json({ entries: [], nextCursor: null })
      if (url === '/api/admin/users') return json({ users: [] })
      if (url === '/api/admin/invites' && init?.method === 'POST') return json({ url: 'http://localhost/invite/once' }, 201)
      if (url === '/api/admin/invites') {
        return json({
          invites: [
            { id: 'i1', spaceId: 's1', maxUses: 5, uses: 5, expiresAt: Date.now() + 3_600_000, revoked: 0, createdBy: 'u1' },
            { id: 'i2', spaceId: 's1', maxUses: 5, uses: 0, expiresAt: Date.now() - 1000, revoked: 0, createdBy: 'u1' },
            { id: 'i3', spaceId: 's1', maxUses: 5, uses: 0, expiresAt: Date.now() + 3_600_000, revoked: 1, createdBy: 'u1' },
          ],
        })
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/admin')
    expect(await screen.findByText('已用尽')).toBeTruthy()
    expect(screen.getAllByText('已过期').length).toBeGreaterThan(0)
    expect(screen.getByText('已撤销')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '生成邀请' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/admin/invites' && call.init?.method === 'POST')).toBe(true))
    const post = calls.find((call) => call.url === '/api/admin/invites' && call.init?.method === 'POST')
    expect(post?.init?.body).toBe(JSON.stringify({ spaceId: 's1', maxUses: 5, expiresInHours: 168 }))
    fireEvent.click(screen.getByRole('tab', { name: '限制' }))
    expect(await screen.findByText(/覆盖值保存在数据库，重启后保留；只读项仍需改环境变量/)).toBeTruthy()
    expect(screen.queryByText(/这些限制来自环境变量/)).toBeNull()
    expect(screen.getByLabelText('单文件上限')).toBeTruthy()
  })

  it('edits the author text in place and applies item.updated', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      if (url === '/api/spaces/s1/items/mine' && init?.method === 'PATCH') {
        return json({ item: item({ id: 'mine', text: 'new note', updatedAt: 1_700_000_000_000 + 5_000, size: 8 }) })
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await screen.findByRole('button', { name: '发送' })
    const socket = FakeSocket.instances.at(-1)
    socket?.emit({
      type: 'snapshot',
      items: [
        item({ id: 'mine', text: 'old note' }),
        item({ id: 'theirs', text: 'their note', userId: 'u2' }),
        item({ id: 'file', text: null, kind: 'file', filename: 'a.bin' }),
      ],
      serverTime: Date.now(),
      expiresAt: null,
    })
    expect(await screen.findByText('old note')).toBeTruthy()
    expect(screen.queryByText('已编辑')).toBeNull()
    const mine = screen.getByText('old note').closest('li')
    const theirs = screen.getByText('their note').closest('li')
    const file = screen.getByText('a.bin').closest('li')
    if (!mine || !theirs || !file) throw new Error('missing clip')
    for (const row of [mine, theirs, file]) fireEvent.click(within(row).getByRole('button', { name: '更多' }))
    expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(1)
    fireEvent.click(within(mine).getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('编辑文本'), { target: { value: 'new note' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('new note')).toBeTruthy()
    expect(screen.getByText('已编辑')).toBeTruthy()
    const patch = calls.find((call) => call.url === '/api/spaces/s1/items/mine')
    expect(patch?.init?.method).toBe('PATCH')
    expect(patch?.init?.body).toBe(JSON.stringify({ text: 'new note' }))
    socket?.emit({
      type: 'item.updated',
      item: item({ id: 'mine', text: 'remote note', updatedAt: 1_700_000_000_000 + 9_000 }),
    })
    expect(await screen.findByText('remote note')).toBeTruthy()
    expect(screen.queryByText('new note')).toBeNull()
  })

  it('lets a room capability holder edit text', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url.startsWith('/api/rooms/room-token')) return json({ id: 'room', name: 'Temporary room', expiresAt: Date.now() + 60_000, maxFileBytes: 100, quotaBytes: 200 })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/rooms/room-token')
    await screen.findByRole('heading', { name: '临时房间' })
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [item({ id: 'room-text', text: 'room note', spaceId: 'room', userId: null })],
      serverTime: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    fireEvent.click(await screen.findByRole('button', { name: '更多' }))
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy()
  })

  it('keeps copy and retract as icon buttons and nests the rest (share included)', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await screen.findByRole('button', { name: '发送' })
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [
        item({ id: 'note', text: 'keep me' }),
        item({ id: 'file', text: null, kind: 'file', filename: 'a.bin' }),
      ],
      serverTime: Date.now(),
      expiresAt: null,
    })
    const note = (await screen.findByText('keep me')).closest('li')
    const file = screen.getByText('a.bin').closest('li')
    if (!note || !file) throw new Error('missing clip')
    const copy = within(note).getByRole('button', { name: '复制' })
    const retract = within(note).getByRole('button', { name: '撤回' })
    // RHEA-190 step 8: 分享 lives in 更多
    expect(within(note).queryByRole('button', { name: '分享' })).toBeNull()
    for (const button of [copy, retract]) {
      expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'))
      expect(button.style.minWidth).toBe('40px')
      expect(button.style.minHeight).toBe('40px')
    }
    expect(within(note).queryByRole('button', { name: '编辑' })).toBeNull()
    expect(within(note).queryByRole('button', { name: '置顶' })).toBeNull()
    fireEvent.click(within(note).getByRole('button', { name: '更多' }))
    expect(within(note).getByRole('button', { name: '更多' }).getAttribute('aria-expanded')).toBe('true')
    expect(within(note).getByRole('button', { name: '编辑' }).style.minHeight).toBe('40px')
    expect(within(note).getByRole('button', { name: '置顶' })).toBeTruthy()
    expect(within(note).getByRole('button', { name: '分享' }).style.minHeight).toBe('40px')
    expect(within(note).queryByRole('button', { name: '标签' })).toBeNull()
    fireEvent.click(retract)
    expect(within(note).getByRole('button', { name: '确认撤回' }).getAttribute('title')).toBe('确认撤回')
    expect(within(note).getByRole('button', { name: '确认撤回' }).textContent).toContain('确认')
    const fileCopy = within(file).getByRole('button', { name: '复制' })
    expect(fileCopy.getAttribute('title')).toBe('复制')
    expect(fileCopy.style.minWidth).toBe('40px')
    fireEvent.click(within(file).getByRole('button', { name: '更多' }))
    expect(within(file).getByRole('link', { name: '下载' }).getAttribute('href')).toBe('/api/spaces/s1/items/file/download')
  })

  it('pins clips, hides tags, and applies a remote label update', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await screen.findByRole('button', { name: '发送' })
    const socket = FakeSocket.instances.at(-1)
    socket?.emit({
      type: 'snapshot',
      items: [
        item({ id: 'new', text: 'newer note', createdAt: 200, tags: ['草稿'] }),
        item({ id: 'old', text: 'older note', createdAt: 100, pinned: true, tags: ['上线'] }),
      ],
      serverTime: Date.now(),
      expiresAt: null,
    })
    expect(await screen.findByText('older note')).toBeTruthy()
    const body = document.body.textContent ?? ''
    expect(body.indexOf('older note')).toBeLessThan(body.indexOf('newer note'))
    // RHEA-190 step 8: tags stay in the data but the board never shows, filters or edits them.
    const chip = screen.getByText('older note').closest('[data-pin-chip]')
    if (!(chip instanceof HTMLElement)) throw new Error('missing pin chip')
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(within(chip).getByRole('button', { name: '取消置顶' })).toBeTruthy()
    expect(within(chip).queryByRole('button', { name: '标签' })).toBeNull()
    expect(screen.queryByRole('button', { name: '#上线' })).toBeNull()
    expect(screen.queryByRole('button', { name: '#草稿' })).toBeNull()
    expect(screen.queryByText(/上线|草稿/)).toBeNull()
    expect(screen.queryByRole('button', { name: /清除标签/ })).toBeNull()
    expect(screen.queryByLabelText('新标签')).toBeNull()
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '草稿' } })
    expect(screen.queryByText('newer note')).toBeNull()
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'newer' } })
    expect(screen.getByText('newer note')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '' } })
    socket?.emit({
      type: 'item.updated',
      item: item({ id: 'new', text: 'newer note', createdAt: 200, pinned: true, tags: ['上线'] }),
    })
    // Pinned clips live in the 置顶栏 above the board (RHEA-190 step 4), newest pin first by board order.
    await waitFor(() => {
      const bar = screen.getByRole('region', { name: '置顶栏' })
      expect(within(bar).getByText('newer note')).toBeTruthy()
      expect(within(bar).getByText('older note')).toBeTruthy()
    })
    expect(screen.getAllByText('置顶')).toHaveLength(1)
    expect(calls.some((call) => call.url.endsWith('/labels'))).toBe(false)
  })

  it('filters clipboard text on the current snapshot', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await screen.findByRole('button', { name: '发送' })
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [item({ id: 'a', text: 'alpha secret' }), item({ id: 'b', text: 'beta' })],
      serverTime: Date.now(),
      expiresAt: null,
    })
    expect(await screen.findByText('alpha secret')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'alpha' } })
    expect(screen.getByText('alpha secret')).toBeTruthy()
    expect(screen.queryByText('beta')).toBeNull()
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: 'missing' } })
    expect(screen.getByText('没有匹配的内容。')).toBeTruthy()
  })

  it('opens the command palette with Ctrl+K and jumps to a clip', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await screen.findByRole('button', { name: '发送' })
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [item({ id: 'a', text: 'alpha secret' }), item({ id: 'b', text: 'beta note', tags: ['上线'] })],
      serverTime: Date.now(),
      expiresAt: null,
    })
    expect(await screen.findByText('alpha secret')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.getByRole('dialog', { name: '命令面板' })).toBeTruthy()
    // RHEA-190 step 8: hidden tags no longer match; text still does
    fireEvent.change(screen.getByLabelText('搜索内容'), { target: { value: '上线' } })
    expect(screen.queryByRole('button', { name: 'beta note' })).toBeNull()
    fireEvent.change(screen.getByLabelText('搜索内容'), { target: { value: 'beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'beta note' }))
    expect(document.activeElement?.id).toBe('clip-b')
    expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull()
    FakeSocket.instances.at(-1)?.emit({ type: 'presence', devices: 2 })
    expect(await screen.findByRole('status', { name: '2 台设备在线' })).toBeTruthy()
  })

  it('opens another temporary room from the room page', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
    let rooms = 0
    const keys: string[] = []
    stubFetch((url, init) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/rooms' && init?.method === 'POST') {
        keys.push((JSON.parse(String(init.body)) as { deviceKey: string }).deviceKey)
        rooms += 1
        return json({ token: `room-${rooms}`, expiresAt: Date.now() + 60_000, url: `/rooms/room-${rooms}` }, 201)
      }
      if (url.startsWith('/api/rooms/')) return json({ id: 'room', name: 'Temporary room', expiresAt: Date.now() + 60_000, maxFileBytes: 100, quotaBytes: 200 })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/rooms/existing')
    expect(await screen.findByRole('heading', { name: '临时房间' })).toBeTruthy()
    expect(screen.queryByRole('img', { name: '房间二维码' })).toBeNull()
    const qrButton = screen.getByRole('button', { name: '二维码' })
    expect(qrButton.getAttribute('aria-expanded')).toBe('false')
    expect(qrButton.getAttribute('title')).toBe('二维码')
    fireEvent.click(qrButton)
    const qr = await screen.findByRole('img', { name: '房间二维码' })
    expect(qr.getAttribute('src')).toMatch(/^data:image\/png/)
    expect(qr.getAttribute('width')).toBe('96')
    const popover = screen.getByRole('dialog', { name: '房间二维码' })
    fireEvent.click(within(popover).getByRole('button', { name: '放大' }))
    expect(screen.getByRole('img', { name: '房间二维码' }).getAttribute('width')).toBe('192')
    fireEvent.click(within(popover).getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/rooms\/existing$/)))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '房间二维码' })).toBeNull()
    expect(screen.queryByRole('button', { name: '新建房间' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '我的临时房间' }))
    expect(await screen.findByText(/\/rooms\/room-1/)).toBeTruthy()
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // inside its own room the browser no longer offers to open it
    await waitFor(() => expect(screen.queryByRole('button', { name: '我的临时房间' })).toBeNull())
  })

  it('creates a share link and renders the public page as text', async () => {
    const payload = '<script>alert(1)</script>'
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      if (url === '/api/spaces/s1/items/a/shares' && init?.method === 'POST') {
        return json({
          id: 'sh1',
          itemId: 'a',
          expiresAt: null,
          maxViews: 1,
          views: 0,
          revoked: 0,
          createdAt: 1,
          token: 'tok',
          url: 'http://localhost/s/tok',
        }, 201)
      }
      if (url === '/api/spaces/s1/items/a/shares') return json({ shares: [] })
      if (url === '/api/spaces/s1/shares/sh1' && init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (url === '/api/s/tok') return json({
        item: { kind: 'text', text: payload, filename: null, mime: null, size: 4, hasThumbnail: false, createdAt: 1, expiresAt: 9 },
        linkExpiresAt: null,
        views: 1,
        maxViews: 1,
        access: 'ticket',
      })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await screen.findByRole('button', { name: '发送' })
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [item({ id: 'a', text: 'alpha' })],
      serverTime: Date.now(),
      expiresAt: null,
    })
    const card = (await screen.findByText('alpha')).closest('li')
    if (!card) throw new Error('missing clip')
    const rowHeight = card.getBoundingClientRect().height
    fireEvent.click(within(card).getByRole('button', { name: '更多' }))
    fireEvent.click(within(card).getByRole('button', { name: '分享' }))
    // RHEA-190 step 8: share options open in a popover outside the card, so the row never grows
    const panel = await screen.findByRole('dialog', { name: '分享链接' })
    expect(card.contains(panel)).toBe(false)
    expect(panel.parentElement).toBe(document.body)
    expect(card.getBoundingClientRect().height).toBe(rowHeight)
    expect(await within(panel).findByText('还没有分享链接。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '生成链接' }))
    expect(await within(panel).findByLabelText('分享链接')).toHaveProperty('value', 'http://localhost/s/tok')
    const post = calls.find((call) => call.url === '/api/spaces/s1/items/a/shares' && call.init?.method === 'POST')
    expect(post?.init?.body).toBe(JSON.stringify({ expiresIn: '1d', maxViews: 1 }))
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/spaces/s1/shares/sh1' && call.init?.method === 'DELETE')).toBe(true))

    cleanup()
    renderAt('/s/tok')
    expect(await screen.findByText(payload)).toBeTruthy()
    expect(screen.getByRole('heading', { name: '分享的内容' })).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('renders markdown as elements and previews images and sniffed media', async () => {
    const source = '## 清单\n\n- [x] 完成\n\n<script>alert(1)</script>\n\n[手册](https://example.com/run) [坏](javascript:alert(1))'
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await screen.findByRole('button', { name: '发送' })
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [
        item({ id: 'md', text: source }),
        item({ id: 'pic', text: null, kind: 'file', filename: 'shot.png', mime: 'image/png', hasThumbnail: true, size: 12 }),
        item({ id: 'vid', text: null, kind: 'file', filename: 'clip.mp4', mime: 'application/octet-stream', hasThumbnail: false, size: 20 }),
        item({ id: 'page', text: null, kind: 'file', filename: 'page.html', mime: 'text/html', hasThumbnail: false, size: 30 }),
      ],
      serverTime: Date.now(),
      expiresAt: null,
    })
    expect(await screen.findByText(/<script>alert\(1\)<\/script>/)).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '渲染' }))
    expect(screen.getByRole('heading', { name: '清单' })).toBeTruthy()
    const manual = screen.getByRole('link', { name: '手册' })
    expect(manual.getAttribute('href')).toBe('https://example.com/run')
    expect(manual.textContent).toBe('手册')
    expect(manual.getAttribute('target')).toBe('_blank')
    expect(manual.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(manual.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(screen.queryByRole('link', { name: '坏' })).toBeNull()
    expect(document.body.innerHTML).not.toContain('href="javascript:')
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/api/spaces/s1/items/pic/thumbnail')
    expect(document.querySelector('video')?.getAttribute('src')).toBe('/api/spaces/s1/items/vid/media')
    expect(document.querySelectorAll('video')).toHaveLength(1)
    expect(screen.getByText('page.html')).toBeTruthy()
  })

  it('autolinks item text on the board, in a room, and on a share page', async () => {
    const source = '打开 https://example.com/docs。 <script>alert(1)</script>'
    const writeText = vi.fn(async () => undefined)
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [space] })
      if (url === '/api/s/tok') {
        return json({
          item: { kind: 'text', text: source, filename: null, mime: null, size: source.length, hasThumbnail: false, createdAt: 1, expiresAt: 9 },
          linkExpiresAt: null,
          views: 1,
          maxViews: null,
          access: 'ticket',
        })
      }
      if (url.startsWith('/api/rooms/room-token')) return json({ id: 'room', name: 'Temporary room', expiresAt: Date.now() + 60_000, maxFileBytes: 100, quotaBytes: 200 })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await screen.findByRole('button', { name: '发送' })
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [item({ id: 'linky', text: source })],
      serverTime: Date.now(),
      expiresAt: null,
    })
    const boardLink = await screen.findByRole('link', { name: 'https://example.com/docs' })
    expect(boardLink.getAttribute('href')).toBe('https://example.com/docs')
    expect(boardLink.textContent).toBe('https://example.com/docs')
    expect(document.querySelector('script')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source))
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect((screen.getByLabelText('编辑文本') as HTMLTextAreaElement).value).toBe(source)

    cleanup()
    renderAt('/rooms/room-token')
    await screen.findByRole('heading', { name: '临时房间' })
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [item({ id: 'room-link', text: source, spaceId: 'room', userId: null })],
      serverTime: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    expect((await screen.findByRole('link', { name: 'https://example.com/docs' })).getAttribute('href')).toBe('https://example.com/docs')

    cleanup()
    renderAt('/s/tok')
    expect((await screen.findByRole('link', { name: 'https://example.com/docs' })).getAttribute('href')).toBe('https://example.com/docs')
    expect(document.querySelector('script')).toBeNull()
    expect(document.body.textContent).toContain(source)
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
