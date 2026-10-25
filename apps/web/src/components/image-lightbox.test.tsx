import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ClipboardBoard } from './clipboard-board.tsx'
import { ImageLightbox, type LightboxSlide } from './image-lightbox.tsx'
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

const fetched: string[] = []

function slide(partial: Partial<LightboxSlide> & Pick<LightboxSlide, 'key' | 'filename'>): LightboxSlide {
  return {
    byteSize: 2048,
    thumbnailSrc: `/thumb/${partial.key}`,
    previewSrc: `/preview/${partial.key}`,
    downloadHref: `/download/${partial.key}`,
    ...partial,
  }
}

const pair = [slide({ key: 'a', filename: 'a.png' }), slide({ key: 'b', filename: 'b.png', byteSize: 4096 })]

function renderOpen(slides: LightboxSlide[] = pair, index = 0, onClose = vi.fn()) {
  const view = render(<ImageLightbox slides={slides} index={index} onClose={onClose} onIndex={() => {}} />)
  return { ...view, onClose }
}

function dialog() {
  return screen.getByRole('dialog')
}

function frame() {
  const node = screen.getByTestId('lightbox-frame')
  if (!(node instanceof HTMLElement)) throw new Error('missing frame')
  return node
}

function backdrop() {
  const node = screen.getByTestId('lightbox-backdrop')
  if (!(node instanceof HTMLElement)) throw new Error('missing backdrop')
  return node
}

function chrome() {
  const node = screen.getByTestId('lightbox-chrome')
  if (!(node instanceof HTMLElement)) throw new Error('missing chrome')
  return node
}

function installBackdrop(options: { motion?: boolean; transparency?: boolean; supports?: boolean }) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches:
      (options.motion === true && query.includes('prefers-reduced-motion')) ||
      (options.transparency === true && query.includes('prefers-reduced-transparency')),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false
    },
    onchange: null,
  }))
  const supported = options.supports !== false
  vi.stubGlobal('CSS', {
    supports: (property: string) => supported && String(property).includes('backdrop-filter'),
  })
}

function channel(color: string, index: number): number {
  const value = color.trim()
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    const full = hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex
    const n = Number.parseInt(full, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255][index] ?? 0
  }
  const parts = value.match(/[\d.]+/g) ?? []
  return Number(parts[index] ?? 0)
}

function luminance(color: string): number {
  const linear = [0, 1, 2].map((index) => {
    const value = channel(color, index) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function pointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp', pointerId: number, x: number, y: number) {
  fireEvent[type](frame(), { pointerId, clientX: x, clientY: y, button: 0, pointerType: 'touch' })
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

describe('ImageLightbox', () => {
  it('opens on a thumbnail, closes from Escape, the backdrop, and the close button, and restores focus', () => {
    function Harness() {
      const [index, setIndex] = useState<number | null>(null)
      return (
        <>
          <button type="button" onClick={() => setIndex(0)}>
            查看 a.png
          </button>
          {index === null ? null : <ImageLightbox slides={pair} index={index} onClose={() => setIndex(null)} onIndex={setIndex} />}
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '查看 a.png' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(dialog().getAttribute('aria-label')).toBe('图片预览 a.png')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭' }))
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.documentElement.style.overflow).toBe('hidden')
    fireEvent.click(frame())
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(document.body.style.overflow).toBe('')

    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(backdrop())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('traps focus and moves between images with the keyboard and buttons', () => {
    function Harness() {
      const [index, setIndex] = useState(0)
      return <ImageLightbox slides={pair} index={index} onClose={() => undefined} onIndex={setIndex} />
    }
    render(<Harness />)
    const close = screen.getByRole('button', { name: '关闭' })
    const download = screen.getByRole('link', { name: '下载原图' })
    expect(document.activeElement).toBe(close)
    download.focus()
    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(download)

    expect((screen.getByRole('button', { name: '上一张' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(dialog().getAttribute('aria-label')).toBe('图片预览 a.png')
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(dialog().getAttribute('aria-label')).toBe('图片预览 b.png')
    expect((screen.getByRole('button', { name: '下一张' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(dialog().getAttribute('aria-label')).toBe('图片预览 b.png')
    fireEvent.click(screen.getByRole('button', { name: '上一张' }))
    expect(dialog().getAttribute('aria-label')).toBe('图片预览 a.png')
    expect(screen.getByRole('link', { name: '下载原图' }).getAttribute('href')).toBe('/download/a')
    for (const img of document.querySelectorAll('img')) expect(img.getAttribute('src') ?? '').not.toContain('/download/')
  })

  it('keeps zoom inside 1x–4x for buttons, keys, the wheel, pinching, and double-click', () => {
    renderOpen()
    const zoomIn = () => screen.getByRole('button', { name: '放大' }) as HTMLButtonElement
    const zoomOut = () => screen.getByRole('button', { name: '缩小' }) as HTMLButtonElement
    expect(zoomOut().disabled).toBe(true)
    expect(dialog().dataset.scale).toBe('1')
    fireEvent.click(zoomOut())
    expect(dialog().dataset.scale).toBe('1')
    for (let step = 0; step < 6; step += 1) fireEvent.click(zoomIn())
    expect(dialog().dataset.scale).toBe('4')
    expect(zoomIn().disabled).toBe(true)
    fireEvent.click(zoomIn())
    expect(dialog().dataset.scale).toBe('4')
    fireEvent.keyDown(document.body, { key: '+' })
    expect(dialog().dataset.scale).toBe('4')
    for (let step = 0; step < 8; step += 1) fireEvent.click(zoomOut())
    expect(dialog().dataset.scale).toBe('1')
    expect(zoomOut().disabled).toBe(true)
    fireEvent.keyDown(document.body, { key: '-' })
    expect(dialog().dataset.scale).toBe('1')

    for (let step = 0; step < 12; step += 1) fireEvent.wheel(dialog(), { deltaY: -120 })
    expect(Number(dialog().dataset.scale)).toBe(4)
    for (let step = 0; step < 24; step += 1) fireEvent.wheel(dialog(), { deltaY: 120 })
    expect(Number(dialog().dataset.scale)).toBe(1)

    fireEvent.doubleClick(frame())
    expect(dialog().dataset.scale).toBe('2')
    fireEvent.doubleClick(frame())
    expect(dialog().dataset.scale).toBe('1')

    pointer('pointerDown', 1, 0, 0)
    pointer('pointerDown', 2, 100, 0)
    pointer('pointerMove', 2, 500, 0)
    expect(Number(dialog().dataset.scale)).toBe(4)
    pointer('pointerUp', 1, 0, 0)
    pointer('pointerUp', 2, 500, 0)
  })

  it('pans while zoomed and closes on a downward swipe at 1x', () => {
    const onClose = vi.fn()
    renderOpen(pair, 0, onClose)
    fireEvent.doubleClick(frame())
    pointer('pointerDown', 1, 20, 20)
    pointer('pointerMove', 1, 20, 5020)
    const limit = (window.innerHeight || document.documentElement.clientHeight || 768) * 0.5
    expect(Number(frame().dataset.panY)).toBeCloseTo(limit, 3)
    expect(onClose).not.toHaveBeenCalled()
    pointer('pointerUp', 1, 20, 5020)
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.doubleClick(frame())
    expect(dialog().dataset.scale).toBe('1')
    pointer('pointerDown', 1, 10, 10)
    pointer('pointerMove', 1, 220, 30)
    pointer('pointerUp', 1, 220, 30)
    expect(onClose).not.toHaveBeenCalled()
    pointer('pointerDown', 1, 10, 10)
    pointer('pointerMove', 1, 16, 40)
    pointer('pointerUp', 1, 16, 40)
    expect(onClose).not.toHaveBeenCalled()
    pointer('pointerDown', 1, 10, 10)
    pointer('pointerMove', 1, 12, 160)
    pointer('pointerUp', 1, 12, 160)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the thumbnail while the preview loads, then the filename and pixel size', () => {
    renderOpen([slide({ key: 'a', filename: 'shot.png', byteSize: 2048 })])
    expect(screen.getByRole('status').textContent).toContain('正在加载大图')
    expect(document.querySelector('[data-lightbox-image="placeholder"]')?.getAttribute('src')).toBe('/thumb/a')
    const preview = document.querySelector('[data-lightbox-image="preview"]')
    expect(preview?.getAttribute('src')).toBe('/preview/a')
    expect(screen.getByTestId('lightbox-meta').textContent).toBe('尺寸 2.0 KB')
    if (!(preview instanceof HTMLImageElement)) throw new Error('missing preview')
    Object.defineProperty(preview, 'naturalWidth', { configurable: true, get: () => 800 })
    Object.defineProperty(preview, 'naturalHeight', { configurable: true, get: () => 600 })
    fireEvent.load(preview)
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.querySelector('[data-lightbox-image="placeholder"]')).toBeNull()
    expect(screen.getByTestId('lightbox-meta').textContent).toBe('尺寸 800 × 600 · 2.0 KB')
    expect(screen.getByText('shot.png')).toBeTruthy()
  })

  it('shows an error and keeps the thumbnail when the preview fails', () => {
    renderOpen([slide({ key: 'a', filename: 'shot.png' })])
    const preview = document.querySelector('[data-lightbox-image="preview"]')
    if (!(preview instanceof HTMLImageElement)) throw new Error('missing preview')
    fireEvent.error(preview)
    expect(screen.getByRole('alert').textContent).toContain('大图加载失败')
    expect(document.querySelector('[data-lightbox-image="placeholder"]')?.getAttribute('src')).toBe('/thumb/a')
    expect(screen.getByRole('link', { name: '下载原图' }).getAttribute('href')).toBe('/download/a')
  })

  it('blurs the backdrop and falls back when blur is unsupported or reduced', () => {
    installBackdrop({ supports: true })
    const view = renderOpen([slide({ key: 'a', filename: 'shot.png' })])
    expect(backdrop().style.backdropFilter).toBe('blur(2px)')
    expect(backdrop().getAttribute('style')).toContain('blur(2px)')
    expect(backdrop().style.backgroundColor.replaceAll(' ', '')).toBe('rgba(10,10,10,0.45)')
    expect(backdrop().style.transition).toBe('opacity 160ms ease')
    expect(document.querySelectorAll('[data-progressive-blur]')).toHaveLength(2)
    const topEdge = document.querySelector('[data-progressive-blur="top"]') as HTMLElement
    expect(topEdge.style.maskImage).toBe('')
    expect(topEdge.style.backdropFilter).toBe('')
    const layers = [...document.querySelectorAll('[data-progressive-blur-layer]')].filter((node): node is HTMLElement => node instanceof HTMLElement)
    expect(layers).toHaveLength(10)
    const blurs = layers.map((node) => Number(node.style.backdropFilter.match(/blur\((\d+)px\)/)?.[1] ?? 0))
    expect(Math.max(...blurs)).toBeGreaterThan(Math.min(...blurs))
    expect(Math.max(...blurs)).toBeGreaterThanOrEqual(32)
    expect(layers.every((node) => node.style.maskImage.includes('linear-gradient'))).toBe(true)
    const topBlurs = layers.filter((node) => node.dataset.progressiveBlurLayer === 'top').map((node) => Number(node.style.backdropFilter.match(/blur\((\d+)px\)/)?.[1] ?? 0))
    expect(topBlurs[0]).toBeLessThan(topBlurs[topBlurs.length - 1] ?? 0)
    view.unmount()

    installBackdrop({ supports: false })
    renderOpen([slide({ key: 'a', filename: 'shot.png' })])
    expect(backdrop().style.backdropFilter).toBe('none')
    expect(backdrop().style.backgroundColor.replaceAll(' ', '')).toBe('rgba(10,10,10,0.94)')
    expect(backdrop().style.transition).toBe('opacity 160ms ease')
    expect(document.querySelector('[data-progressive-blur]')).toBeNull()
    cleanup()

    installBackdrop({ supports: true, transparency: true })
    renderOpen([slide({ key: 'a', filename: 'shot.png' })])
    expect(backdrop().style.backdropFilter).toBe('none')
    expect(backdrop().style.backgroundColor.replaceAll(' ', '')).toBe('rgba(10,10,10,0.94)')
    expect(backdrop().style.transition).toBe('none')
    cleanup()

    installBackdrop({ supports: true, motion: true })
    renderOpen([slide({ key: 'a', filename: 'shot.png' })])
    expect(dialog().dataset.backdrop).toBe('solid')
    expect(backdrop().style.backdropFilter).toBe('none')
    expect(backdrop().style.transition).toBe('none')
    expect(Number(backdrop().style.backgroundColor.replaceAll(' ', '').match(/0\.\d+/)?.[0])).toBeGreaterThan(0.9)
  })

  it('keeps chrome contrast in light and dark themes and insets for the safe area', () => {
    installBackdrop({ supports: true })
    renderOpen([slide({ key: 'a', filename: 'shot.png' })])
    const toolbar = screen.getByTestId('lightbox-toolbar')
    for (const node of [chrome(), toolbar]) {
      expect(node.style.borderRadius).toBe('0px')
      expect(node.style.border).toContain('2px')
      expect(contrast(node.style.color, node.style.backgroundColor)).toBeGreaterThan(7)
    }
    const light = chrome().style.color
    const lightBg = chrome().style.backgroundColor
    document.documentElement.classList.add('dark')
    cleanup()
    renderOpen([slide({ key: 'a', filename: 'shot.png' })])
    expect(chrome().style.color).toBe(light)
    expect(chrome().style.backgroundColor).toBe(lightBg)
    expect(contrast(chrome().style.color, chrome().style.backgroundColor)).toBeGreaterThan(7)
    expect(dialog().className).toContain('lightbox-safe')
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'), 'utf8')
    expect(css).toContain('padding-top: env(safe-area-inset-top)')
    expect(css).toContain('padding-right: env(safe-area-inset-right)')
    expect(css).toContain('padding-bottom: env(safe-area-inset-bottom)')
    expect(css).toContain('padding-left: env(safe-area-inset-left)')
    expect(frame().style.touchAction).toBe('none')
  })
})

describe('lightbox entry points', () => {
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
    expect(document.querySelector('[data-lightbox-image="preview"]')?.getAttribute('src')).toBe('/api/spaces/s1/items/a/preview')
    expect(document.querySelector('[data-lightbox-image="placeholder"]')?.getAttribute('src')).toBe('/api/spaces/s1/items/a/thumbnail')
    expect(screen.getByRole('link', { name: '下载原图' }).getAttribute('href')).toBe('/api/spaces/s1/items/a/download')
    expect(fetched.some((url) => url.includes('/download'))).toBe(false)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(dialog().getAttribute('aria-label')).toBe('图片预览 b.png')
    expect(screen.getByRole('link', { name: '下载原图' }).getAttribute('href')).toBe('/api/spaces/s1/items/b/download')
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
    expect(document.querySelector('[data-lightbox-image="preview"]')?.getAttribute('src')).toBe('/api/rooms/room-token/items/room-pic/preview')
    expect(screen.getByRole('link', { name: '下载原图' }).getAttribute('href')).toBe('/api/rooms/room-token/items/room-pic/download')
  })

  it('opens a single share image with no previous or next control', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        urls.push(url)
        if (url === '/api/s/tok') {
          return new Response(
            JSON.stringify({
              item: {
                kind: 'file',
                text: null,
                filename: 'shot.png',
                mime: 'image/png',
                size: 4096,
                hasThumbnail: true,
                createdAt: 1,
                expiresAt: 9,
              },
              linkExpiresAt: null,
              views: 1,
              maxViews: null,
              access: 'ticket',
            }),
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
    const trigger = await screen.findByRole('button', { name: '查看 shot.png' })
    expect(trigger.querySelector('img')?.getAttribute('src')).toBe('/api/s/tok/thumbnail?access=ticket')
    trigger.focus()
    fireEvent.click(trigger)
    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(screen.queryByRole('button', { name: '上一张' })).toBeNull()
    expect(screen.queryByRole('button', { name: '下一张' })).toBeNull()
    expect(document.querySelector('[data-lightbox-image="preview"]')?.getAttribute('src')).toBe('/api/s/tok/preview?access=ticket')
    const download = screen.getByRole('link', { name: '下载原图' })
    expect(download.getAttribute('href')).toBe('/api/s/tok/file?access=ticket')
    for (const img of document.querySelectorAll('img')) expect(img.getAttribute('src') ?? '').not.toContain('/file')
    expect(urls.some((url) => url.includes('/file'))).toBe(false)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(dialog().getAttribute('aria-label')).toBe('图片预览 shot.png')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

