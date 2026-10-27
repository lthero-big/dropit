// RHEA-190 step 7: paper-style polish — no text selection on the board chrome,
// drag-a-card-onto-a-group targets, one-tap tag removal and the group dropdown.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipboardBoard } from './clipboard-board.tsx'
import { GroupBar, GroupTarget } from './board-groups.tsx'
import { TagChip } from './tag-chip.tsx'
import { DROP_PAD, chipAt, groupColor } from '@/lib/groups.ts'
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

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'clip-ui.css'), 'utf8')

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

describe('no text selection on the board', () => {
  it('marks the board as no-select but keeps fields selectable', async () => {
    const { container, socket } = renderBoard()
    socket?.emit({ type: 'snapshot', items: [item({ text: 'note' })], groups: [], serverTime: Date.now(), expiresAt: null })
    expect(await screen.findByText('note')).toBeTruthy()
    const root = container.querySelector('[data-board-root]')
    expect(root?.classList.contains('dd-noselect')).toBe(true)
    expect(root?.contains(screen.getByText('note'))).toBe(true)
    // the composer textarea lives inside the no-select board but is re-enabled by the CSS
    expect(root?.contains(screen.getByLabelText('要发送的文本'))).toBe(true)
    const rule = /\.dd-noselect\s*\{[^}]*user-select:\s*none/.exec(css)
    expect(rule).not.toBeNull()
    const reenable = /\.dd-noselect\s+:is\((.*)\)\s*\{[^}]*user-select:\s*text/.exec(css)
    expect(reenable?.[1]).toMatch(/input/)
    expect(reenable?.[1]).toMatch(/textarea/)
    expect(reenable?.[1]).toMatch(/contenteditable/)
    // only the board opts in, not the shared .dd-board surface used by the public share page
    expect(css).not.toMatch(/\.dd-board\s*\{[^}]*user-select:\s*none/)
  })
})

describe('drag a card onto a group chip', () => {
  const chips = [
    ['工作', { left: 100, right: 160, top: 10, bottom: 38 }],
    ['个人', { left: 166, right: 226, top: 10, bottom: 38 }],
  ] as const

  it('hits a chip through its padded area and picks the nearest where pads overlap', () => {
    expect(chipAt(chips, 130, 24)).toBe('工作')
    expect(chipAt(chips, 100 - DROP_PAD.x + 1, 24)).toBe('工作')
    expect(chipAt(chips, 130, 38 + DROP_PAD.y - 1)).toBe('工作')
    expect(chipAt(chips, 130, 38 + DROP_PAD.y + 2)).toBeNull()
    expect(chipAt(chips, 100 - DROP_PAD.x - 2, 24)).toBeNull()
    // the gap between the chips is covered by both pads: the closer centre wins
    expect(chipAt(chips, 162, 24)).toBe('工作')
    expect(chipAt(chips, 165, 24)).toBe('个人')
  })

  it('grows and highlights the target chip while keeping its name visible', () => {
    const refs = new Map<string, HTMLElement | null>()
    render(
      <GroupBar
        groups={['工作', '个人']}
        filter={null}
        counts={new Map([['工作', 3], ['个人', 1]])}
        total={4}
        reduced={false}
        dragging
        dropHover="工作"
        pulse={{}}
        chipRef={(key, el) => refs.set(key, el)}
        onFilter={() => {}}
        onCreate={() => true}
        onRename={() => true}
        onDelete={() => {}}
      />,
    )
    const bar = screen.getByRole('toolbar', { name: '分组' })
    expect(bar.getAttribute('data-dragging')).not.toBeNull()
    const hot = bar.querySelector<HTMLElement>('[data-group-chip="工作"]')!
    expect(hot.getAttribute('data-drop-hot')).not.toBeNull()
    expect(hot.style.zIndex).toBe('50')
    expect(hot.style.getPropertyValue('--hot')).toBe(groupColor('工作'))
    expect(hot.querySelector('[data-drop-glow]')).not.toBeNull()
    expect(within(hot).getByText('工作')).toBeTruthy()
    expect(within(hot).getByText('松手放入')).toBeTruthy()
    const other = bar.querySelector<HTMLElement>('[data-group-chip="个人"]')!
    expect(other.getAttribute('data-drop-hot')).toBeNull()
    expect(other.className).toContain('outline-dashed')
    // every group (not 全部) registers as a drop target
    expect([...refs.keys()].sort()).toEqual(['个人', '工作'].sort())
  })
})

describe('one-tap tag removal', () => {
  it('the × removes the tag without toggling the filter', () => {
    const onFilter = vi.fn()
    const onRemove = vi.fn()
    render(<TagChip name="设计" active={false} onFilter={onFilter} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: '移除标签 #设计' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onFilter).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '#设计' }))
    expect(onFilter).toHaveBeenCalledTimes(1)
  })

  it('removes a tag from a card in one click', async () => {
    const { socket } = renderBoard((url, init) => {
      if (url === '/api/spaces/s1/items/a/labels' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { tags: string[] }
        return json({ item: item({ text: 'tagged', tags: body.tags }) })
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    socket?.emit({ type: 'snapshot', items: [item({ text: 'tagged', tags: ['设计', '稿件'] })], groups: [], serverTime: Date.now(), expiresAt: null })
    expect(await screen.findByText('tagged')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除标签 #设计' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/spaces/s1/items/a/labels')).toBe(true))
    const patch = calls.find((call) => call.url === '/api/spaces/s1/items/a/labels')
    expect(patch?.init?.body).toBe(JSON.stringify({ tags: ['稿件'] }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '移除标签 #设计' })).toBeNull())
    expect(screen.getByRole('button', { name: '移除标签 #稿件' })).toBeTruthy()
  })
})

describe('composer group dropdown', () => {
  function renderTarget(value = '工作') {
    const onChange = vi.fn()
    render(<GroupTarget groups={['工作', '个人']} value={value} onChange={onChange} />)
    return { onChange, button: screen.getByRole('button', { name: '发送到分组' }) }
  }

  it('lists every group with its colour and checks the selected one', () => {
    const { button } = renderTarget()
    expect(button.getAttribute('aria-haspopup')).toBe('listbox')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const list = screen.getByRole('listbox', { name: '发送到分组' })
    const options = within(list).getAllByRole('option')
    expect(options.map((o) => o.textContent?.trim())).toEqual(['工作', '个人', '未分组'])
    const swatch = (name: string) => list.querySelector<HTMLElement>(`[data-group-swatch="${name}"]`)!
    const colour = (name: string) => swatch(name).style.getPropertyValue('--swatch')
    expect(colour('工作')).toBe(groupColor('工作'))
    expect(colour('个人')).toBe(groupColor('个人'))
    expect(colour('工作')).not.toBe(colour('个人'))
    expect(swatch('工作').style.background).toBe('var(--swatch)')
    const selected = within(list).getByRole('option', { name: '工作' })
    expect(selected.getAttribute('aria-selected')).toBe('true')
    expect(selected.querySelector('[data-group-check]')).not.toBeNull()
    expect(within(list).getByRole('option', { name: '个人' }).querySelector('[data-group-check]')).toBeNull()
  })

  it('opens, moves and picks with the keyboard', async () => {
    const { button, onChange } = renderTarget()
    button.focus()
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    const list = screen.getByRole('listbox')
    const activeName = () => document.getElementById(button.getAttribute('aria-activedescendant') ?? '')?.textContent?.trim()
    expect(activeName()).toBe('工作')
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    expect(activeName()).toBe('个人')
    fireEvent.keyDown(button, { key: 'End' })
    expect(activeName()).toBe('未分组')
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    expect(activeName()).toBe('工作')
    fireEvent.keyDown(button, { key: 'ArrowUp' })
    expect(activeName()).toBe('未分组')
    fireEvent.keyDown(button, { key: 'Home' })
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    expect(list.querySelector('[data-active]')?.textContent?.trim()).toBe('个人')
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('个人')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(document.activeElement).toBe(button)

    fireEvent.keyDown(button, { key: 'Enter' })
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(button, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
