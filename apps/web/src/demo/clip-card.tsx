import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

function preHide(node: HTMLElement, transform?: string) {
  node.style.opacity = '0'
  if (transform) node.style.transform = transform
}
import { AnimatePresence, motion, useAnimate, useMotionValue, useTransform, type PanInfo } from 'motion/react'
import { CheckIcon, CopyIcon, PinIcon, Undo2Icon } from 'lucide-react'
import { deviceById, formatAgo, formatLeft, formatSize, hexToRgb, readableOn, type Clip } from './data.ts'
import { DeviceGlyph } from './icons.tsx'
import { deviceColor, fileType, labelFor } from './visuals.ts'
import { dur, easeIn, easeOut, enter, springBounce, springSettle } from './motion-tokens.ts'

const AGING_WINDOW = 20 * 60_000

export type GestureMode = 'pin-drag' | 'swipe'

type Props = {
  clip: Clip
  now: number
  variant: 'grid' | 'row'
  gesture: GestureMode
  reduced: boolean
  copied: boolean
  pinBarRef: RefObject<HTMLElement | null>
  deviceDot: (deviceId: string) => HTMLElement | null
  onCopy: (clip: Clip) => void
  onRetract: (clip: Clip) => void
  onPin: (clip: Clip) => void
  onPinHover: (over: boolean) => void
  onArrived: (clip: Clip) => void
}

function inside(el: HTMLElement | null, x: number, y: number, pad = 24) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
}

export function ClipCard(props: Props) {
  const { clip, now, variant, gesture, reduced, copied, pinBarRef, deviceDot, onCopy, onRetract, onPin, onPinHover, onArrived } = props
  const [hover, setHover] = useState(false)
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const x = useMotionValue(0)
  const copyHint = useTransform(x, [0, 72], [0, 1])
  const undoHint = useTransform(x, [-72, 0], [1, 0])

  const remaining = clip.expiresAt - now
  const aging = remaining < AGING_WINDOW
  const ratio = Math.max(0, Math.min(1, remaining / AGING_WINDOW))
  const life = aging ? 0.15 + ratio * 0.85 : 1
  const curl = aging ? 1 - ratio : 0
  const device = deviceById(clip.deviceId)

  // Fly in from the source device's dot in the top bar. Keyed on the two
  // flags only: StrictMode's mount/unmount/mount re-runs it cleanly, and the
  // parent clears the flag only once the flight has finished.
  const dragged = useRef(false)
  const latest = useRef({ clip, deviceDot, onArrived, reduced })
  useLayoutEffect(() => {
    latest.current = { clip, deviceDot, onArrived, reduced }
  })
  const { arrived, landed } = clip
  useLayoutEffect(() => {
    const { clip: c, deviceDot: dotOf, onArrived: done, reduced: still } = latest.current
    const el = scope.current
    if (!el || (!arrived && !landed)) return
    let cancelled = false
    const finish = () => {
      if (!cancelled) done(c)
    }
    if (arrived) {
      const dot = dotOf(c.deviceId)
      if (!dot || still) return finish()
      const a = dot.getBoundingClientRect()
      const b = el.getBoundingClientRect()
      const dx = a.left + a.width / 2 - (b.left + b.width / 2)
      const dy = a.top + a.height / 2 - (b.top + b.height / 2)
      preHide(el, `translate(${dx}px, ${dy}px) scale(0.12)`)
      void animate(el, { x: [dx, 0], y: [dy, 0], scale: [0.12, 1], opacity: [0, 1], rotate: [dx > 0 ? 8 : -8, 0] }, { ...springBounce, opacity: { duration: dur.fast } }).then(finish)
    } else if (!still) {
      // Pasted screenshot / dropped file: drop from above with a squash on landing.
      preHide(el)
      void animate([
        [el, { y: [-120, 0], scale: [0.7, 1], opacity: [0, 1] }, { type: 'spring', stiffness: 380, damping: 20 }],
        [el, { scaleY: [1, 0.94, 1], scaleX: [1, 1.03, 1] }, { duration: dur.slow, ease: easeOut, at: '-0.15' }],
      ]).then(finish)
    } else finish()
    return () => {
      cancelled = true
    }
  }, [arrived, landed, animate, scope])

  const handleTap = (event: MouseEvent | TouchEvent | PointerEvent) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('[data-action]') || dragged.current) return
    onCopy(clip)
  }

  const handleDrag = (_: unknown, info: PanInfo) => {
    if (gesture === 'pin-drag') onPinHover(inside(pinBarRef.current, info.point.x - window.scrollX, info.point.y - window.scrollY))
  }

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    // A drag must never also count as a tap-to-copy on release.
    window.setTimeout(() => {
      dragged.current = false
    }, 0)
    if (gesture === 'swipe') {
      if (info.offset.x > 72) onCopy(clip)
      else if (info.offset.x < -72) onRetract(clip)
      return
    }
    const over = inside(pinBarRef.current, info.point.x - window.scrollX, info.point.y - window.scrollY)
    onPinHover(false)
    if (over && !clip.pinned) onPin(clip)
  }

  const expiredExit = remaining < 1500
  const exitAnim = expiredExit
    ? { opacity: 0, scale: 0.97, filter: 'blur(6px)', transition: { duration: dur.slow, ease: easeIn } }
    : { opacity: 0, scale: 0.9, y: -6, transition: { duration: dur.base, ease: easeIn } }

  return (
    <motion.article
      layout={!reduced}
      layoutId={reduced ? undefined : `clip-${clip.id}`}
      initial={clip.arrived || clip.landed ? false : { opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={reduced ? { opacity: 0, transition: { duration: dur.fast } } : exitAnim}
      transition={{ ...enter, layout: springSettle }}
      className={variant === 'grid' ? 'relative h-full' : 'relative'}
      data-clip-id={clip.id}
      data-kind={clip.kind}
      onHoverStart={() => setHover(true)}
      onHoverEnd={() => setHover(false)}
    >
      {gesture === 'swipe' ? (
        <div aria-hidden className="absolute inset-0 flex items-center justify-between overflow-hidden rounded-[var(--radius-md)] px-4 text-[12px] font-medium">
          <motion.span style={{ opacity: copyHint }} className="flex items-center gap-1.5 text-[var(--ok)]">
            <CopyIcon className="size-4" /> 复制
          </motion.span>
          <motion.span style={{ opacity: undoHint }} className="flex items-center gap-1.5 text-[var(--accent)]">
            撤回 <Undo2Icon className="size-4" />
          </motion.span>
        </div>
      ) : null}
      <motion.div ref={scope} className="relative h-full">
        <motion.div
          role="button"
          tabIndex={0}
          aria-label={`复制：${labelFor(clip)}`}
          data-card
          className="dd-card flex h-full cursor-pointer select-none flex-col outline-none"
          data-aging={aging || undefined}
          data-copied={copied || undefined}
          style={{ ['--life' as string]: life, ['--curl' as string]: curl, x: gesture === 'swipe' ? x : undefined, touchAction: gesture === 'swipe' ? 'pan-y' : 'none' }}
          drag={reduced ? false : gesture === 'swipe' ? 'x' : true}
          dragSnapToOrigin
          dragElastic={gesture === 'swipe' ? 0.6 : 0.9}
          dragConstraints={gesture === 'swipe' ? { left: 0, right: 0 } : undefined}
          dragTransition={{ bounceStiffness: 420, bounceDamping: 20 }}
          whileDrag={gesture === 'swipe' ? { cursor: 'grabbing' } : { scale: 1.04, rotate: -1.5, zIndex: 40, boxShadow: 'var(--shadow-3)', cursor: 'grabbing' }}
          animate={copied && !reduced ? { y: -3, boxShadow: 'var(--shadow-3)' } : { y: 0, boxShadow: 'var(--shadow-1)' }}
          transition={springBounce}
          onDragStart={() => {
            dragged.current = true
            setHover(false)
          }}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
          onTap={handleTap}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onCopy(clip)
            }
          }}
        >
          <div className="dd-card-body flex-1">
            {variant === 'grid' ? <GridBody clip={clip} /> : <RowBody clip={clip} />}
          </div>
          <footer className={`flex items-center gap-2 border-t border-[var(--line-1)] py-2 pl-3 ${aging ? 'pr-6' : 'pr-3'} text-[11px] text-[var(--fg-3)]`}>
            <span className="inline-flex items-center gap-1" style={{ color: deviceColor(device.kind) }}>
              <DeviceGlyph kind={device.kind} className="size-3.5" />
              <span className="text-[var(--fg-2)]">{device.name}</span>
            </span>
            <span aria-hidden>·</span>
            <span>{formatAgo(now - clip.createdAt)}</span>
            <span className={`dd-mono ml-auto tabular-nums ${aging ? 'text-[var(--accent)]' : ''}`}>{shortLeft(remaining)}</span>
          </footer>
          <div className="dd-card-actions absolute right-2 top-2 flex gap-1">
            {!clip.pinned ? (
              <button type="button" data-action aria-label="置顶" title="置顶" onClick={() => onPin(clip)} className="grid size-7 place-items-center rounded-[var(--radius-sm)] border border-[var(--line-2)] bg-[var(--surface-1)] text-[var(--fg-2)] hover:text-[var(--fg)]">
                <PinIcon className="size-3.5" />
              </button>
            ) : null}
            <button type="button" data-action aria-label="撤回" title="撤回" onClick={() => onRetract(clip)} className="grid size-7 place-items-center rounded-[var(--radius-sm)] border border-[var(--line-2)] bg-[var(--surface-1)] text-[var(--fg-2)] hover:text-[var(--accent)]">
              <Undo2Icon className="size-3.5" />
            </button>
            <span className="grid size-7 place-items-center rounded-[var(--radius-sm)] border border-[var(--line-2)] bg-[var(--surface-1)] text-[var(--fg-2)]" aria-hidden>
              <AnimatePresence mode="popLayout" initial={false}>
                {copied ? (
                  <motion.span key="ok" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={springBounce} className="text-[var(--ok)]">
                    <CheckIcon className="size-3.5" />
                  </motion.span>
                ) : (
                  <motion.span key="cp" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={{ duration: dur.fast }}>
                    <CopyIcon className="size-3.5" />
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
          </div>
        </motion.div>
        <AnimatePresence>
          {hover && gesture === 'pin-drag' ? (
            <motion.div
              role="tooltip"
              initial={{ opacity: 0, y: 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: dur.fast, ease: easeOut } }}
              exit={{ opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
              className="dd-mono pointer-events-none absolute -top-2 left-3 z-30 -translate-y-full whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--fg)] px-2 py-1 text-[11px] text-[var(--bg)] shadow-[var(--shadow-2)]"
            >
              还剩 {formatLeft(remaining)} · {new Date(clip.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })} 过期
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </motion.article>
  )
}

function shortLeft(ms: number) {
  if (ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const kindLabel: Record<Clip['kind'], string> = { link: '链接', code: '代码', color: '色值', text: '文本', image: '图片', file: '文件' }

function KindTag({ clip }: { clip: Clip }) {
  return <span className="dd-mono text-[10px] uppercase tracking-[0.08em] text-[var(--fg-3)]">{kindLabel[clip.kind]}{clip.kind === 'code' ? ` · ${clip.lang}` : ''}</span>
}

function siteHue(site: string) {
  let h = 0
  for (const ch of site) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

function Favicon({ site, size = 28 }: { site: string; size?: number }) {
  const hue = siteHue(site)
  return (
    <span
      aria-hidden
      className="dd-mono grid shrink-0 place-items-center rounded-[var(--radius-sm)] text-[12px] font-semibold text-white"
      style={{ width: size, height: size, background: `oklch(0.55 0.11 ${hue})`, boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.08)' }}
    >
      {site.replace(/^www\./, '')[0]?.toUpperCase()}
    </span>
  )
}

function GridBody({ clip }: { clip: Clip }) {
  switch (clip.kind) {
    case 'link':
      return (
        <div className="flex flex-col gap-3 p-3 pr-24">
          <KindTag clip={clip} />
          <div className="flex items-start gap-2.5">
            <Favicon site={clip.site} />
            <div className="min-w-0">
              <p className="dd-display line-clamp-2 text-[14px] font-medium leading-snug text-[var(--fg)]">{clip.title}</p>
              <p className="dd-mono mt-1 truncate text-[11px] text-[var(--fg-3)]">{clip.url.replace(/^https?:\/\//, '')}</p>
            </div>
          </div>
        </div>
      )
    case 'code':
      return (
        <div className="flex flex-col gap-2 p-3">
          <KindTag clip={clip} />
          <pre className="dd-mono m-0 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--line-1)] bg-[var(--code-bg)] p-2.5 text-[11.5px] leading-[1.6] text-[var(--fg-2)]">
            {clip.code.split('\n').slice(0, 5).map((line, i) => (
              <div key={i} className="flex gap-3">
                <span className="w-3 shrink-0 select-none text-right text-[var(--fg-4)]">{i + 1}</span>
                <span className="truncate">{line || ' '}</span>
              </div>
            ))}
          </pre>
        </div>
      )
    case 'color':
      return (
        <div className="p-1.5 pb-0">
          <div className="flex h-24 flex-col justify-between rounded-[calc(var(--radius-md)-3px)] p-2.5" style={{ background: clip.value, color: readableOn(clip.value) }}>
            <span className="dd-mono text-[10px] uppercase tracking-[0.08em] opacity-70">色值</span>
            <span className="dd-mono text-[18px] font-medium tracking-tight">{clip.value}</span>
          </div>
          <p className="dd-mono flex justify-between px-1.5 py-2 text-[11px] text-[var(--fg-3)]">
            <span>rgb({hexToRgb(clip.value)})</span>
            {clip.name ? <span>{clip.name}</span> : null}
          </p>
        </div>
      )
    case 'text':
      return (
        <div className="flex min-h-28 flex-col justify-between gap-3 p-3">
          <KindTag clip={clip} />
          <p className="dd-display text-[20px] font-medium leading-[1.35] tracking-[-0.01em] text-[var(--fg)]">{clip.text}</p>
        </div>
      )
    case 'image':
      return (
        <div className="p-1.5 pb-0">
          <div className="grid h-36 place-items-center overflow-hidden rounded-[calc(var(--radius-md)-3px)]" style={{ background: `color-mix(in oklab, ${clip.tone} 70%, var(--surface-2))` }}>
            <img src={clip.src} alt={clip.name} draggable={false} className="max-h-[85%] max-w-[85%] rounded-[var(--radius-xs)] object-contain shadow-[0_8px_20px_-8px_rgb(0_0_0/0.45)]" />
          </div>
          <p className="flex justify-between px-1.5 py-2 text-[11px] text-[var(--fg-3)]">
            <span className="truncate text-[var(--fg-2)]">{clip.name}</span>
            <span className="dd-mono shrink-0">{clip.w}×{clip.h}</span>
          </p>
        </div>
      )
    case 'file': {
      const t = fileType(clip.name)
      const Icon = t.icon
      return (
        <div className="flex items-center gap-3 p-3 pr-24">
          <span className="relative grid size-11 shrink-0 place-items-center rounded-[var(--radius-sm)]" style={{ background: `color-mix(in oklab, ${t.color} 14%, var(--surface-1))`, color: t.color }}>
            <Icon className="size-5" />
            <span className="dd-mono absolute -bottom-1.5 rounded-[2px] px-1 text-[8.5px] font-semibold text-white" style={{ background: t.color }}>{t.ext.slice(0, 4)}</span>
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-medium text-[var(--fg)]">{clip.name}</p>
            <p className="dd-mono mt-0.5 text-[11px] text-[var(--fg-3)]">{t.label} · {formatSize(clip.size)}</p>
          </div>
        </div>
      )
    }
  }
}

function RowBody({ clip }: { clip: Clip }) {
  // Compact one-line rendering for the timeline.
  let lead
  let main
  switch (clip.kind) {
    case 'link':
      lead = <Favicon site={clip.site} size={24} />
      main = <><p className="truncate text-[13.5px] font-medium">{clip.title}</p><p className="dd-mono truncate text-[11px] text-[var(--fg-3)]">{clip.site}</p></>
      break
    case 'code':
      lead = <span className="dd-mono grid size-6 place-items-center rounded-[var(--radius-xs)] bg-[var(--code-bg)] text-[9px] text-[var(--fg-2)] ring-1 ring-[var(--line-1)]">{'</>'}</span>
      main = <p className="dd-mono truncate text-[12px] text-[var(--fg-2)]">{clip.code.split('\n')[0]}</p>
      break
    case 'color':
      lead = <span className="size-6 rounded-[var(--radius-xs)] ring-1 ring-black/10" style={{ background: clip.value }} />
      main = <p className="dd-mono text-[13px]">{clip.value} <span className="text-[var(--fg-3)]">{clip.name}</span></p>
      break
    case 'text':
      lead = <span className="dd-display grid size-6 place-items-center text-[15px] text-[var(--fg-3)]">“</span>
      main = <p className="dd-display truncate text-[15px] font-medium">{clip.text}</p>
      break
    case 'image':
      lead = <img src={clip.src} alt="" draggable={false} className="size-6 rounded-[var(--radius-xs)] object-cover" />
      main = <p className="truncate text-[13px]">{clip.name} <span className="dd-mono text-[11px] text-[var(--fg-3)]">{clip.w}×{clip.h}</span></p>
      break
    case 'file': {
      const t = fileType(clip.name)
      const Icon = t.icon
      lead = <span className="grid size-6 place-items-center rounded-[var(--radius-xs)]" style={{ color: t.color, background: `color-mix(in oklab, ${t.color} 14%, transparent)` }}><Icon className="size-3.5" /></span>
      main = <p className="truncate text-[13px]">{clip.name} <span className="dd-mono text-[11px] text-[var(--fg-3)]">{formatSize(clip.size)}</span></p>
      break
    }
  }
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 pr-24">
      {lead}
      <div className="min-w-0 flex-1">{main}</div>
    </div>
  )
}
