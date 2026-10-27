import { fileType } from '@/lib/file-type.ts'
import type { UploadRow } from '@/lib/upload-queue.ts'

export const uploadStatusLabel: Record<UploadRow['status'], string> = {
  queued: '排队中',
  uploading: '上传中',
  processing: '处理中…',
  paused: '已暂停',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

/** what an upload looks like before the server has the file: image / video previews come from a local object URL */
export function uploadPreviewKind(row: Pick<UploadRow, 'mime' | 'name'>): 'image' | 'video' | null {
  const mime = row.mime.toLowerCase()
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (!mime) {
    const t = fileType(row.name).label
    if (t === 'IMAGE' && !/\.svg$/i.test(row.name)) return 'image'
    if (t === 'VIDEO') return 'video'
  }
  return null
}
