import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClipboardBoard } from './clipboard-board.tsx'
import type { Item } from '@/lib/types.ts'

class FakeSocket {
  static instances: FakeSocket[] = []
  url: string
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readyState = 1

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

function clip(partial: Partial<Item> & Pick<Item, 'id'>): Item {
  return {
    spaceId: 's1',
    userId: 'u1',
    kind: 'text',
    text: 'keep me',
    filename: null,
    mime: null,
    size: 7,
    hasThumbnail: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    expiresAt: Date.now() + 3_600_000,
    pinned: false,
    tags: [],
    ...partial,
  }
}

const deletes: string[] = []

function renderBoard() {
  FakeSocket.instances = []
  deletes.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
  window.WebSocket = FakeSocket as unknown as typeof WebSocket
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      deletes.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return new Response(null, { status: 204 })
    }),
  )
  render(
    <ClipboardBoard
      base="/api/spaces/s1"
      title="私人空间"
      quotaBytes={1000}
      usedBytes={0}
      maxFileBytes={500}
      maxTextBytes={1000}
      sender={() => '我'}
      canEdit={() => true}
      canRetract={() => true}
      canShare={() => true}
    />,
  )
  act(() => {
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [clip({ id: 'note', text: 'keep me' }), clip({ id: 'file', kind: 'file', text: null, filename: 'notes.bin', mime: 'application/octet-stream' })],
      serverTime: Date.now(),
      expiresAt: null,
    })
  })
}

function note() {
  const row = screen.getByText('keep me').closest('li')
  if (!row) throw new Error('missing note')
  return row
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('retract confirmation', () => {
  it('asks again, then deletes on the second click', async () => {
    renderBoard()
    const row = note()
    fireEvent.click(withinRow(row, '撤回'))
    const confirm = withinRow(row, '确认撤回')
    expect(confirm.textContent).toContain('确认')
    expect(confirm.className).toContain('bg-primary')
    fireEvent.pointerDown(confirm)
    fireEvent.click(confirm)
    await waitFor(() => expect(deletes.some((call) => call.startsWith('DELETE '))).toBe(true))
    expect(deletes.some((call) => call.includes('/api/spaces/s1/items/note'))).toBe(true)
    await waitFor(() => expect(screen.queryByText('keep me')).toBeNull())
  })

  it('cancels when the pointer goes outside, on Escape, and after 3 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    renderBoard()
    const row = note()
    fireEvent.click(withinRow(row, '撤回'))
    expect(withinRow(row, '确认撤回')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(row.querySelector('[data-retract="confirm"]')).toBeNull()
    expect(withinRow(row, '撤回')).toBeTruthy()

    fireEvent.click(withinRow(row, '撤回'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(row.querySelector('[data-retract="confirm"]')).toBeNull()

    fireEvent.click(withinRow(row, '撤回'))
    act(() => {
      vi.advanceTimersByTime(2999)
    })
    expect(withinRow(row, '确认撤回')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(row.querySelector('[data-retract="confirm"]')).toBeNull()
    expect(withinRow(row, '撤回')).toBeTruthy()
    expect(deletes.some((call) => call.startsWith('DELETE '))).toBe(false)
  })

  it('copies a file download link from the same icon as text', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
    renderBoard()
    const file = screen.getByText('notes.bin').closest('li')
    if (!file) throw new Error('missing file')
    fireEvent.click(withinRow(file, '复制'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/api\/spaces\/s1\/items\/file\/download$/)))
    expect(file.querySelector('[data-slot="expand-capsule"]')).toBeTruthy()
  })
})

function withinRow(row: Element, name: string) {
  const button = [...row.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === name || node.textContent === name)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${name}`)
  return button
}
