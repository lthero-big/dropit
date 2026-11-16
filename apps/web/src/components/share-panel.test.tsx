import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { SharePanel } from '@/components/share-panel.tsx'
import { copyText } from '@/lib/format.ts'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/format.ts', async (original) => ({ ...await original<typeof import('@/lib/format.ts')>(), copyText: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it.each(['file', 'text'])('copies a newly created %s share without opening the public link', async (kind) => {
  const now = Date.now()
  const created = {
    id: 'share', itemId: 'item', token: 'Abc123', url: 'https://dropit.example/s/Abc123',
    ...(kind === 'file' ? { directUrl: 'https://dropit.example/d/Abc123' } : {}),
    expiresAt: now + 86400000, maxViews: 1, views: 0, revoked: 0, createdAt: now,
  }
  const requests: string[] = []
  vi.mocked(copyText).mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    requests.push(input)
    if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
    const body = input === '/api/me/share-presets' ? { hours: [], days: [], months: [], views: [] }
      : init?.method === 'POST' ? created : { shares: [] }
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))
  }))

  render(<SharePanel base="/api/spaces/space" itemId="item" now={now} onClose={() => {}} />)
  await screen.findByText('还没有分享链接。')
  fireEvent.click(screen.getByRole('button', { name: '生成链接' }))
  expect(await screen.findByRole('textbox', { name: '分享链接' })).toHaveProperty('value', created.url)
  fireEvent.click(screen.getByRole('button', { name: '复制分享链接' }))
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(created.url))
  if (kind === 'file') {
    expect(screen.getByLabelText('文件直链')).toHaveProperty('value', created.directUrl)
    fireEvent.click(screen.getByRole('button', { name: '复制文件直链' }))
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(created.directUrl))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('文件直链已复制'))
  } else {
    expect(screen.queryByRole('button', { name: '复制文件直链' })).toBeNull()
  }
  expect(requests.some((path) => path.startsWith('/api/s/') || path.startsWith('/d/'))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '分享链接' })).toBeNull())
  expect(screen.queryByLabelText('文件直链')).toBeNull()
})
