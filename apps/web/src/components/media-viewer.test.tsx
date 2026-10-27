/**
 * RHEA-190 step 6: images on the board and the share page open in the RHEA-191
 * demo viewer (thumbnail morph → full preview, click / wheel / + − zoom, drag
 * when zoomed, Esc / backdrop close); video and audio use the demo players.
 */
import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ClipboardBoard } from './clipboard-board.tsx'
import { MediaViewer, type ViewerMedia } from './clip-media.tsx'
import { SharePage } from '@/pages/share-page.tsx'
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

/** every Image "loads" on the next tick, so the viewer can swap to the full preview */
class LoadingImage {
  static loaded: string[] = []
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  complete = false
  #src = ''
  get src() {
    return this.#src
  }
  set src(value: string) {
    this.#src = value
    setTimeout(() => {
      LoadingImage.loaded.push(value)
      this.onload?.()
    }, 0)
  }
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

function viewerImage() {
  return document.querySelector('[data-viewer-image]')
}

beforeEach(() => {
  LoadingImage.loaded = []
  vi.stubGlobal('Image', LoadingImage)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function Harness({ media, onClose }: { media: ViewerMedia; onClose?: () => void }) {
  const anchor = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(true)
  return (
    <div className="dd-board" ref={anchor}>
      <MediaViewer
        media={open ? media : null}
        anchor={anchor}
        reduced
        onClose={() => {
          onClose?.()
          setOpen(false)
        }}
      />
    </div>
  )
}

describe('MediaViewer (demo viewer)', () => {
  const photo: ViewerMedia = { type: 'image', src: '/thumb/a', full: '/preview/a', name: 'a.png', meta: '2.0 KB', layoutId: 'img-a' }

  it('opens on the cached thumbnail and swaps to the full preview once it has loaded', async () => {
    render(<Harness media={photo} />)
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('a.png')
    expect(viewerImage()?.getAttribute('src')).toBe('/thumb/a')
    expect(viewerImage()?.getAttribute('data-viewer-image')).toBe('thumbnail')
    await waitFor(() => expect(viewerImage()?.getAttribute('src')).toBe('/preview/a'))
    expect(viewerImage()?.getAttribute('data-viewer-image')).toBe('full')
    expect(screen.getByText('2.0 KB')).toBeTruthy()
    expect(screen.getByText('点击图片放大 · 滚轮 / + − 缩放 · 放大后可拖动 · Esc 关闭')).toBeTruthy()
  })

  it('zooms through 100% / 200% / 350% with the buttons, + − keys and the wheel', () => {
    render(<Harness media={photo} />)
    expect(screen.getByText('100%')).toBeTruthy()
    expect((screen.getByRole('button', { name: '缩小' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(screen.getByText('200%')).toBeTruthy()
    fireEvent.keyDown(window, { key: '+' })
    expect(screen.getByText('350%')).toBeTruthy()
    expect((screen.getByRole('button', { name: '放大' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: '-' })
    expect(screen.getByText('200%')).toBeTruthy()
    const stage = viewerImage()?.parentElement
    if (!stage) throw new Error('missing stage')
    fireEvent.wheel(stage, { deltaY: 100 })
    expect(screen.getByText('100%')).toBeTruthy()
    fireEvent.wheel(stage, { deltaY: -100 })
    expect(screen.getByText('200%')).toBeTruthy()
  })

  it('closes from Escape, the close button and the backdrop', async () => {
    const onClose = vi.fn()
    const first = render(<Harness media={photo} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    first.unmount()
    render(<Harness media={photo} onClose={onClose} />)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭（Esc）')
    fireEvent.click(screen.getByRole('button', { name: '关闭（Esc）' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    cleanup()
    render(<Harness media={photo} onClose={onClose} />)
    const stage = viewerImage()?.parentElement
    if (!stage) throw new Error('missing stage')
    fireEvent.click(stage)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('plays a video with native controls and no zoom chrome', () => {
    render(<Harness media={{ type: 'video', src: '/media/v', name: 'clip.mp4' }} />)
    const video = document.querySelector('video')
    expect(video?.getAttribute('src')).toBe('/media/v')
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(screen.queryByRole('button', { name: '放大' })).toBeNull()
    expect(screen.queryByText('点击图片放大 · 滚轮 / + − 缩放 · 放大后可拖动 · Esc 关闭')).toBeNull()
  })
})

function renderBoard(base: string, items: Item[]) {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  window.WebSocket = FakeSocket as unknown as typeof WebSocket
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 })),
  )
  render(
    <ClipboardBoard
      base={base}
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
  act(() => {
    FakeSocket.instances.at(-1)?.emit({ type: 'snapshot', items, serverTime: Date.now(), expiresAt: null })
  })
}

describe('viewer entry points', () => {
  it('opens a space image in the demo viewer with its preview, and skips files without thumbnails', async () => {
    const note: Item = { ...imageItem('note', 'notes.txt', 1500), hasThumbnail: false, mime: 'text/plain' }
    renderBoard('/api/spaces/s1', [imageItem('a', 'a.png', 2000), note])
    expect(screen.queryByRole('button', { name: '查看 notes.txt' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看 a.png' }))
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('a.png')
    expect(viewerImage()?.getAttribute('src')).toBe('/api/spaces/s1/items/a/thumbnail')
    await waitFor(() => expect(viewerImage()?.getAttribute('src')).toBe('/api/spaces/s1/items/a/preview'))
    expect(LoadingImage.loaded.some((url) => url.includes('/download'))).toBe(false)
    // old lightbox chrome is gone; the demo viewer carries its own download link
    expect(screen.queryByRole('link', { name: '下载原图' })).toBeNull()
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('href')).toBe('/api/spaces/s1/items/a/download')
    // a single image has no gallery controls
    expect(screen.queryByRole('button', { name: '下一张' })).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('pages through every board image with ← / →, the step buttons and a counter', async () => {
    renderBoard('/api/spaces/s1', [imageItem('a', 'a.png', 3000), imageItem('b', 'b.png', 2000), imageItem('c', 'c.png', 1000)])
    fireEvent.click(screen.getByRole('button', { name: '查看 a.png' }))
    expect(document.querySelector('[data-viewer-count]')?.textContent).toBe('1 / 3')
    expect((screen.getByRole('button', { name: '上一张' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('b.png')
    fireEvent.click(screen.getByRole('button', { name: '下一张' }))
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('c.png')
    expect(document.querySelector('[data-viewer-count]')?.textContent).toBe('3 / 3')
    expect((screen.getByRole('button', { name: '下一张' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('b.png')
    // stepped-away images fade out; the one for b swaps to its preview once loaded
    await waitFor(() => expect(document.querySelector('[data-full-src="/api/spaces/s1/items/b/preview"]')?.getAttribute('src')).toBe('/api/spaces/s1/items/b/preview'))
  })

  it('uses the room preview route for a room image', async () => {
    renderBoard('/api/rooms/room-token', [imageItem('room-pic', 'room.png', 2000)])
    fireEvent.click(screen.getByRole('button', { name: '查看 room.png' }))
    await waitFor(() => expect(viewerImage()?.getAttribute('src')).toBe('/api/rooms/room-token/items/room-pic/preview'))
  })
})

function renderShare(item: Record<string, unknown>) {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url === '/api/s/tok') {
        return new Response(
          JSON.stringify({ item: { kind: 'file', text: null, createdAt: 1, expiresAt: 9, ...item }, linkExpiresAt: null, views: 1, maxViews: null, access: 'ticket' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(null, { status: 200 })
    }),
  )
  render(
    <MemoryRouter initialEntries={['/s/tok']}>
      <Routes>
        <Route path="/s/:token" element={<SharePage />} />
      </Routes>
    </MemoryRouter>,
  )
  return urls
}

describe('share page media', () => {
  it('opens a shared image in the demo viewer without touching the original file', async () => {
    const urls = renderShare({ filename: 'shot.png', mime: 'image/png', size: 4096, hasThumbnail: true })
    const trigger = await screen.findByRole('button', { name: '查看 shot.png' })
    expect(trigger.querySelector('img')?.getAttribute('src')).toBe('/api/s/tok/thumbnail?access=ticket')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
    await waitFor(() => expect(viewerImage()?.getAttribute('src')).toBe('/api/s/tok/preview?access=ticket'))
    for (const img of document.querySelectorAll('img')) expect(img.getAttribute('src') ?? '').not.toContain('/file')
    expect(urls.some((url) => url.includes('/file'))).toBe(false)
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('href')).toBe('/api/s/tok/file?access=ticket')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('plays a shared video with the demo inline player', async () => {
    renderShare({ filename: 'rec.mp4', mime: 'video/mp4', size: 4096, hasThumbnail: false })
    await screen.findByRole('button', { name: '播放 rec.mp4' })
    expect(document.querySelector('video')?.getAttribute('src')).toBe('/api/s/tok/media?access=ticket')
    expect(document.querySelector('video')?.hasAttribute('controls')).toBe(false)
  })

  it('plays shared audio with the demo audio player', async () => {
    renderShare({ filename: 'memo.mp3', mime: 'audio/mpeg', size: 4096, hasThumbnail: false })
    await screen.findByRole('button', { name: '播放 memo.mp3' })
    expect(screen.getByRole('slider', { name: '播放进度' })).toBeTruthy()
    expect(document.querySelector('audio')?.getAttribute('src')).toBe('/api/s/tok/media?access=ticket')
    expect(document.querySelector('audio')?.hasAttribute('controls')).toBe(false)
  })
})
