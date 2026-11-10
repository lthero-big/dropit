import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { ThemeProvider } from '@/components/theme-provider.tsx'
import { ShareLinks } from '@/components/share-links.tsx'
import type { ManagedShare, ManagedShareCopyStatus, ManagedShareState } from '@/lib/types.ts'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const initialClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const initialExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

function share(id: string, state: ManagedShareState = 'active', copyStatus: ManagedShareCopyStatus = state === 'active' ? 'available' : 'unavailable'): ManagedShare {
  return {
    id, itemId: `item-${id}`, state, copyStatus, sourceName: `来源 ${id}`, spaceName: '我的空间',
    expiresAt: null, maxViews: 5, views: 1, revoked: state === 'revoked' ? 1 : 0, createdAt: 1_700_000_000_000,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function requestUrl(input: RequestInfo | URL) {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function row(id: string) {
  const element = document.querySelector<HTMLElement>(`[data-share-id="${id}"]`)
  if (!element) throw new Error(`missing share row ${id}`)
  return element
}

function disabled(element: HTMLElement) {
  return (element as HTMLButtonElement).disabled
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  if (initialClipboard) Object.defineProperty(navigator, 'clipboard', initialClipboard)
  else delete (navigator as { clipboard?: Clipboard }).clipboard
  if (initialExecCommand) Object.defineProperty(document, 'execCommand', initialExecCommand)
  else delete (document as unknown as { execCommand?: (commandId: string) => boolean }).execCommand
})

describe('share link management', () => {
  it('isolates pending actions by share, deduplicates a row, and permits a failed row retry', async () => {
    const first = share('first')
    const second = share('second')
    const firstRevoke = deferred<Response>()
    const secondRevoke = deferred<Response>()
    const retryRevoke = deferred<Response>()
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === '/api/shares') return Promise.resolve(json({ shares: [first, second], nextCursor: null }))
      if (url === '/api/shares/first/revoke') return firstRevoke.promise
      if (url === '/api/shares/second/revoke' && calls.filter((call) => call.endsWith('/second/revoke')).length === 1) return secondRevoke.promise
      if (url === '/api/shares/second/revoke') return retryRevoke.promise
      return Promise.resolve(json({ error: { code: 'NOT_FOUND' } }, 404))
    }))

    render(<ThemeProvider><ShareLinks /></ThemeProvider>)
    await screen.findByText('来源 first')
    const firstRow = row('first')
    const secondRow = row('second')
    fireEvent.click(within(firstRow).getByRole('button', { name: '撤回' }))
    fireEvent.click(within(firstRow).getByRole('button', { name: '正在撤回…' }))
    fireEvent.click(within(secondRow).getByRole('button', { name: '撤回' }))
    await waitFor(() => expect(calls.filter((call) => call.endsWith('/revoke')).length).toBe(2))
    expect(disabled(within(firstRow).getByRole('button', { name: '正在撤回…' }))).toBe(true)
    expect(disabled(within(secondRow).getByRole('button', { name: '正在撤回…' }))).toBe(true)

    firstRevoke.resolve(new Response(null, { status: 204 }))
    await waitFor(() => expect(within(firstRow).getByText('已撤销')).toBeTruthy())
    expect(disabled(within(secondRow).getByRole('button', { name: '正在撤回…' }))).toBe(true)
    secondRevoke.reject(new Error('network'))
    await waitFor(() => expect(disabled(within(secondRow).getByRole('button', { name: '撤回' }))).toBe(false))
    fireEvent.click(within(secondRow).getByRole('button', { name: '撤回' }))
    await waitFor(() => expect(calls.filter((call) => call.endsWith('/revoke')).length).toBe(3))
    retryRevoke.resolve(new Response(null, { status: 204 }))
    await waitFor(() => expect(within(secondRow).getByText('已撤销')).toBeTruthy())
  })

  it('keeps deletion confirmations independent while another row is deleted', async () => {
    const first = share('first', 'revoked')
    const second = share('second', 'revoked')
    const removal = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url === '/api/shares') return Promise.resolve(json({ shares: [first, second], nextCursor: null }))
      if (url === '/api/shares/first' && init?.method === 'DELETE') return removal.promise
      return Promise.resolve(json({ error: { code: 'NOT_FOUND' } }, 404))
    }))

    render(<ThemeProvider><ShareLinks /></ThemeProvider>)
    await screen.findByText('来源 first')
    const firstRow = row('first')
    const secondRow = row('second')
    fireEvent.click(within(firstRow).getByRole('button', { name: '删除记录' }))
    fireEvent.click(within(secondRow).getByRole('button', { name: '删除记录' }))
    fireEvent.click(within(firstRow).getByRole('button', { name: '确认删除记录' }))
    await waitFor(() => expect(disabled(within(firstRow).getByRole('button', { name: '正在删除…' }))).toBe(true))
    removal.resolve(new Response(null, { status: 204 }))
    await waitFor(() => expect(document.querySelector('[data-share-id="first"]')).toBeNull())
    expect(within(secondRow).getByRole('alertdialog', { name: '删除分享记录确认' })).toBeTruthy()
  })

  it('copies only a recoverable active link and waits for clipboard success', async () => {
    const available = share('available')
    const legacy = share('legacy', 'active', 'legacy')
    const expired = share('expired', 'expired')
    const clipboard = vi.fn<Clipboard['writeText']>()
    const copied = deferred<void>()
    clipboard.mockReturnValue(copied.promise)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
    const linkCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === '/api/shares') return Promise.resolve(json({ shares: [available, legacy, expired], nextCursor: null }))
      if (url === '/api/shares/available/link') {
        linkCalls.push(url)
        return Promise.resolve(json({ url: 'https://dropit.example/s/Abc234' }))
      }
      return Promise.resolve(json({ error: { code: 'NOT_FOUND' } }, 404))
    }))

    render(<ThemeProvider><ShareLinks /></ThemeProvider>)
    await screen.findByText('来源 available')
    expect(within(row('legacy')).queryByRole('button', { name: '复制链接' })).toBeNull()
    expect(within(row('legacy')).getByText('旧版本链接无法恢复，可从原条目重新分享。')).toBeTruthy()
    expect(within(row('expired')).queryByRole('button', { name: '复制链接' })).toBeNull()
    expect(within(row('expired')).getByText('链接已过期，无法复制。')).toBeTruthy()

    const availableRow = row('available')
    fireEvent.click(within(availableRow).getByRole('button', { name: '复制链接' }))
    fireEvent.click(within(availableRow).getByRole('button', { name: '正在复制…' }))
    await waitFor(() => expect(linkCalls).toHaveLength(1))
    expect(clipboard).toHaveBeenCalledWith('https://dropit.example/s/Abc234')
    expect(toast.success).not.toHaveBeenCalled()
    copied.resolve()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('链接已复制'))
    expect(disabled(within(availableRow).getByRole('button', { name: '复制链接' }))).toBe(false)
  })

  it('cleans up failed clipboard fallbacks and keeps the row retryable', async () => {
    const available = share('available')
    const clipboard = vi.fn<Clipboard['writeText']>().mockRejectedValue(new Error('clipboard denied'))
    const fallback = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === '/api/shares') return Promise.resolve(json({ shares: [available], nextCursor: null }))
      if (url === '/api/shares/available/link') return Promise.resolve(json({ url: 'https://dropit.example/s/Abc234' }))
      return Promise.resolve(json({ error: { code: 'NOT_FOUND' } }, 404))
    }))

    render(<ThemeProvider><ShareLinks /></ThemeProvider>)
    await screen.findByText('来源 available')
    const availableRow = row('available')
    fireEvent.click(within(availableRow).getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('复制链接失败，请重试'))
    expect(disabled(within(availableRow).getByRole('button', { name: '复制链接' }))).toBe(false)
    expect(document.querySelectorAll('body > textarea')).toHaveLength(0)
    expect(toast.success).not.toHaveBeenCalled()

    fireEvent.click(within(availableRow).getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))
    expect(document.querySelectorAll('body > textarea')).toHaveLength(0)

    fireEvent.click(within(availableRow).getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('链接已复制'))
    expect(fallback).toHaveBeenCalledTimes(3)
    expect(document.querySelectorAll('body > textarea')).toHaveLength(0)
  })

  it('cleans up the fallback textarea when execCommand throws', async () => {
    const available = share('available')
    const clipboard = vi.fn<Clipboard['writeText']>().mockRejectedValue(new Error('clipboard denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => { throw new Error('copy unavailable') }) })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === '/api/shares') return Promise.resolve(json({ shares: [available], nextCursor: null }))
      if (url === '/api/shares/available/link') return Promise.resolve(json({ url: 'https://dropit.example/s/Abc234' }))
      return Promise.resolve(json({ error: { code: 'NOT_FOUND' } }, 404))
    }))

    render(<ThemeProvider><ShareLinks /></ThemeProvider>)
    await screen.findByText('来源 available')
    const availableRow = row('available')
    fireEvent.click(within(availableRow).getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('复制链接失败，请重试'))
    expect(disabled(within(availableRow).getByRole('button', { name: '复制链接' }))).toBe(false)
    expect(toast.success).not.toHaveBeenCalled()
    expect(document.querySelectorAll('body > textarea')).toHaveLength(0)
  })
})
