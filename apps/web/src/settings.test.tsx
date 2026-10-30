import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'
import { isSafeReturn, normalizeUserCode, parseDeviceEntry } from './lib/machine.ts'

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

const me = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'user' as const, disabled: 0, pending: 0, createdAt: 1 },
  usedBytes: 20,
  quotaBytes: 1000,
  maxFileBytes: 500,
  maxTextBytes: 1000,
  retentionMs: 86_400_000,
}

const tokens = [
  {
    id: 't1',
    userId: 'u1',
    name: 'laptop',
    scopes: ['read', 'write'],
    createdAt: Date.now() - 3_600_000,
    lastUsedAt: null,
    expiresAt: null,
    revoked: 0,
  },
  {
    id: 't2',
    userId: 'u1',
    name: 'old',
    scopes: ['read'],
    createdAt: Date.now() - 86_400_000,
    lastUsedAt: Date.now() - 60_000,
    expiresAt: Date.now() - 1000,
    revoked: 1,
  },
]

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
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('device code helpers', () => {
  it('normalizes user codes and pasted verification links', () => {
    expect(normalizeUserCode(' abcd efgh ')).toBe('ABCD-EFGH')
    expect(parseDeviceEntry('https://dropit.example/device?user_code=abcd-efgh&verification_id=vid-1')).toEqual({
      code: 'ABCD-EFGH',
      verificationId: 'vid-1',
    })
    expect(parseDeviceEntry('abcd')).toEqual({ code: 'ABCD' })
  })

  it('only restores device, settings and admin paths', () => {
    expect(isSafeReturn('/device?user_code=ABCD-EFGH&verification_id=vid-1')).toBe(true)
    expect(isSafeReturn('/settings')).toBe(true)
    expect(isSafeReturn('https://evil.example/device')).toBe(false)
    expect(isSafeReturn('//evil.example/device')).toBe(false)
    expect(isSafeReturn('/admin')).toBe(true)
    expect(isSafeReturn('/r/abc')).toBe(false)
  })
})

describe('settings and device confirmation', () => {
  it('lists tokens and revokes one after confirmation', async () => {
    const live = tokens.map((token) => ({ ...token }))
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/tokens' && (!init?.method || init.method === 'GET')) return json({ tokens: live })
      if (url === '/api/tokens/t1' && init?.method === 'DELETE') {
        live[0] = { ...live[0]!, revoked: 1 }
        return new Response(null, { status: 204 })
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    expect(await screen.findByRole('heading', { name: '设置' })).toBeTruthy()
    expect(await screen.findByText('laptop')).toBeTruthy()
    expect(screen.getByText('读取、写入')).toBeTruthy()
    expect(screen.getByText('从未使用')).toBeTruthy()
    expect(screen.getByText('永不')).toBeTruthy()
    expect(screen.getByText('已撤销')).toBeTruthy()
    expect(document.body.textContent).not.toContain('tokenHash')
    fireEvent.click(screen.getAllByRole('button', { name: '撤销' })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '确认撤销' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/tokens/t1' && call.init?.method === 'DELETE')).toBe(true))
  })

  it('shows a created token once and drops it when the dialog closes', async () => {
    const secret = 'sekret-value-once'
    const created = { ...tokens[0], id: 't3', name: 'ci', scopes: ['read'] as ('read' | 'write')[], expiresAt: null, revoked: 0 }
    let listed = false
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/tokens' && init?.method === 'POST') {
        listed = true
        return json({ ...created, token: secret }, 201)
      }
      if (url === '/api/tokens') return json({ tokens: listed ? [created] : [] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    const writeText = vi.fn(async () => undefined)
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
    renderAt('/settings')
    fireEvent.click(await screen.findByRole('button', { name: '创建令牌' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'ci' } })
    fireEvent.click(screen.getByLabelText('写入'))
    fireEvent.change(screen.getByLabelText('有效期'), { target: { value: 'never' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByDisplayValue(secret)).toBeTruthy()
    const post = calls.find((call) => call.url === '/api/tokens' && call.init?.method === 'POST')
    expect(post?.init?.body).toBe(JSON.stringify({ name: 'ci', scopes: ['read'], expiresInDays: null }))
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(secret))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByDisplayValue(secret)).toBeNull())
    expect(document.body.textContent).not.toContain(secret)
    expect(await screen.findByText('ci')).toBeTruthy()
  })

  it('renames a token from the list', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/tokens/t1' && init?.method === 'PATCH') return new Response(null, { status: 204 })
      if (url === '/api/tokens') return json({ tokens })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    fireEvent.click(await screen.findByRole('button', { name: '改名' }))
    fireEvent.change(screen.getByLabelText('新名称'), { target: { value: 'desk' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(calls.some((call) => call.url === '/api/tokens/t1' && call.init?.body === JSON.stringify({ name: 'desk' }))).toBe(true),
    )
  })

  it('previews a device from the link and approves it', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url.startsWith('/api/auth/device?')) {
        return json({
          name: 'laptop',
          ipSummary: '192.168.1.0/24',
          scopes: ['read', 'write'],
          expiresAt: Date.now() + 600_000,
          tokenExpiresInDays: 90,
        })
      }
      if (url === '/api/auth/device/approve' && init?.method === 'POST') return new Response(null, { status: 204 })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/device?user_code=abcd-efgh&verification_id=vid-1')
    expect(await screen.findByText('laptop')).toBeTruthy()
    expect(screen.getByText('192.168.1.0/24')).toBeTruthy()
    expect(screen.getByText('90 天')).toBeTruthy()
    expect((screen.getByLabelText('用户码') as HTMLInputElement).value).toBe('ABCD-EFGH')
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/auth/device/approve')).toBe(true))
    const post = calls.find((call) => call.url === '/api/auth/device/approve')
    expect(post?.init?.body).toBe(JSON.stringify({ user_code: 'ABCD-EFGH', verification_id: 'vid-1' }))
    expect(await screen.findByText(/回到终端完成登录/)).toBeTruthy()
  })

  it('reports an unknown code without echoing the server body', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/tokens') return json({ tokens: [] })
      if (url === '/api/sessions') return json({ sessions: [] })
      if (url.startsWith('/api/auth/device?')) return json({ error: { code: 'NOT_FOUND', detail: '<script>' } }, 404)
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    const input = await screen.findByLabelText('用户码')
    fireEvent.change(input, { target: { value: 'ZZZZ-ZZZZ' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    expect((await screen.findByRole('alert')).textContent).toContain('代码无效、已过期或已处理')
    expect(document.body.textContent).not.toContain('<script>')
    const lookup = calls.find((call) => call.url.startsWith('/api/auth/device?'))
    expect(lookup?.url).toBe('/api/auth/device?user_code=ZZZZ-ZZZZ')
    expect(lookup?.url).not.toContain('verification_id')
  })

  it('denies a device from the settings page', async () => {
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/tokens') return json({ tokens: [] })
      if (url.startsWith('/api/auth/device?')) {
        return json({ name: 'cli', ipSummary: '10.0.0.0/24', scopes: ['read'], expiresAt: Date.now() + 60_000, tokenExpiresInDays: 30 })
      }
      if (url === '/api/auth/device/deny' && init?.method === 'POST') return new Response(null, { status: 204 })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    fireEvent.change(await screen.findByLabelText('用户码'), { target: { value: 'https://dropit.example/device?user_code=abcd-efgh&verification_id=vid-9' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(await screen.findByText('cli')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/auth/device/deny')).toBe(true))
    const post = calls.find((call) => call.url === '/api/auth/device/deny')
    expect(post?.init?.body).toBe(JSON.stringify({ user_code: 'ABCD-EFGH', verification_id: 'vid-9' }))
    expect(await screen.findByText(/已拒绝。这台设备拿不到令牌/)).toBeTruthy()
  })

  it('keeps the device link across login', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/device?user_code=ABCD-EFGH&verification_id=vid-1')
    // RHEA-190 m48: signed out goes straight to /login?next=…; the login page stores the return path.
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(new URLSearchParams(window.location.search).get('next')).toBe('/device?user_code=ABCD-EFGH&verification_id=vid-1')
    await waitFor(() => expect(sessionStorage.getItem('dropit-return')).toBe('/device?user_code=ABCD-EFGH&verification_id=vid-1'))
    cleanup()
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [] })
      if (url.startsWith('/api/auth/device?')) {
        return json({ name: 'laptop', ipSummary: '192.168.1.0/24', scopes: ['read'], expiresAt: Date.now() + 60_000, tokenExpiresInDays: null })
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await waitFor(() => expect(window.location.pathname).toBe('/device'))
    expect(window.location.search).toContain('user_code=ABCD-EFGH')
    expect(window.location.search).toContain('verification_id=vid-1')
    expect(sessionStorage.getItem('dropit-return')).toBeNull()
    expect(await screen.findByText('laptop')).toBeTruthy()
    expect(screen.getByText('永不')).toBeTruthy()
  })

  it('ignores an unsafe return path', async () => {
    sessionStorage.setItem('dropit-return', 'https://evil.example/device')
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    expect(await screen.findByText('没有可用空间。')).toBeTruthy()
    expect(window.location.pathname).toBe('/')
    expect(sessionStorage.getItem('dropit-return')).toBeNull()
  })
})
