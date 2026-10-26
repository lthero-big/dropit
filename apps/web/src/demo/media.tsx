import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, animate, motion, useMotionValue, useTransform, type AnimationPlaybackControls } from 'motion/react'
import { MaximizeIcon, MinusIcon, PauseIcon, PlayIcon, PlusIcon, XIcon } from 'lucide-react'
import { dur, easeIn, easeOut, springBounce, springSettle } from './motion-tokens.ts'

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
export function HoldToConfirm(props: { label: string; onConfirm: () => void; children: ReactNode; className?: string }) {
  const { label, onConfirm, children, className } = props
  const ref = useIsolatePointer<HTMLButtonElement>()
  const progress = useMotionValue(0)
  const dash = useTransform(progress, [0, 1], [CIRC, 0])
  const run = useRef<AnimationPlaybackControls | null>(null)
  const [holding, setHolding] = useState(false)
  const [done, setDone] = useState(false)

  const start = useCallback(() => {
    if (run.current) return
    setHolding(true)
    run.current = animate(progress, 1, {
      duration: (HOLD_MS / 1000) * (1 - progress.get()),
      ease: 'linear',
      onComplete: () => {
        run.current = null
        setHolding(false)
        setDone(true)
        navigator.vibrate?.(12)
        onConfirm()
      },
    })
  }, [onConfirm, progress])

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
      aria-label={`${label}（按住确认）`}
      title={`按住 ${label}`}
      data-holding={holding || undefined}
      className={`dd-hold relative grid place-items-center ${className ?? ''}`}
      style={{ touchAction: 'none', WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture?.(e.pointerId)
        start()
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault()
          start()
        }
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') cancel()
      }}
      onClick={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg aria-hidden viewBox="0 0 28 28" className="pointer-events-none absolute inset-0 size-full -rotate-90">
        <motion.circle cx="14" cy="14" r={R} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeDasharray={CIRC} style={{ strokeDashoffset: dash }} />
      </svg>
      <motion.span animate={holding ? { scale: 0.86 } : { scale: 1 }} transition={springBounce} className="relative grid place-items-center">
        {children}
      </motion.span>
      <AnimatePresence>
        {holding && !done ? (
          <motion.span
            role="status"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: dur.fast, ease: easeOut } }}
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
            className="pointer-events-none absolute -top-2 right-0 z-30 -translate-y-full whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--fg)] px-2 py-1 text-[11px] text-[var(--bg)] shadow-[var(--shadow-2)]"
          >
            继续按住{label}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </button>
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

export type ViewerMedia = { type: 'image' | 'video'; src: string; poster?: string; name: string; meta?: string; layoutId?: string }

/**
 * Full-screen viewer. Images open from their thumbnail (shared layoutId),
 * zoom with click / wheel / +- and pan while zoomed. Esc or backdrop closes.
 */
export function MediaViewer({ media, anchor, reduced, onClose }: { media: ViewerMedia | null; anchor: RefObject<HTMLElement | null>; reduced: boolean; onClose: () => void }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setHost((anchor.current?.closest('.dd') as HTMLElement | null) ?? document.body)
  }, [anchor])
  if (!host) return null
  return createPortal(
    <AnimatePresence>{media ? <Viewer key={media.src} media={media} reduced={reduced} onClose={onClose} /> : null}</AnimatePresence>,
    host,
  )
}

const ZOOMS = [1, 2, 3.5]

function Viewer({ media, reduced, onClose }: { media: ViewerMedia; reduced: boolean; onClose: () => void }) {
  const [zoom, setZoom] = useState(0)
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const scale = ZOOMS[zoom]

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

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (media.type === 'image' && (e.key === '+' || e.key === '=')) setLevel(zoom + 1)
      else if (media.type === 'image' && e.key === '-') setLevel(zoom - 1)
      else return
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [media.type, onClose, setLevel, zoom])

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={media.name}
      className="fixed inset-0 z-[100] flex flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: dur.base, ease: easeOut } }}
      exit={{ opacity: 0, transition: { duration: dur.base, ease: easeIn } }}
    >
      <div className="absolute inset-0 bg-[color-mix(in_oklab,var(--bg)_55%,black)]/90 backdrop-blur-md" onClick={onClose} />
      <header className="relative z-10 flex items-center gap-3 px-4 py-3 text-[12px] text-white/85">
        <span className="truncate font-medium">{media.name}</span>
        {media.meta ? <span className="dd-mono text-white/55">{media.meta}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          {media.type === 'image' ? (
            <>
              <ViewerButton label="缩小" disabled={zoom === 0} onClick={() => setLevel(zoom - 1)}><MinusIcon className="size-4" /></ViewerButton>
              <span className="dd-mono w-10 text-center tabular-nums text-white/70">{Math.round(scale * 100)}%</span>
              <ViewerButton label="放大" disabled={zoom === ZOOMS.length - 1} onClick={() => setLevel(zoom + 1)}><PlusIcon className="size-4" /></ViewerButton>
            </>
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
          <motion.img
            layoutId={reduced ? undefined : media.layoutId}
            src={media.src}
            alt={media.name}
            draggable={false}
            drag={zoom > 0}
            dragMomentum={false}
            dragElastic={0.15}
            onTap={() => setLevel(zoom === 0 ? 1 : 0)}
            animate={{ scale }}
            transition={{ ...springSettle, layout: springSettle }}
            style={{ x, y, cursor: zoom === 0 ? 'zoom-in' : 'grab' }}
            className="max-h-full max-w-full select-none rounded-[var(--radius-sm)] object-contain shadow-[0_24px_60px_-20px_rgb(0_0_0/0.7)]"
          />
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
      </div>
      {media.type === 'image' ? (
        <p className="relative z-10 pb-3 text-center text-[11px] text-white/50">点击图片放大 · 滚轮 / + − 缩放 · 放大后可拖动 · Esc 关闭</p>
      ) : null}
    </motion.div>
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
