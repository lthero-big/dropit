import { FileArchiveIcon, FileAudioIcon, FileCodeIcon, FileIcon, FileImageIcon, FileTextIcon, FileVideoIcon } from 'lucide-react'
import type { Clip, DeviceKind } from './data.ts'

export const deviceColor = (kind: DeviceKind) => `var(--dev-${kind})`

const fileTypes: Array<{ test: RegExp; icon: typeof FileIcon; color: string; label: string }> = [
  { test: /\.(pdf)$/i, icon: FileTextIcon, color: '#d0453a', label: 'PDF' },
  { test: /\.(zip|tar|zst|gz|7z|rar)(\.|$)/i, icon: FileArchiveIcon, color: '#a07a2c', label: 'ARCHIVE' },
  { test: /\.(m4a|mp3|wav|flac)$/i, icon: FileAudioIcon, color: '#8a5cc2', label: 'AUDIO' },
  { test: /\.(mp4|mov|webm)$/i, icon: FileVideoIcon, color: '#c2577f', label: 'VIDEO' },
  { test: /\.(png|jpe?g|gif|webp|heic)$/i, icon: FileImageIcon, color: '#3f8f7a', label: 'IMAGE' },
  { test: /\.(fig|sketch|psd)$/i, icon: FileImageIcon, color: '#4f6fd0', label: 'DESIGN' },
  { test: /\.(ts|tsx|js|json|sh|py|go|rs)$/i, icon: FileCodeIcon, color: '#4d6f9c', label: 'CODE' },
]

export function fileType(name: string) {
  const hit = fileTypes.find((t) => t.test.test(name))
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase() : 'FILE'
  return hit ? { ...hit, ext } : { icon: FileIcon, color: '#7d776d', label: 'FILE', ext }
}

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
