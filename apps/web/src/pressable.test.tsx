import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('shared press styles', () => {
  it('uses the fast motion token (120ms) for hover and press scale, and drops the scale when motion is reduced', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8')
    expect(css).toContain('--dur-fast: 120ms')
    expect(css).toContain('transition-duration: var(--dur-fast)')
    expect(css).toContain('transform: scale(0.97)')
    expect(css).toContain('background-color: color-mix(in srgb, var(--foreground) 8%, transparent)')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('transform: none !important')
  })
})
