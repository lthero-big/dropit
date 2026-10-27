import type { ClipVisual } from '@/components/clip-visual.tsx'

/**
 * While over a group chip the card hides and a small ghost follows the pointer
 * at a fixed offset (below-right, so the chip's name stays readable). RHEA-190
 * step 8: the ghost is its own fixed element positioned straight from the
 * pointer; the old approach shrank the dragged card about a moved
 * transform-origin, which Motion's drag/layout compensation does not know
 * about, so every chip change nudged the card further off the pointer.
 */
export const GHOST_OFFSET = { x: 14, y: 18 }

/** One line that names a clip in the drag ghost. */
export function ghostLabel(visual: ClipVisual): string {
  switch (visual.kind) {
    case 'color':
      return visual.value
    case 'code':
      return visual.code.split('\n')[0] ?? ''
    case 'link':
      return visual.title
    case 'image':
    case 'file':
      return visual.name
    default:
      return visual.text.split('\n')[0] ?? ''
  }
}

/** The ghost's transform for a pointer at (x, y): always pointer + GHOST_OFFSET, nothing else. */
export function ghostTransform(x: number, y: number): string {
  return `translate3d(${Math.round(x + GHOST_OFFSET.x)}px, ${Math.round(y + GHOST_OFFSET.y)}px, 0)`
}
