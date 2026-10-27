/**
 * Board chrome shared by the real clipboard board and the RHEA-191 demo
 * (RHEA-190 step 4): device dots with a send ripple, the dashed pin bar,
 * the magnetic drop target, timeline sections, skeletons and the empty state.
 */
import { useEffect, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react'
import { PinIcon, UploadIcon } from 'lucide-react'
import { dur, easeIn, easeOut, springBounce } from '@/lib/motion.ts'

/* ------------------------------------------------------------ device dot */

export function DeviceDot(props: {
  color: string
  online: boolean
  title: string
  /** bump to play the "sent from here" ripple once */
  ripple: number
  dotRef?: (el: HTMLElement | null) => void
  /** hover label under the dot (desktop) */
  label?: ReactNode
}) {
  const { color, online, title, ripple, dotRef, label } = props
  return (
    <span className="group relative grid size-6 place-items-center" title={title} data-device-dot="">
      <span
        ref={dotRef}
        className="relative block size-2.5 rounded-full"
        style={{ background: online ? color : 'transparent', boxShadow: online ? undefined : 'inset 0 0 0 1.5px var(--line-3)' }}
      >
        <AnimatePresence>
          {ripple > 0 ? (
            <motion.span
              key={ripple}
              aria-hidden
              className="absolute inset-0 rounded-full"
              style={{ boxShadow: `0 0 0 1.5px ${color}` }}
              initial={{ scale: 1, opacity: 0.9 }}
              animate={{ scale: 4.2, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, ease: easeOut }}
            />
          ) : null}
        </AnimatePresence>
        {ripple > 0 ? (
          <motion.span
            key={`b${ripple}`}
            aria-hidden
            className="absolute inset-0 rounded-full"
            style={{ boxShadow: `0 0 0 1px ${color}` }}
            initial={{ scale: 1, opacity: 0.6 }}
            animate={{ scale: 2.6, opacity: 0 }}
            transition={{ duration: 0.9, ease: easeOut, delay: 0.18 }}
          />
        ) : null}
      </span>
      {label ? (
        <span className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 hidden -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--fg)] px-1.5 py-0.5 text-[10px] text-[var(--bg)] group-hover:flex">
          {label}
        </span>
      ) : null}
    </span>
  )
}

/* --------------------------------------------------------------- pin bar */

export function PinBarShell(props: {
  barRef: RefObject<HTMLElement | null>
  hover: boolean
  reduced: boolean
  empty: boolean
  children: ReactNode
  /** chips scroll sideways (demo); cards stack (board) */
  layout?: 'chips' | 'stack'
}) {
  const { barRef, hover, reduced, empty, children, layout = 'chips' } = props
  return (
    <motion.section
      ref={barRef}
      layout={!reduced}
      aria-label="置顶栏"
      data-hover={hover || undefined}
      data-pin-bar=""
      className={`relative rounded-[var(--radius-lg)] border border-dashed px-2.5 py-2 ${
        layout === 'chips' || empty ? 'dd-scroll-x flex min-h-[52px] items-center gap-2 overflow-x-auto' : 'flex flex-col gap-2'
      }`}
      animate={
        hover
          ? { borderColor: 'var(--brand)', backgroundColor: 'var(--brand-soft)', scale: reduced ? 1 : 1.015 }
          : { borderColor: 'var(--line-2)', backgroundColor: 'var(--surface-0)', scale: 1 }
      }
      transition={{ ...springBounce, borderColor: { duration: dur.fast }, backgroundColor: { duration: dur.fast } }}
    >
      <span className="flex shrink-0 items-center gap-1.5 pr-1 text-[11px] text-[var(--fg-3)]">
        <motion.span animate={hover && !reduced ? { rotate: [0, -18, 12, 0] } : { rotate: 0 }} transition={{ duration: dur.slow }}>
          <PinIcon className={`size-3.5 ${hover ? 'text-[var(--brand)]' : ''}`} />
        </motion.span>
        置顶
        <AnimatePresence>
          {hover && layout === 'stack' && !empty ? (
            <motion.span initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, transition: { duration: dur.fast } }} className="ml-auto pr-1 text-[12px] font-medium text-[var(--brand)]">
              松手吸附
            </motion.span>
          ) : null}
        </AnimatePresence>
      </span>
      {children}
      {empty ? <span className="text-[12px] text-[var(--fg-4)]">把卡片拖到这里置顶</span> : null}
      <AnimatePresence>
        {hover && (layout === 'chips' || empty) ? (
          <motion.span
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: dur.fast } }}
            className="ml-auto shrink-0 pr-1 text-[12px] font-medium text-[var(--brand)]"
          >
            松手吸附
          </motion.span>
        ) : null}
      </AnimatePresence>
    </motion.section>
  )
}

/* ------------------------------------------------------- magnetic drop zone */

/**
 * What a composer turns into while files are dragged over the window: a
 * dotted field whose target leans toward the cursor. Tracks dragover itself.
 */
export function MagnetDropZone(props: { zoneRef: RefObject<HTMLElement | null>; reduced: boolean; title?: string; hint?: string }) {
  const { zoneRef, reduced, title = '松手，吸进来', hint = '图片会落进列表，其他文件按类型归档' } = props
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const sx = useSpring(mx, { stiffness: 300, damping: 22 })
  const sy = useSpring(my, { stiffness: 300, damping: 22 })
  useEffect(() => {
    const onOver = (e: DragEvent) => {
      const r = zoneRef.current?.getBoundingClientRect()
      if (!r || reduced) return
      // Magnetic pull: the target leans toward the cursor, capped.
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      mx.set(Math.max(-60, Math.min(60, (e.clientX - cx) * 0.18)))
      my.set(Math.max(-24, Math.min(24, (e.clientY - cy) * 0.18)))
    }
    window.addEventListener('dragover', onOver)
    return () => window.removeEventListener('dragover', onOver)
  }, [mx, my, reduced, zoneRef])
  return (
    <motion.div style={{ x: sx, y: sy }} className="flex flex-col items-center gap-2 text-[var(--brand)]">
      <motion.span
        className="grid size-14 place-items-center rounded-full border border-dashed border-[var(--brand)] bg-[var(--brand-soft)]"
        animate={reduced ? undefined : { scale: [1, 1.06, 1] }}
        transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
      >
        <UploadIcon className="size-5" />
      </motion.span>
      <span className="text-[13px] font-medium">{title}</span>
      <span className="text-[11px] text-[var(--fg-3)]">{hint}</span>
    </motion.div>
  )
}

/* -------------------------------------------------------------- timeline */

export function TimelineSection(props: { reduced: boolean; dotColor?: string; title: ReactNode; count: number; extra?: ReactNode; children: ReactNode }) {
  const { reduced, dotColor = 'var(--fg-3)', title, count, extra, children } = props
  return (
    <motion.section
      layout={!reduced}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
      className="grid grid-cols-[18px_1fr] gap-x-3"
      data-timeline-section=""
    >
      <div className="relative flex justify-center">
        <span className="relative z-10 mt-[3px] size-2.5 rounded-full ring-4 ring-[var(--bg)]" style={{ background: dotColor }} />
        <span className="absolute bottom-0 top-3 w-px bg-[var(--line-2)]" />
      </div>
      <div className="flex min-w-0 flex-col gap-2 pb-1">
        <h3 className="dd-display m-0 flex items-center gap-2 text-[13px] font-semibold text-[var(--fg)]">
          {title}
          <span className="dd-mono text-[11px] font-normal text-[var(--fg-3)]">{count}</span>
          {extra}
        </h3>
        {children}
      </div>
    </motion.section>
  )
}

/* ---------------------------------------------------------------- states */

export function BoardSkeletons({ view }: { view: 'grid' | 'rows' }) {
  const n = view === 'grid' ? 6 : 5
  return (
    <div aria-busy="true" aria-label="加载中" className={view === 'grid' ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3' : 'flex flex-col gap-2 pl-[30px]'}>
      {Array.from({ length: n }, (_, i) => (
        <motion.div key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: dur.base, delay: i * 0.04 }} className="dd-card overflow-hidden">
          {view === 'grid' ? (
            <div className="flex flex-col gap-3 p-3">
              <div className="dd-skel h-2.5 w-12" />
              <div className="flex gap-2.5">
                <div className="dd-skel size-7 shrink-0" />
                <div className="flex flex-1 flex-col gap-2">
                  <div className="dd-skel h-3 w-[85%]" />
                  <div className="dd-skel h-3 w-[55%]" />
                </div>
              </div>
              <div className="dd-skel h-12 w-full" style={{ opacity: i % 2 ? 1 : 0 }} />
            </div>
          ) : (
            <div className="flex items-center gap-3 px-3 py-3">
              <div className="dd-skel size-6 shrink-0" />
              <div className="dd-skel h-3 flex-1" style={{ maxWidth: `${60 + ((i * 13) % 30)}%` }} />
            </div>
          )}
          <div className="flex gap-2 border-t border-[var(--line-1)] px-3 py-2.5">
            <div className="dd-skel h-2.5 w-20" />
            <div className="dd-skel ml-auto h-2.5 w-10" />
          </div>
        </motion.div>
      ))}
    </div>
  )
}

export function BoardEmpty({ title, body, children }: { title: string; body: ReactNode; children?: ReactNode }) {
  const reduced = useReducedMotion()
  const sheet = (i: number) => ({
    initial: { opacity: 0, y: 16, rotate: 0 },
    animate: { opacity: 1, y: reduced ? 0 : [0, -4, 0], rotate: [-8, 3, 10][i] },
    transition: { opacity: { duration: dur.slow, delay: i * 0.06 }, rotate: { ...springBounce, delay: i * 0.06 }, y: { duration: 3.2, repeat: Infinity, ease: 'easeInOut' as const, delay: i * 0.4 } },
  })
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: dur.slow, ease: easeOut }}
      className="flex flex-col items-center gap-5 rounded-[var(--radius-lg)] border border-dashed border-[var(--line-2)] px-6 py-16 text-center"
      data-board-empty=""
    >
      <div className="relative h-24 w-28" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            {...sheet(i)}
            className="absolute left-5 top-2 h-20 w-16 rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-1)] shadow-[var(--elev-2)]"
            style={{ zIndex: i }}
          >
            <div className="m-2 h-1.5 w-8 rounded-full bg-[var(--surface-2)]" />
            <div className="mx-2 h-1.5 w-10 rounded-full bg-[var(--surface-2)]" />
            {i === 2 ? <span className="absolute bottom-2 right-2 size-2 rounded-full bg-[var(--brand)]" /> : null}
          </motion.div>
        ))}
      </div>
      <div className="flex max-w-sm flex-col gap-1.5">
        <p className="dd-display m-0 text-[17px] font-semibold text-[var(--fg)]">{title}</p>
        <p className="m-0 text-[13px] leading-relaxed text-[var(--fg-3)]">{body}</p>
      </div>
      {children ? <div className="flex gap-2">{children}</div> : null}
    </motion.div>
  )
}
