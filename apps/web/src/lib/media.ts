const videoExtensions = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov'])
const audioExtensions = new Set(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'flac'])

export function mediaKind(item: { kind: string; mime: string | null; filename: string | null; hasThumbnail: boolean }): 'video' | 'audio' | null {
  if (item.kind !== 'file' || item.hasThumbnail) return null
  const mime = (item.mime ?? '').toLowerCase().split(';')[0].trim()
  if (mime === 'image/svg+xml' || mime === 'text/html' || mime === 'application/xhtml+xml') return null
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  const name = item.filename ?? ''
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (videoExtensions.has(extension)) return 'video'
  if (audioExtensions.has(extension)) return 'audio'
  return null
}
