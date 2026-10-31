import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClipboardBoard } from '@/components/clipboard-board.tsx'
import type { Item } from '@/lib/types.ts'

class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readyState = 0
  constructor(_url: string | URL) {
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

const LONG = ['# 标题', '', ...Array.from({ length: 40 }, (_, i) => `- 第 ${i + 1} 行：很长很长的 markdown 内容`), '', '最后一行 END-MARK'].join('\n')

async function renderBoard() {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  render(
    <ClipboardBoard
      base="/api/spaces/s1"
      title="私人空间"
      quotaBytes={1000}
      usedBytes={20}
      maxFileBytes={100}
      maxTextBytes={100000}
      sender={() => '我'}
      canEdit={() => true}
      canRetract={() => true}
      canShare={() => true}
    />,
  )
  FakeSocket.instances.at(-1)?.emit({
    type: 'snapshot',
    items: [item({ id: 'long', text: LONG }), item({ id: 'short', text: '短' })],
    serverTime: Date.now(),
    expiresAt: null,
  })
  await screen.findByRole('button', { name: '展开' })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.style.overflow = ''
})

describe('RHEA-190 lt2: long text reader', () => {
  it('keeps grid cards at their own height instead of stretching the row', async () => {
    await renderBoard()
    const list = screen.getByRole('list')
    expect(list.className).toContain('items-start')
    for (const card of list.querySelectorAll('[data-clip-card]')) {
      expect(card.className.split(/\s+/)).not.toContain('h-full')
      expect(card.querySelector('[data-card]')?.className.split(/\s+/)).not.toContain('h-full')
    }
  })

  it('opens the full text in a blurred dialog from 展开, closes on Esc and returns focus', async () => {
    await renderBoard()
    const expand = screen.getByRole('button', { name: '展开' })
    expect(expand.getAttribute('aria-haspopup')).toBe('dialog')
    expand.focus()
    fireEvent.click(expand)
    const dialog = await screen.findByRole('dialog', { name: '全文' })
    expect(within(dialog).getByText(/END-MARK/)).toBeTruthy()
    expect(dialog.querySelector('[data-text-reader-backdrop]')?.className).toContain('backdrop-blur')
    expect(dialog.querySelector('[data-text-reader-scroll]')?.className).toContain('overflow-y-auto')
    expect(document.documentElement.style.overflow).toBe('hidden')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '全文' })).toBeNull())
    expect(document.documentElement.style.overflow).toBe('')
    await waitFor(() => expect(document.activeElement).toBe(expand))
  })

  it('closes when the backdrop is clicked but not when the text itself is clicked', async () => {
    await renderBoard()
    fireEvent.click(screen.getByRole('button', { name: '展开' }))
    const dialog = await screen.findByRole('dialog', { name: '全文' })
    fireEvent.click(within(dialog).getByText(/END-MARK/))
    expect(screen.getByRole('dialog', { name: '全文' })).toBeTruthy()
    fireEvent.click(dialog.querySelector('[data-text-reader-backdrop]') as Element)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '全文' })).toBeNull())
  })

  it('RHEA-190 lt3: tapping the preview text does not open the reader; only 展开 does', async () => {
    await renderBoard()
    const preview = document.querySelector('[data-text-preview]') as HTMLElement
    expect(preview.className).not.toContain('cursor-zoom-in')
    const text = preview.firstElementChild as HTMLElement
    fireEvent.pointerDown(text, { pointerId: 1, button: 0, isPrimary: true })
    fireEvent.pointerUp(text, { pointerId: 1, button: 0, isPrimary: true })
    fireEvent.click(text)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('dialog', { name: '全文' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开' }))
    const dialog = await screen.findByRole('dialog', { name: '全文' })
    // the board stays no-select (step 7), but the full text in the reader can be selected/copied
    expect(dialog.querySelector('[data-text-reader-scroll]')?.className).toContain('dd-selectable')
  })

  it('leaves short text cards without an expander', async () => {
    await renderBoard()
    expect(screen.getAllByRole('button', { name: '展开' })).toHaveLength(1)
    expect(screen.getByText('短')).toBeTruthy()
  })
})
