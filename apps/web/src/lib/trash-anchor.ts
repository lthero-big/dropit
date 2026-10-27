/** Geometry for the PC drag-to-delete bin (see trash-bin.tsx). */

/** Pointer within this distance of the bin centre = drop deletes. */
export const TRASH_HIT = 58
/** Pointer within this distance starts pulling the bin toward it. */
export const TRASH_MAGNET = 150
export const TRASH_SIZE = 60

export type TrashAnchor = { x: number; y: number; side: 'left' | 'right' | 'below' }

export type TrashHandle = {
  /** Feed the drag pointer (client coords). Returns true when a drop would delete. */
  track: (x: number, y: number) => boolean
  /** Where a deleted card should fly to (client coords). */
  mouth: () => { x: number; y: number } | null
}

/** Park the bin beside the dragged card's starting rect, on whichever side has room. */
export function trashAnchorFor(rect: DOMRect): TrashAnchor {
  const w = window.innerWidth
  const h = window.innerHeight
  const half = TRASH_SIZE / 2
  const gap = 26 + half
  const cy = Math.min(h - 70, Math.max(110, rect.top + rect.height / 2))
  if (rect.right + gap + half + 12 <= w) return { x: rect.right + gap, y: cy, side: 'right' }
  if (rect.left - gap - half - 12 >= 0) return { x: rect.left - gap, y: cy, side: 'left' }
  return { x: Math.min(w - 50, Math.max(50, rect.left + rect.width / 2)), y: Math.min(h - 50, rect.bottom + gap), side: 'below' }
}
