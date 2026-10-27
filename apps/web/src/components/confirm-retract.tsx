import { useEffect, useLayoutEffect, useRef } from 'react'
import { motion } from 'motion/react'
import { Undo2Icon } from 'lucide-react'
import { dur, easeIn, springBounce } from '@/lib/motion.ts'

/** Swipe-left reveal: the card rests aside and this button waits behind it (shared with the demo). */
/**
 * The confirm fires on pointerup, not click. A left swipe is a flick, so the
 * browser starts a fling/momentum gesture; the next tap only cancels that
 * fling and its click is swallowed (Chrome tap suppression, iOS momentum
 * stop). pointerdown/pointerup still arrive, so a press that starts and ends
 * on the button counts. click stays as the path for keyboard and mouse.
 */
export function ConfirmRetract({ onConfirm, label = '确认撤回' }: { onConfirm: () => void; label?: string }) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const latest = useRef(onConfirm)
  useLayoutEffect(() => {
    latest.current = onConfirm
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let down: { id: number; x: number; y: number } | null = null
    let fired = false
    const fire = () => {
      if (fired) return
      fired = true
      latest.current()
    }
    const onDown = (e: PointerEvent) => {
      // Keep the press away from the card's own drag / tap listeners.
      e.stopPropagation()
      if (e.isPrimary && e.button === 0) down = { id: e.pointerId, x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent) => {
      const start = down
      down = null
      if (!start || e.pointerId !== start.id) return
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 14) return
      if (!el.contains(document.elementFromPoint(e.clientX, e.clientY))) return
      fire()
      // The button is gone by the time a (possibly) synthesised click lands;
      // don't let that click hit whatever slides in underneath.
      const swallow = (ev: MouseEvent) => {
        ev.preventDefault()
        ev.stopPropagation()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 400)
    }
    const onCancel = () => {
      down = null
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    el.addEventListener('click', fire)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      el.removeEventListener('click', fire)
    }
  }, [])
  return (
    <motion.button
      ref={ref}
      type="button"
      data-action
      data-retract="confirm"
      aria-label={label}
      title={label}
      autoFocus
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1, transition: springBounce }}
      exit={{ opacity: 0, scale: 0.8, transition: { duration: dur.fast, ease: easeIn } }}
      className="absolute inset-y-1.5 right-1.5 z-20 flex w-[80px] flex-col items-center justify-center gap-1 rounded-[var(--radius-sm)] bg-[var(--brand)] text-[11.5px] font-medium text-white"
    >
      <Undo2Icon className="size-4" />
      {label}
    </motion.button>
  )
}

