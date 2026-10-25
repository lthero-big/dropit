import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const ACTION = 40
const PAD = 8
const BORDER = 4
const OPEN_ROW = 48
const FADE_MS = 90
const ENTER_MS = 200
const ENTER_DELAY_MS = 100

export function ExpandCapsule({
  label,
  icon,
  children,
  stiffness = 300,
  damping = 25,
  collapsedWidth = 40,
  height = 40,
  className,
}: {
  label: string
  icon: ReactNode
  children: ReactNode
  stiffness?: number
  damping?: number
  collapsedWidth?: number
  height?: number
  className?: string
}) {
  const pillRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const actsRef = useRef<HTMLDivElement>(null)
  const expandedRef = useRef(false)
  const gen = useRef(0)
  const shrinkTimer = useRef(0)
  const motion = useRef({ w: collapsedWidth, v: 0, target: collapsedWidth, raf: 0, last: 0 })
  const [expanded, setExpanded] = useState(false)

  const setPill = useCallback((node: HTMLDivElement | null) => {
    pillRef.current = node
  }, [])

  const setActs = useCallback((node: HTMLDivElement | null) => {
    actsRef.current = node
  }, [])

  function prefersReducedMotion() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  function setTarget(next: number) {
    const motionState = motion.current
    const pill = pillRef.current
    motionState.target = next
    if (!pill) return
    if (prefersReducedMotion()) {
      cancelAnimationFrame(motionState.raf)
      motionState.raf = 0
      motionState.w = next
      motionState.v = 0
      pill.style.width = `${next}px`
      return
    }
    if (motionState.raf) return
    motionState.last = performance.now()
    const tick = (time: number) => {
      const dt = Math.min((time - motionState.last) / 1000, 0.05)
      motionState.last = time
      // Semi-implicit Euler, 1/240s substeps. a = (-k (w - target) - c v) / m
      const steps = Math.max(1, Math.ceil(dt * 240))
      const step = dt / steps
      for (let index = 0; index < steps; index += 1) {
        const accel = (-stiffness * (motionState.w - motionState.target) - damping * motionState.v) / 1
        motionState.v += accel * step
        motionState.w += motionState.v * step
      }
      if (Math.abs(motionState.w - motionState.target) < 0.05 && Math.abs(motionState.v) < 0.05) {
        motionState.w = motionState.target
        motionState.v = 0
        pill.style.width = `${motionState.w}px`
        motionState.raf = 0
        return
      }
      pill.style.width = `${motionState.w}px`
      motionState.raf = requestAnimationFrame(tick)
    }
    motionState.raf = requestAnimationFrame(tick)
  }

  function collapsedSize() {
    const parentWidth = pillRef.current?.parentElement?.clientWidth ?? 0
    if (parentWidth > 0) return Math.min(collapsedWidth, parentWidth)
    return collapsedWidth
  }

  function measureLayout() {
    const acts = actsRef.current
    const count = acts ? acts.querySelectorAll('button, a').length : 0
    let content = PAD + ACTION * count
    if (acts) {
      acts.style.width = 'max-content'
      acts.style.flexWrap = 'nowrap'
      acts.style.flexDirection = 'row'
      acts.style.whiteSpace = 'nowrap'
      if (acts.offsetWidth > 0) content = acts.offsetWidth
    }
    const natural = content + BORDER
    const parentWidth = pillRef.current?.parentElement?.clientWidth ?? 0
    const limit = parentWidth > 0 ? parentWidth : Number.POSITIVE_INFINITY
    const openHeight = Math.max(height, OPEN_ROW)
    if (natural <= limit) return { width: natural, height: openHeight, wrap: false, vertical: false, count }
    if (limit < ACTION + PAD + BORDER) {
      return {
        width: Math.min(height, limit),
        height: Math.max(height, count * ACTION + PAD + BORDER),
        wrap: false,
        vertical: true,
        count,
      }
    }
    const perRow = Math.max(1, Math.floor((limit - BORDER - PAD) / ACTION))
    const rows = Math.ceil(Math.max(count, 1) / perRow)
    return {
      width: limit,
      height: Math.max(height, rows * ACTION + PAD + BORDER),
      wrap: rows > 1,
      vertical: false,
      count,
    }
  }

  function applyLayout(layout: { width: number; height: number; wrap: boolean; vertical: boolean }) {
    const pill = pillRef.current
    const acts = actsRef.current
    if (!pill || !acts) return
    pill.style.height = `${layout.height}px`
    pill.dataset.layout = layout.vertical ? 'vertical' : layout.wrap ? 'wrap' : 'row'
    if (layout.vertical) {
      acts.style.flexDirection = 'column'
      acts.style.flexWrap = 'nowrap'
      acts.style.whiteSpace = 'normal'
      acts.style.width = `${Math.max(ACTION, layout.width - BORDER)}px`
      acts.style.top = '0'
      acts.style.bottom = 'auto'
      acts.style.height = `${Math.max(ACTION, layout.height - BORDER)}px`
      return
    }
    if (layout.wrap) {
      acts.style.flexDirection = 'row'
      acts.style.flexWrap = 'wrap'
      acts.style.whiteSpace = 'normal'
      acts.style.width = `${Math.max(ACTION, layout.width - BORDER)}px`
      acts.style.top = '0'
      acts.style.bottom = 'auto'
      acts.style.height = `${Math.max(ACTION, layout.height - BORDER)}px`
      return
    }
    acts.style.flexDirection = 'row'
    acts.style.flexWrap = 'nowrap'
    acts.style.whiteSpace = 'nowrap'
    acts.style.width = 'max-content'
    acts.style.top = '0'
    acts.style.bottom = '0'
    acts.style.height = 'auto'
  }

  function play(element: HTMLElement | null, frames: Keyframe[], options: KeyframeAnimationOptions) {
    if (!element) return
    if (typeof element.animate !== 'function') {
      const end = frames[frames.length - 1]
      if (end && end.opacity != null) element.style.opacity = String(end.opacity)
      if (end && typeof end.transform === 'string') element.style.transform = end.transform
      return
    }
    try {
      element.animate(frames, options)
    } catch {
      const end = frames[frames.length - 1]
      if (end && end.opacity != null) element.style.opacity = String(end.opacity)
      if (end && typeof end.transform === 'string') element.style.transform = end.transform
    }
  }

  function expand(fromKeyboard: boolean) {
    if (expandedRef.current) return
    expandedRef.current = true
    gen.current += 1
    window.clearTimeout(shrinkTimer.current)
    const motionScale = prefersReducedMotion() ? 0 : 1
    const trigger = triggerRef.current
    const acts = actsRef.current
    const token = gen.current
    if (trigger) {
      trigger.tabIndex = -1
      trigger.style.pointerEvents = 'none'
      play(
        trigger,
        [
          { opacity: 1, transform: 'translateY(0px)' },
          { opacity: 0, transform: 'translateY(-20px)' },
        ],
        { duration: ENTER_MS * motionScale, easing: 'ease-in-out', fill: 'forwards' },
      )
    }
    window.setTimeout(() => {
      if (token === gen.current && expandedRef.current && trigger) trigger.style.visibility = 'hidden'
    }, ENTER_MS * motionScale)
    if (acts) {
      acts.style.visibility = 'visible'
      play(
        acts,
        [
          { opacity: 0, transform: 'scale(0.9)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        { duration: ENTER_MS * motionScale, delay: ENTER_DELAY_MS * motionScale, easing: 'ease-in-out', fill: 'both' },
      )
    }
    const layout = measureLayout()
    applyLayout(layout)
    setTarget(layout.width)
    setExpanded(true)
    if (fromKeyboard) acts?.querySelector<HTMLElement>('button, a')?.focus()
  }

  function finishCollapse() {
    const pill = pillRef.current
    const acts = actsRef.current
    if (pill) {
      pill.style.height = `${height}px`
      pill.dataset.layout = 'closed'
    }
    if (acts) {
      acts.style.visibility = 'hidden'
      acts.style.flexDirection = 'row'
      acts.style.flexWrap = 'nowrap'
      acts.style.whiteSpace = 'nowrap'
      acts.style.width = 'max-content'
      acts.style.top = '0'
      acts.style.bottom = '0'
      acts.style.height = 'auto'
    }
    setTarget(collapsedSize())
  }

  function collapse() {
    if (!expandedRef.current) return
    expandedRef.current = false
    gen.current += 1
    const token = gen.current
    const motionScale = prefersReducedMotion() ? 0 : 1
    const trigger = triggerRef.current
    const acts = actsRef.current
    const hadFocus = !!acts && acts.contains(document.activeElement)
    if (trigger) {
      trigger.tabIndex = 0
      trigger.style.pointerEvents = 'auto'
      trigger.style.visibility = 'visible'
      play(
        trigger,
        [
          { opacity: 0, transform: 'translateY(20px)' },
          { opacity: 1, transform: 'translateY(0px)' },
        ],
        { duration: ENTER_MS * motionScale, delay: (FADE_MS + 40) * motionScale, easing: 'ease-in-out', fill: 'both' },
      )
    }
    play(
      acts,
      [
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.9)' },
      ],
      { duration: FADE_MS * motionScale, easing: 'ease-out', fill: 'forwards' },
    )
    window.clearTimeout(shrinkTimer.current)
    if (motionScale === 0) finishCollapse()
    else {
      shrinkTimer.current = window.setTimeout(() => {
        if (token === gen.current && !expandedRef.current) finishCollapse()
      }, FADE_MS)
    }
    setExpanded(false)
    if (hadFocus) trigger?.focus()
  }

  function resync() {
    if (!expandedRef.current) return
    const layout = measureLayout()
    applyLayout(layout)
    const motionState = motion.current
    cancelAnimationFrame(motionState.raf)
    motionState.raf = 0
    motionState.w = layout.width
    motionState.v = 0
    motionState.target = layout.width
    if (pillRef.current) pillRef.current.style.width = `${layout.width}px`
  }

  const api = useRef({ expand, collapse, resync })

  useLayoutEffect(() => {
    const pill = pillRef.current
    const acts = actsRef.current
    if (acts && acts.dataset.ready !== '1') {
      acts.dataset.ready = '1'
      acts.style.visibility = 'hidden'
      acts.style.width = 'max-content'
      acts.style.opacity = '0'
    }
    if (!pill || expandedRef.current) return
    const parentWidth = pill.parentElement?.clientWidth ?? 0
    const width = parentWidth > 0 ? Math.min(collapsedWidth, parentWidth) : collapsedWidth
    motion.current.w = width
    motion.current.target = width
    motion.current.v = 0
    pill.style.width = `${width}px`
    pill.style.height = `${height}px`
    pill.dataset.layout = 'closed'
  }, [collapsedWidth, height])

  useEffect(() => {
    api.current = { expand, collapse, resync }
  })

  useEffect(() => {
    const motionState = motion.current
    const onPointerDown = (event: PointerEvent) => {
      const pill = pillRef.current
      if (!pill || !expandedRef.current) return
      if (event.target instanceof Node && pill.contains(event.target)) return
      api.current.collapse()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      api.current.collapse()
    }
    const onResize = () => api.current.resync()
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(motionState.raf)
      window.clearTimeout(shrinkTimer.current)
    }
  }, [])

  return (
    <div
      ref={setPill}
      data-slot="expand-capsule"
      className={`relative box-border inline-flex max-w-full shrink-0 overflow-hidden border-2 border-foreground bg-card text-foreground ${className ?? ''}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="absolute inset-0 flex cursor-pointer items-center justify-center border-0 bg-transparent text-foreground hover:bg-foreground hover:text-background"
        aria-expanded={expanded}
        aria-label={label}
        title={label}
        tabIndex={expanded ? -1 : 0}
        style={{ pointerEvents: expanded ? 'none' : 'auto' }}
        onClick={(event) => {
          if (!expandedRef.current) api.current.expand(event.detail === 0)
        }}
      >
        {icon}
      </button>
      <div
        ref={setActs}
        data-slot="expand-capsule-actions"
        aria-hidden={expanded ? undefined : true}
        className="absolute top-0 bottom-0 left-0 flex items-center px-1"
      >
        {children}
      </div>
    </div>
  )
}
