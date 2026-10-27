import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react'
import { ArrowUpIcon, CalendarDaysIcon, LayoutGridIcon, ListIcon, PaperclipIcon } from 'lucide-react'
import { toast } from 'sonner'
import { BoardCard, type Arrival, type DragPhase } from '@/components/board-card.tsx'
import { BoardEmpty, BoardSkeletons, DeviceDot, MagnetDropZone, PinBarShell, TimelineSection } from '@/components/board-chrome.tsx'
import { CommandPalette } from '@/components/command-palette.tsx'
import { ImageLightbox, type LightboxSlide } from '@/components/image-lightbox.tsx'
import { TrashBin } from '@/components/trash-bin.tsx'
import { ApiError, api, errorText, uploadFile } from '@/lib/api.ts'
import { adoptResume, browserResumeStore, browserTransport, discardSession, discardUpload, matchResumeFile, receivedRatio, uploadMaybeChunked, type ChunkTransport, type ResumeRecord, type ResumeStore } from '@/lib/chunked-upload.ts'
import { useChannel } from '@/lib/channel.ts'
import { CLAIMS_KEY, claimUpload, heartbeatUploads, ownsUpload, releaseUploads, tabId } from '@/lib/upload-claims.ts'
import { createUploadQueue, type UploadQueue, type UploadRow } from '@/lib/upload-queue.ts'
import { formatEta, formatSpeed } from '@/lib/upload-speed.ts'
import { copyText, formatBytes, formatRemain, quotaTone, useClock, utf8Size } from '@/lib/format.ts'
import { clipKind, codeSource } from '@/lib/clip-kind.ts'
import { dayLabel } from '@/lib/day-label.ts'
import { dur, easeIn, easeOut, springBounce, springSettle } from '@/lib/motion.ts'
import { trashAnchorFor, type TrashAnchor, type TrashHandle } from '@/lib/trash-anchor.ts'
import type { ConnectionStatus, Item } from '@/lib/types.ts'

function filesFromList(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? [])
}

const COPIED_MS = 1400

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(pointer: coarse)')
    const onChange = () => setCoarse(query.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])
  return coarse
}
const touchTarget = { minWidth: 40, minHeight: 40 }
const RETRACT_MS = 3000

const uploadStatusLabel: Record<UploadRow['status'], string> = {
  queued: '排队中',
  uploading: '上传中',
  processing: '处理中…',
  paused: '已暂停',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

const queueActionClass =
  'inline-flex min-h-10 min-w-10 items-center rounded-md border border-line-2 bg-surface-1 px-2 text-xs font-medium text-fg-2 transition-colors duration-(--dur-fast) hover:border-line-3 hover:bg-surface-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const EXPIRED = '会话已过期，请重新上传'

const layoutKey = 'dropit-layout'
type BoardLayout = 'grid' | 'list' | 'timeline'
/** top-bar device dots cycle through the paper device tints */
const DOT_COLORS = ['var(--dev-mac)', 'var(--dev-phone)', 'var(--dev-pad)', 'var(--dev-pc)']

function readLayout(): BoardLayout {
  try {
    const saved = localStorage.getItem(layoutKey)
    return saved === 'list' || saved === 'timeline' ? saved : 'grid'
  } catch {
    return 'grid'
  }
}

/** Day sections for the timeline layout, newest day first (items keep board order). */
function timeline(items: Item[], now: number): Array<[string, Item[]]> {
  const days = new Map<string, Item[]>()
  for (const item of items) {
    const key = dayLabel(item.createdAt, now)
    const list = days.get(key)
    if (list) list.push(item)
    else days.set(key, [item])
  }
  return [...days.entries()]
}

export function ClipboardBoard({
  base,
  title,
  subtitle,
  quotaBytes,
  usedBytes,
  maxFileBytes,
  maxTextBytes,
  deadline = null,
  sender,
  canEdit,
  canRetract,
  canShare,
  onActivity,
  onAuthLost,
  onStatus,
  onBusyChange,
  onBindCancel,
  upload = uploadFile,
  chunkBytes,
  resumeStore,
  transport,
}: {
  base: string | null
  title: string
  subtitle?: string
  quotaBytes: number
  usedBytes: number | null
  maxFileBytes: number
  maxTextBytes: number
  deadline?: number | null
  sender: (item: Item) => string
  canEdit: (item: Item) => boolean
  canRetract: (item: Item) => boolean
  canShare: (item: Item) => boolean
  onActivity?: () => void
  onAuthLost?: () => void
  onStatus?: (status: ConnectionStatus) => void
  onBusyChange?: (busy: boolean) => void
  onBindCancel?: (cancel: () => void) => void
  upload?: typeof uploadFile
  /** Bytes above this use the resumable chunk protocol. Omit to use the learned or 8 MiB default. */
  chunkBytes?: number
  resumeStore?: ResumeStore
  transport?: ChunkTransport
}) {
  const channel = useChannel(base)
  const now = useClock(channel.offset)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [shareFor, setShareFor] = useState<string | null>(null)
  const [tagFor, setTagFor] = useState<string | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [rows, setRows] = useState<UploadRow[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [sending, setSending] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [layout, setLayout] = useState<BoardLayout>(readLayout)
  const [expandedText, setExpandedText] = useState<Record<string, boolean>>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const coarse = useCoarsePointer()
  const gesture = coarse ? 'swipe' : 'pin-drag'
  const reduced = useReducedMotion() ?? false
  const [openCard, setOpenCard] = useState<string | null>(null)
  const [pinHover, setPinHover] = useState(false)
  const pinBarRef = useRef<HTMLElement | null>(null)
  const zoneRef = useRef<HTMLFormElement | null>(null)
  const trashRef = useRef<TrashHandle | null>(null)
  const [trash, setTrash] = useState<{ anchor: TrashAnchor; gulp: boolean } | null>(null)
  const gulpTimer = useRef(0)
  const [arrivals, setArrivals] = useState<Record<string, Arrival>>({})
  const [ripples, setRipples] = useState<Record<number, number>>({})
  const dotRefs = useRef<Array<HTMLElement | null>>([])
  const seenIds = useRef<Set<string> | null>(null)
  const localIds = useRef(new Set<string>())
  const fileRef = useRef<HTMLInputElement>(null)
  const resumeRef = useRef<HTMLInputElement>(null)
  const resumeTarget = useRef<string | null>(null)
  const ownerRef = useRef(tabId())
  const storeRef = useRef<ResumeStore>(resumeStore ?? browserResumeStore())
  const transportRef = useRef<ChunkTransport>(transport ?? browserTransport())
  const seenAuth = useRef(0)
  const sendFilesRef = useRef<(files: File[]) => void>(() => {})
  const queueRef = useRef<UploadQueue | null>(null)
  const baseRef = useRef(base)
  const maxFileRef = useRef(maxFileBytes)
  const channelRef = useRef(channel)
  const onActivityRef = useRef(onActivity)
  const onAuthLostRef = useRef(onAuthLost)
  const uploadRef = useRef(upload)
  const chunkBytesRef = useRef(chunkBytes)
  const visible = channel.items.filter((item) => item.expiresAt > now)
  const needle = query.trim().toLowerCase()
  const shown = visible.filter((item) => {
    if (activeTag && !(item.tags ?? []).includes(activeTag)) return false
    if (!needle) return true
    const haystack = `${item.text ?? ''}\n${item.filename ?? ''}\n${(item.tags ?? []).join('\n')}`
    return haystack.toLowerCase().includes(needle)
  })
  const slides: LightboxSlide[] = base
    ? shown.flatMap((item) =>
        item.hasThumbnail
          ? [
              {
                key: item.id,
                filename: item.filename?.trim() || '未命名图片',
                byteSize: item.size,
                thumbnailSrc: `${base}/items/${item.id}/thumbnail`,
                previewSrc: `${base}/items/${item.id}/preview`,
                downloadHref: `${base}/items/${item.id}/download`,
              },
            ]
          : [],
      )
    : []
  const openIndex = openId === null ? -1 : slides.findIndex((slide) => slide.key === openId)
  const roomUsed = usedBytes ?? channel.items.reduce((sum, item) => sum + item.size, 0)

  useEffect(() => {
    onStatus?.(channel.status)
  }, [channel.status, onStatus])

  useEffect(() => {
    if (channel.authLost > seenAuth.current) {
      seenAuth.current = channel.authLost
      onAuthLost?.()
    }
  }, [channel.authLost, onAuthLost])

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

  async function sendText() {
    const text = draft.trim()
    if (!base || !text || sending) return
    if (utf8Size(text) > maxTextBytes) {
      toast.error(`文本超过长度上限（${formatBytes(maxTextBytes)}）`)
      return
    }
    setSending(true)
    try {
      const result = await api<{ item: Item }>(`${base}/items/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      localIds.current.add(result.item.id)
      channel.upsert(result.item)
      setDraft('')
      onActivity?.()
    } catch (error) {
      toast.error(errorText(error))
      if (error instanceof ApiError && error.status === 401) onAuthLost?.()
    } finally {
      setSending(false)
    }
  }

  async function saveEdit(item: Item) {
    const text = editDraft.trim()
    if (!base || savingEdit) return
    if (!text) {
      toast.error('文本不能为空')
      return
    }
    if (utf8Size(text) > maxTextBytes) {
      toast.error(`文本超过长度上限（${formatBytes(maxTextBytes)}）`)
      return
    }
    setSavingEdit(true)
    try {
      const result = await api<{ item: Item }>(`${base}/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      channel.upsert(result.item)
      setEditing(null)
      onActivity?.()
    } catch (error) {
      toast.error(errorText(error))
      if (error instanceof ApiError && error.status === 401) onAuthLost?.()
    } finally {
      setSavingEdit(false)
    }
  }

  async function saveLabels(item: Item, patch: { pinned?: boolean; tags?: string[] }) {
    if (!base) return
    try {
      const result = await api<{ item: Item }>(`${base}/items/${item.id}/labels`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      channel.upsert(result.item)
    } catch (error) {
      toast.error(errorText(error))
      if (error instanceof ApiError && error.status === 401) onAuthLost?.()
    }
  }

  function clearPending() {
    pendingRef.current = null
    setPending(null)
  }

  function armPending(id: string) {
    pendingRef.current = id
    setPending(id)
  }

  useEffect(() => {
    if (!pending) return
    const timer = window.setTimeout(() => {
      if (pendingRef.current !== pending) return
      clearPending()
    }, RETRACT_MS)
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
      if (element?.closest('[data-retract="confirm"]')) return
      clearPending()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      clearPending()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [pending])

  async function retract(item: Item) {
    if (!base) return
    if (pendingRef.current !== item.id) {
      armPending(item.id)
      return
    }
    await removeItem(item)
  }

  async function removeItem(item: Item) {
    if (!base) return
    clearPending()
    try {
      await api(`${base}/items/${item.id}`, { method: 'DELETE' })
      channel.remove(item.id)
      onActivity?.()
      toast.success('已撤回')
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  // New items after the first snapshot fly in: our own sends drop from above,
  // everything else flies from a peer's dot in the top bar (which ripples).
  useEffect(() => {
    if (channel.status === 'connecting' || channel.status === 'idle') return
    const seen = seenIds.current
    if (!seen) {
      seenIds.current = new Set(channel.items.map((item) => item.id))
      return
    }
    const fresh = channel.items.filter((item) => !seen.has(item.id))
    if (!fresh.length) return
    for (const item of fresh) seen.add(item.id)
    if (reduced) return
    const next: Record<string, Arrival> = {}
    let remote = false
    for (const item of fresh) {
      const mine = localIds.current.has(item.id)
      next[item.id] = mine ? 'landed' : 'arrived'
      remote ||= !mine
    }
    setArrivals((current) => ({ ...current, ...next }))
    if (remote) {
      const dot = channel.devices > 1 ? 1 : 0
      setRipples((current) => ({ ...current, [dot]: (current[dot] ?? 0) + 1 }))
    }
  }, [channel.items, channel.status, channel.devices, reduced])

  useEffect(() => {
    if (!openCard) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
      if (element?.closest(`[data-clip-id="${openCard}"]`)) return
      setOpenCard(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenCard(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openCard])

  useEffect(() => () => window.clearTimeout(gulpTimer.current), [])

  function onDragPhase(phase: DragPhase) {
    window.clearTimeout(gulpTimer.current)
    if ('rect' in phase) {
      setOpenCard(null)
      setTrash({ anchor: trashAnchorFor(phase.rect), gulp: false })
      return
    }
    if (phase.end === 'cancel') {
      setTrash(null)
      return
    }
    setTrash((current) => (current ? { ...current, gulp: true } : current))
    gulpTimer.current = window.setTimeout(() => setTrash(null), 560)
  }

  function copyValue(item: Item): string {
    if (item.kind === 'text') return item.text ?? ''
    if (!base) return ''
    return new URL(`${base}/items/${item.id}/download`, window.location.origin).href
  }

  useEffect(() => {
    if (!copiedId) return
    const timer = window.setTimeout(() => setCopiedId(null), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [copiedId])

  function copyItem(item: Item) {
    const value = item.kind === 'text' && clipKind(item) === 'code' ? codeSource(item.text ?? '').body : copyValue(item)
    void copyText(value).then(() => {
      setCopiedId(item.id)
      toast.success('已复制')
    })
  }


  const ratio = quotaBytes > 0 ? Math.min(100, Math.round((roomUsed / quotaBytes) * 100)) : 0
  const tone = quotaTone(roomUsed, quotaBytes)
  const quotaBar = tone === 'over' ? 'bg-destructive' : tone === 'warn' ? 'bg-[#b45309]' : 'bg-primary'

  function chooseLayout(next: BoardLayout) {
    setLayout(next)
    try {
      localStorage.setItem(layoutKey, next)
    } catch {
      // Ignore persistence failures.
    }
  }

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

  const pinnedShown = shown.filter((item) => item.pinned)
  const looseShown = shown.filter((item) => !item.pinned)
  const showPinBar = pinnedShown.length > 0 || (gesture === 'pin-drag' && visible.some((item) => canShare(item)))
  const dotCount = Math.max(1, Math.min(channel.devices, 6))
  const live = channel.status === 'live'

  function cardFor(item: Item, variant: 'grid' | 'row') {
    return (
      <BoardCard
        key={item.id}
        item={item}
        base={base}
        now={now}
        variant={variant}
        gesture={gesture}
        reduced={reduced}
        sender={sender(item)}
        canEdit={canEdit(item)}
        canRetract={canRetract(item)}
        canShare={canShare(item)}
        open={openCard === item.id}
        onOpen={(next) => setOpenCard(next ? item.id : null)}
        copied={copiedId === item.id}
        pending={pending === item.id}
        editing={editing === item.id}
        editDraft={editDraft}
        savingEdit={savingEdit}
        onEditDraft={setEditDraft}
        onStartEdit={() => {
          setEditing(item.id)
          setEditDraft(item.text ?? '')
          clearPending()
        }}
        onSaveEdit={() => void saveEdit(item)}
        onCancelEdit={() => setEditing(null)}
        shareOpen={shareFor === item.id}
        onToggleShare={() => {
          setShareFor((current) => (current === item.id ? null : item.id))
          clearPending()
        }}
        tagOpen={tagFor === item.id}
        onToggleTag={() => {
          setTagFor((current) => (current === item.id ? null : item.id))
          setTagDraft('')
        }}
        tagDraft={tagDraft}
        onTagDraft={setTagDraft}
        onAddTag={() => {
          const next = tagDraft.trim().replace(/^#+/, '')
          if (!next) return
          void saveLabels(item, { tags: [...(item.tags ?? []), next] })
          setTagDraft('')
        }}
        onRemoveTag={(name) => void saveLabels(item, { tags: (item.tags ?? []).filter((tag) => tag !== name) })}
        activeTag={activeTag}
        onTag={(name) => setActiveTag((current) => (current === name ? null : name))}
        textOpen={expandedText[item.id] === true}
        onToggleText={() => setExpandedText((current) => ({ ...current, [item.id]: !current[item.id] }))}
        arrival={arrivals[item.id] ?? null}
        arrivalDot={() => dotRefs.current[dotCount > 1 ? 1 : 0] ?? null}
        onArrived={() => setArrivals(({ [item.id]: _done, ...rest }) => rest)}
        pinBarRef={pinBarRef}
        onPinHover={setPinHover}
        trashRef={trashRef}
        onDragPhase={onDragPhase}
        onCopy={() => copyItem(item)}
        onRetractClick={() => void retract(item)}
        onRetractNow={() => void removeItem(item)}
        onPin={(pinned) => void saveLabels(item, { pinned })}
        onOpenImage={() => setOpenId(item.id)}
      />
    )
  }

  const layoutButton = (value: BoardLayout, label: string, icon: ReactNode, first = false) => (
    <button
      type="button"
      aria-pressed={layout === value}
      aria-label={label}
      title={label}
      className={`relative inline-flex size-10 items-center justify-center transition-colors duration-(--dur-fast) ${first ? '' : 'border-l border-[var(--line-2)]'} ${layout === value ? 'bg-[var(--surface-2)] text-fg' : 'text-fg-3 hover:text-fg'}`}
      style={touchTarget}
      onClick={() => chooseLayout(value)}
    >
      {icon}
    </button>
  )

  return (
    <section>
      <div>
        <header className="mb-5 border-b border-[var(--line-1)] pb-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h1 className="dd-display text-3xl font-semibold tracking-tight text-fg md:text-[40px] md:leading-none">{title}</h1>
            <span className="inline-flex items-center gap-2">
              <span
                className="inline-flex min-h-10 items-center gap-0.5 rounded-full border border-[var(--line-2)] bg-[var(--surface-1)] pr-2.5 pl-1 text-xs font-medium text-fg-2 tabular-nums"
                tabIndex={0}
                role="status"
                title={`${channel.devices} 台设备在线`}
                aria-label={`${channel.devices} 台设备在线`}
              >
                <span className="flex items-center" aria-hidden="true">
                  {Array.from({ length: dotCount }, (_, index) => (
                    <DeviceDot
                      key={index}
                      color={DOT_COLORS[index % DOT_COLORS.length]}
                      online={live && index < channel.devices}
                      title={index === 0 ? '本设备' : `设备 ${index + 1}`}
                      ripple={reduced ? 0 : (ripples[index] ?? 0)}
                      dotRef={(el) => {
                        dotRefs.current[index] = el
                      }}
                    />
                  ))}
                </span>
                {channel.devices}
              </span>
              <span className="inline-flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-1)]" role="group" aria-label="布局">
                {layoutButton('grid', '网格', <LayoutGridIcon className="size-4" aria-hidden="true" />, true)}
                {layoutButton('list', '列表', <ListIcon className="size-4" aria-hidden="true" />)}
                {layoutButton('timeline', '时间线', <CalendarDaysIcon className="size-4" aria-hidden="true" />)}
              </span>
            </span>
          </div>
          {subtitle ? <p className="mt-3 text-sm text-muted-foreground">{subtitle}</p> : null}
          {deadline ? (
            <p className="mt-2 text-sm">
              剩余 <b>{formatRemain(deadline - now)}</b> 后自动销毁
            </p>
          ) : null}
          {usedBytes === null ? (
            <p className="mt-3 flex max-w-xs items-center gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">房间配额 {formatBytes(roomUsed)} / {formatBytes(quotaBytes)}</span>
              <span className="h-1 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="房间配额" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio} data-quota-tone={tone}>
                <span className={`block h-full rounded-full ${quotaBar}`} style={{ width: `${ratio}%` }} />
              </span>
            </p>
          ) : null}
        </header>
        <motion.form
          ref={zoneRef}
          aria-label="投放区"
          data-dragging={dragOver || undefined}
          className="dd-board relative overflow-hidden rounded-[var(--radius-lg)] border bg-[var(--surface-1)]"
          animate={dragOver ? { borderColor: 'var(--brand)', boxShadow: '0 0 0 4px var(--brand-soft), var(--elev-3)', scale: reduced ? 1 : 1.01 } : { borderColor: 'var(--line-2)', boxShadow: 'var(--elev-1)', scale: 1 }}
          transition={{ ...springSettle, borderColor: { duration: dur.base }, boxShadow: { duration: dur.base } }}
          onSubmit={(event) => {
            event.preventDefault()
            void sendText()
          }}
        >
          <AnimatePresence initial={false}>
            {dragOver ? (
              <motion.div
                key="zone"
                initial={{ opacity: 0, height: 64 }}
                animate={{ opacity: 1, height: 168, transition: { ...springSettle, opacity: { duration: dur.base, ease: easeOut } } }}
                exit={{ opacity: 0, height: 64, transition: { duration: dur.fast, ease: easeIn } }}
                className="dd-grid-bg pointer-events-none grid place-items-center"
              >
                <MagnetDropZone zoneRef={zoneRef} reduced={reduced} hint="文件会直接上传，图片会出现在看板里" />
              </motion.div>
            ) : null}
          </AnimatePresence>
          <div className={`flex items-end gap-2 p-2.5 ${dragOver ? 'hidden' : ''}`}>
            <button
              type="button"
              aria-label="文件"
              title="添加文件"
              onClick={() => fileRef.current?.click()}
              disabled={!base}
              className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fg-3)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)] disabled:opacity-50"
              style={touchTarget}
            >
              <PaperclipIcon className="size-4" aria-hidden="true" />
            </button>
            <label className="sr-only" htmlFor="draft">
              要发送的文本
            </label>
            <textarea
              id="draft"
              value={draft}
              rows={2}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void sendText()
                }
              }}
              placeholder="粘贴、输入，或把文件拖到这里…"
              className="min-h-10 flex-1 resize-y bg-transparent py-2 text-[15px] text-[var(--fg)] outline-none placeholder:text-[var(--fg-4)]"
            />
            <motion.button
              type="submit"
              aria-label="发送"
              title="发送（Ctrl/⌘ Enter）"
              disabled={!base || sending}
              whileTap={reduced ? undefined : { scale: 0.9 }}
              animate={{ opacity: draft.trim() ? 1 : 0.45 }}
              transition={springBounce}
              className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--brand)] text-[var(--brand-fg)] disabled:cursor-not-allowed"
              style={touchTarget}
            >
              <ArrowUpIcon className="size-4" aria-hidden="true" />
            </motion.button>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="sr-only"
            aria-label="选择文件"
            onChange={(event) => {
              const files = filesFromList(event.target.files)
              event.target.value = ''
              if (files.length) void sendFiles(files)
            }}
          />
          <input ref={resumeRef} type="file" className="sr-only" aria-label="选择要续传的文件" onChange={onResumePicked} />
          <p className={`border-t border-[var(--line-1)] px-3 py-1.5 text-[11px] text-[var(--fg-4)] ${dragOver ? 'hidden' : ''}`}>拖入文件，或直接粘贴截图 · Ctrl/⌘ Enter 发送</p>
          {rows.length > 0 ? (
            <div className="m-2.5 mt-0 max-w-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-0)]" role="region" aria-label="上传队列">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-1 px-3 py-2">
                <p className="text-xs font-medium text-fg-2">上传</p>
                {uploadBusy ? (
                  <button
                    type="button"
                    className={queueActionClass}
                    style={touchTarget}
                    onClick={() => queueRef.current?.cancelAll()}
                  >
                    全部取消
                  </button>
                ) : null}
              </div>
              <ul>
                {rows.map((row) => (
                  <li key={row.id} className="border-t border-line-1 px-3 py-2 first:border-t-0" data-upload-status={row.status}>
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</p>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {row.status === 'failed' ? (
                          <button
                            type="button"
                            className={queueActionClass}
                            style={touchTarget}
                            aria-label={`重试 ${row.name}`}
                            onClick={() => queueRef.current?.retry(row.id)}
                          >
                            重试
                          </button>
                        ) : null}
                        {row.status === 'uploading' ? (
                          <button
                            type="button"
                            className={queueActionClass}
                            style={touchTarget}
                            aria-label={`暂停 ${row.name}`}
                            onClick={() => queueRef.current?.pause(row.id)}
                          >
                            暂停
                          </button>
                        ) : null}
                        {row.status === 'paused' ? (
                          <button
                            type="button"
                            className={queueActionClass}
                            style={touchTarget}
                            aria-label={`继续 ${row.name}`}
                            onClick={() => continueRow(row)}
                          >
                            继续
                          </button>
                        ) : null}
                        {row.status === 'paused' && row.confirmMtime ? (
                          <button
                            type="button"
                            className={queueActionClass}
                            style={touchTarget}
                            aria-label={`仍要续传 ${row.name}`}
                            onClick={() => acceptMtime(row)}
                          >
                            仍要续传
                          </button>
                        ) : null}
                        {row.status === 'paused' && row.restored && row.error && !row.confirmMtime ? (
                          <button
                            type="button"
                            className={queueActionClass}
                            style={touchTarget}
                            aria-label={`放弃并重新上传 ${row.name}`}
                            onClick={() => abandonResume(row)}
                          >
                            放弃并重新上传
                          </button>
                        ) : null}
                        {row.status === 'queued' || row.status === 'uploading' || row.status === 'processing' || row.status === 'paused' ? (
                          <button
                            type="button"
                            className={queueActionClass}
                            style={touchTarget}
                            aria-label={`取消 ${row.name}`}
                            onClick={() => queueRef.current?.cancel(row.id)}
                          >
                            取消
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <p className="mt-1 text-xs break-words text-muted-foreground tabular-nums">
                      {formatBytes(row.size)} ·{' '}
                      <span className={row.status === 'processing' ? 'font-medium text-fg' : undefined}>
                        {uploadStatusLabel[row.status]}
                      </span>
                      {row.status === 'uploading' || row.status === 'done' || row.status === 'paused' ? ` · ${Math.round(row.ratio * 100)}%` : ''}
                      {row.status === 'paused' ? ` · 剩余 ${formatBytes(Math.max(0, row.size - Math.round(row.ratio * row.size)))}` : ''}
                      {row.status === 'uploading' && row.speedBps > 0 ? ` · ${formatSpeed(row.speedBps)} · ${formatEta(row.etaMs)}` : ''}
                    </p>
                    {(row.status === 'failed' || row.status === 'paused') && row.error ? <p className="mt-1 text-xs break-words text-destructive">{row.error}</p> : null}
                    <div
                      className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(row.ratio * 100)}
                      aria-valuetext={row.status === 'processing' ? '处理中' : undefined}
                      aria-label={row.name}
                    >
                      <div className="h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-(--dur-fast)" style={{ width: `${Math.round(row.ratio * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </motion.form>
        <label className="mt-4 block rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-1)] transition-colors duration-(--dur-fast) focus-within:border-[var(--line-3)]">
          <span className="sr-only">搜索</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文本、文件名或标签"
            aria-label="搜索"
            className="w-full bg-transparent px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-4"
          />
        </label>
        {channel.status === 'connecting' || channel.status === 'reconnecting' ? (
          <p className="pt-4 text-sm text-fg-3" role="status">
            {channel.status === 'reconnecting' ? '连接中断，正在重连并补拉…' : '正在同步…'}
          </p>
        ) : null}
        {activeTag ? (
          <button type="button" className="mt-3 inline-flex min-h-10 min-w-10 items-center justify-center rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-1)] px-2.5 text-xs font-medium text-fg-2 hover:border-[var(--line-3)]" style={touchTarget} onClick={() => setActiveTag(null)}>
            #{activeTag} · 清除标签
          </button>
        ) : null}
        <MotionConfig reducedMotion="user">
          <LayoutGroup>
            <div className="dd-board mt-4 flex flex-col gap-4" data-gesture={gesture} data-reduced={reduced || undefined}>
              {channel.status === 'connecting' && visible.length === 0 ? <BoardSkeletons view={layout === 'grid' ? 'grid' : 'rows'} /> : null}
              {channel.status !== 'connecting' && visible.length === 0 ? (
                <BoardEmpty title="这里还空着" body="还没有内容。发送文本或文件，其他设备会实时收到。到期的内容会自己褪色消失。" />
              ) : null}
              {showPinBar && visible.length > 0 ? (
                <PinBarShell barRef={pinBarRef} hover={pinHover} reduced={reduced} empty={pinnedShown.length === 0} layout="stack">
                  {pinnedShown.length > 0 ? <ul className="flex flex-col gap-2">{pinnedShown.map((item) => cardFor(item, 'row'))}</ul> : null}
                </PinBarShell>
              ) : null}
              {visible.length > 0 && shown.length === 0 ? <p className="py-8 text-center text-sm text-fg-3">没有匹配的内容。</p> : null}
              {layout === 'timeline' ? (
                <div className="flex flex-col gap-5" data-layout="timeline">
                  {timeline(looseShown, now).map(([day, list]) => (
                    <TimelineSection key={day} reduced={reduced} title={day} count={list.length}>
                      <ul className="flex flex-col gap-2">{list.map((item) => cardFor(item, 'row'))}</ul>
                    </TimelineSection>
                  ))}
                </div>
              ) : (
                <ul className={layout === 'grid' ? 'clip-board grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3' : 'clip-board flex flex-col gap-2'} data-layout={layout}>
                  {looseShown.map((item) => cardFor(item, layout === 'grid' ? 'grid' : 'row'))}
                </ul>
              )}
            </div>
          </LayoutGroup>
          {gesture === 'pin-drag' ? <TrashBin handle={trashRef} anchor={trash?.anchor ?? null} gulp={trash?.gulp ?? false} reduced={reduced} /> : null}
        </MotionConfig>
      </div>
      {openIndex >= 0 ? (
        <ImageLightbox
          slides={slides}
          index={openIndex}
          onClose={() => setOpenId(null)}
          onIndex={(next) => {
            const slide = slides[next]
            if (slide) setOpenId(slide.key)
          }}
        />
      ) : null}
      <CommandPalette
        items={visible}
        onJump={(id) => {
          const row = document.getElementById(`clip-${id}`)
          row?.scrollIntoView({ block: 'center' })
          row?.focus()
        }}
      />
    </section>
  )
}
