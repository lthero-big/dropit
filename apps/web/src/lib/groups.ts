// Group colours/names shared by the real board and the RHEA-191 demo.
/** Stable colour per group name; the two demo seed groups get fixed hues. */
const fixedHue: Record<string, number> = { 工作: 250, 个人: 150 }
export function groupHue(name: string) {
  if (name in fixedHue) return fixedHue[name]
  let h = 0
  for (const ch of name) h = (h * 37 + ch.charCodeAt(0)) % 360
  return h
}
export const groupColor = (name?: string | null) => (name ? `oklch(0.6 0.11 ${groupHue(name)})` : 'var(--fg-4)')

export const groupName = (g: string | null | undefined) => (g ? g : '未分组')

/** Extra hit area around a group chip while a card is dragged over the bar. */
export const DROP_PAD = { x: 10, y: 14 }

/** Once a chip is hot it stays hot until the pointer is this much further out than its normal hit box. */
export const DROP_STICK = 8

export type Box = { left: number; right: number; top: number; bottom: number }

/**
 * A chip's untransformed layout box: the centre from getBoundingClientRect
 * (the hot chip scales about its centre) and the size from offsetWidth /
 * offsetHeight, which ignore transforms. Hit zones are taken from these so a
 * chip growing under the pointer can't change which chip is hit.
 */
export function layoutBox(el: HTMLElement): Box {
  const r = el.getBoundingClientRect()
  const w = el.offsetWidth || r.width
  const h = el.offsetHeight || r.height
  const cx = (r.left + r.right) / 2
  const cy = (r.top + r.bottom) / 2
  return { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 }
}

/** The chip a dragged card is over: padded hit boxes, nearest centre wins where they overlap. */
export function chipAt(chips: Iterable<readonly [string, Box]>, x: number, y: number, pad = DROP_PAD): string | null {
  let hit: string | null = null
  let best = Infinity
  for (const [key, r] of chips) {
    if (x < r.left - pad.x || x > r.right + pad.x || y < r.top - pad.y || y > r.bottom + pad.y) continue
    const d = Math.hypot(x - (r.left + r.right) / 2, y - (r.top + r.bottom) / 2)
    if (d < best) {
      best = d
      hit = key
    }
  }
  return hit
}

/**
 * chipAt with hysteresis (RHEA-190 step 8): the current chip keeps the hover
 * until the pointer leaves its hit box grown by `stick`, so the pointer resting
 * on the border between two chips can't flip between them every frame.
 */
export function chipAtSticky(chips: ReadonlyArray<readonly [string, Box]>, x: number, y: number, current: string | null, pad = DROP_PAD, stick = DROP_STICK): string | null {
  if (current !== null) {
    const r = chips.find(([key]) => key === current)?.[1]
    if (r && x >= r.left - pad.x - stick && x <= r.right + pad.x + stick && y >= r.top - pad.y - stick && y <= r.bottom + pad.y + stick) return current
  }
  return chipAt(chips, x, y, pad)
}
