import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composerTextareaMaxHeight, keyboardViewport, useKeyboardViewport } from './board-hooks.ts'

const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

afterEach(() => {
  if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport)
  else Reflect.deleteProperty(window, 'visualViewport')
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
})

function ViewportProbe() {
  const viewport = useKeyboardViewport()
  return <output>{`${viewport.open}:${viewport.inset}:${viewport.height}`}</output>
}

describe('keyboardViewport', () => {
  it('uses the visual viewport inset when a keyboard overlays the layout viewport', () => {
    expect(keyboardViewport(844, 500, 0, 844, true)).toEqual({ inset: 344, open: true, height: 500 })
    expect(keyboardViewport(844, 500, 24, 844, true)).toEqual({ inset: 320, open: true, height: 500 })
  })

  it('recognizes a resized layout viewport without adding a second bottom offset', () => {
    expect(keyboardViewport(500, 500, 0, 844, true)).toEqual({ inset: 0, open: true, height: 500 })
  })

  it('does not reserve keyboard space after focus leaves an editable control', () => {
    expect(keyboardViewport(844, 500, 0, 844, false)).toEqual({ inset: 0, open: false, height: 500 })
  })

  it('keeps a 40px editor and all mobile controls below the fixed header in a 180px viewport', () => {
    expect(composerTextareaMaxHeight(180, true)).toBe(52)
    expect(composerTextareaMaxHeight(180, false)).toBe(96)
    expect(composerTextareaMaxHeight(360, true)).toBe(192)
  })

  it('updates from visual viewport events and removes their listeners on unmount', async () => {
    const visual = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 }) as unknown as VisualViewport
    const remove = vi.spyOn(visual, 'removeEventListener')
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
    const { unmount } = render(<><textarea aria-label="draft" /><ViewportProbe /></>)
    screen.getByLabelText('draft').focus()
    ;(visual as unknown as { height: number }).height = 500
    ;(visual as unknown as { offsetTop: number }).offsetTop = 24
    act(() => visual.dispatchEvent(new Event('resize')))
    await waitFor(() => expect(screen.getByText('true:320:500')).toBeTruthy())
    unmount()
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
  })
})
