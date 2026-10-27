import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, animate, motion, useMotionValue, useTransform, type AnimationPlaybackControls, type MotionValue } from 'motion/react'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, MaximizeIcon, MinusIcon, PauseIcon, PlayIcon, PlusIcon, XIcon } from 'lucide-react'
import { dur, easeIn, easeOut, springBounce, springSettle } from '@/lib/motion.ts'

/**
 * Cards are draggable (swipe / pin-drag) and tap-to-copy. Controls that live
 * inside a card must keep their pointer events to themselves, otherwise a
 * press on "play" starts a drag or copies the clip. Motion listens with
 * native listeners on the card, so React's stopPropagation is too late.
 *
 * The native stop also hides pointerdown from React's root listener, so a
 * control inside an isolated subtree must use onPointerDownCapture (React runs
 * capture handlers from the root before the event reaches this element).
 */
export function useIsolatePointer<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    el.addEventListener('pointerdown', stop)
    return () => el.removeEventListener('pointerdown', stop)
  }, [])
  return ref
}

export function formatClock(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/* ------------------------------------------------------------ hold to confirm */

const HOLD_MS = 900

/**
 * Destructive action that only fires after a sustained press (mouse, touch or
 * Enter/Space). Releasing early springs the ring back; nothing happens.
 */
export function HoldToConfirm(props: {
  label: string
  onConfirm: () => void
  children: ReactNode
  className?: string
  /**
   * Board mode (RHEA-190 step 4): a short click calls onTap (the board's
   * two-step 撤回 → 确认撤回), a sustained press still confirms straight away.
   * The accessible name is then exactly `name`, and keyboard uses the click path.
   */
  onTap?: () => void
  name?: string
  style?: CSSProperties
  confirm?: boolean
}) {
  const { label, onConfirm, children, className, onTap, name, style, confirm } = props
  const fired = useRef(false)
  const ref = useIsolatePointer<HTMLButtonElement>()
  const progress = useMotionValue(0)
  const dash = useTransform(progress, [0, 1], [CIRC, 0])
  const run = useRef<AnimationPlaybackControls | null>(null)
  const [holding, setHolding] = useState(false)
  const [done, setDone] = useState(false)
  // Where the progress bubble goes. It is portalled out of the card: the card
  // clips its overflow, and on a phone the finger covers the button's ring,
  // so the only visible progress has to sit above the finger, outside the card.
  const [anchor, setAnchor] = useState<{ host: HTMLElement; x: number; y: number } | null>(null)
  const fill = useTransform(progress, [0, 1], ['0%', '100%'])

  const start = useCallback(() => {
    if (run.current) return
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      const host = (el.closest('.dd, .dd-board') as HTMLElement | null) ?? document.body
      setAnchor({ host, x: r.left + r.width / 2, y: r.top })
    }
    setHolding(true)
    run.current = animate(progress, 1, {
      duration: (HOLD_MS / 1000) * (1 - progress.get()),
      ease: 'linear',
      onComplete: () => {
        run.current = null
        setHolding(false)
        setDone(true)
        navigator.vibrate?.(12)
        fired.current = true
        onConfirm()
      },
    })
  }, [onConfirm, progress, ref])

  const cancel = useCallback(() => {
    if (!run.current) return
    run.current.stop()
    run.current = null
    setHolding(false)
    animate(progress, 0, { duration: dur.base, ease: easeOut })
  }, [progress])

  useEffect(() => () => run.current?.stop(), [])

  return (
    <button
      ref={ref}
      type="button"
      data-action
      aria-label={name ?? `${label}（按住确认）`}
      title={name ?? `按住 ${label}`}
      data-holding={holding || undefined}
      data-retract={confirm ? 'confirm' : undefined}
      className={`dd-hold relative grid place-items-center ${className ?? ''}`}
      style={{ touchAction: 'none', WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none', ...style }}
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return
        fired.current = false
        e.currentTarget.setPointerCapture?.(e.pointerId)
        start()
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(e) => {
        if (onTap) return
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault()
          start()
        }
      }}
      onKeyUp={(e) => {
        if (onTap) return
        if (e.key === 'Enter' || e.key === ' ') cancel()
      }}
      onClick={(e) => {
        e.preventDefault()
        if (!onTap) return
        // A completed hold already confirmed; the trailing click is not a tap.
        if (fired.current) {
          fired.current = false
          return
        }
        cancel()
        onTap()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg aria-hidden viewBox="0 0 28 28" className="pointer-events-none absolute inset-0 size-full -rotate-90">
        <motion.circle cx="14" cy="14" r={R} fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeDasharray={CIRC} style={{ strokeDashoffset: dash }} />
      </svg>
      <motion.span animate={holding ? { scale: 0.86 } : { scale: 1 }} transition={springBounce} className="relative grid place-items-center">
        {children}
      </motion.span>
      {anchor
        ? createPortal(
            <AnimatePresence onExitComplete={() => setAnchor(null)}>
              {holding && !done ? <HoldBubble key="hold" label={label} x={anchor.x} y={anchor.y} fill={fill} /> : null}
            </AnimatePresence>,
            anchor.host,
          )
        : null}
    </button>
  )
}
/**
 * Floating "keep holding" bubble with a filling bar. Fixed-positioned above the
 * press point, higher on touch so it clears the thumb, and clamped to the
 * viewport so a button near the screen edge still shows the whole bubble.
 */
function HoldBubble(props: { label: string; x: number; y: number; fill: MotionValue<string> }) {
  const { label, x, y, fill } = props
  const W = 156
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  const gap = coarse ? 44 : 10
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const left = Math.min(Math.max(8, x - W / 2), vw - W - 8)
  const bottom = Math.max(8 + 44, y - gap)
  return (
    <motion.div
      role="status"
      aria-live="polite"
      initial={{ opacity: 0, y: 6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: dur.fast, ease: easeOut } }}
      exit={{ opacity: 0, y: 4, transition: { duration: dur.fast, ease: easeIn } }}
      style={{ position: 'fixed', left, top: bottom, width: W, translateY: '-100%', zIndex: 60 }}
      className="pointer-events-none rounded-[var(--radius-md)] bg-[var(--fg)] px-3 py-2 text-[var(--bg)] shadow-[var(--elev-2)]"
    >
      <div className="text-[12px] font-medium leading-none">继续按住{label}</div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--bg)_25%,transparent)]">
        <motion.div className="h-full rounded-full bg-[var(--brand)]" style={{ width: fill }} />
      </div>
    </motion.div>
  )
}

const R = 12
const CIRC = 2 * Math.PI * R

/* ------------------------------------------------------------------ audio */

function bars(seed: string, n: number) {
  let h = 7
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return Array.from({ length: n }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0
    const env = Math.sin((Math.PI * (i + 0.5)) / n) * 0.55 + 0.45
    return 0.18 + ((h % 1000) / 1000) * 0.82 * env
  })
}

/** Inline audio: play/pause, a seekable waveform and elapsed / total time. */
export function AudioPlayer({ src, name, color, compact = false }: { src: string; name: string; color: string; compact?: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const ref = useIsolatePointer<HTMLDivElement>()
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [total, setTotal] = useState(0)
  const wave = useMemo(() => bars(name, compact ? 28 : 40), [name, compact])
  const ratio = total ? t / total : 0

  const toggle = () => {
    const el = audio.current
    if (!el) return
    if (el.paused) void el.play().catch(() => undefined)
    else el.pause()
  }
  const scrubbing = useRef(false)
  const seek = (clientX: number, target: HTMLElement) => {
    const el = audio.current
    if (!el) return
    const len = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : total
    if (!len) {
      // Metadata not loaded yet (iOS ignores preload): load, then seek.
      const r = target.getBoundingClientRect()
      const at = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
      el.addEventListener('loadedmetadata', () => {
        el.currentTime = at * el.duration
        setT(el.currentTime)
      }, { once: true })
      el.load()
      return
    }
    const r = target.getBoundingClientRect()
    el.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * len
    setT(el.currentTime)
  }

  return (
    <div ref={ref} data-action className={`flex items-center gap-2.5 ${compact ? '' : 'rounded-[var(--radius-sm)] border border-[var(--line-1)] bg-[var(--surface-2)] p-2'}`}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => setTotal(e.currentTarget.duration)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
      />
      <motion.button
        type="button"
        aria-label={playing ? `暂停 ${name}` : `播放 ${name}`}
        onClick={toggle}
        whileTap={{ scale: 0.9 }}
        className={`grid shrink-0 place-items-center rounded-full text-white ${compact ? 'size-6' : 'size-8'}`}
        style={{ background: color }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={playing ? 'pause' : 'play'} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: dur.fast }}>
            {playing ? <PauseIcon className={compact ? 'size-3' : 'size-3.5'} fill="currentColor" /> : <PlayIcon className={`${compact ? 'size-3' : 'size-3.5'} translate-x-px`} fill="currentColor" />}
          </motion.span>
        </AnimatePresence>
      </motion.button>
      <div
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(t)}
        className={`flex flex-1 cursor-pointer items-center gap-[2px] ${compact ? 'h-5' : 'h-7'}`}
        style={{ touchAction: 'none' }}
        onPointerDownCapture={(e) => {
          if (e.button !== 0) return
          scrubbing.current = true
          e.currentTarget.setPointerCapture?.(e.pointerId)
          seek(e.clientX, e.currentTarget)
        }}
        onPointerMove={(e) => {
          if (scrubbing.current) seek(e.clientX, e.currentTarget)
        }}
        onPointerUp={() => (scrubbing.current = false)}
        onPointerCancel={() => (scrubbing.current = false)}
        onKeyDown={(e) => {
          const el = audio.current
          if (!el) return
          if (e.key === 'ArrowRight') el.currentTime = Math.min(total, el.currentTime + 2)
          else if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 2)
          else if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        {wave.map((v, i) => {
          const on = (i + 0.5) / wave.length <= ratio
          return (
            <motion.span
              key={i}
              className="flex-1 rounded-full"
              animate={{ scaleY: playing && on ? [1, 1.25, 1] : 1 }}
              transition={playing && on ? { duration: 0.6, repeat: Infinity, delay: (i % 5) * 0.08 } : { duration: dur.fast }}
              style={{ height: `${v * 100}%`, background: on ? color : 'var(--line-3, var(--fg-4))', opacity: on ? 1 : 0.55 }}
            />
          )
        })}
      </div>
      <span className="dd-mono w-[68px] shrink-0 text-right text-[10.5px] tabular-nums text-[var(--fg-3)]">
        {formatClock(t)} / {formatClock(total)}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ video */

/** Poster with a play button; plays inline in the card, expand opens the viewer. */
export function InlineVideo({ src, poster, name, onExpand }: { src: string; poster?: string; name: string; onExpand: () => void }) {
  const ref = useIsolatePointer<HTMLDivElement>()
  const video = useRef<HTMLVideoElement | null>(null)
  const [started, setStarted] = useState(false)
  return (
    <div ref={ref} data-action className="group/video relative h-36 overflow-hidden rounded-[calc(var(--radius-md)-3px)] bg-black">
      <video
        ref={video}
        src={src}
        poster={poster}
        playsInline
        preload="metadata"
        controls={started}
        className="size-full object-contain"
        onPause={(e) => {
          if (e.currentTarget.currentTime === 0) setStarted(false)
        }}
      />
      <AnimatePresence>
        {!started ? (
          <motion.button
            type="button"
            aria-label={`播放 ${name}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
            className="absolute inset-0 grid place-items-center bg-black/25"
            onClick={() => {
              setStarted(true)
              void video.current?.play().catch(() => undefined)
            }}
          >
            <motion.span whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.92 }} transition={springBounce} className="grid size-11 place-items-center rounded-full bg-white/90 text-black shadow-[0_6px_20px_-6px_rgb(0_0_0/0.6)]">
              <PlayIcon className="size-4 translate-x-px" fill="currentColor" />
            </motion.span>
          </motion.button>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        aria-label="放大查看"
        title="放大查看"
        onClick={() => {
          video.current?.pause()
          onExpand()
        }}
        className="absolute bottom-2 right-2 grid size-7 place-items-center rounded-[var(--radius-sm)] bg-black/55 text-white opacity-0 transition-opacity group-hover/video:opacity-100 focus-visible:opacity-100"
      >
        <MaximizeIcon className="size-3.5" />
      </button>
    </div>
  )
}

/* --------------------------------------------------------------- lightbox */

export type ViewerMedia = {
  type: 'image' | 'video'
  src: string
  poster?: string
  name: string
  meta?: string
  layoutId?: string
  /** larger image swapped in once loaded (the board opens from the thumbnail, then shows the preview) */
  full?: string
  /** download link shown in the viewer header */
  download?: string
}

/** RHEA-190 step 6: the board's image viewer pages through every image on the board. */
export type ViewerGallery = { index: number; count: number; onStep: (delta: -1 | 1) => void }

/**
 * Full-screen viewer. Images open from their thumbnail (shared layoutId),
 * zoom with click / wheel / +- and pan while zoomed. Esc or backdrop closes.
 * With a gallery, ← / → (buttons, keys or a swipe) step to the neighbours.
 */
export function MediaViewer({
  media,
  anchor,
  reduced,
  onClose,
  gallery,
}: {
  media: ViewerMedia | null
  anchor: RefObject<HTMLElement | null>
  reduced: boolean
  onClose: () => void
  gallery?: ViewerGallery
}) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setHost((anchor.current?.closest('.dd, .dd-board') as HTMLElement | null) ?? document.body)
  }, [anchor])
  const open = media !== null
  // While open: lock page scroll; on close hand focus straight back to whatever opened it.
  // The opener is read in a layout effect (before the viewer's own effect focuses 关闭); focus is
  // handed back from a passive cleanup so React's post-commit focus restore doesn't undo it.
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])
  useEffect(() => {
    if (!open) return
    const html = document.documentElement
    const before = html.style.overflow
    html.style.overflow = 'hidden'
    return () => {
      html.style.overflow = before
      const previous = opener.current
      opener.current = null
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])
  if (!host) return null
  return createPortal(
    <AnimatePresence>{media ? <Viewer key={gallery ? 'gallery' : media.src} media={media} reduced={reduced} onClose={onClose} gallery={gallery} /> : null}</AnimatePresence>,
    host,
  )
}

const ZOOMS = [1, 2, 3.5]
const SWIPE_STEP = 80

function Viewer({ media, reduced, onClose, gallery }: { media: ViewerMedia; reduced: boolean; onClose: () => void; gallery?: ViewerGallery }) {
  const [zoom, setZoom] = useState(0)
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const scale = ZOOMS[zoom]
  const [dir, setDir] = useState<-1 | 1>(1)
  const canPrev = gallery ? gallery.index > 0 : false
  const canNext = gallery ? gallery.index < gallery.count - 1 : false

  const setLevel = useCallback(
    (next: number) => {
      const level = Math.max(0, Math.min(ZOOMS.length - 1, next))
      setZoom(level)
      if (level === 0) {
        animate(x, 0, springSettle)
        animate(y, 0, springSettle)
      }
    },
    [x, y],
  )

  const step = useCallback(
    (delta: -1 | 1) => {
      if (!gallery) return
      if (delta < 0 ? gallery.index <= 0 : gallery.index >= gallery.count - 1) return
      setDir(delta)
      setZoom(0)
      x.set(0)
      y.set(0)
      gallery.onStep(delta)
    },
    [gallery, x, y],
  )

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (media.type === 'image' && (e.key === '+' || e.key === '=')) setLevel(zoom + 1)
      else if (media.type === 'image' && (e.key === '-' || e.key === '_')) setLevel(zoom - 1)
      else if (gallery && e.key === 'ArrowLeft') step(-1)
      else if (gallery && e.key === 'ArrowRight') step(1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [gallery, media.type, onClose, setLevel, step, zoom])

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={media.name}
      data-media-viewer={media.type}
      className="fixed inset-0 z-[100] flex flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: dur.base, ease: easeOut } }}
      exit={{ opacity: 0, transition: { duration: dur.base, ease: easeIn } }}
    >
      <div className="absolute inset-0 bg-[color-mix(in_oklab,var(--bg)_55%,black)]/90 backdrop-blur-md" onClick={onClose} />
      <header className="relative z-10 flex items-center gap-3 px-4 py-3 text-[12px] text-white/85">
        <span className="truncate font-medium">{media.name}</span>
        {media.meta ? <span className="dd-mono shrink-0 text-white/55">{media.meta}</span> : null}
        {gallery && gallery.count > 1 ? (
          <span className="dd-mono shrink-0 tabular-nums text-white/55" data-viewer-count="">
            {gallery.index + 1} / {gallery.count}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {media.type === 'image' ? (
            <>
              <ViewerButton label="缩小" disabled={zoom === 0} onClick={() => setLevel(zoom - 1)}><MinusIcon className="size-4" /></ViewerButton>
              <span className="dd-mono w-10 text-center tabular-nums text-white/70">{Math.round(scale * 100)}%</span>
              <ViewerButton label="放大" disabled={zoom === ZOOMS.length - 1} onClick={() => setLevel(zoom + 1)}><PlusIcon className="size-4" /></ViewerButton>
            </>
          ) : null}
          {media.download ? (
            <a
              href={media.download}
              aria-label="下载"
              title="下载"
              className="grid size-8 place-items-center rounded-[var(--radius-sm)] text-white/80 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <DownloadIcon className="size-4" />
            </a>
          ) : null}
          <ViewerButton ref={closeRef} label="关闭（Esc）" onClick={onClose}><XIcon className="size-4" /></ViewerButton>
        </div>
      </header>
      <div
        className="relative z-0 flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 sm:p-10"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
        onWheel={(e) => {
          if (media.type !== 'image') return
          setLevel(zoom + (e.deltaY < 0 ? 1 : -1))
        }}
      >
        {media.type === 'image' ? (
          <AnimatePresence initial={false} mode="popLayout" custom={dir}>
            <ViewerImage
              key={media.src}
              media={media}
              reduced={reduced}
              zoom={zoom}
              scale={scale}
              x={x}
              y={y}
              dir={dir}
              swipe={gallery ? (delta) => step(delta) : undefined}
              onTap={() => setLevel(zoom === 0 ? 1 : 0)}
            />
          </AnimatePresence>
        ) : (
          <motion.video
            src={media.src}
            poster={media.poster}
            controls
            autoPlay
            playsInline
            initial={reduced ? false : { scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={springSettle}
            className="max-h-full max-w-full rounded-[var(--radius-sm)] bg-black shadow-[0_24px_60px_-20px_rgb(0_0_0/0.7)]"
          />
        )}
        {gallery && gallery.count > 1 ? (
          <>
            <StepButton side="left" label="上一张" disabled={!canPrev} onClick={() => step(-1)} />
            <StepButton side="right" label="下一张" disabled={!canNext} onClick={() => step(1)} />
          </>
        ) : null}
      </div>
      {media.type === 'image' ? (
        <p className="relative z-10 pb-3 text-center text-[11px] text-white/50">
          点击图片放大 · 滚轮 / + − 缩放 · 放大后可拖动{gallery && gallery.count > 1 ? ' · ← → 切换' : ''} · Esc 关闭
        </p>
      ) : null}
    </motion.div>
  )
}

/** One image in the viewer: starts from the card thumbnail, swaps to the larger preview once it has loaded. */
function ViewerImage(props: {
  media: ViewerMedia
  reduced: boolean
  zoom: number
  scale: number
  x: MotionValue<number>
  y: MotionValue<number>
  dir: -1 | 1
  swipe?: (delta: -1 | 1) => void
  onTap: () => void
}) {
  const { media, reduced, zoom, scale, x, y, dir, swipe, onTap } = props
  const [ready, setReady] = useState<string | null>(null)
  const swiped = useRef(false)
  useEffect(() => {
    const full = media.full
    if (!full || full === media.src || typeof Image === 'undefined') return
    let live = true
    const img = new Image()
    img.onload = () => {
      if (live) setReady(full)
    }
    img.src = full
    return () => {
      live = false
    }
  }, [media.full, media.src])
  const src = ready ?? media.src
  return (
    <motion.img
      layoutId={reduced ? undefined : media.layoutId}
      src={src}
      alt={media.name}
      data-viewer-image={ready ? 'full' : 'thumbnail'}
      data-full-src={media.full}
      draggable={false}
      drag={zoom > 0 ? true : swipe ? 'x' : false}
      dragSnapToOrigin={zoom === 0}
      dragMomentum={false}
      dragElastic={zoom > 0 ? 0.15 : 0.5}
      onDragStart={() => {
        swiped.current = false
      }}
      onDragEnd={(_, info) => {
        if (zoom > 0 || !swipe) return
        if (info.offset.x <= -SWIPE_STEP) {
          swiped.current = true
          swipe(1)
        } else if (info.offset.x >= SWIPE_STEP) {
          swiped.current = true
          swipe(-1)
        }
      }}
      onTap={() => {
        if (swiped.current) return
        onTap()
      }}
      initial={reduced || !swipe ? undefined : { opacity: 0, x: dir * 60 }}
      animate={{ scale, opacity: 1, ...(zoom === 0 && swipe ? { x: 0 } : {}) }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: dir * -60, transition: { duration: dur.fast, ease: easeIn } }}
      transition={{ ...springSettle, layout: springSettle }}
      style={zoom > 0 || !swipe ? { x, y, cursor: zoom === 0 ? 'zoom-in' : 'grab' } : { cursor: 'zoom-in' }}
      className="max-h-full max-w-full select-none rounded-[var(--radius-sm)] object-contain shadow-[0_24px_60px_-20px_rgb(0_0_0/0.7)]"
    />
  )
}

function StepButton({ side, label, disabled, onClick }: { side: 'left' | 'right'; label: string; disabled: boolean; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeftIcon : ChevronRightIcon
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      whileTap={disabled ? undefined : { scale: 0.92 }}
      transition={springBounce}
      className={`absolute top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white/85 outline-none backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 disabled:pointer-events-none disabled:opacity-0 ${side === 'left' ? 'left-3 sm:left-5' : 'right-3 sm:right-5'}`}
    >
      <Icon className="size-5" />
    </motion.button>
  )
}

function ViewerButton({ label, onClick, disabled, children, ref }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode; ref?: RefObject<HTMLButtonElement | null> }) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-[var(--radius-sm)] text-white/80 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-30"
    >
      {children}
    </button>
  )
}
