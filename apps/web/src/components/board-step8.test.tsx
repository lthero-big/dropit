// RHEA-190 step 8: drag-to-group is desktop-mouse only, the drag ghost follows the
// pointer at a fixed offset, and on desktop 撤回 has no press-and-hold entry.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipboardBoard } from './clipboard-board.tsx'
import { GHOST_OFFSET, ghostLabel, ghostTransform } from '@/lib/drag-ghost.ts'
import { resetLocalDevice } from '@/lib/device.ts'
import type { Item } from '@/lib/types.ts'

class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readyState = 0
  url: string
  constructor(url: string | URL) {
    this.url = String(url)
    FakeSocket.instances.push(this)
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  send() {}
  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

function item(patch: Partial<Item> = {}): Item {
  return {
    id: 'a',
    spaceId: 's1',
    userId: 'u1',
    kind: 'text',
    text: 'hello',
    filename: null,
    mime: null,
    size: 5,
    hasThumbnail: false,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000,
    pinned: false,
    tags: [],
    ...patch,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type Call = { url: string; init?: RequestInit }
let calls: Call[] = []

function renderBoard(respond: (url: string, init?: RequestInit) => Response = () => json({ error: { code: 'NOT_FOUND' } }, 404)) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return respond(url, init)
    }),
  )
  const view = render(
    <ClipboardBoard
      base="/api/spaces/s1"
      title="私人空间"
      quotaBytes={1000}
      usedBytes={20}
      maxFileBytes={100}
      maxTextBytes={1000}
      sender={() => '我'}
      canEdit={() => true}
      canRetract={() => true}
      canShare={() => true}
    />,
  )
  return { ...view, socket: FakeSocket.instances.at(-1) }
}


function stubMedia(match: (query: string) => boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: match(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
    onchange: null,
  }))
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  localStorage.clear()
  resetLocalDevice()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function boardWith(items: Item[], groups: string[] = []) {
  const view = renderBoard()
  view.socket?.emit({ type: 'snapshot', items, groups, serverTime: Date.now(), expiresAt: null })
  await screen.findByText(items[0]?.text ?? '')
  return view
}

describe('touch devices never get pin-drag / drag-to-group', () => {
  it('uses the swipe gesture when the device has no hover, even with a fine pointer', async () => {
    stubMedia((q) => q.includes('hover: none'))
    const { container } = await boardWith([item({ text: 'phone card' })], ['工作'])
    expect(container.querySelector('[data-gesture]')?.getAttribute('data-gesture')).toBe('swipe')
  })

  it('uses the swipe gesture on a coarse pointer', async () => {
    stubMedia((q) => q.includes('pointer: coarse'))
    const { container } = await boardWith([item({ text: 'tablet card' })], ['工作'])
    expect(container.querySelector('[data-gesture]')?.getAttribute('data-gesture')).toBe('swipe')
  })

  it('keeps pin-drag for a desktop mouse', async () => {
    stubMedia(() => false)
    const { container } = await boardWith([item({ text: 'desk card' })], ['工作'])
    expect(container.querySelector('[data-gesture]')?.getAttribute('data-gesture')).toBe('pin-drag')
  })
})

describe('撤回 entry points', () => {
  it('desktop: tap → 确认撤回, no press-and-hold button', async () => {
    stubMedia(() => false)
    await boardWith([item({ text: 'desk note' })])
    const card = screen.getByText('desk note').closest('li')!
    const retract = within(card).getByRole('button', { name: '撤回' })
    expect(retract.classList.contains('dd-hold')).toBe(false)
    expect(card.querySelector('.dd-hold')).toBeNull()
    fireEvent.click(retract)
    expect(within(card).getByRole('button', { name: '确认撤回' })).toBeTruthy()
  })

  it('mobile keeps the press-and-hold button', async () => {
    stubMedia((q) => q.includes('pointer: coarse'))
    await boardWith([item({ text: 'phone note' })])
    const card = screen.getByText('phone note').closest('li')!
    expect(within(card).getByRole('button', { name: '撤回' }).classList.contains('dd-hold')).toBe(true)
  })
})

describe('drag ghost', () => {
  it('names the clip and offsets below-right of the pointer', () => {
    expect(GHOST_OFFSET.x).toBeGreaterThan(0)
    expect(GHOST_OFFSET.y).toBeGreaterThan(0)
    // pointer-only: the same pointer always gives the same place, however many chips were crossed
    expect(ghostTransform(300, 200)).toBe(`translate3d(${300 + GHOST_OFFSET.x}px, ${200 + GHOST_OFFSET.y}px, 0)`)
    expect(ghostTransform(300.4, 199.6)).toBe(ghostTransform(300, 200))
    expect(ghostLabel({ id: 'a', kind: 'text', text: 'first line\nsecond' })).toBe('first line')
    expect(ghostLabel({ id: 'a', kind: 'file', name: 'a.zip', size: 3 })).toBe('a.zip')
  })

  it('a touch press on a desktop card never lifts it', async () => {
    stubMedia(() => false)
    await boardWith([item({ text: 'touch me' })], ['工作'])
    const card = screen.getByText('touch me').closest('[data-card]') as HTMLElement
    fireEvent.pointerDown(card, { button: 0, pointerType: 'touch', clientX: 50, clientY: 50, pointerId: 3 })
    for (let i = 0; i < 6; i++) fireEvent.pointerMove(window, { pointerType: 'touch', clientX: 50 - i * 10, clientY: 50 - i * 10, pointerId: 3 })
    fireEvent.pointerUp(window, { pointerType: 'touch', pointerId: 3 })
    expect(document.querySelector('[data-drag-ghost]')).toBeNull()
    expect(screen.getByRole('toolbar', { name: '分组' }).getAttribute('data-dragging')).toBeNull()
  })
})
