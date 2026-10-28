import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react'
import { toast } from 'sonner'
import type { UploadCardActions } from '@/components/upload-card.tsx'
import { ApiError, type uploadFile } from '@/lib/api.ts'
import { adoptResume, browserResumeStore, browserTransport, discardSession, discardUpload, matchResumeFile, receivedRatio, uploadMaybeChunked, type ChunkTransport, type ResumeRecord, type ResumeStore } from '@/lib/chunked-upload.ts'
import type { useChannel } from '@/lib/channel.ts'
import { formatBytes } from '@/lib/format.ts'
import { CLAIMS_KEY, claimUpload, heartbeatUploads, ownsUpload, releaseUploads, tabId } from '@/lib/upload-claims.ts'
import { uploadPreviewKind } from '@/lib/upload-preview.ts'
import { createUploadQueue, type UploadQueue, type UploadRow } from '@/lib/upload-queue.ts'

export function filesFromList(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? [])
}

const EXPIRED = '会话已过期，请重新上传'

export interface BoardUploadOptions {
  base: string | null
  channel: ReturnType<typeof useChannel>
  maxFileBytes: number
  upload: typeof uploadFile
  chunkBytes?: number
  resumeStore?: ResumeStore
  transport?: ChunkTransport
  onActivity?: () => void
  onAuthLost?: () => void
  onBusyChange?: (busy: boolean) => void
  onBindCancel?: (cancel: () => void) => void
}

export interface BoardUploads {
  rows: UploadRow[]
  dragOver: boolean
  uploadBusy: boolean
  /** ids of clips this tab created (text sends add theirs here too) */
  localIds: Set<string>
  /** items that finished uploading from this tab: their translucent placeholder hands over to the real card */
  uploadedIds: Set<string>
  resumeRef: RefObject<HTMLInputElement | null>
  sendFiles: (files: File[]) => void
  pasteShot: () => Promise<void>
  onResumePicked: (event: ChangeEvent<HTMLInputElement>) => void
  cancelAll: () => void
  previewFor: (row: UploadRow) => string | null
  uploadActions: (row: UploadRow) => UploadCardActions
}

/**
 * Everything upload-shaped on the board: the window drag/drop and paste listeners, the upload
 * queue (chunked + resumable), cross-tab claims, local previews and the resume prompts.
 */
export function useBoardUploads({ base, channel, maxFileBytes, upload, chunkBytes, resumeStore, transport, onActivity, onAuthLost, onBusyChange, onBindCancel }: BoardUploadOptions): BoardUploads {
  const [rows, setRows] = useState<UploadRow[]>([])
  const [dragOver, setDragOver] = useState(false)
  const localIds = useRef(new Set<string>())
  // items that finished uploading from this tab: their translucent placeholder hands over to the real card
  const uploadedIds = useRef(new Set<string>())
  // object URLs for the picked files (image / video uploads preview before the server has them)
  const previewUrls = useRef(new Map<string, string>())
  const resumeRef = useRef<HTMLInputElement>(null)
  const resumeTarget = useRef<string | null>(null)
  const ownerRef = useRef(tabId())
  const storeRef = useRef<ResumeStore>(resumeStore ?? browserResumeStore())
  const transportRef = useRef<ChunkTransport>(transport ?? browserTransport())
  const sendFilesRef = useRef<(files: File[]) => void>(() => {})
  const queueRef = useRef<UploadQueue | null>(null)
  const baseRef = useRef(base)
  const maxFileRef = useRef(maxFileBytes)
  const channelRef = useRef(channel)
  const onActivityRef = useRef(onActivity)
  const onAuthLostRef = useRef(onAuthLost)
  const uploadRef = useRef(upload)
  const chunkBytesRef = useRef(chunkBytes)

  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const onDrag = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
    }
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setDragOver(true)
    }
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragOver(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragOver(false)
      const files = filesFromList(event.dataTransfer?.files)
      if (files.length) void sendFilesRef.current(files)
    }
    const onPaste = (event: ClipboardEvent) => {
      const files: File[] = []
      for (const item of event.clipboardData?.items ?? []) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file) files.push(file)
      }
      if (!files.length) return
      event.preventDefault()
      void sendFilesRef.current(files)
    }
    window.addEventListener('dragover', onDrag)
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragover', onDrag)
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  /** 粘贴截图: read an image straight off the system clipboard. */
  async function pasteShot() {
    const read = navigator.clipboard?.read?.bind(navigator.clipboard)
    if (!read) {
      toast('按 ⌘V / Ctrl+V 直接粘贴截图')
      return
    }
    try {
      const files: File[] = []
      for (const entry of await read()) {
        const type = entry.types.find((kind) => kind.startsWith('image/'))
        if (!type) continue
        const blob = await entry.getType(type)
        files.push(new File([blob], `截图-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${type.split('/')[1] || 'png'}`, { type }))
      }
      if (files.length) sendFiles(files)
      else toast('剪贴板里没有图片')
    } catch {
      toast('读不到剪贴板，按 ⌘V / Ctrl+V 直接粘贴')
    }
  }

  function sendFiles(files: File[]) {
    if (!baseRef.current) return
    queueRef.current?.enqueue(files, maxFileRef.current)
  }

  useEffect(() => {
    baseRef.current = base
    maxFileRef.current = maxFileBytes
    channelRef.current = channel
    onActivityRef.current = onActivity
    onAuthLostRef.current = onAuthLost
    uploadRef.current = upload
    chunkBytesRef.current = chunkBytes
    sendFilesRef.current = sendFiles
    if (resumeStore) storeRef.current = resumeStore
    if (transport) transportRef.current = transport
  })

  useEffect(() => {
    const queue = createUploadQueue({
      upload: (file, onProgress, signal) => uploadMaybeChunked({
        base: baseRef.current ?? '',
        file,
        onProgress,
        signal,
        chunkBytes: chunkBytesRef.current,
        store: storeRef.current,
        transport: transportRef.current,
        single: (next, progress, nextSignal) => uploadRef.current(baseRef.current ?? '', next, progress, nextSignal),
      }),
      discard: (file) => discardUpload(baseRef.current ?? '', file, storeRef.current, transportRef.current),
      discardKept: (session) => {
        const current = baseRef.current ?? ''
        discardSession(current, { ...session, base: current }, storeRef.current, transportRef.current)
        releaseUploads([session.uploadId], ownerRef.current)
      },
      onItem: (item) => {
        localIds.current.add(item.id)
        uploadedIds.current.add(item.id)
        channelRef.current.upsert(item)
        onActivityRef.current?.()
      },
      onAuthLost: () => onAuthLostRef.current?.(),
      onChange: setRows,
      onOversize: (name) => toast.error(`${name}超过大小上限（${formatBytes(maxFileRef.current)}）`),
      onFailed: (message) => toast.error(message),
    })
    queueRef.current = queue
    return () => {
      queue.dispose()
      if (queueRef.current === queue) queueRef.current = null
    }
  }, [])

  useEffect(() => {
    const owner = ownerRef.current
    const timer = window.setInterval(() => {
      heartbeatUploads(queueRef.current?.claimedIds() ?? [], owner)
    }, 5_000)
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CLAIMS_KEY) return
      for (const id of queueRef.current?.claimedIds() ?? []) {
        if (!ownsUpload(id, owner)) queueRef.current?.dropForeign(id)
      }
    }
    const release = () => releaseUploads(queueRef.current?.claimedIds() ?? [], owner)
    window.addEventListener('storage', onStorage)
    window.addEventListener('beforeunload', release)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('beforeunload', release)
      release()
    }
  }, [])

  useEffect(() => {
    const current = base
    if (!current) return
    let cancelled = false
    queueRef.current?.dropRestored()
    const owner = ownerRef.current
    const records = storeRef.current.list().filter((record) => record.base === current)
    void (async () => {
      for (const record of records) {
        if (cancelled) return
        if (record.expiresAt <= Date.now()) {
          discardSession(current, record, storeRef.current, transportRef.current)
          toast.error(EXPIRED)
          continue
        }
        if (!claimUpload(record.uploadId, owner)) continue
        try {
          const session = await transportRef.current.get(current, record.uploadId, new AbortController().signal)
          if (cancelled) {
            releaseUploads([record.uploadId], owner)
            return
          }
          if (session.expiresAt <= Date.now()) {
            discardSession(current, record, storeRef.current, transportRef.current)
            releaseUploads([record.uploadId], owner)
            toast.error(EXPIRED)
            continue
          }
          queueRef.current?.restore({
            uploadId: record.uploadId,
            name: record.name,
            size: record.size,
            ratio: receivedRatio(record.size, session.chunkSize || record.chunkSize, session.received ?? []),
            sessionKey: record.key,
          })
        } catch (error) {
          if (cancelled) {
            releaseUploads([record.uploadId], owner)
            return
          }
          if (error instanceof ApiError && error.status === 404) {
            discardSession(current, record, storeRef.current, transportRef.current)
            releaseUploads([record.uploadId], owner)
            toast.error(EXPIRED)
            continue
          }
          queueRef.current?.restore({
            uploadId: record.uploadId,
            name: record.name,
            size: record.size,
            ratio: 0,
            sessionKey: record.key,
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [base])

  const uploadBusy = rows.some((row) => row.status === 'queued' || row.status === 'uploading' || row.status === 'processing' || row.status === 'paused')

  // Drop the local previews of uploads that have left the queue.
  useEffect(() => {
    const live = new Set(rows.map((row) => row.id))
    for (const [id, url] of previewUrls.current) {
      if (live.has(id)) continue
      URL.revokeObjectURL?.(url)
      previewUrls.current.delete(id)
    }
  }, [rows])
  useEffect(() => {
    const urls = previewUrls.current
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL?.(url)
      urls.clear()
    }
  }, [])

  useEffect(() => {
    onBusyChange?.(uploadBusy)
  }, [onBusyChange, uploadBusy])

  useEffect(() => {
    onBindCancel?.(() => queueRef.current?.cancelAll())
  }, [onBindCancel])

  useEffect(() => {
    if (!uploadBusy) return
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [uploadBusy])

  function recordFor(session: { key: string; uploadId: string }): ResumeRecord | null {
    return storeRef.current.get(session.key) ?? storeRef.current.list().find((entry) => entry.uploadId === session.uploadId) ?? null
  }

  function continueRow(row: UploadRow) {
    const queue = queueRef.current
    if (!queue) return
    if (queue.needsFile(row.id)) {
      resumeTarget.current = row.id
      resumeRef.current?.click()
      return
    }
    queue.resume(row.id)
  }

  function onResumePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = filesFromList(event.target.files)[0]
    event.target.value = ''
    const id = resumeTarget.current
    resumeTarget.current = null
    const queue = queueRef.current
    if (!file || !id || !queue) return
    const session = queue.sessionOf(id)
    if (!session) return
    const record = recordFor(session)
    if (!record) {
      toast.error(EXPIRED)
      releaseUploads([session.uploadId], ownerRef.current)
      queue.dropUpload(session.uploadId)
      return
    }
    const match = matchResumeFile(record, file)
    if (match.kind === 'match') {
      queue.bindFile(id, file)
      return
    }
    if (match.kind === 'mtime') {
      queue.armMtime(id, file)
      return
    }
    queue.holdFile(id, file, `${match.fields.join('、')}不一致`)
  }

  function acceptMtime(row: UploadRow) {
    const queue = queueRef.current
    const file = queue?.confirmMtime(row.id)
    const session = queue?.sessionOf(row.id)
    const current = baseRef.current
    if (!queue || !file || !session || !current) return
    const record = recordFor(session)
    if (!record) {
      toast.error(EXPIRED)
      releaseUploads([session.uploadId], ownerRef.current)
      queue.dropUpload(session.uploadId)
      return
    }
    const next = adoptResume(storeRef.current, record, file)
    queue.bindFile(row.id, file, next.key)
  }

  function abandonResume(row: UploadRow) {
    const queue = queueRef.current
    if (!queue) return
    const session = queue.sessionOf(row.id)
    const file = queue.takeHeld(row.id)
    const current = baseRef.current
    if (session && current) {
      const record = recordFor(session)
      if (record) discardSession(current, record, storeRef.current, transportRef.current)
      releaseUploads([session.uploadId], ownerRef.current)
      queue.dropUpload(session.uploadId)
    }
    if (file) queue.enqueue([file], maxFileRef.current)
  }

  const previewFor = (row: UploadRow) => {
    const known = previewUrls.current.get(row.id)
    if (known) return known
    if (!uploadPreviewKind(row) || typeof URL.createObjectURL !== 'function') return null
    const file = queueRef.current?.fileOf(row.id)
    if (!file) return null
    const url = URL.createObjectURL(file)
    previewUrls.current.set(row.id, url)
    return url
  }
  const uploadActions = (row: UploadRow): UploadCardActions => ({
    onCancel: () => queueRef.current?.cancel(row.id),
    onPause: () => queueRef.current?.pause(row.id),
    onContinue: () => continueRow(row),
    onRetry: () => queueRef.current?.retry(row.id),
    onRemove: () => queueRef.current?.dismiss(row.id),
    onAcceptMtime: () => acceptMtime(row),
    onAbandon: () => abandonResume(row),
  })

  return {
    rows,
    dragOver,
    uploadBusy,
    localIds: localIds.current,
    uploadedIds: uploadedIds.current,
    resumeRef,
    sendFiles,
    pasteShot,
    onResumePicked,
    cancelAll: () => queueRef.current?.cancelAll(),
    previewFor,
    uploadActions,
  }
}
