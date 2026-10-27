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


export { groupColor, groupHue, groupName } from '@/lib/groups.ts'
