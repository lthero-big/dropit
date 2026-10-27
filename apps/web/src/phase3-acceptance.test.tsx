// Phase-3 UI acceptance: admin limit editing and the clip action capsule.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { ExpandCapsule } from './components/expand-capsule.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'
import { channelClock } from './lib/channel.ts'
import type { AdminLimits, Item, LimitField, LimitKey } from './lib/types.ts'

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
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

const me = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'admin' as const, disabled: 0, createdAt: 1 },
  usedBytes: 20,
  quotaBytes: 1000,
  maxFileBytes: 25 * 1024 ** 2,
  maxTextBytes: 65536,
  retentionMs: 7 * 86_400_000,
}

function field(value: number, max: number, overridden = false, fallback = value): LimitField {
  return { value, default: fallback, overridden, min: 1, max }
}

function sampleLimits(): AdminLimits {
  const day = 86_400_000
  return {
    maxFileBytes: field(25 * 1024 ** 2, 1024 ** 3),
    maxTextBytes: field(64 * 1024, 1024 ** 2),
    maxItems: field(1000, 100_000),
    userQuotaBytes: field(1024 ** 3, 100 * 1024 ** 3),
    retentionMs: field(7 * day, 365 * day),
    roomQuotaBytes: field(50 * 1024 ** 2, 100 * 1024 ** 3),
    roomMaxFileBytes: field(5 * 1024 ** 2, 1024 ** 3),
    roomRetentionMs: field(day, day),
    rateWindowMs: field(60_000, 3_600_000),
    rateGeneral: field(240, 1_000_000),
    rateAuth: field(20, 1_000_000),
    rateInvite: field(10, 1_000_000),
    rateUpload: field(30, 1_000_000),
    rateRoom: field(10, 1_000_000),
    sessionMs: field(7 * day, 365 * day),
    uploadChunkBytes: field(8388608, 25165824),
    uploadChunkTimeoutMs: field(120000, 3600000),
    rateChunk: field(2000, 1000000),
    uploadChunksPerSession: field(3, 16),
    uploadChunksPerUser: field(6, 64),
    uploadChunksGlobal: field(16, 256),
    uploadSessionsPerUser: field(8, 1000),
    uploadSessionsGlobal: field(128, 10000),
  }
}

function clip(partial: Partial<Item> & Pick<Item, 'id' | 'text'>): Item {
  return {
    spaceId: 's1',
    userId: 'u1',
    kind: 'text',
    filename: null,
    mime: null,
    size: 4,
    hasThumbnail: false,
    createdAt: 1_700_000_000_000,
    expiresAt: Date.now() + 3_600_000,
    pinned: false,
    tags: [],
    ...partial,
    updatedAt: partial.updatedAt ?? partial.createdAt ?? 1_700_000_000_000,
  }
}

const calls: { url: string; init?: RequestInit }[] = []
let limits = sampleLimits()
let failPatch = false

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    if (url === '/api/me') return json(me)
    if (url === '/api/spaces') return json({ spaces: [{ id: 's1', name: 'Private space', ownerId: 'u1', expiresAt: null }] })
    if (url === '/api/admin/users') return json({ users: [] })
    if (url === '/api/admin/invites') return json({ invites: [] })
    if (url.startsWith('/api/admin/limits/audit')) {
      const changed = limits.maxItems.overridden
      return json({
        entries: changed ? [{
          id: 1, actorId: 'u1', actorEmail: 'ada@example.com', createdAt: Date.UTC(2026, 9, 25, 3, 0),
          key: 'maxItems', oldValue: 1000, newValue: limits.maxItems.value, oldOverride: null, newOverride: limits.maxItems.value,
        }] : [],
        nextCursor: null,
      })
    }
    if (url === '/api/admin/limits' && init?.method === 'PATCH') {
      if (failPatch) return json({ error: { code: 'INVALID_LIMITS' } }, 400)
      const patch = JSON.parse(String(init.body)) as Partial<Record<LimitKey, number | null>>
      const next = { ...limits }
      for (const [key, value] of Object.entries(patch) as Array<[LimitKey, number | null]>) {
        const current = { ...next[key] }
        if (value === null) {
          current.value = current.default
          current.overridden = false
        } else {
          current.value = value
          current.overridden = true
        }
        next[key] = current
      }
      limits = next
      return json(limits)
    }
    if (url === '/api/admin/limits') return json(limits)
    return json({ error: { code: 'NOT_FOUND' } }, 404)
  }))
}

function renderAt(path: string) {
  window.history.pushState({}, '', path)
  return render(<ThemeProvider><App /></ThemeProvider>)
}

const originalDelay = channelClock.delay

beforeEach(() => {
  calls.length = 0
  limits = sampleLimits()
  failPatch = false
  FakeSocket.instances = []
  channelClock.delay = () => 0
  vi.stubGlobal('WebSocket', FakeSocket)
  window.WebSocket = FakeSocket as unknown as typeof WebSocket
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  channelClock.delay = originalDelay
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function limitRow(key: string) {
  const node = document.querySelector(`[data-limit="${key}"]`)
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${key}`)
  return node
}

describe('AC-O7/O8 admin limits', () => {
  it('edits one limit, shows the audit, and restores the default', async () => {
    stubFetch()
    renderAt('/admin')
    fireEvent.click(await screen.findByRole('tab', { name: '限制' }))
    expect(await screen.findByText('覆盖值保存在数据库，重启后保留；只读项仍需改环境变量。')).toBeTruthy()
    expect(screen.getByText(/调低上限或配额不会删除已有内容/)).toBeTruthy()
    expect(screen.getByText(/保留时间只影响新条目和新房间，会话时长只影响新会话/)).toBeTruthy()
    expect(screen.queryByText(/这些限制来自环境变量/)).toBeNull()
    const items = limitRow('maxItems')
    expect(within(items).getByText('未覆盖')).toBeTruthy()
    expect(within(items).getByText('当前 1000 条')).toBeTruthy()
    expect(within(items).getByText('默认 1000 条')).toBeTruthy()
    expect(within(limitRow('maxFileBytes')).getByText('当前 25.0 MB')).toBeTruthy()
    expect(within(limitRow('retentionMs')).getByText('当前 7 天')).toBeTruthy()

    fireEvent.change(within(items).getByLabelText('每空间条目上限'), { target: { value: '12' } })
    fireEvent.click(within(items).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(limitRow('maxItems')).getByText('已覆盖')).toBeTruthy())
    expect(within(limitRow('maxItems')).getByText('当前 12 条')).toBeTruthy()
    expect(await screen.findByText('ada@example.com')).toBeTruthy()
    expect(screen.getByText('1000 条 → 12 条')).toBeTruthy()
    const patch = calls.find((call) => call.url === '/api/admin/limits' && call.init?.method === 'PATCH')
    expect(patch?.init?.body).toBe(JSON.stringify({ maxItems: 12 }))

    fireEvent.click(within(limitRow('maxItems')).getByRole('button', { name: '恢复默认' }))
    await waitFor(() => expect(within(limitRow('maxItems')).getByText('未覆盖')).toBeTruthy())
    expect(calls.filter((call) => call.init?.method === 'PATCH').at(-1)?.init?.body).toBe(JSON.stringify({ maxItems: null }))
  })

  it('keeps an illegal value off the server and shows the backend error', async () => {
    stubFetch()
    renderAt('/admin')
    fireEvent.click(await screen.findByRole('tab', { name: '限制' }))
    const items = await waitFor(() => limitRow('maxItems'))
    fireEvent.change(within(items).getByLabelText('每空间条目上限'), { target: { value: '100001' } })
    fireEvent.click(within(items).getByRole('button', { name: '保存' }))
    expect(within(items).getByRole('alert').textContent).toMatch(/需在/)
    expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(false)

    failPatch = true
    fireEvent.change(within(items).getByLabelText('每空间条目上限'), { target: { value: '12' } })
    fireEvent.click(within(items).getByRole('button', { name: '保存' }))
    expect((await within(items).findByRole('alert')).textContent).toContain('限制值不在允许范围')
    expect(within(items).getByText('未覆盖')).toBeTruthy()
  })
})

describe('AC-P1/P2 clip actions', () => {
  async function openBoard() {
    stubFetch()
    renderAt('/')
    await screen.findByRole('button', { name: '发送' })
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [
        clip({ id: 'note', text: 'keep me' }),
        clip({ id: 'file', text: null, kind: 'file', filename: 'notes.bin' }),
      ],
      serverTime: Date.now(),
      expiresAt: null,
    })
    const note = (await screen.findByText('keep me')).closest('li')
    const file = screen.getByText('notes.bin').closest('li')
    if (!note || !file) throw new Error('missing clip')
    return { note, file }
  }

  it('leaves copy and retract outside, and puts the rest (share included) behind more', async () => {
    const { note, file } = await openBoard()
    expect(within(note).queryByRole('button', { name: '分享' })).toBeNull()
    for (const name of ['复制', '撤回']) {
      const button = within(note).getByRole('button', { name })
      expect(button.getAttribute('title')).toBe(name)
      expect(button.style.minWidth).toBe('40px')
      expect(button.style.minHeight).toBe('40px')
    }
    expect(within(note).queryByRole('button', { name: '编辑' })).toBeNull()
    expect(within(note).queryByRole('button', { name: '置顶' })).toBeNull()
    expect(within(note).queryByRole('button', { name: '标签' })).toBeNull()
    const more = within(note).getByRole('button', { name: '更多' })
    const capsule = note.querySelector('[data-slot="expand-capsule"]')
    if (!(capsule instanceof HTMLElement)) throw new Error('missing capsule')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(more.getAttribute('title')).toBe('更多')
    expect(more.getAttribute('aria-label')).toBe('更多')
    expect(more.textContent ?? '').not.toContain('更多')
    expect(capsule.style.height).toBe('40px')
    expect(capsule.style.width).toBe('40px')
    more.focus()
    fireEvent.click(more, { detail: 0 })
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const edit = within(note).getByRole('button', { name: '编辑' })
    expect(document.activeElement).toBe(edit)
    expect(edit.style.minHeight).toBe('40px')
    expect(within(note).getByRole('button', { name: '置顶' }).style.minWidth).toBe('40px')
    expect(within(note).getByRole('button', { name: '分享' }).style.minHeight).toBe('40px')
    expect(within(note).queryByRole('button', { name: '标签' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(within(note).queryByRole('button', { name: '编辑' })).toBeNull()
    expect(document.activeElement).toBe(more)

    fireEvent.click(more, { detail: 1 })
    fireEvent.pointerDown(document.body)
    expect(more.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(within(note).getByRole('button', { name: '撤回' }))
    expect(within(note).getByRole('button', { name: '确认撤回' }).getAttribute('title')).toBe('确认撤回')
    const fileCopy = within(file).getByRole('button', { name: '复制' })
    expect(fileCopy.getAttribute('title')).toBe('复制')
    expect(fileCopy.style.minWidth).toBe('40px')
    expect(within(file).queryByRole('link', { name: '下载' })).toBeNull()
    fireEvent.click(within(file).getByRole('button', { name: '更多' }))
    const download = within(file).getByRole('link', { name: '下载' })
    expect(download.getAttribute('href')).toBe('/api/spaces/s1/items/file/download')
    expect(download.style.minWidth).toBe('40px')
  })
})

function pill() {
  const node = document.querySelector('[data-slot="expand-capsule"]')
  if (!(node instanceof HTMLElement)) throw new Error('missing capsule')
  return node
}

function actionsNode() {
  const node = document.querySelector('[data-slot="expand-capsule-actions"]')
  if (!(node instanceof HTMLElement)) throw new Error('missing actions')
  return node
}

describe('AC-P2/P3 capsule motion', () => {
  function renderCapsule(count: number, parentWidth = 0, actionWidth = 160) {
    const view = render(
      <div data-testid="bound">
        <ExpandCapsule label="更多" icon={<svg aria-hidden="true" />} stiffness={300} damping={25} collapsedWidth={120} height={48}>
          {Array.from({ length: count }, (_, index) => (
            <button key={index} type="button" aria-label={`动作${index + 1}`}>{index + 1}</button>
          ))}
        </ExpandCapsule>
      </div>,
    )
    const bound = screen.getByTestId('bound')
    Object.defineProperty(bound, 'clientWidth', { configurable: true, get: () => parentWidth })
    Object.defineProperty(actionsNode(), 'offsetWidth', { configurable: true, get: () => actionWidth })
    return view
  }

  it('springs open with stiffness 300 and damping 25, then fades icons before shrinking', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const queued: FrameRequestCallback[] = []
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queued.push(callback)
      return queued.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const animated: KeyframeAnimationOptions[] = []
    vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation((_frames, options) => {
      if (options && typeof options === 'object') animated.push(options)
      return { cancel() {}, finish() {}, persist() {}, finished: Promise.resolve() } as unknown as Animation
    })
    renderCapsule(2, 0, 160)
    expect(pill().style.width).toBe('120px')
    expect(pill().style.height).toBe('48px')
    expect(pill().className).toContain('border-2')
    fireEvent.click(screen.getByRole('button', { name: '更多' }), { detail: 1 })
    const callback = queued.shift()
    clock += 1000 / 240
    callback?.(clock)
    const dt = 1 / 240
    const velocity = (-300 * (120 - 164)) * dt
    expect(parseFloat(pill().style.width)).toBeCloseTo(120 + velocity * dt, 5)
    let guard = 0
    while (queued.length && guard < 400) {
      const next = queued.shift()
      clock += 16
      next?.(clock)
      guard += 1
    }
    expect(parseFloat(pill().style.width)).toBeCloseTo(164, 3)
    const enter = animated.find((options) => options.delay === 100)
    expect(enter?.duration).toBe(200)
    expect(enter?.easing).toBe('ease-in-out')
    const queuedAfterOpen = queued.length
    fireEvent.keyDown(document.body, { key: 'Escape' })
    const fade = animated.at(-1)
    expect(fade?.duration).toBe(90)
    expect(fade?.easing).toBe('ease-out')
    vi.advanceTimersByTime(89)
    expect(queued.length).toBe(queuedAfterOpen)
    vi.advanceTimersByTime(1)
    expect(queued.length).toBeGreaterThan(queuedAfterOpen)
  })

  it('snaps under reduced motion and wraps or stacks to stay inside a narrow parent', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false },
      onchange: null,
      addListener() {},
      removeListener() {},
    }))
    const animated: KeyframeAnimationOptions[] = []
    vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation((_frames, options) => {
      if (options && typeof options === 'object') animated.push(options)
      return { cancel() {}, finish() {}, persist() {}, finished: Promise.resolve() } as unknown as Animation
    })
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    renderCapsule(4, 100, 200)
    const before = frames.length
    fireEvent.click(screen.getByRole('button', { name: '更多' }), { detail: 1 })
    expect(frames.length).toBe(before)
    expect(pill().dataset.layout).toBe('wrap')
    expect(animated.every((options) => options.duration === 0)).toBe(true)
    expect(parseFloat(pill().style.width)).toBeLessThanOrEqual(100)
    cleanup()

    renderCapsule(3, 30, 200)
    fireEvent.click(screen.getByRole('button', { name: '更多' }), { detail: 1 })
    expect(pill().dataset.layout).toBe('vertical')
    expect(parseFloat(pill().style.width)).toBeLessThanOrEqual(30)
  })
})
