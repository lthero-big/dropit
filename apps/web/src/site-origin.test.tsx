import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'
import { ApiError, errorText } from './lib/api.ts'
import { normalizeOrigin, originMismatch } from './lib/site.ts'

// RHEA-190 auth step 1: 管理 → 站点地址 (APP_ORIGIN) and the origin-mismatch hint.
class FakeSocket {
  onopen = null
  onmessage = null
  onclose = null
  readyState = 0
  close() {}
  send() {}
}
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
const admin = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'admin' as const, disabled: 0, pending: 0, createdAt: 1 },
  usedBytes: 0, quotaBytes: 1000, maxFileBytes: 500, maxTextBytes: 1000, retentionMs: 86_400_000,
}
const settings = (patch: Record<string, unknown> = {}) => {
  const effective = (patch.effectiveOrigin as string | undefined) ?? window.location.origin
  return {
    origin: null, source: 'request', adminOrigin: null, envOrigin: null, requestOrigin: window.location.origin,
    effectiveOrigin: effective, production: true, secureCookies: false, trustProxy: false, updatedAt: null, updatedBy: null,
    callbacks: [
      { provider: 'github', label: 'GitHub', url: `${effective}/api/auth/github/callback` },
      { provider: 'google', label: 'Google', url: `${effective}/api/auth/google/callback` },
    ],
    ...patch,
  }
}

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('site address helpers', () => {
  it('normalizes like the server and explains mismatches', () => {
    expect(normalizeOrigin('https://Dropit.Example.com/')).toBe('https://dropit.example.com')
    expect(normalizeOrigin('http://1.2.3.4:8787')).toBe('http://1.2.3.4:8787')
    for (const bad of ['dropit.example', 'https://dropit.example/app', 'ftp://x.example', 'https://a@b.example', 'https://x.example?a']) expect(normalizeOrigin(bad)).toBeNull()
    expect(originMismatch({ origin: 'https://a.example', source: 'env', requestOrigin: 'http://b.example' }, 'https://a.example')).toBeNull()
    const env = originMismatch({ origin: 'https://a.example', source: 'env', requestOrigin: 'http://b.example:8787' }, 'http://b.example:8787')!
    expect(env).toContain('改为 http://b.example:8787')
    expect(env).toContain('.env 里的 APP_ORIGIN')
    expect(originMismatch({ origin: 'https://a.example', source: 'admin', requestOrigin: null }, 'http://b.example')).toContain('RESET_APP_ORIGIN=1')
    expect(originMismatch({ origin: null, source: 'request', requestOrigin: 'http://b.example' }, 'http://b.example')).toBeNull()
    expect(originMismatch({ origin: null, source: 'request', requestOrigin: 'http://b.example' }, 'https://b.example')).toContain('TRUST_PROXY')
    expect(originMismatch({ origin: null, source: 'request', requestOrigin: 'http://127.0.0.1:8787' }, 'https://b.example')).toContain('Host')
  })

  it('turns ORIGIN_REJECTED into an actionable message', () => {
    const error = new ApiError(403, 'ORIGIN_REJECTED', null, { expected: 'https://a.example', received: 'http://1.2.3.4:8787' })
    expect(errorText(error)).toBe(
      '当前访问地址（http://1.2.3.4:8787）与 APP_ORIGIN（https://a.example）不一致，请求被拒绝。请改用 https://a.example 访问；如果当前地址才是正确的，请把 APP_ORIGIN 改为 http://1.2.3.4:8787（管理 → 站点地址，或 .env）。',
    )
    expect(errorText(new ApiError(403, 'ORIGIN_REJECTED', null))).toBe('请求来源被拒绝')
  })
})

describe('login page', () => {
  it('shows the APP_ORIGIN mismatch before the user hits a 403', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/auth/providers') return json({ providers: ['github'] })
      if (url === '/api/site') return json({ origin: 'https://dropit.example', source: 'env', requestOrigin: window.location.origin })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/login')
    const alert = await waitFor(() => {
      const node = document.querySelector('[data-origin-mismatch]')
      if (!node) throw new Error('no hint yet')
      return node as HTMLElement
    })
    expect(alert.textContent).toContain(`当前访问地址 ${window.location.origin} 与 APP_ORIGIN（https://dropit.example）不一致`)
  })

  it('stays quiet when the address matches', async () => {
    stubFetch((url) => {
      if (url === '/api/me') return json({ error: { code: 'UNAUTHENTICATED' } }, 401)
      if (url === '/api/auth/providers') return json({ providers: ['github'] })
      if (url === '/api/site') return json({ origin: null, source: 'request', requestOrigin: window.location.origin })
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/login')
    await screen.findByText('使用 GitHub 继续')
    await waitFor(() => expect(calls.some((call) => call.url === '/api/site')).toBe(true))
    expect(document.querySelector('[data-origin-mismatch]')).toBeNull()
  })
})

describe('admin: 站点地址', () => {
  it('shows source and callbacks, validates input and asks to confirm a different address', async () => {
    let view = settings()
    const puts: unknown[] = []
    stubFetch((url, init) => {
      if (url === '/api/me') return json(admin)
      if (url === '/api/admin/site' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { origin: string | null; confirm?: boolean }
        puts.push(body)
        if (!body.confirm) return json({ error: { code: 'ORIGIN_CONFIRM_REQUIRED', origin: body.origin, current: window.location.origin } }, 409)
        view = settings({ origin: body.origin, source: 'admin', adminOrigin: body.origin, effectiveOrigin: body.origin })
        return json(view)
      }
      if (url === '/api/admin/site') return json(view)
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    renderAt('/admin?tab=site')
    const region = await screen.findByRole('region', { name: '站点地址' })
    expect(await within(region).findByText('未设置，自动使用浏览器访问的地址')).toBeTruthy()
    const callbacks = region.querySelector('[data-site-callbacks]') as HTMLElement
    expect((within(callbacks).getByLabelText('GitHub 回调地址') as HTMLInputElement).value).toBe(`${window.location.origin}/api/auth/github/callback`)
    expect(within(region).getByText(/登录 Cookie 不带 Secure/)).toBeTruthy()

    const input = within(region).getByLabelText(/站点地址（协议/) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'https://dropit.example/app' } })
    expect(within(region).getByRole('alert').textContent).toContain('格式不对')
    expect((within(region).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'https://dropit.example' } })
    fireEvent.click(within(region).getByRole('button', { name: '保存' }))
    const confirm = await within(region).findByRole('alertdialog', { name: '确认修改站点地址' })
    expect(confirm.textContent).toContain('https://dropit.example')
    fireEvent.click(within(confirm).getByRole('button', { name: '确认保存' }))
    await waitFor(() => expect(puts).toEqual([{ origin: 'https://dropit.example' }, { origin: 'https://dropit.example', confirm: true }]))
    expect(await within(region).findByText('管理页面设置')).toBeTruthy()
    expect((within(callbacks).getByLabelText('GitHub 回调地址') as HTMLInputElement).value).toBe('https://dropit.example/api/auth/github/callback')
    expect(within(region).getByText(/与当前访问地址不一致/)).toBeTruthy()
  })
})
