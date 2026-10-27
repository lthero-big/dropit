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

type Box = { left: number; right: number; top: number; bottom: number }

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
