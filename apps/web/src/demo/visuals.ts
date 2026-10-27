import { fileType } from '@/lib/file-type.ts'
import type { Clip, DeviceKind } from './data.ts'

export { fileType }

export const deviceColor = (kind: DeviceKind) => `var(--dev-${kind})`

/** audio / video files with a source play inline instead of showing a file icon */
export function mediaOf(clip: Clip): 'audio' | 'video' | null {
  if (clip.kind !== 'file' || !clip.src) return null
  const t = fileType(clip.name).label
  return t === 'AUDIO' ? 'audio' : t === 'VIDEO' ? 'video' : null
}

export function labelFor(clip: Clip) {
  switch (clip.kind) {
    case 'link': return clip.title
    case 'code': return `${clip.lang} 代码`
    case 'color': return clip.value
    case 'text': return clip.text
    case 'image': return clip.name
    case 'file': return clip.name
  }
}


/** Stable colour per group name; the two seed groups get fixed hues. */
const fixedHue: Record<string, number> = { 工作: 250, 个人: 150 }
export function groupHue(name: string) {
  if (name in fixedHue) return fixedHue[name]
  let h = 0
  for (const ch of name) h = (h * 37 + ch.charCodeAt(0)) % 360
  return h
}
export const groupColor = (name?: string) => (name ? `oklch(0.6 0.11 ${groupHue(name)})` : 'var(--fg-4)')

export const groupName = (g: string | undefined) => (g ? g : '未分组')
