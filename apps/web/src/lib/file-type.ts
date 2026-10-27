import { FileArchiveIcon, FileAudioIcon, FileCodeIcon, FileIcon, FileImageIcon, FileTextIcon, FileVideoIcon } from 'lucide-react'

/** File-type badge (icon, colour, label) shared by the real board and the RHEA-191 demo. */
const fileTypes: Array<{ test: RegExp; icon: typeof FileIcon; color: string; label: string }> = [
  { test: /\.(pdf)$/i, icon: FileTextIcon, color: '#d0453a', label: 'PDF' },
  { test: /\.(zip|tar|zst|gz|7z|rar)(\.|$)/i, icon: FileArchiveIcon, color: '#a07a2c', label: 'ARCHIVE' },
  { test: /\.(m4a|mp3|wav|flac|ogg|oga|aac|opus)$/i, icon: FileAudioIcon, color: '#8a5cc2', label: 'AUDIO' },
  { test: /\.(mp4|mov|webm|m4v|ogv)$/i, icon: FileVideoIcon, color: '#c2577f', label: 'VIDEO' },
  { test: /\.(png|jpe?g|gif|webp|heic|avif|bmp|svg)$/i, icon: FileImageIcon, color: '#3f8f7a', label: 'IMAGE' },
  { test: /\.(fig|sketch|psd)$/i, icon: FileImageIcon, color: '#4f6fd0', label: 'DESIGN' },
  { test: /\.(ts|tsx|js|json|sh|py|go|rs)$/i, icon: FileCodeIcon, color: '#4d6f9c', label: 'CODE' },
  { test: /\.(md|txt|docx?|rtf|csv|xlsx?|pptx?)$/i, icon: FileTextIcon, color: '#6b7a8f', label: 'DOC' },
]

export type FileTypeInfo = { icon: typeof FileIcon; color: string; label: string; ext: string }

export function fileType(name: string): FileTypeInfo {
  const hit = fileTypes.find((t) => t.test.test(name))
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toUpperCase() || 'FILE' : 'FILE'
  return hit ? { ...hit, ext } : { icon: FileIcon, color: '#7d776d', label: 'FILE', ext }
}
