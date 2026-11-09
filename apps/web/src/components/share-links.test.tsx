import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@/components/theme-provider.tsx'
import { ShareLinks } from '@/components/share-links.tsx'
import type { ManagedShare } from '@/lib/types.ts'

const share: ManagedShare = {
  id: 'share-1', itemId: 'item-1', state: 'active', sourceName: '部署说明', spaceName: '我的空间',
  expiresAt: null, maxViews: 5, views: 1, revoked: 0, createdAt: 1_700_000_000_000,
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('share link management', () => {
  it('revokes a link and only deletes its record after confirmation', async () => {
    let shares = [share]
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init })
      if (url === '/api/shares' && (!init?.method || init.method === 'GET')) return json({ shares, nextCursor: null })
      if (url === '/api/shares/share-1/revoke' && init?.method === 'POST') {
        shares = [{ ...share, state: 'revoked', revoked: 1 }]
        return new Response(null, { status: 204 })
      }
      if (url === '/api/shares/share-1' && init?.method === 'DELETE') {
        shares = []
        return new Response(null, { status: 204 })
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    }))

    render(<ThemeProvider><ShareLinks /></ThemeProvider>)
    expect(await screen.findByText('部署说明')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '撤回' }))
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/revoke'))).toBe(true))
    expect(await screen.findByText('已撤销')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '删除记录' }))
    expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '删除记录' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除记录' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/shares/share-1' && call.init?.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(screen.queryByText('部署说明')).toBeNull())
  })
})
