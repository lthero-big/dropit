import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'
import { channelClock } from './lib/channel.ts'

// RHEA-190 auth step 3/4: room codes + PIN, links and personal invites in the web app.
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
}

const member = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'user' as const, disabled: 0, pending: 0, createdAt: 1 },
  usedBytes: 20,
  quotaBytes: 1000,
  maxFileBytes: 500,
  maxTextBytes: 1000,
  retentionMs: 86_400_000,
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
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
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  channelClock.delay = originalDelay
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ACCESS = `11111111-1111-4111-8111-111111111111.${'p'.repeat(43)}`
const LEGACY = 'L'.repeat(43)
const roomInfo = (extra: Record<string, unknown> = {}) => ({ id: 'room', name: 'Temporary room', expiresAt: Date.now() + 60_000, maxFileBytes: 100, quotaBytes: 200, code: 'k7Rm2x', hasPin: false, ...extra })

// RHEA-190 auth step 4: one code per room, the link is /r/<code>, optional PIN that also guards the link.
describe('room codes', () => {
  it('opens the own room at /r/<code>, and the owner changes the code (the link follows) and sets / removes the PIN', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
    let info = roomInfo()
    stubFetch((url, init) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/rooms' && init?.method === 'POST') return json({ token: ACCESS, expiresAt: Date.now() + 60_000, url: '/r/k7Rm2x', code: 'k7Rm2x', hasPin: false }, 201)
      if (url === `/api/rooms/${ACCESS}/code` && init?.method === 'PUT') {
        const sent = JSON.parse(String(init.body)) as { code?: string | null; pin?: string | null }
        info = roomInfo({ code: 'code' in sent ? sent.code ?? 'Rnd234' : info.code, hasPin: 'pin' in sent ? Boolean(sent.pin) : info.hasPin })
        return json({ code: info.code, hasPin: info.hasPin })
      }
      if (url.startsWith(`/api/rooms/${ACCESS}`)) return json(info)
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/login')
    fireEvent.click(await screen.findByRole('button', { name: '进入临时房间' }))
    expect(await screen.findByText('k7Rm2x')).toBeTruthy()
    expect(window.location.pathname).toBe('/r/k7Rm2x')
    // the link shown and copied is /r/<code>
    expect(screen.getByText(`${window.location.origin}/r/k7Rm2x`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制房间码' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('k7Rm2x'))
    fireEvent.click(screen.getByRole('button', { name: '房间码与 PIN' }))
    const codeForm = screen.getByRole('form', { name: '修改房间码' })
    fireEvent.change(within(codeForm).getByRole('textbox'), { target: { value: 'team-red' } })
    fireEvent.click(within(codeForm).getByRole('button', { name: '保存房间码' }))
    await waitFor(() => expect(window.location.pathname).toBe('/r/team-red'))
    expect(await screen.findByText('team-red')).toBeTruthy()
    // PIN on its own (the panel stays open after saving)
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy()
    const pinForm = screen.getByRole('form', { name: '设置 PIN' })
    fireEvent.change(pinForm.querySelector('input[type=password]')!, { target: { value: '4821' } })
    fireEvent.click(within(pinForm).getByRole('button', { name: '设置 PIN' }))
    expect(await screen.findByText('已设置 PIN')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除 PIN' }))
    await waitFor(() => expect(screen.queryByText('已设置 PIN')).toBeNull())
    const puts = calls.filter((call) => call.url === `/api/rooms/${ACCESS}/code`).map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>)
    expect(puts.map(({ deviceKey: _key, ...rest }) => rest)).toEqual([{ code: 'team-red' }, { pin: '4821' }, { pin: null }])
    expect(puts[0]!.deviceKey).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
  })

  it('enters a room by code at /join, asks for the PIN when needed and lands on /r/<code>', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/rooms/enter' && init?.method === 'POST') {
        const sent = JSON.parse(String(init.body)) as { code: string; pin?: string }
        if (sent.code === 'nope') return json({ error: { code: 'NOT_FOUND' } }, 404)
        if (!sent.pin) return json({ error: { code: 'PIN_REQUIRED' } }, 401)
        if (sent.pin !== '4821') return json({ error: { code: 'PIN_INVALID' } }, 403)
        return json({ token: ACCESS, expiresAt: Date.now() + 60_000, code: sent.code, hasPin: true })
      }
      if (url.startsWith(`/api/rooms/${ACCESS}`)) return json(roomInfo({ code: 'team-red', hasPin: true }))
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/join?code=nope')
    expect(((await screen.findByLabelText('房间码')) as HTMLInputElement).value).toBe('nope')
    fireEvent.click(screen.getByRole('button', { name: '进入房间' }))
    expect(await screen.findByText(/没有这个房间码/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('房间码'), { target: { value: 'team-red' } })
    fireEvent.click(screen.getByRole('button', { name: '进入房间' }))
    expect(await screen.findByLabelText('PIN')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '0000' } })
    fireEvent.click(screen.getByRole('button', { name: '进入房间' }))
    expect(await screen.findByText('PIN 不对。')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '4821' } })
    fireEvent.click(screen.getByRole('button', { name: '进入房间' }))
    expect(await screen.findByText('team-red')).toBeTruthy()
    expect(window.location.pathname).toBe('/r/team-red')
    // no second PIN prompt on the room page: the browser kept the access token for that code
    expect(calls.filter((call) => call.url === '/api/rooms/enter')).toHaveLength(4)
    // someone who entered by code is not the owner, and shares the same /r/<code> link
    expect(screen.queryByRole('button', { name: '房间码与 PIN' })).toBeNull()
    expect(screen.getByText(`${window.location.origin}/r/team-red`)).toBeTruthy()
  })

  it('opening /r/<code> of a room with a PIN asks for the PIN, then never again on this device', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/rooms/enter' && init?.method === 'POST') {
        const sent = JSON.parse(String(init.body)) as { code: string; pin?: string }
        if (!sent.pin) return json({ error: { code: 'PIN_REQUIRED' } }, 401)
        if (sent.pin === '9999') return json({ error: { code: 'RATE_LIMITED' } }, 429, { 'Retry-After': '30' })
        if (sent.pin !== '4821') return json({ error: { code: 'PIN_INVALID' } }, 403)
        return json({ token: ACCESS, expiresAt: Date.now() + 60_000, code: sent.code, hasPin: true })
      }
      if (url.startsWith(`/api/rooms/${ACCESS}`)) return json(roomInfo({ code: 'team-red', hasPin: true }))
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/r/team-red')
    expect(await screen.findByRole('heading', { name: '这个房间需要 PIN' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '0000' } })
    fireEvent.click(screen.getByRole('button', { name: '进入房间' }))
    expect(await screen.findByText('PIN 不对。')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '9999' } })
    fireEvent.click(screen.getByRole('button', { name: '进入房间' }))
    expect(await screen.findByText(/尝试次数太多/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '4821' } })
    fireEvent.click(screen.getByRole('button', { name: '进入房间' }))
    expect(await screen.findByRole('heading', { name: '临时房间' })).toBeTruthy()
    expect(window.location.pathname).toBe('/r/team-red')
    cleanup()
    calls.length = 0
    renderAt('/r/team-red')
    expect(await screen.findByRole('heading', { name: '临时房间' })).toBeTruthy()
    expect(calls.some((call) => call.url === '/api/rooms/enter')).toBe(false)
  })

  it('old /rooms/<token> links still open the room and are replaced by /r/<code>', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url.startsWith(`/api/rooms/${LEGACY}`)) return json(roomInfo())
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt(`/rooms/${LEGACY}`)
    expect(await screen.findByRole('heading', { name: '临时房间' })).toBeTruthy()
    await waitFor(() => expect(window.location.pathname).toBe('/r/k7Rm2x'))
    expect(calls.some((call) => call.url === '/api/rooms/enter')).toBe(false)
  })

  it('an unknown code shows the not-found page', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/r/nope')
    expect(await screen.findByRole('heading', { name: '房间不存在或已过期' })).toBeTruthy()
  })
})

describe('personal invites', () => {
  const view = (extra: Record<string, unknown> = {}) => ({
    enabled: true,
    limit: 2,
    used: 1,
    remaining: 1,
    registration: 'invite',
    invites: [{ id: 'i1', maxUses: 1, uses: 0, expiresAt: Date.now() + 3_600_000, revoked: 0, createdAt: 1, status: 'open' }],
    ...extra,
  })

  it('creates an invite once, shows its link a single time and enforces the visible limit', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
    let current = view()
    stubFetch((url, init) => {
      if (url === '/api/me') return json(member)
      if (url === '/api/tokens') return json({ tokens: [] })
      if (url === '/api/me/invites' && init?.method === 'POST') {
        current = view({ used: 2, remaining: 0, invites: [...current.invites, { id: 'i2', maxUses: 1, uses: 0, expiresAt: Date.now() + 7_200_000, revoked: 0, createdAt: 2, status: 'open' }] })
        return json({ id: 'i2', token: 'tok', url: 'http://dropit.lan/invite/tok', expiresAt: Date.now() + 7_200_000 }, 201)
      }
      if (url === '/api/me/invites/i1' && init?.method === 'DELETE') {
        current = view({ used: 1, remaining: 1, invites: [{ ...current.invites[0]!, status: 'revoked', revoked: 1 }] })
        return new Response(null, { status: 204 })
      }
      if (url === '/api/me/invites') return json(current)
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    expect(await screen.findByText(/已用 1 \/ 2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '生成邀请' }))
    expect(await screen.findByText('http://dropit.lan/invite/tok')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://dropit.lan/invite/tok'))
    await waitFor(() => expect((screen.getByRole('button', { name: '生成邀请' }) as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByText(/邀请名额已用完/)).toBeTruthy()
  })

  it('tells members when the admin switched invites off', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json(member)
      if (url === '/api/tokens') return json({ tokens: [] })
      if (url === '/api/me/invites') return json({ enabled: false, limit: 5, used: 0, remaining: 5, registration: 'invite', invites: [] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    expect(await screen.findByText(/管理员暂时关闭了普通用户的邀请功能/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '生成邀请' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('explains a personal invite on the invite page', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/site') return json({ origin: window.location.origin, expected: null })
      if (url === '/api/auth/providers') return json({ providers: [], password: true, registration: 'invite', setupRequired: false })
      if (url === '/api/invites/tok') return json({ personal: true, spaceName: null, inviterName: 'Ada', expiresAt: Date.now() + 3_600_000, remainingUses: 1 })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/invite/tok')
    expect(await screen.findByText(/Ada 邀请你注册 dropit/)).toBeTruthy()
  })
})

describe('admin invite controls', () => {
  it('saves the user-invite switch and default limit together with registration', async () => {
    const admin = { ...member, user: { ...member.user, role: 'admin' as const } }
    let invites = { enabled: true, defaultLimit: 5 }
    stubFetch((url, init) => {
      if (url === '/api/me') return json(admin)
      if (url === '/api/admin/registration' && init?.method === 'PUT') {
        invites = { ...invites, ...(JSON.parse(String(init.body)) as { userInvites: typeof invites }).userInvites }
        return json({ policy: 'invite', default: 'invite', updatedAt: null, updatedBy: null, userInvites: invites })
      }
      if (url === '/api/admin/registration') return json({ policy: 'invite', default: 'invite', updatedAt: null, updatedBy: null, userInvites: invites })
      if (url === '/api/admin/users') return json({ users: [] })
      if (url === '/api/admin/invites') return json({ invites: [] })
      if (url === '/api/spaces') return json({ spaces: [] })
      if (url === '/api/admin/limits') return json({ limits: {} })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/admin?tab=registration')
    const field = await screen.findByLabelText(/每人默认邀请上限/)
    fireEvent.change(field, { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '保存邀请设置' }))
    await waitFor(() => expect(invites.defaultLimit).toBe(8))
    const put = calls.filter((call) => call.url === '/api/admin/registration' && call.init?.method === 'PUT').pop()
    expect(JSON.parse(String(put?.init?.body))).toEqual({ userInvites: { enabled: true, defaultLimit: 8 } })
  })
})
