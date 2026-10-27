import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'

// RHEA-190 m11: 登录方式 (bind / unbind) and admin OAuth 配置 in 设置.
class FakeSocket {
  static instances: FakeSocket[] = []
  onopen = null
  onmessage = null
  onclose = null
  readyState = 0
  constructor() {
    FakeSocket.instances.push(this)
  }
  close() {}
  send() {}
}

const user = { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'user' as const, disabled: 0, pending: 0, createdAt: 1 }
const me = (role: 'user' | 'admin') => ({ user: { ...user, role }, usedBytes: 0, quotaBytes: 1000, maxFileBytes: 500, maxTextBytes: 1000, retentionMs: 86_400_000 })
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
function renderAt(path: string) {
  window.history.pushState({}, '', path)
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  )
}
const provider = (name: 'github' | 'google', patch: Record<string, unknown> = {}) => ({
  provider: name,
  label: name === 'github' ? 'GitHub' : 'Google',
  consoleUrl: name === 'github' ? 'https://github.com/settings/developers' : 'https://console.cloud.google.com/apis/credentials',
  docsUrl: 'https://docs.example',
  callbackUrl: `https://dropit.example/api/auth/${name}/callback`,
  homepageUrl: 'https://dropit.example',
  source: 'none',
  enabled: false,
  active: false,
  clientId: '',
  secretSet: false,
  secretHint: null,
  envConfigured: false,
  updatedAt: null,
  check: null as { at: number; ok: boolean; code: string } | null,
  ...patch,
})

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('settings: login methods', () => {
  it('lists bound providers, binds through a redirect and unbinds after confirmation', async () => {
    let identities = [
      { provider: 'github', email: 'ada@example.com', linkedAt: 1 },
      { provider: 'google', email: 'ada@gmail.com', linkedAt: 2 },
    ]
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me('user'))
      if (url === '/api/tokens') return json({ tokens: [] })
      if (url === '/api/me/identities') return json({ identities, available: ['github', 'google'] })
      if (url === '/api/me/identities/google' && init?.method === 'DELETE') {
        identities = identities.filter((identity) => identity.provider !== 'google')
        return new Response(null, { status: 204 })
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    const section = await screen.findByRole('region', { name: '登录方式' })
    expect(await within(section).findByText(/ada@gmail\.com/)).toBeTruthy()
    // Users never see the admin OAuth section.
    expect(screen.queryByRole('region', { name: 'OAuth 配置（管理员）' })).toBeNull()
    expect(calls.some((call) => call.url === '/api/admin/oauth')).toBe(false)
    const google = section.querySelector('[data-provider="google"]') as HTMLElement
    fireEvent.click(within(google).getByRole('button', { name: '解绑' }))
    fireEvent.click(await within(google).findByRole('button', { name: '确认解绑' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/me/identities/google' && call.init?.method === 'DELETE')).toBe(true))
    const bind = await within(section).findByRole('link', { name: '绑定 Google' })
    expect(bind.getAttribute('href')).toBe('/api/auth/google?link=1')
    expect(within(section).getByText('唯一的登录方式，不能解绑')).toBeTruthy()
  })
})

describe('settings: OAuth configuration (admin)', () => {
  it('shows the callback URL to copy, saves id + secret without echoing it and verifies', async () => {
    let google = provider('google')
    const github = provider('github', { source: 'env', enabled: true, active: true, clientId: 'env-id', secretSet: true, secretHint: '••••••••cdef', envConfigured: true })
    const view = () => ({ origin: 'https://dropit.example', providers: [github, google] })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    stubFetch((url, init) => {
      if (url === '/api/me') return json(me('admin'))
      if (url === '/api/tokens') return json({ tokens: [] })
      if (url === '/api/me/identities') return json({ identities: [{ provider: 'github', email: 'ada@example.com', linkedAt: 1 }], available: ['github'] })
      if (url === '/api/admin/oauth') return json(view())
      if (url === '/api/admin/oauth/google' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { clientId: string; clientSecret?: string }
        google = provider('google', { source: 'database', enabled: true, active: true, clientId: body.clientId, secretSet: true, secretHint: '••••••••3456' })
        return json(view())
      }
      if (url === '/api/admin/oauth/google/verify') {
        google = { ...google, check: { at: Date.now(), ok: true, code: 'CREDENTIALS_OK' } }
        return json({ ok: true, code: 'CREDENTIALS_OK', checkedAt: Date.now(), ...view() })
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/settings')
    const section = await screen.findByRole('region', { name: 'OAuth 配置（管理员）' })
    const card = () => section.querySelector('[data-provider="google"]') as HTMLElement
    expect(within(card()).getByRole('status').textContent).toBe('未配置')
    const callback = within(card()).getByLabelText('回调地址（Callback / Redirect URI）') as HTMLInputElement
    expect(callback.value).toBe('https://dropit.example/api/auth/google/callback')
    fireEvent.click(within(card()).getAllByRole('button', { name: '复制' })[0]!)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://dropit.example/api/auth/google/callback'))
    // GitHub from the environment shows a masked secret only.
    const githubCard = section.querySelector('[data-provider="github"]') as HTMLElement
    expect((within(githubCard).getByLabelText('Client Secret') as HTMLInputElement).placeholder).toContain('••••••••cdef')
    expect(within(githubCard).getByRole('status').textContent).toContain('环境变量')

    fireEvent.change(within(card()).getByLabelText('Client ID'), { target: { value: 'g-id.apps.googleusercontent.com' } })
    fireEvent.change(within(card()).getByLabelText('Client Secret'), { target: { value: 'GOCSPX-secret-123456' } })
    fireEvent.click(within(card()).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(card()).getByRole('status').textContent).toBe('已保存，尚未验证'))
    const put = calls.find((call) => call.url === '/api/admin/oauth/google' && call.init?.method === 'PUT')!
    expect(JSON.parse(String(put.init!.body))).toEqual({ clientId: 'g-id.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret-123456', enabled: true })
    expect((within(card()).getByLabelText('Client Secret') as HTMLInputElement).value).toBe('')
    expect(document.body.textContent).not.toContain('GOCSPX-secret-123456')

    fireEvent.click(within(card()).getByRole('button', { name: '验证' }))
    await waitFor(() => expect(within(card()).getByRole('status').textContent).toContain('Client ID / Secret 有效'))
  })
})
