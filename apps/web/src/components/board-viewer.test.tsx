// Board entry points for the image viewer (moved from the deleted
// image-lightbox.test.tsx in RHEA-190 step 7, when the old ImageLightbox went away).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

const fetched: string[] = []

function dialog() {
  return screen.getByRole('dialog')
}

function imageItem(id: string, filename: string, createdAt: number): Item {
  return {
    id,
    spaceId: 's1',
    userId: 'u1',
    kind: 'file',
    text: null,
    filename,
    mime: 'image/png',
    size: 2048,
    hasThumbnail: true,
    createdAt,
    updatedAt: createdAt,
    expiresAt: Date.now() + 86_400_000,
    pinned: false,
    tags: [],
  }
}

afterEach(() => {
  cleanup()
  document.documentElement.className = ''
  document.body.style.overflow = ''
  document.documentElement.style.overflow = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('board image viewer entry points', () => {
  it('opens the preview for image clips in a space and skips files without thumbnails', () => {
    FakeSocket.instances = []
    fetched.length = 0
    vi.stubGlobal('WebSocket', FakeSocket)
    window.WebSocket = FakeSocket as unknown as typeof WebSocket
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        fetched.push(String(input))
        return new Response(null, { status: 200 })
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
        canEdit={() => false}
        canRetract={() => false}
        canShare={() => false}
      />,
    )
    const note: Item = {
      ...imageItem('note', 'notes.txt', 1500),
      hasThumbnail: false,
      mime: 'text/plain',
    }
    act(() => {
      FakeSocket.instances.at(-1)?.emit({
        type: 'snapshot',
        items: [imageItem('a', 'a.png', 2000), note, imageItem('b', 'b.png', 1000)],
        serverTime: Date.now(),
        expiresAt: null,
      })
    })
    expect(screen.queryByRole('button', { name: '查看 notes.txt' })).toBeNull()
    const trigger = screen.getByRole('button', { name: '查看 a.png' })
    trigger.focus()
    fireEvent.click(trigger)
    // RHEA-190 step 6: the board opens the demo viewer — it starts from the card thumbnail and swaps in the preview.
    const image = () => document.querySelector('[data-viewer-image]')
    expect(image()?.getAttribute('src')).toBe('/api/spaces/s1/items/a/thumbnail')
    expect(image()?.getAttribute('data-full-src')).toBe('/api/spaces/s1/items/a/preview')
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('href')).toBe('/api/spaces/s1/items/a/download')
    expect(fetched.some((url) => url.includes('/download'))).toBe(false)
    expect(document.querySelector('[data-viewer-count]')?.textContent).toBe('1 / 2')
    expect((screen.getByRole('button', { name: '上一张' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(dialog().getAttribute('aria-label')).toBe('b.png')
    expect(document.querySelector('[data-viewer-count]')?.textContent).toBe('2 / 2')
    expect((screen.getByRole('button', { name: '下一张' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('href')).toBe('/api/spaces/s1/items/b/download')
    fireEvent.click(screen.getByRole('button', { name: '上一张' }))
    expect(dialog().getAttribute('aria-label')).toBe('a.png')
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(screen.getByText('200%')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: '-' })
    expect(screen.getByText('100%')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })

  it('uses the room preview route for a room image', () => {
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    window.WebSocket = FakeSocket as unknown as typeof WebSocket
    render(
      <ClipboardBoard
        base="/api/rooms/room-token"
        title="临时房间"
        quotaBytes={1000}
        usedBytes={0}
        maxFileBytes={500}
        maxTextBytes={1000}
        sender={() => '访客'}
        canEdit={() => false}
        canRetract={() => false}
        canShare={() => false}
      />,
    )
    act(() => {
      FakeSocket.instances.at(-1)?.emit({
        type: 'snapshot',
        items: [imageItem('room-pic', 'room.png', 2000)],
        serverTime: Date.now(),
        expiresAt: null,
      })
    })
    fireEvent.click(screen.getByRole('button', { name: '查看 room.png' }))
    expect(document.querySelector('[data-viewer-image]')?.getAttribute('data-full-src')).toBe('/api/rooms/room-token/items/room-pic/preview')
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('href')).toBe('/api/rooms/room-token/items/room-pic/download')
    // a single image has no gallery controls
    expect(screen.queryByRole('button', { name: '下一张' })).toBeNull()
  })
})
