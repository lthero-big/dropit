import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App.tsx'
import { ThemeProvider } from './components/theme-provider.tsx'

describe('App', () => {
  it('renders the scaffold shell and switches theme', () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    )

    expect(screen.getByRole('heading', { name: 'Scaffold' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'dark' }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
