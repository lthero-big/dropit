import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { TrashHandle } from '@/lib/trash-anchor.ts'

function preHide(node: HTMLElement, transform?: string) {
  node.style.opacity = '0'
  if (transform) node.style.transform = transform
}
import { AnimatePresence, animate as animateValue, motion, useAnimate, useMotionValue, useTransform, type PanInfo } from 'motion/react'
import { CheckIcon, CopyIcon, PinIcon, Undo2Icon } from 'lucide-react'
import { deviceById, formatAgo, formatLeft, type Clip } from './data.ts'
import { DeviceGlyph } from './icons.tsx'
import { deviceColor, labelFor } from './visuals.ts'
import { HoldToConfirm, MediaViewer, useIsolatePointer, type ViewerMedia } from '@/components/clip-media.tsx'
import { GridBody, RowBody, shortLeft } from '@/components/clip-visual.tsx'
import { ConfirmRetract } from '@/components/confirm-retract.tsx'
import { GroupBadge } from './groups.tsx'
import { dur, easeIn, easeOut, enter, springBounce, springSettle } from '../lib/motion.ts'

import { AGING_WINDOW } from '@/lib/clip-kind.ts'
/** swipe-left distance that opens the retract confirm; the card rests there */
const REVEAL = 92

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
  /** actions (置顶 / 撤回 / 复制) are hidden until the card is tapped open */
  open: boolean
  onOpen: (clip: Clip | null) => void
  groups: string[]
  onMoveGroup: (clip: Clip, group: string | undefined) => void
  /**
   * pin-drag only: report the pointer over the group chips while dragging.
   * Returns the group key under the pointer ('' = 未分组) or null; with
   * `drop` set it also moves the clip and returns whether it was consumed.
   */
  onGroupDrag?: (clip: Clip, x: number, y: number, drop: boolean) => string | null
  /** pin-drag only: the drag-to-delete bin that appears next to a dragged card */
  trashRef?: RefObject<TrashHandle | null>
  onDragPhase?: (phase: { clip: Clip; rect: DOMRect } | { clip: Clip; end: 'cancel' | 'deleted' }) => void
}

function inside(el: HTMLElement | null, x: number, y: number, pad = 24) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
}

export function ClipCard(props: Props) {
  const { clip, now, variant, gesture, reduced, copied, pinBarRef, deviceDot, onCopy, onRetract, onPin, onPinHover, onArrived, trashRef, onDragPhase, open, onOpen, groups, onMoveGroup, onGroupDrag } = props
  const [hover, setHover] = useState(false)
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const x = useMotionValue(0)
  // pin-drag offsets, owned here so a drop on the bin can fly the card into it
  const dragX = useMotionValue(0)
  const dragY = useMotionValue(0)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const overTrash = useRef(false)
  const copyHint = useTransform(x, [0, 72], [0, 1])
  const undoHint = useTransform(x, [-72, 0], [1, 0])
  const [viewer, setViewer] = useState<ViewerMedia | null>(null)
  // Swipe-left no longer retracts on its own: it opens a confirm button and
  // waits for a second, deliberate tap. Tapping the card or waiting closes it.
  const [armed, setArmed] = useState(false)
  const armedAtStart = useRef(false)
  useEffect(() => {
    if (gesture !== 'swipe') return
    const controls = animateValue(x, armed ? -REVEAL : 0, springBounce)
    if (!armed) return () => controls.stop()
    const t = window.setTimeout(() => setArmed(false), 4000)
    return () => {
      controls.stop()
      window.clearTimeout(t)
    }
  }, [armed, gesture, x])

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
    if (armed) return setArmed(false)
    // A tap only reveals the actions; copying is a deliberate second tap on 复制.
    onOpen(open ? null : clip)
  }

  const handleDrag = (_: unknown, info: PanInfo) => {
    if (gesture !== 'pin-drag') return
    const px = info.point.x - window.scrollX
    const py = info.point.y - window.scrollY
    const trash = trashRef?.current?.track(px, py) ?? false
    if (trash !== overTrash.current) {
      overTrash.current = trash
      // Shrink toward the bin while hovering it: "this will go away".
      const el = cardRef.current
      if (el && !reduced) void animate(el, trash ? { scale: 0.62, rotate: 4, opacity: 0.86 } : { scale: 1.04, rotate: -1.5, opacity: 1 }, springBounce)
    }
    const overGroup = !trash && (onGroupDrag?.(clip, px, py, false) ?? null) !== null
    onPinHover(!trash && !overGroup && inside(pinBarRef.current, px, py))
  }

  // The article is a layout-animated (transformed) stacking context, so the
  // card's own whileDrag zIndex can't lift it over later grid siblings.
  // Raise the whole article while dragging and until the snap-back settles.
  const [lifted, setLifted] = useState(false)
  const liftTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(liftTimer.current), [])

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    // A drag must never also count as a tap-to-copy on release.
    window.setTimeout(() => {
      dragged.current = false
    }, 0)
    if (gesture === 'swipe') {
      // Swiping right on an open retract confirm only cancels it. The offset is
      // measured from the -REVEAL rest point, so treating it as a fresh swipe
      // would turn the cancel into a copy.
      if (armedAtStart.current) {
        armedAtStart.current = false
        const keep = info.offset.x < 24
        setArmed(keep)
        animateValue(x, keep ? -REVEAL : 0, springBounce)
        return
      }
      if (info.offset.x > 72) {
        setArmed(false)
        onCopy(clip)
      } else if (info.offset.x < -72) setArmed(true)
      else setArmed(false)
      // Re-run the settle even if `armed` did not change.
      animateValue(x, info.offset.x < -72 ? -REVEAL : 0, springBounce)
      return
    }
    const px = info.point.x - window.scrollX
    const py = info.point.y - window.scrollY
    const trash = (trashRef?.current?.track(px, py) ?? false) || overTrash.current
    overTrash.current = false
    onPinHover(false)
    const mouth = trashRef?.current?.mouth()
    const el = cardRef.current
    if (trash && mouth && el) {
      onDragPhase?.({ clip, end: 'deleted' })
      // Fly into the bin's mouth and dissolve, then hand off to the normal
      // retract path (same undo toast as every other delete).
      const r = el.getBoundingClientRect()
      const dx = mouth.x - (r.left + r.width / 2)
      const dy = mouth.y - (r.top + r.height / 2)
      if (reduced) return onRetract(clip)
      void animate(el, { x: dragX.get() + dx, y: dragY.get() + dy, scale: 0.08, rotate: 14, opacity: 0, filter: 'blur(2px)' }, { duration: 0.28, ease: easeIn }).then(() => onRetract(clip))
      return
    }
    onDragPhase?.({ clip, end: 'cancel' })
    window.clearTimeout(liftTimer.current)
    liftTimer.current = window.setTimeout(() => setLifted(false), 600)
    if ((onGroupDrag?.(clip, px, py, true) ?? null) !== null) return
    const over = inside(pinBarRef.current, px, py)
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
      style={lifted ? { zIndex: 40 } : undefined}
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
      {gesture === 'swipe' ? (
        <AnimatePresence>
          {armed ? (
            <ConfirmRetract
              onConfirm={() => {
                setArmed(false)
                onRetract(clip)
              }}
            />
          ) : null}
        </AnimatePresence>
      ) : null}
      <motion.div ref={scope} className="relative h-full">
        <motion.div
          ref={cardRef}
          role="button"
          tabIndex={0}
          aria-label={`${labelFor(clip)}，点按显示操作`}
          aria-expanded={open}
          data-card
          data-open={open || undefined}
          className="dd-card flex h-full cursor-pointer select-none flex-col outline-none"
          data-aging={aging || undefined}
          data-copied={copied || undefined}
          style={{ ['--life' as string]: life, ['--curl' as string]: curl, x: gesture === 'swipe' ? x : dragX, y: gesture === 'swipe' ? undefined : dragY, touchAction: gesture === 'swipe' ? 'pan-y' : 'none' }}
          drag={reduced ? false : gesture === 'swipe' ? 'x' : true}
          dragSnapToOrigin={gesture !== 'swipe'}
          dragMomentum={gesture !== 'swipe'}
          dragElastic={gesture === 'swipe' ? 0.6 : 0.9}
          dragTransition={{ bounceStiffness: 420, bounceDamping: 20 }}
          whileDrag={gesture === 'swipe' ? { cursor: 'grabbing' } : { scale: 1.04, rotate: -1.5, zIndex: 40, boxShadow: 'var(--shadow-3)', cursor: 'grabbing' }}
          animate={copied && !reduced ? { y: -3, boxShadow: 'var(--shadow-3)' } : { y: 0, boxShadow: 'var(--shadow-1)' }}
          transition={springBounce}
          onDragStart={() => {
            dragged.current = true
            armedAtStart.current = armed
            setHover(false)
            overTrash.current = false
            if (gesture === 'pin-drag') {
              window.clearTimeout(liftTimer.current)
              setLifted(true)
            }
            if (gesture === 'pin-drag' && cardRef.current) onDragPhase?.({ clip, rect: cardRef.current.getBoundingClientRect() })
          }}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
          onTap={handleTap}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpen(open ? null : clip)
            } else if (e.key === 'Escape' && open) onOpen(null)
          }}
        >
          <div className="dd-card-body flex-1">
            {variant === 'grid' ? <GridBody clip={clip} viewing={viewer !== null} onView={setViewer} /> : <RowBody clip={clip} viewing={viewer !== null} onView={setViewer} />}
          </div>
          <footer className={`flex items-center gap-2 border-t border-[var(--line-1)] py-2 pl-3 ${aging ? 'pr-6' : 'pr-3'} text-[11px] text-[var(--fg-3)]`}>
            <span className="inline-flex items-center gap-1" style={{ color: deviceColor(device.kind) }}>
              <DeviceGlyph kind={device.kind} className="size-3.5" />
              <span className="text-[var(--fg-2)]">{device.name}</span>
            </span>
            <span aria-hidden>·</span>
            <span>{formatAgo(now - clip.createdAt)}</span>
            <GroupBadge group={clip.group} groups={groups} onMove={(g) => onMoveGroup(clip, g)} />
            <span className={`dd-mono ml-auto tabular-nums ${aging ? 'text-[var(--accent)]' : ''}`}>{shortLeft(remaining)}</span>
          </footer>
          <div className="dd-card-actions absolute right-2 top-2 flex gap-1">
            {!clip.pinned ? (
              <ActionButton label="置顶" onClick={() => onPin(clip)} className="hover:text-[var(--fg)]">
                <PinIcon className="size-3.5" />
              </ActionButton>
            ) : null}
            <HoldToConfirm label="撤回" onConfirm={() => onRetract(clip)} className="size-7 rounded-[var(--radius-sm)] border border-[var(--line-2)] bg-[var(--surface-1)] text-[var(--fg-2)] hover:text-[var(--accent)]">
              <Undo2Icon className="size-3.5" />
            </HoldToConfirm>
            <ActionButton label={copied ? '已复制' : '复制'} onClick={() => onCopy(clip)} className={copied ? 'text-[var(--ok)]' : 'hover:text-[var(--fg)]'}>
              <AnimatePresence mode="popLayout" initial={false}>
                {copied ? (
                  <motion.span key="ok" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={springBounce} className="grid place-items-center">
                    <CheckIcon className="size-3.5" />
                  </motion.span>
                ) : (
                  <motion.span key="cp" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={{ duration: dur.fast }} className="grid place-items-center">
                    <CopyIcon className="size-3.5" />
                  </motion.span>
                )}
              </AnimatePresence>
            </ActionButton>
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
      <MediaViewer media={viewer} anchor={scope} reduced={reduced} onClose={() => setViewer(null)} />
    </motion.article>
  )
}

/** Card action: keeps its press away from the card's drag / tap handlers. */
function ActionButton({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: ReactNode }) {
  const ref = useIsolatePointer<HTMLButtonElement>()
  return (
    <button ref={ref} type="button" data-action aria-label={label} title={label} onClick={onClick} className={`grid size-7 place-items-center rounded-[var(--radius-sm)] border border-[var(--line-2)] bg-[var(--surface-1)] text-[var(--fg-2)] ${className ?? ''}`}>
      {children}
    </button>
  )
}
