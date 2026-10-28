import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu.tsx'

afterEach(() => cleanup())

describe('DropdownMenu (RHEA-190 m24)', () => {
  it('opens without locking page scroll, so the layout does not shift', async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>菜单</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>设置</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    expect(await screen.findByRole('menuitem', { name: '设置' })).toBeTruthy()
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false)
    expect(document.body.style.pointerEvents).not.toBe('none')
    expect(document.body.style.overflow).not.toBe('hidden')
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')?.getAttribute('data-state')).toBe('open')
  })
})
