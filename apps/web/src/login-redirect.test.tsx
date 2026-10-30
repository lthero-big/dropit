import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'
import { isSafeReturn, loginPath, readNext } from './lib/machine.ts'

// RHEA-190 m48: /admin, /settings and /device redirect a signed-out visitor to /login?next=<path>
// instead of showing a "请先登录" page, and login brings them back to that page.
class FakeSocket {
  onopen = null
  onmessage = null
  onclose = null
  readyState = 0
  close() {}
  send() {}
}

const user = { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'admin' as const, disabled: 0, createdAt: 1 }
const me = { user, usedBytes: 0, quotaBytes: 1000, maxFileBytes: 500, maxTextBytes: 1000, retentionMs: 86_400_000, hasPassword: true, mustChangePassword: false }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const anon = () => json({ error: { code: 'UNAUTHENTICATED' } }, 401)

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return handler(url, init)
    }),
  )
}

/** Signed out until the password form posts; afterwards /api/me answers as the admin above. */
function stubSignIn() {
  let signedIn = false
  stubFetch((url) => {
    if (url === '/api/me') return signedIn ? json(me) : anon()
    if (url === '/api/auth/providers') return json({ providers: ['github'], password: true, registration: 'invite', setupRequired: false })
    if (url === '/api/site') return json({ origin: '', source: 'request' })
    if (url === '/api/auth/password/login') {
      signedIn = true
      return json({ user, mustChangePassword: false })
    }
    if (url === '/api/spaces') return json({ spaces: [] })
    if (url === '/api/tokens') return json({ tokens: [] })
    if (url === '/api/admin/users') return json({ users: [] })
    if (url === '/api/admin/invites') return json({ invites: [] })
    if (url.startsWith('/api/auth/device?')) {
      return json({ name: 'laptop', ipSummary: '192.168.1.0/24', scopes: ['read'], expiresAt: Date.now() + 60_000, tokenExpiresInDays: null })
    }
    return json({ error: { code: 'NOT_FOUND' } }, 404)
  })
}

function renderAt(path: string) {
  window.history.pushState({}, '', path)
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  )
}

async function signInWithPassword() {
  fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'ada@example.com' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct horse' } })
  fireEvent.click(screen.getByRole('button', { name: '用密码登录' }))
}

const nextParam = () => new URLSearchParams(window.location.search).get('next')

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('return path helpers', () => {
  it('builds /login?next= only for allowed same-origin pages', () => {
    expect(loginPath('/admin')).toBe('/login?next=%2Fadmin')
    expect(loginPath('/admin?tab=oauth')).toBe('/login?next=%2Fadmin%3Ftab%3Doauth')
    expect(loginPath('/device?user_code=ABCD-EFGH&verification_id=vid-1')).toBe('/login?next=%2Fdevice%3Fuser_code%3DABCD-EFGH%26verification_id%3Dvid-1')
    expect(loginPath('/settings#tokens')).toBe('/login?next=%2Fsettings%23tokens')
    expect(loginPath('/r/abc')).toBe('/login')
  })

  it('rejects open-redirect tricks in ?next=', () => {
    for (const bad of [
      'https://evil.example/admin',
      '//evil.example/admin',
      '/\\evil.example/admin',
      '\\\\evil.example/admin',
      '/\t/evil.example/admin',
      '/\n/evil.example/admin',
      'javascript:alert(1)',
      '/adminx',
      '/login',
      '',
    ]) {
      expect(isSafeReturn(bad), bad).toBe(false)
      expect(readNext(bad), bad).toBeNull()
    }
    expect(readNext(null)).toBeNull()
    expect(readNext('/admin?tab=users')).toBe('/admin?tab=users')
  })
})

describe('signed-out redirect to /login', () => {
  it('sends /admin to /login?next=/admin and returns there after a password login', async () => {
    stubSignIn()
    renderAt('/admin?tab=users')
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(nextParam()).toBe('/admin?tab=users')
    expect(screen.queryByText('请先登录')).toBeNull()
    await waitFor(() => expect(sessionStorage.getItem('dropit-return')).toBe('/admin?tab=users'))
    await signInWithPassword()
    await waitFor(() => expect(window.location.pathname).toBe('/admin'))
    expect(window.location.search).toBe('?tab=users')
    expect(sessionStorage.getItem('dropit-return')).toBeNull()
  })

  it('sends /settings to /login?next=/settings and returns there after a password login', async () => {
    stubSignIn()
    renderAt('/settings')
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(nextParam()).toBe('/settings')
    await signInWithPassword()
    await waitFor(() => expect(window.location.pathname).toBe('/settings'))
  })

  it('keeps the device code through the redirect and a password login', async () => {
    stubSignIn()
    renderAt('/device?user_code=ABCD-EFGH&verification_id=vid-1')
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(nextParam()).toBe('/device?user_code=ABCD-EFGH&verification_id=vid-1')
    await signInWithPassword()
    await waitFor(() => expect(window.location.pathname).toBe('/device'))
    expect(window.location.search).toBe('?user_code=ABCD-EFGH&verification_id=vid-1')
    expect(await screen.findByText('laptop')).toBeTruthy()
  })

  it('keeps the return path for OAuth, which lands on / after the provider', async () => {
    stubSignIn()
    renderAt('/admin?tab=oauth')
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    await waitFor(() => expect(sessionStorage.getItem('dropit-return')).toBe('/admin?tab=oauth'))
    cleanup()
    stubFetch((url) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/spaces') return json({ spaces: [] })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/')
    await waitFor(() => expect(window.location.pathname).toBe('/admin'))
    expect(window.location.search).toBe('?tab=oauth')
    expect(sessionStorage.getItem('dropit-return')).toBeNull()
  })

  it('ignores an unsafe ?next= and goes home after login', async () => {
    stubSignIn()
    renderAt('/login?next=%2F%2Fevil.example%2Fadmin')
    expect(await screen.findByLabelText('邮箱')).toBeTruthy()
    expect(sessionStorage.getItem('dropit-return')).toBeNull()
    await signInWithPassword()
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  })

  it('does not redirect when the server is unreachable', async () => {
    stubFetch(() => {
      throw new TypeError('network down')
    })
    renderAt('/admin')
    expect(await screen.findByRole('heading', { name: '无法连接' })).toBeTruthy()
    expect(window.location.pathname).toBe('/admin')
  })
})
