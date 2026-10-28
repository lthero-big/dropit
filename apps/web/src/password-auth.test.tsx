import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'

// RHEA-190 auth step 2: /setup, email + password sign-in, forced password change, admin reset and registration policy.
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
const space = { id: 's1', name: 'Private space', ownerId: 'u1', expiresAt: null }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
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
const bodyOf = (url: string) => JSON.parse(String(calls.findLast((call) => call.url === url)?.init?.body ?? 'null'))
function renderAt(path: string) {
  window.history.pushState({}, '', path)
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  )
}
const anon = () => json({ error: { code: 'UNAUTHENTICATED' } }, 401)

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('password auth', () => {
  it('sends a fresh install to /setup and creates the first admin with the log code', async () => {
    let created = false
    stubFetch((url) => {
      if (url === '/api/me') return created ? json(me) : anon()
      if (url === '/api/auth/providers') return json({ providers: [], password: true, registration: 'invite', setupRequired: !created })
      if (url === '/api/setup') {
        if (calls.at(-1)?.init?.method === 'POST') {
          created = true
          return json({ user, mustChangePassword: false }, 201)
        }
        return json({ required: !created, providers: [] })
      }
      if (url === '/api/spaces') return json({ spaces: [space] })
      if (url === '/api/site') return json({ origin: '', source: 'request' })
      return json({}, 200)
    })
    renderAt('/login')
    expect(await screen.findByText(/dropit setup code: XXXX-XXXX/)).toBeTruthy()
    expect(window.location.pathname).toBe('/setup')
    fireEvent.change(screen.getByLabelText('初始化码'), { target: { value: 'abcd-efgh' } })
    fireEvent.change(screen.getByLabelText('管理员邮箱'), { target: { value: 'ada@example.com' } })
    fireEvent.change(screen.getByLabelText('密码（至少 8 位）'), { target: { value: 'correct horse' } })
    fireEvent.change(screen.getByLabelText('再输入一次'), { target: { value: 'correct horse' } })
    fireEvent.click(screen.getByRole('button', { name: '创建管理员并登录' }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(bodyOf('/api/setup')).toEqual({ code: 'abcd-efgh', email: 'ada@example.com', password: 'correct horse' })
  })

  it('signs in with email + password, shows a uniform error, and forces a change of a temporary password', async () => {
    let signedIn = false
    let mustChange = true
    stubFetch((url, init) => {
      if (url === '/api/me') return signedIn ? json({ ...me, mustChangePassword: mustChange }) : anon()
      if (url === '/api/auth/providers') return json({ providers: ['github'], password: true, registration: 'invite', setupRequired: false })
      if (url === '/api/site') return json({ origin: '', source: 'request' })
      if (url === '/api/auth/password/login') {
        const body = JSON.parse(String(init?.body))
        if (body.password !== 'temp-pass-word') return json({ error: { code: 'INVALID_CREDENTIALS' } }, 401)
        signedIn = true
        return json({ user, mustChangePassword: true })
      }
      if (url === '/api/me/password') {
        mustChange = false
        return json({ hasPassword: true, mustChangePassword: false, revokedSessions: 0 })
      }
      if (url === '/api/spaces') return json({ spaces: [space] })
      return json({}, 200)
    })
    renderAt('/login')
    expect(await screen.findByRole('link', { name: '使用 GitHub 继续' })).toBeTruthy()
    expect(screen.queryByText('还没有账号？注册')).toBeNull()
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'ada@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: '用密码登录' }))
    expect(await screen.findByText('邮箱或密码不对')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'temp-pass-word' } })
    fireEvent.click(screen.getByRole('button', { name: '用密码登录' }))
    expect(await screen.findByText('请设置新密码')).toBeTruthy()
    expect(window.location.pathname).toBe('/change-password')
    fireEvent.change(screen.getByLabelText('临时密码'), { target: { value: 'temp-pass-word' } })
    fireEvent.change(screen.getByLabelText('新密码（至少 8 位）'), { target: { value: 'my own secret' } })
    fireEvent.change(screen.getByLabelText('再输入一次'), { target: { value: 'my own secret' } })
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(bodyOf('/api/me/password')).toEqual({ currentPassword: 'temp-pass-word', newPassword: 'my own secret' })
  })

  it('offers registration only when the policy is open', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return anon()
      if (url === '/api/auth/providers') return json({ providers: [], password: true, registration: 'open', setupRequired: false })
      if (url === '/api/site') return json({ origin: '', source: 'request' })
      if (url === '/api/auth/password/register') return json({ error: { code: 'EMAIL_IN_USE' } }, 409)
      return json({}, 200)
    })
    renderAt('/login')
    fireEvent.click(await screen.findByText('还没有账号？注册'))
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'new@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'long enough' } })
    fireEvent.click(screen.getByRole('button', { name: '注册并登录' }))
    expect(await screen.findByText('该邮箱已有账号')).toBeTruthy()
    expect(bodyOf('/api/auth/password/register')).toEqual({ email: 'new@example.com', password: 'long enough' })
  })

  it('lets an admin reset a password (shown once) and change the registration policy', async () => {
    const member = { ...user, id: 'u2', email: 'bob@example.com', name: 'Bob', role: 'user' as const, pending: 0, usedBytes: 0, quotaBytes: 1000, quotaOverride: null, hasPassword: false, providers: ['github'] }
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me)
      if (url === '/api/admin/users') return json({ users: [member] })
      if (url === '/api/admin/invites') return json({ invites: [] })
      if (url === '/api/spaces') return json({ spaces: [space] })
      if (url === '/api/admin/limits') return json({})
      if (url === '/api/admin/users/u2/password') return json({ temporaryPassword: 'abcd-efgh-jkmn', mustChangePassword: true })
      if (url === '/api/admin/registration')
        return json({ policy: init?.method === 'PUT' ? 'closed' : 'invite', default: 'invite', updatedAt: null, updatedBy: null })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/admin')
    fireEvent.click(await screen.findByRole('tab', { name: '用户' }))
    expect(await screen.findByText('GitHub')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(await screen.findByRole('button', { name: '重置密码' }))
    fireEvent.click(screen.getByRole('button', { name: '确认重置密码' }))
    expect(await screen.findByText('abcd-efgh-jkmn')).toBeTruthy()
    expect(screen.getByText(/只显示这一次/)).toBeTruthy()
    expect(calls.find((call) => call.url === '/api/admin/users/u2/password')?.init?.method).toBe('POST')

    fireEvent.click(screen.getByRole('tab', { name: '注册' }))
    fireEvent.click(await screen.findByLabelText(/关闭注册/))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(bodyOf('/api/admin/registration')).toEqual({ policy: 'closed' }))
  })
})
