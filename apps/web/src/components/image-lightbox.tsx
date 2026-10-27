import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { formatBytes } from '@/lib/format.ts'

export type LightboxSlide = {
  key: string
  filename: string
  byteSize: number
  thumbnailSrc: string
  previewSrc: string
  downloadHref: string
}

const MIN_SCALE = 1
const MAX_SCALE = 4
const ZOOM_STEP = 0.5
const SWIPE_CLOSE_PX = 96
const CHROME_FG = '#f5f5f5'
const CHROME_BG = '#0a0a0a'
const BLUR_BG = 'rgba(10, 10, 10, 0.45)'
const SOLID_BG = 'rgba(10, 10, 10, 0.94)'

type Point = { x: number; y: number }
type Phase = 'loading' | 'ready' | 'error'

const chromeStyle: CSSProperties = {
  color: CHROME_FG,
  backgroundColor: CHROME_BG,
  border: `2px solid ${CHROME_FG}`,
  borderRadius: 0,
}

const controlStyle: CSSProperties = {
  ...chromeStyle,
  minWidth: 40,
  minHeight: 40,
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return MIN_SCALE
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

function viewport(): { width: number; height: number } {
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 1024,
    height: window.innerHeight || document.documentElement.clientHeight || 768,
  }
}

function clampPan(x: number, y: number, scale: number): Point {
  if (scale <= MIN_SCALE) return { x: 0, y: 0 }
  const { width, height } = viewport()
  const limitX = width * (scale - 1) * 0.5
  const limitY = height * (scale - 1) * 0.5
  return {
    x: Math.min(limitX, Math.max(-limitX, x)),
    y: Math.min(limitY, Math.max(-limitY, y)),
  }
}

function mediaMatches(query: string): boolean {
  if (typeof window.matchMedia !== 'function') return false
  return window.matchMedia(query).matches
}

function supportsBackdropBlur(): boolean {
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('backdrop-filter', 'blur(8px)') || CSS.supports('-webkit-backdrop-filter', 'blur(8px)')
  }
  return typeof document !== 'undefined' && 'backdropFilter' in document.documentElement.style
}

function readBackdrop(): { blur: boolean; transition: string } {
  const quiet = mediaMatches('(prefers-reduced-motion: reduce)') || mediaMatches('(prefers-reduced-transparency: reduce)')
  return {
    blur: supportsBackdropBlur() && !quiet,
    transition: quiet ? 'none' : 'opacity 160ms ease',
  }
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')).filter((node) => !node.hasAttribute('disabled'))
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

const PROGRESSIVE_LAYERS = [
  { blur: 4, stop: 100 },
  { blur: 10, stop: 78 },
  { blur: 18, stop: 56 },
  { blur: 32, stop: 34 },
  { blur: 48, stop: 16 },
] as const

function layerStyle(edge: 'top' | 'bottom', blur: number, stop: number): CSSProperties {
  const mask =
    edge === 'top'
      ? `linear-gradient(to bottom, #000 0%, transparent ${stop}%)`
      : `linear-gradient(to top, #000 0%, transparent ${stop}%)`
  return {
    backdropFilter: `blur(${blur}px)`,
    WebkitBackdropFilter: `blur(${blur}px)`,
    maskImage: mask,
    WebkitMaskImage: mask,
  }
}

export function ImageLightbox({
  slides,
  index,
  onClose,
  onIndex,
}: {
  slides: LightboxSlide[]
  index: number
  onClose: () => void
  onIndex: (index: number) => void
}) {
  const slide = slides[index] ?? null
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const previewRef = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const pinched = useRef(false)
  const gesture = useRef({ startX: 0, startY: 0, originX: 0, originY: 0, pinchDist: 0, pinchScale: 1 })
  const [scale, setScale] = useState(MIN_SCALE)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [phase, setPhase] = useState<Phase>('loading')
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [backdrop, setBackdrop] = useState(readBackdrop)
  const scaleRef = useRef(scale)
  const panRef = useRef(pan)
  const slideKey = slide?.key ?? ''
  const [zoomKey, setZoomKey] = useState(slideKey)
  if (slideKey !== zoomKey) {
    setZoomKey(slideKey)
    setScale(MIN_SCALE)
    setPan({ x: 0, y: 0 })
    setPhase('loading')
    setDims(null)
  }
  scaleRef.current = slideKey === zoomKey ? scale : MIN_SCALE
  panRef.current = slideKey === zoomKey ? pan : { x: 0, y: 0 }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const active = document.activeElement
    const previous = active instanceof HTMLElement && !dialog.contains(active) ? active : null
    closeRef.current?.focus()
    const html = document.documentElement
    const body = document.body
    const prevHtmlOverflow = html.style.overflow
    const prevBodyOverflow = body.style.overflow
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    return () => {
      html.style.overflow = prevHtmlOverflow
      body.style.overflow = prevBodyOverflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    const update = () => setBackdrop(readBackdrop())
    const lists = ['(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)'].map((query) => window.matchMedia(query))
    for (const list of lists) list.addEventListener?.('change', update)
    return () => {
      for (const list of lists) list.removeEventListener?.('change', update)
    }
  }, [])

  useEffect(() => {
    const node = previewRef.current
    if (!node?.complete || node.naturalWidth <= 0 || node.naturalHeight <= 0) return
    setDims({ w: node.naturalWidth, h: node.naturalHeight })
    setPhase('ready')
  }, [slideKey])

  useEffect(() => {
    const node = dialogRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaY < 0 ? 1.25 : 0.8
      commitScale(scaleRef.current * factor)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [slideKey])

  useEffect(() => {
    if (!slide) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        if (slides.length < 2) return
        const next = event.key === 'ArrowLeft' ? index - 1 : index + 1
        if (next >= 0 && next < slides.length) onIndex(next)
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        commitScale(scaleRef.current + ZOOM_STEP)
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        commitScale(scaleRef.current - ZOOM_STEP)
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const nodes = focusableElements(root)
      if (nodes.length === 0) {
        event.preventDefault()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault()
          last.focus()
        }
        return
      }
      if (active === last || !root.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [index, onClose, onIndex, slide, slides.length])

  function commitScale(next: number) {
    const clamped = clampScale(next)
    scaleRef.current = clamped
    setScale(clamped)
    if (clamped <= MIN_SCALE) {
      panRef.current = { x: 0, y: 0 }
      setPan({ x: 0, y: 0 })
    }
  }

  function onPreviewLoad(event: SyntheticEvent<HTMLImageElement>) {
    const img = event.currentTarget
    setDims(img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null)
    setPhase('ready')
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.stopPropagation()
    const node = event.currentTarget
    if (typeof node.setPointerCapture === 'function') {
      try {
        node.setPointerCapture(event.pointerId)
      } catch {
        // Pointer capture is optional. Moves fired on the frame still pan.
      }
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const pts = [...pointers.current.values()]
    const first = pts[0]
    const second = pts[1]
    if (first && second) {
      pinched.current = true
      gesture.current.pinchDist = distance(first, second)
      gesture.current.pinchScale = scaleRef.current
      return
    }
    pinched.current = false
    gesture.current.startX = event.clientX
    gesture.current.startY = event.clientY
    gesture.current.originX = panRef.current.x
    gesture.current.originY = panRef.current.y
    gesture.current.pinchDist = 0
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const pts = [...pointers.current.values()]
    const first = pts[0]
    const second = pts[1]
    if (first && second && gesture.current.pinchDist > 0) {
      commitScale(gesture.current.pinchScale * (distance(first, second) / gesture.current.pinchDist))
      return
    }
    if (scaleRef.current <= MIN_SCALE) return
    const dx = event.clientX - gesture.current.startX
    const dy = event.clientY - gesture.current.startY
    setPan(clampPan(gesture.current.originX + dx, gesture.current.originY + dy, scaleRef.current))
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const startX = gesture.current.startX
    const startY = gesture.current.startY
    const wasPinch = pinched.current
    pointers.current.delete(event.pointerId)
    if (pointers.current.size > 0) {
      const remaining = [...pointers.current.values()][0]
      if (remaining) {
        gesture.current.startX = remaining.x
        gesture.current.startY = remaining.y
        gesture.current.originX = panRef.current.x
        gesture.current.originY = panRef.current.y
        gesture.current.pinchDist = 0
      }
      return
    }
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (!wasPinch && scaleRef.current <= MIN_SCALE && dy > SWIPE_CLOSE_PX && dy > Math.abs(dx) * 1.25) onClose()
  }

  if (!slide) return null

  const backdropStyle: CSSProperties = {
    backgroundColor: backdrop.blur ? BLUR_BG : SOLID_BG,
    backdropFilter: backdrop.blur ? 'blur(2px)' : 'none',
    WebkitBackdropFilter: backdrop.blur ? 'blur(2px)' : 'none',
    transition: backdrop.transition,
  }
  const multiple = slides.length > 1
  const viewPan = scale <= MIN_SCALE ? { x: 0, y: 0 } : pan
  const sizeLabel = dims ? `尺寸 ${dims.w} × ${dims.h} · ${formatBytes(slide.byteSize)}` : `尺寸 ${formatBytes(slide.byteSize)}`

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览 ${slide.filename}`}
      data-scale={scale}
      data-backdrop={backdrop.blur ? 'blur' : 'solid'}
      className="lightbox-safe fixed inset-0 z-50"
    >
      <div data-testid="lightbox-backdrop" className="absolute inset-0" style={backdropStyle} onClick={onClose} />
      {backdrop.blur ? (
        <>
          {(['top', 'bottom'] as const).map((edge) => (
            <div
              key={edge}
              data-progressive-blur={edge}
              aria-hidden="true"
              className={`pointer-events-none absolute inset-x-0 z-10 h-[40%] ${edge === 'top' ? 'top-0' : 'bottom-0'}`}
            >
              {PROGRESSIVE_LAYERS.map((layer) => (
                <div
                  key={layer.blur}
                  data-progressive-blur-layer={edge}
                  className="absolute inset-0"
                  style={layerStyle(edge, layer.blur, layer.stop)}
                />
              ))}
            </div>
          ))}
        </>
      ) : null}
      <div className="pointer-events-none relative z-20 flex h-full min-h-0 flex-col">
        <header data-testid="lightbox-chrome" className="pointer-events-auto m-3 flex items-center gap-3 px-3 py-2" style={chromeStyle}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold" title={slide.filename}>
              {slide.filename}
            </p>
            <p data-testid="lightbox-meta" className="text-xs">
              {sizeLabel}
            </p>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭" onClick={onClose} className="px-3 text-xs font-medium" style={controlStyle}>
            关闭
          </button>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div
            data-testid="lightbox-frame"
            data-pan-x={viewPan.x}
            data-pan-y={viewPan.y}
            className="pointer-events-auto relative"
            style={{ touchAction: 'none', transform: `translate(${viewPan.x}px, ${viewPan.y}px) scale(${scale})`, transformOrigin: 'center center' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              commitScale(Math.abs(scaleRef.current - MIN_SCALE) < 0.001 ? 2 : MIN_SCALE)
            }}
          >
            {phase !== 'ready' ? (
              <img
                data-lightbox-image="placeholder"
                src={slide.thumbnailSrc}
                alt=""
                draggable={false}
                className="max-h-[70vh] max-w-[92vw] object-contain"
                style={{ border: `2px solid ${CHROME_FG}`, borderRadius: 0 }}
              />
            ) : null}
            <img
              ref={previewRef}
              key={slide.key}
              data-lightbox-image="preview"
              src={slide.previewSrc}
              alt={slide.filename}
              draggable={false}
              onLoad={onPreviewLoad}
              onError={() => {
                setDims(null)
                setPhase('error')
              }}
              className="max-h-[70vh] max-w-[92vw] object-contain"
              style={{
                opacity: phase === 'ready' ? 1 : 0,
                position: phase === 'ready' ? 'relative' : 'absolute',
                border: `2px solid ${CHROME_FG}`,
                borderRadius: 0,
              }}
            />
          </div>
        </div>
        {phase === 'loading' ? (
          <p role="status" className="sr-only">
            正在加载大图
          </p>
        ) : null}
        {phase === 'error' ? (
          <p role="alert" className="pointer-events-auto mx-auto mb-2 px-3 py-2 text-sm font-bold" style={chromeStyle}>
            大图加载失败
          </p>
        ) : null}
        <footer data-testid="lightbox-toolbar" className="pointer-events-auto m-3 flex flex-wrap items-center gap-2 px-3 py-2" style={chromeStyle}>
          {multiple ? (
            <button type="button" aria-label="上一张" disabled={index <= 0} onClick={() => onIndex(index - 1)} className="px-2 text-xs font-medium disabled:opacity-40" style={controlStyle}>
              上一张
            </button>
          ) : null}
          <button
            type="button"
            aria-label="缩小"
            disabled={scale <= MIN_SCALE}
            onClick={() => commitScale(scaleRef.current - ZOOM_STEP)}
            className="text-sm font-medium disabled:opacity-40"
            style={controlStyle}
          >
            −
          </button>
          <span aria-live="polite" className="min-w-12 text-center text-xs font-medium">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            aria-label="放大"
            disabled={scale >= MAX_SCALE}
            onClick={() => commitScale(scaleRef.current + ZOOM_STEP)}
            className="text-sm font-medium disabled:opacity-40"
            style={controlStyle}
          >
            +
          </button>
          {multiple ? (
            <button
              type="button"
              aria-label="下一张"
              disabled={index >= slides.length - 1}
              onClick={() => onIndex(index + 1)}
              className="px-2 text-xs font-medium disabled:opacity-40"
              style={controlStyle}
            >
              下一张
            </button>
          ) : null}
          <a href={slide.downloadHref} download={slide.filename} className="ml-auto inline-flex items-center justify-center px-3 text-xs font-medium no-underline" style={controlStyle}>
            下载原图
          </a>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
