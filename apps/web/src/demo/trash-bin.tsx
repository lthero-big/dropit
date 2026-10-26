import { useEffect, useImperativeHandle, useState, type Ref } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useSpring } from 'motion/react'
import { dur, easeIn, easeOut, springBounce } from './motion-tokens.ts'
import { TRASH_HIT as HIT, TRASH_MAGNET as MAGNET, TRASH_SIZE as SIZE, type TrashAnchor, type TrashHandle } from './trash-anchor.ts'

/**
 * PC-only second delete path: while a card is being dragged (the same drag
 * used for pinning), a bin pops out right next to it. Inspired by 21st.dev
 * "Bucket" (0xUrvish, lid + gulp on drop), "Halo Dropzone" (cult-ui, glowing
 * rim when armed) and folio's "下拉收进画布" (Ben Journal: the item shrinks
 * and flies into its slot).
 */

type Props = {
  anchor: TrashAnchor | null
  /** a card was just dropped in: play the gulp before hiding */
  gulp: boolean
  reduced: boolean
  handle: Ref<TrashHandle>
}

export function TrashBin({ anchor, gulp, reduced, handle }: Props) {
  const [hot, setHot] = useState(false)
  const pullX = useMotionValue(0)
  const pullY = useMotionValue(0)
  const mx = useSpring(pullX, { stiffness: 380, damping: 24 })
  const my = useSpring(pullY, { stiffness: 380, damping: 24 })

  useImperativeHandle(
    handle,
    () => ({
      track(x, y) {
        if (!anchor) return false
        const dx = x - anchor.x
        const dy = y - anchor.y
        const d = Math.hypot(dx, dy)
        if (!reduced) {
          // Magnetic pull: the bin leans toward the card, harder the closer it gets.
          const k = d < MAGNET ? 0.24 * (1 - d / MAGNET) + 0.08 : 0
          pullX.set(Math.max(-18, Math.min(18, dx * k)))
          pullY.set(Math.max(-18, Math.min(18, dy * k)))
        }
        const over = d < HIT
        setHot((v) => (v === over ? v : over))
        return over
      },
      mouth() {
        return anchor ? { x: anchor.x + mx.get(), y: anchor.y + my.get() } : null
      },
    }),
    [anchor, reduced, pullX, pullY, mx, my],
  )

  // A new drag session starts centred; after a gulp the bin springs back to centre.
  useEffect(() => {
    if (anchor && !gulp) return
    const a = animate(pullX, 0, springBounce)
    const b = animate(pullY, 0, springBounce)
    return () => {
      a.stop()
      b.stop()
    }
  }, [anchor, gulp, pullX, pullY])
  const armed = hot && !gulp && anchor !== null

  const from = anchor?.side === 'left' ? { x: 18 } : anchor?.side === 'below' ? { y: -14 } : { x: -18 }
  const lidOpen = armed
  return (
    <AnimatePresence>
      {anchor ? (
        <motion.div
          key="trash"
          data-trash
          data-hot={armed || undefined}
          aria-hidden
          className="pointer-events-none fixed z-[60]"
          style={{ left: anchor.x - SIZE / 2, top: anchor.y - SIZE / 2, width: SIZE, height: SIZE, x: mx, y: my }}
        >
          <motion.div
            className="relative grid size-full place-items-center"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.5, ...from }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: gulp ? [1.22, 0.86, 1.06, 1] : armed ? 1.2 : 1, x: 0, y: 0 }}
            exit={reduced ? { opacity: 0, transition: { duration: dur.fast } } : { opacity: 0, scale: 0.6, transition: { duration: dur.base, ease: easeIn } }}
            transition={gulp ? { duration: 0.42, ease: easeOut } : springBounce}
          >
            {/* halo rim: breathes while armed */}
            <motion.span
              className="absolute inset-0 rounded-full"
              animate={
                armed && !reduced
                  ? { opacity: [0.55, 0.2, 0.55], scale: [1.18, 1.42, 1.18] }
                  : { opacity: 0, scale: 1 }
              }
              transition={armed ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut' } : { duration: dur.fast }}
              style={{ background: 'radial-gradient(circle, color-mix(in oklab, var(--accent) 45%, transparent) 0%, transparent 70%)' }}
            />
            <motion.span
              className="relative grid size-full place-items-center rounded-full border shadow-[var(--shadow-3)]"
              animate={
                armed || gulp
                  ? { backgroundColor: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }
                  : { backgroundColor: 'var(--surface-1)', borderColor: 'var(--line-2)', color: 'var(--fg-2)' }
              }
              transition={{ duration: dur.fast }}
              style={{ borderStyle: armed || gulp ? 'solid' : 'dashed' }}
            >
              <svg viewBox="0 0 24 24" className="size-6 overflow-visible" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <motion.g
                  style={{ originX: '19px', originY: '6px' }}
                  animate={reduced ? { rotate: 0 } : { rotate: lidOpen ? 32 : 0, y: lidOpen ? -2.5 : 0 }}
                  transition={springBounce}
                >
                  <path d="M3 6h18" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </motion.g>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
              </svg>
            </motion.span>
            <motion.span
              className="dd-mono absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--line-1)] bg-[var(--surface-1)] px-1.5 py-0.5 text-[11px] font-medium shadow-[var(--shadow-1)]"
              animate={{ color: armed || gulp ? 'var(--accent)' : 'var(--fg-3)' }}
              transition={{ duration: dur.fast }}
            >
              {gulp ? '已删除' : armed ? '松手删除' : '拖到这里删除'}
            </motion.span>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
