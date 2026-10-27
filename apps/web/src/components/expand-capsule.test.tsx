import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExpandCapsule } from './expand-capsule.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function actions(count = 2) {
  return Array.from({ length: count }, (_, index) => (
    <button key={index} type="button" aria-label={`动作${index + 1}`}>
      {index + 1}
    </button>
  ))
}

function renderCapsule(count = 2, props: { stiffness?: number; damping?: number; collapsedWidth?: number; height?: number } = {}) {
  return render(
    <div data-testid="bound">
      <ExpandCapsule label="更多" icon={<svg aria-hidden="true" />} {...props}>
        {actions(count)}
      </ExpandCapsule>
    </div>,
  )
}

function pill() {
  const node = document.querySelector('[data-slot="expand-capsule"]')
  if (!(node instanceof HTMLElement)) throw new Error('missing capsule')
  return node
}

function acts() {
  const node = document.querySelector('[data-slot="expand-capsule-actions"]')
  if (!(node instanceof HTMLElement)) throw new Error('missing actions')
  return node
}

function mockWidths(actionWidth: number, parentWidth = 0) {
  Object.defineProperty(acts(), 'offsetWidth', { configurable: true, get: () => actionWidth })
  if (parentWidth > 0) {
    Object.defineProperty(screen.getByTestId('bound'), 'clientWidth', { configurable: true, get: () => parentWidth })
  }
}

function queueFrames() {
  const queued: FrameRequestCallback[] = []
  let clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queued.push(callback)
    return queued.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  return {
    queued,
    drain() {
      let guard = 0
      while (queued.length && guard < 400) {
        const callback = queued.shift()
        clock += 16
        callback?.(clock)
        guard += 1
      }
      return guard
    },
    step(ms: number) {
      const callback = queued.shift()
      clock += ms
      callback?.(clock)
    },
  }
}

describe('ExpandCapsule', () => {
  it('collapses to a 40×40 icon button with a label and springs open', () => {
    const frames = queueFrames()
    renderCapsule()
    const trigger = screen.getByRole('button', { name: '更多' })
    expect(pill().style.width).toBe('40px')
    expect(pill().style.height).toBe('40px')
    expect(trigger.style.minWidth).toBe('40px')
    expect(trigger.style.minHeight).toBe('40px')
    expect(trigger.style.top).toBe('-2px')
    expect(trigger.getAttribute('aria-label')).toBe('更多')
    expect(trigger.getAttribute('title')).toBe('更多')
    expect(trigger.textContent ?? '').not.toContain('更多')
    mockWidths(160)
    fireEvent.click(trigger, { detail: 1 })
    frames.drain()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(parseFloat(pill().style.width)).toBeGreaterThan(40)
    expect(screen.getByRole('button', { name: '动作1' })).toBeTruthy()
  })

  it('opens on click, closes on Escape, and restores focus', () => {
    renderCapsule()
    const trigger = screen.getByRole('button', { name: '更多' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: '动作1' })).toBeNull()
    trigger.focus()
    fireEvent.click(trigger)
    const first = screen.getByRole('button', { name: '动作1' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(first).toBe(document.activeElement)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: '动作1' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on an outside pointer and stays open for an inside pointer', () => {
    renderCapsule()
    fireEvent.click(screen.getByRole('button', { name: '更多' }), { detail: 1 })
    fireEvent.pointerDown(screen.getByRole('button', { name: '动作2' }))
    expect(screen.getByRole('button', { name: '更多' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('button', { name: '更多' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('focuses the first action from the keyboard and leaves focus alone for a pointer click', () => {
    renderCapsule()
    const trigger = screen.getByRole('button', { name: '更多' })
    fireEvent.click(trigger, { detail: 1 })
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: '动作1' }))
    fireEvent.pointerDown(document.body)
    trigger.focus()
    fireEvent.click(trigger, { detail: 0 })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '动作1' }))
  })

  it('snaps width and zeroes motion when reduced motion is requested', () => {
    const frames = queueFrames()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false
      },
      onchange: null,
      addListener() {},
      removeListener() {},
    }))
    const animated: KeyframeAnimationOptions[] = []
    vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation((_frames, options) => {
      if (options && typeof options === 'object') animated.push(options)
      return { cancel() {}, finish() {}, persist() {}, finished: Promise.resolve() } as unknown as Animation
    })
    renderCapsule(2, { collapsedWidth: 120, height: 48 })
    mockWidths(160)
    expect(pill().style.width).toBe('120px')
    expect(pill().style.height).toBe('48px')
    fireEvent.click(screen.getByRole('button', { name: '更多' }), { detail: 1 })
    expect(frames.queued).toHaveLength(0)
    expect(pill().style.width).toBe('164px')
    expect(animated.every((options) => options.duration === 0 && (options.delay ?? 0) === 0)).toBe(true)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(pill().style.width).toBe('120px')
    expect(acts().style.visibility).toBe('hidden')
  })

  it('fades the icons for 90ms before the spring shrinks the width', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const frames = queueFrames()
    const animated: KeyframeAnimationOptions[] = []
    vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation((_frames, options) => {
      if (options && typeof options === 'object') animated.push(options)
      return { cancel() {}, finish() {}, persist() {}, finished: Promise.resolve() } as unknown as Animation
    })
    renderCapsule(3)
    mockWidths(200)
    fireEvent.click(screen.getByRole('button', { name: '更多' }), { detail: 1 })
    frames.drain()
    expect(parseFloat(pill().style.width)).toBeCloseTo(204, 3)
    expect(animated[1]?.duration).toBe(200)
    expect(animated[1]?.delay).toBe(100)
    expect(animated[1]?.easing).toBe('ease-in-out')
    const queuedAfterOpen = frames.queued.length
    fireEvent.keyDown(document.body, { key: 'Escape' })
    const fade = animated.at(-1)
    expect(fade?.duration).toBe(90)
    expect(fade?.easing).toBe('ease-out')
    vi.advanceTimersByTime(89)
    expect(frames.queued.length).toBe(queuedAfterOpen)
    expect(parseFloat(pill().style.width)).toBeCloseTo(204, 3)
    vi.advanceTimersByTime(1)
    expect(frames.queued.length).toBeGreaterThan(queuedAfterOpen)
  })

  it('steps the width with stiffness 300 and damping 25', () => {
    const frames = queueFrames()
    renderCapsule(2, { stiffness: 300, damping: 25, collapsedWidth: 120 })
    mockWidths(160)
    fireEvent.click(screen.getByRole('button', { name: '更多' }), { detail: 1 })
    frames.step(1000 / 240)
    const dt = 1 / 240
    const accel = -300 * (120 - 164)
    const velocity = accel * dt
    const width = 120 + velocity * dt
    expect(parseFloat(pill().style.width)).toBeCloseTo(width, 5)
  })

  it('wraps when the row is wider than the parent and stacks when the parent is narrower than one icon', () => {
    renderCapsule(4, { collapsedWidth: 120, height: 48 })
    mockWidths(200, 100)
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false
      },
      onchange: null,
      addListener() {},
      removeListener() {},
    }))
    fireEvent.click(screen.getByRole('button', { name: '更多' }), { detail: 1 })
    expect(pill().dataset.layout).toBe('wrap')
    expect(parseFloat(pill().style.width)).toBe(100)
    expect(parseFloat(pill().style.height)).toBeGreaterThan(48)
    expect(acts().style.flexWrap).toBe('wrap')
    cleanup()
    renderCapsule(2, { collapsedWidth: 120, height: 48 })
    mockWidths(200, 30)
    fireEvent.click(screen.getByRole('button', { name: '更多' }), { detail: 1 })
    expect(pill().dataset.layout).toBe('vertical')
    expect(parseFloat(pill().style.width)).toBeLessThanOrEqual(30)
    expect(acts().style.flexDirection).toBe('column')
  })

  it('uses the collapsed width and height props', () => {
    renderCapsule(1, { collapsedWidth: 88, height: 40 })
    expect(pill().style.width).toBe('88px')
    expect(pill().style.height).toBe('40px')
    expect(pill().className).toContain('border-2')
    expect(pill().className).not.toContain('rounded')
  })
  it('grows into a [data-capsule-bound] ancestor instead of wrapping in a shrink-wrapped row (RHEA-190 step 9)', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 40, height: 40, x: left, y: 0, toJSON() {} }) as DOMRect
    render(
      <div data-capsule-bound="" data-testid="card">
        <div data-testid="row">
          <button type="button">复制</button>
          <ExpandCapsule label="更多" icon={<svg aria-hidden="true" />}>
            {actions(3)}
          </ExpandCapsule>
        </div>
      </div>,
    )
    const row = screen.getByTestId('row')
    Object.defineProperty(acts(), 'offsetWidth', { configurable: true, get: () => 128 })
    // the action row is only as wide as its current content (复制 + closed 更多)
    Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => 84 })
    vi.spyOn(screen.getByTestId('card'), 'getBoundingClientRect').mockReturnValue(rect(0, 360))
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect(270, 84))
    vi.spyOn(pill(), 'getBoundingClientRect').mockReturnValue(rect(314, 40))
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(pill().dataset.layout).toBe('row')
    expect(pill().style.width).toBe('132px')
    expect(acts().style.flexWrap).toBe('nowrap')
  })
})
