import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { SKINS, ThemeProvider, useTheme } from './components/theme-provider.tsx'

function Picker() {
  const { skin, setSkin } = useTheme()
  return (
    <div>
      <span data-testid="skin">{skin}</span>
      {SKINS.map((option) => (
        <button key={option.id} type="button" onClick={() => setSkin(option.id)}>
          {option.id}
        </button>
      ))}
    </div>
  )
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete document.documentElement.dataset.skin
  window.history.replaceState(null, '', '/')
})

describe('interface skins (RHEA-190 m21)', () => {
  it('defaults to paper without a data-skin attribute', () => {
    render(<ThemeProvider><Picker /></ThemeProvider>)
    expect(screen.getByTestId('skin').textContent).toBe('paper')
    expect(document.documentElement.dataset.skin).toBeUndefined()
  })

  it('switches, persists and clears the skin', () => {
    const { unmount } = render(<ThemeProvider><Picker /></ThemeProvider>)
    act(() => screen.getByRole('button', { name: 'terminal' }).click())
    expect(document.documentElement.dataset.skin).toBe('terminal')
    expect(localStorage.getItem('dropit-skin')).toBe('terminal')
    unmount()
    render(<ThemeProvider><Picker /></ThemeProvider>)
    expect(screen.getByTestId('skin').textContent).toBe('terminal')
    act(() => screen.getByRole('button', { name: 'paper' }).click())
    expect(document.documentElement.dataset.skin).toBeUndefined()
  })

  it('accepts ?skin= and ignores unknown values', () => {
    window.history.replaceState(null, '', '/?skin=swiss')
    const { unmount } = render(<ThemeProvider><Picker /></ThemeProvider>)
    expect(document.documentElement.dataset.skin).toBe('swiss')
    unmount()
    localStorage.clear()
    window.history.replaceState(null, '', '/?skin=glass')
    render(<ThemeProvider><Picker /></ThemeProvider>)
    expect(screen.getByTestId('skin').textContent).toBe('paper')
  })
})
