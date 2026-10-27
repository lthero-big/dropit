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
