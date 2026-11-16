import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { SharePresets } from '@/components/share-presets.tsx'
import { SharePanel } from '@/components/share-panel.tsx'
import type { SharePresets as Presets } from '@/lib/share-presets.ts'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handler(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init)))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('saves added/removed presets, reloads them and uses them when creating a share', async () => {
  // Preferences saved before hours/months were introduced still load.
  let saved: Partial<Presets> = { days: [14], views: [50] }
  let created: unknown
  stubFetch((url, init) => {
    if (url === '/api/me/share-presets') {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body)) as Presets
      return json(saved)
    }
    if (url === '/api/spaces/s/items/i/shares' && init?.method === 'POST') {
      created = JSON.parse(String(init.body))
      return json({ id: 'share', itemId: 'i', expiresAt: Date.now() + 3 * 86400000, maxViews: 200, views: 0, revoked: 0, createdAt: Date.now(), url: 'http://localhost/s/Abc123' })
    }
    if (url === '/api/spaces/s/items/i/shares') return json({ shares: [] })
    return json({ error: { code: 'NOT_FOUND' } }, 404)
  })
  const settings = render(<SharePresets />)
  await screen.findByRole('button', { name: '移除 14 天' })
  fireEvent.click(screen.getByRole('button', { name: '移除 14 天' }))
  for (const [unit, value] of [['days', '21'], ['hours', '6'], ['months', '2']]) {
    fireEvent.change(screen.getByLabelText('单位'), { target: { value: unit } })
    fireEvent.change(screen.getByLabelText('自定义有效期'), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '添加有效期' }))
  }
  fireEvent.change(screen.getByLabelText('自定义次数'), { target: { value: '200' } })
  fireEvent.click(screen.getByRole('button', { name: '添加次数' }))
  fireEvent.click(screen.getByRole('button', { name: '保存分享选项' }))
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('分享选项已保存'))
  expect(saved).toEqual({ hours: [6], days: [21], months: [2], views: [50, 200] })
  settings.unmount()
  const reloaded = render(<SharePresets />)
  await screen.findByRole('button', { name: '移除 21 天' })
  expect(screen.getByRole('button', { name: '移除 6 小时' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '移除 2 个月' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '移除 14 天' })).toBeNull()
  reloaded.unmount()
  render(<SharePanel base="/api/spaces/s" itemId="i" now={Date.now()} onClose={() => {}} />)
  const panel = screen.getByRole('dialog', { name: '分享链接' })
  await within(panel).findByRole('option', { name: '2 个月' })
  expect(within(panel).getAllByRole('option').map((option) => option.textContent)).toEqual([
    '1 小时', '6 小时', '1 天', '3 天', '7 天', '21 天', '2 个月', '不过期', '仅一次', '5 次', '10 次', '50 次', '200 次', '不限',
  ])
  fireEvent.change(within(panel).getByLabelText('有效期'), { target: { value: '2mo' } })
  fireEvent.change(within(panel).getByLabelText('查看次数'), { target: { value: '200' } })
  fireEvent.click(within(panel).getByRole('button', { name: '生成链接' }))
  await waitFor(() => expect(created).toEqual({ expiresIn: '2mo', maxViews: 200 }))
  expect(await within(panel).findByLabelText('分享链接')).toHaveProperty('value', 'http://localhost/s/Abc123')
  fireEvent.change(within(panel).getByLabelText('有效期'), { target: { value: '6h' } })
  fireEvent.click(within(panel).getByRole('button', { name: '生成链接' }))
  await waitFor(() => expect(created).toEqual({ expiresIn: '6h', maxViews: 200 }))
})

it('rejects duplicates, fractions and out-of-range custom options before saving', async () => {
  stubFetch(() => json({ days: [14], views: [] }))
  render(<SharePresets />)
  await screen.findByRole('button', { name: '移除 14 天' })
  for (const value of ['1', '3', '7', '14', '0', '-1', '1.5', '3651']) {
    fireEvent.change(screen.getByLabelText('自定义有效期'), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '添加有效期' }))
  }
  for (const [unit, value] of [['hours', '24'], ['hours', '87601'], ['months', '122']]) {
    fireEvent.change(screen.getByLabelText('单位'), { target: { value: unit } })
    fireEvent.change(screen.getByLabelText('自定义有效期'), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '添加有效期' }))
  }
  fireEvent.change(screen.getByLabelText('自定义次数'), { target: { value: '1000001' } })
  fireEvent.click(screen.getByRole('button', { name: '添加次数' }))
  expect(toast.error).toHaveBeenCalledTimes(12)
  expect((screen.getByRole('button', { name: '保存分享选项' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getAllByRole('button', { name: /移除/ })).toHaveLength(1)
})

it('keeps a failed save retryable and can remove all custom options', async () => {
  let writes = 0
  let saved: unknown
  stubFetch((_url, init) => {
    if (init?.method === 'PUT') {
      writes++
      if (writes === 1) return json({ error: { code: 'INTERNAL_ERROR' } }, 500)
      saved = JSON.parse(String(init.body))
      return json(saved)
    }
    return json({ days: [14], views: [20] })
  })
  render(<SharePresets />)
  await screen.findByRole('button', { name: '移除 14 天' })
  fireEvent.click(screen.getByRole('button', { name: '移除 14 天' }))
  fireEvent.click(screen.getByRole('button', { name: '移除 20 次' }))
  fireEvent.click(screen.getByRole('button', { name: '保存分享选项' }))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
  await waitFor(() => expect((screen.getByRole('button', { name: '保存分享选项' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '保存分享选项' }))
  await waitFor(() => expect(saved).toEqual({ hours: [], days: [], months: [], views: [] }))
})

it('keeps built-in sharing available to anonymous room visitors', async () => {
  stubFetch((url) => url === '/api/me/share-presets'
    ? json({ error: { code: 'UNAUTHENTICATED' } }, 401)
    : json({ shares: [] }))
  render(<SharePanel base="/api/rooms/room" itemId="i" now={Date.now()} onClose={() => {}} />)
  await screen.findByText('还没有分享链接。')
  expect(screen.getByLabelText('有效期')).toHaveProperty('value', '1d')
  expect(within(screen.getByLabelText('有效期')).getAllByRole('option').map((option) => option.textContent))
    .toEqual(['1 小时', '1 天', '3 天', '7 天', '不过期'])
  expect(screen.getByLabelText('查看次数')).toHaveProperty('value', '1')
  expect(toast.error).not.toHaveBeenCalled()
})

it('keeps built-in days once when legacy presets contain equivalent durations', async () => {
  stubFetch((url) => url === '/api/me/share-presets'
    ? json({ hours: [24], days: [3, 30], months: [1], views: [] })
    : json({ shares: [] }))
  render(<SharePanel base="/api/spaces/s" itemId="i" now={Date.now()} onClose={() => {}} />)
  await screen.findByRole('option', { name: '30 天' })
  expect(within(screen.getByLabelText('有效期')).getAllByRole('option').map((option) => option.textContent))
    .toEqual(['1 小时', '1 天', '3 天', '7 天', '30 天', '不过期'])
})
