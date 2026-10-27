import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react'
import { ArrowUpIcon, CalendarDaysIcon, ClipboardPasteIcon, FolderIcon, LayoutGridIcon, ListIcon, PaperclipIcon, SearchIcon, TabletSmartphoneIcon } from 'lucide-react'
import { toast } from 'sonner'
import { BoardCard, itemVisual, type Arrival, type DragPhase } from '@/components/board-card.tsx'
import { BoardEmpty, BoardSkeletons, MagnetDropZone, PinBarShell, TimelineSection } from '@/components/board-chrome.tsx'
import { GroupBar, GroupTarget, type GroupFilter } from '@/components/board-groups.tsx'
import { GroupEmpty, GroupedSections, PinChip, PresencePill, Segmented } from '@/components/board-parts.tsx'
import { DeviceGlyph } from '@/components/device-glyph.tsx'
import { presenceDots, useDockedComposer, useScrollCollapse } from '@/lib/board-hooks.ts'
import { CommandPalette } from '@/components/command-palette.tsx'
import { ImageLightbox, type LightboxSlide } from '@/components/image-lightbox.tsx'
import { TrashBin } from '@/components/trash-bin.tsx'
import { ApiError, api, errorText, uploadFile } from '@/lib/api.ts'
import { adoptResume, browserResumeStore, browserTransport, discardSession, discardUpload, matchResumeFile, receivedRatio, uploadMaybeChunked, type ChunkTransport, type ResumeRecord, type ResumeStore } from '@/lib/chunked-upload.ts'
import { useChannel } from '@/lib/channel.ts'
import { PRESENCE_SLOT, deviceColor, itemHeaders, localDevice, setUploadGroup } from '@/lib/device.ts'
import { groupName } from '@/lib/groups.ts'
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
type BoardLayout = 'grid' | 'list' | 'group' | 'timeline' | 'device'
const LAYOUTS: BoardLayout[] = ['grid', 'list', 'group', 'timeline', 'device']

function readLayout(): BoardLayout {
  try {
    const saved = localStorage.getItem(layoutKey)
    return LAYOUTS.includes(saved as BoardLayout) ? (saved as BoardLayout) : 'grid'
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

/** 按设备 sections, most recent sender first; clips without a device fall under their sender label. */
function byDevice(items: Item[], sender: (item: Item) => string): Array<{ key: string; name: string; kind: NonNullable<Item['device']>['kind'] | null; list: Item[] }> {
  const map = new Map<string, { key: string; name: string; kind: NonNullable<Item['device']>['kind'] | null; list: Item[] }>()
  for (const item of items) {
    const key = item.device?.id ?? `sender:${sender(item)}`
    const entry = map.get(key)
    if (entry) entry.list.push(item)
    else map.set(key, { key, name: item.device?.name ?? `${sender(item)} · 未识别设备`, kind: item.device?.kind ?? null, list: [item] })
  }
  return [...map.values()]
}

function deviceOnlyHeaders(): Record<string, string> {
  return Object.fromEntries(Object.entries(itemHeaders()).filter(([key]) => key !== 'X-Dropit-Group'))
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
  const [ripples, setRipples] = useState<Record<string, number>>({})
  const dotRefs = useRef(new Map<string, HTMLElement>())
  const [groupFilter, setGroupFilter] = useState<GroupFilter>(null)
  const [target, setTarget] = useState('')
  const [groupPulse, setGroupPulse] = useState<Record<string, number>>({})
  const docked = useDockedComposer()
  const [composerFocus, setComposerFocus] = useState(false)
  const [collapsed, setCollapsed] = useScrollCollapse(docked, composerFocus || draft.trim().length > 0 || dragOver || sending)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const selfId = localDevice().id
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
  const groups = channel.groups
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

  /** The demo's 粘贴截图: read an image straight off the system clipboard. */
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
        // device headers tag the clip with this browser; the group travels in the body
        headers: { 'Content-Type': 'application/json', ...deviceOnlyHeaders() },
        body: JSON.stringify(target ? { text, group: target } : { text }),
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

  async function saveLabels(item: Item, patch: { pinned?: boolean; tags?: string[]; group?: string | null }) {
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

  // ------------------------------------------------ groups (RHEA-190 step 5)

  useEffect(() => {
    setUploadGroup(target || null)
    return () => setUploadGroup(null)
  }, [target])

  useEffect(() => {
    setSlot(document.getElementById(PRESENCE_SLOT))
  }, [])

  // A filtered / targeted group that disappears (renamed or deleted elsewhere) falls back to 全部 / 未分组.
  useEffect(() => {
    if (channel.status !== 'live') return
    if (groupFilter && !groups.includes(groupFilter)) setGroupFilter(null)
    if (target && !groups.includes(target)) setTarget('')
  }, [channel.status, groups, groupFilter, target])

  function groupFailed(error: unknown) {
    toast.error(errorText(error))
    if (error instanceof ApiError && error.status === 401) onAuthLost?.()
    if (!base) return
    void api<{ groups: string[] }>(`${base}/groups`)
      .then((result) => channel.setGroups(result.groups))
      .catch(() => undefined)
  }

  function checkGroupName(raw: string, except?: string): string | null {
    const name = raw.replace(/\s+/g, ' ').trim()
    if (!name) return null
    if (name === '全部' || name === '未分组') {
      toast.error(`「${name}」是保留名字`)
      return null
    }
    if (name !== except && groups.includes(name)) {
      toast.error('已有同名分组')
      return null
    }
    return name
  }

  function createGroup(raw: string): boolean {
    if (!base) return false
    const name = checkGroupName(raw)
    if (!name) return false
    if (groups.length >= 24) {
      toast.error('分组太多了（最多 24 个）')
      return false
    }
    channel.setGroups((current) => (current.includes(name) ? current : [...current, name]))
    setGroupFilter(name)
    void api<{ groups: string[] }>(`${base}/groups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      .then((result) => channel.setGroups(result.groups))
      .catch(groupFailed)
    return true
  }

  function renameGroup(from: string, raw: string): boolean {
    if (!base) return false
    const name = checkGroupName(raw, from)
    if (!name) return false
    if (name === from) return true
    channel.setGroups((current) => current.map((g) => (g === from ? name : g)))
    if (groupFilter === from) setGroupFilter(name)
    if (target === from) setTarget(name)
    void api<{ groups: string[] }>(`${base}/groups/${encodeURIComponent(from)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      .then((result) => channel.setGroups(result.groups))
      .catch(groupFailed)
    return true
  }

  function deleteGroup(name: string) {
    if (!base) return
    channel.setGroups((current) => current.filter((g) => g !== name))
    if (groupFilter === name) setGroupFilter(null)
    if (target === name) setTarget('')
    void api<{ groups: string[] }>(`${base}/groups/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then((result) => {
        channel.setGroups(result.groups)
        toast.success(`已删除分组「${name}」，内容移到未分组`)
      })
      .catch(groupFailed)
  }

  function pulseGroup(group: string | null | undefined) {
    const key = group ?? ''
    setGroupPulse((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }))
  }

  function moveToGroup(item: Item, group: string | null) {
    void saveLabels(item, { group }).then(() => pulseGroup(group))
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

  // Latest render-derived helpers for the arrivals effect (filled by a layout effect below).
  const arrivalRef = useRef<{ sourceKey: (item: Item) => string; groupFilter: GroupFilter; pulseGroup: (group: string | null | undefined) => void } | null>(null)

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
    const latest = arrivalRef.current
    // Arriving into a group that's filtered out: pulse its chip and say where it went.
    if (latest) {
      for (const item of fresh) {
        if (!item.pinned && latest.groupFilter !== null && (item.group ?? '') !== latest.groupFilter) {
          latest.pulseGroup(item.group)
          if (!localIds.current.has(item.id)) toast(`新内容进了「${groupName(item.group)}」`)
        }
      }
    }
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
      const bumped: Record<string, number> = {}
      for (const item of fresh) if (!localIds.current.has(item.id)) bumped[latest ? latest.sourceKey(item) : item.id] = 1
      setRipples((current) => {
        const out = { ...current }
        for (const key of Object.keys(bumped)) out[key] = (out[key] ?? 0) + 1
        return out
      })
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
  const looseAll = shown.filter((item) => !item.pinned)
  const looseShown = groupFilter === null ? looseAll : looseAll.filter((item) => (item.group ?? '') === groupFilter)
  const showPinBar = pinnedShown.length > 0 || (gesture === 'pin-drag' && visible.some((item) => canShare(item)))
  const live = channel.status === 'live'
  const dots = presenceDots(channel.devices, channel.peers, visible, selfId)
  const groupCounts = new Map<string, number>()
  for (const item of looseAll) groupCounts.set(item.group ?? '', (groupCounts.get(item.group ?? '') ?? 0) + 1)

  /** which presence dot a remote clip flies from: its sender's own dot when we know it */
  function sourceKey(item: Item): string {
    if (item.device && dots.some((dot) => dot.key === item.device?.id)) return item.device.id
    const other = dots.find((dot) => !dot.self && dot.online) ?? dots.find((dot) => !dot.self) ?? dots[0]
    return other?.key ?? '#0'
  }

  useLayoutEffect(() => {
    arrivalRef.current = { sourceKey, groupFilter, pulseGroup }
  })

  function focusDraft() {
    setCollapsed(false)
    window.setTimeout(() => draftRef.current?.focus(), reduced ? 0 : 120)
  }

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
        arrivalDot={() => dotRefs.current.get(sourceKey(item)) ?? null}
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
        groups={groups}
        onMoveGroup={canShare(item) && (groups.length > 0 || item.group) ? (group) => moveToGroup(item, group) : undefined}
      />
    )
  }

  function chipFor(item: Item) {
    return (
      <PinChip
        key={item.id}
        item={item}
        visual={itemVisual(item, base)}
        reduced={reduced}
        open={openCard === item.id}
        onOpen={(next) => setOpenCard(next ? item.id : null)}
        copied={copiedId === item.id}
        canLabel={canShare(item)}
        activeTag={activeTag}
        onTag={(name) => setActiveTag((current) => (current === name ? null : name))}
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
        onCopy={() => copyItem(item)}
        onUnpin={() => {
          setOpenCard(null)
          void saveLabels(item, { pinned: false })
        }}
      />
    )
  }

  const presence = (
    <PresencePill
      count={channel.devices}
      dots={dots}
      live={live}
      reduced={reduced}
      ripples={ripples}
      dotRef={(key, el) => {
        if (el) dotRefs.current.set(key, el)
        else dotRefs.current.delete(key)
      }}
    />
  )

  const uploadQueue =
    rows.length > 0 ? (
      <div className="max-w-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-0)]" role="region" aria-label="上传队列">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-1 px-3 py-2">
          <p className="text-xs font-medium text-fg-2">上传</p>
          {uploadBusy ? (
            <button type="button" className={queueActionClass} style={touchTarget} onClick={() => queueRef.current?.cancelAll()}>
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
                    <button type="button" className={queueActionClass} style={touchTarget} aria-label={`重试 ${row.name}`} onClick={() => queueRef.current?.retry(row.id)}>
                      重试
                    </button>
                  ) : null}
                  {row.status === 'uploading' ? (
                    <button type="button" className={queueActionClass} style={touchTarget} aria-label={`暂停 ${row.name}`} onClick={() => queueRef.current?.pause(row.id)}>
                      暂停
                    </button>
                  ) : null}
                  {row.status === 'paused' ? (
                    <button type="button" className={queueActionClass} style={touchTarget} aria-label={`继续 ${row.name}`} onClick={() => continueRow(row)}>
                      继续
                    </button>
                  ) : null}
                  {row.status === 'paused' && row.confirmMtime ? (
                    <button type="button" className={queueActionClass} style={touchTarget} aria-label={`仍要续传 ${row.name}`} onClick={() => acceptMtime(row)}>
                      仍要续传
                    </button>
                  ) : null}
                  {row.status === 'paused' && row.restored && row.error && !row.confirmMtime ? (
                    <button type="button" className={queueActionClass} style={touchTarget} aria-label={`放弃并重新上传 ${row.name}`} onClick={() => abandonResume(row)}>
                      放弃并重新上传
                    </button>
                  ) : null}
                  {row.status === 'queued' || row.status === 'uploading' || row.status === 'processing' || row.status === 'paused' ? (
                    <button type="button" className={queueActionClass} style={touchTarget} aria-label={`取消 ${row.name}`} onClick={() => queueRef.current?.cancel(row.id)}>
                      取消
                    </button>
                  ) : null}
                </div>
              </div>
              <p className="mt-1 text-xs break-words text-muted-foreground tabular-nums">
                {formatBytes(row.size)} ·{' '}
                <span className={row.status === 'processing' ? 'font-medium text-fg' : undefined}>{uploadStatusLabel[row.status]}</span>
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
    ) : null

  const composer = (
    <motion.form
      ref={zoneRef}
      layout={docked && !reduced}
      aria-label="投放区"
      data-dragging={dragOver || undefined}
      data-docked={docked || undefined}
      data-collapsed={collapsed || undefined}
      style={{ borderRadius: docked ? (collapsed ? 999 : 20) : undefined }}
      className={`dd-board relative overflow-hidden border ${
        docked
          ? `pointer-events-auto bg-[color-mix(in_oklab,var(--surface-1)_88%,transparent)] backdrop-blur-xl ${collapsed ? 'w-auto' : 'w-full max-w-[640px]'}`
          : 'rounded-[var(--radius-lg)] bg-[var(--surface-1)]'
      }`}
      animate={
        dragOver
          ? { borderColor: 'var(--brand)', boxShadow: '0 0 0 4px var(--brand-soft), var(--elev-3)', scale: reduced ? 1 : 1.01 }
          : { borderColor: 'var(--line-2)', boxShadow: docked ? 'var(--elev-3)' : 'var(--elev-1)', scale: 1 }
      }
      transition={{ ...springSettle, borderColor: { duration: dur.base }, boxShadow: { duration: dur.base } }}
      onSubmit={(event) => {
        event.preventDefault()
        void sendText()
      }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {dragOver ? (
          <motion.div
            key="zone"
            initial={{ opacity: 0, height: 64 }}
            animate={{ opacity: 1, height: 168, transition: { ...springSettle, opacity: { duration: dur.base, ease: easeOut } } }}
            exit={{ opacity: 0, height: 64, transition: { duration: dur.fast, ease: easeIn } }}
            className="dd-grid-bg pointer-events-none grid place-items-center"
          >
            <MagnetDropZone zoneRef={zoneRef} reduced={reduced} hint={target ? `文件会直接上传到「${target}」` : '文件会直接上传，图片会出现在看板里'} />
          </motion.div>
        ) : collapsed ? (
          <motion.button
            key="pill"
            type="button"
            layout="position"
            onClick={focusDraft}
            aria-label="展开输入框"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: dur.base, ease: easeOut } }}
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
            className="flex h-11 items-center gap-2 pr-1.5 pl-4 text-[13px] text-[var(--fg-3)]"
          >
            <span className="whitespace-nowrap">粘贴或输入…</span>
            <span className="grid size-8 place-items-center rounded-full bg-[var(--brand)] text-[var(--brand-fg)]">
              <ArrowUpIcon className="size-3.5" aria-hidden="true" />
            </span>
          </motion.button>
        ) : (
          <motion.div key="input" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: dur.fast } }} className="flex items-end gap-1.5 p-2 sm:gap-2 sm:p-2.5">
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
            {groups.length > 0 ? (
              <span className="flex min-h-10 items-center">
                <GroupTarget groups={groups} value={target} onChange={setTarget} compact={docked} />
              </span>
            ) : null}
            <label className="sr-only" htmlFor="draft">
              要发送的文本
            </label>
            <textarea
              id="draft"
              ref={draftRef}
              value={draft}
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={() => setComposerFocus(true)}
              onBlur={() => setComposerFocus(false)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                if (event.metaKey || event.ctrlKey || !event.shiftKey) {
                  event.preventDefault()
                  void sendText()
                }
              }}
              placeholder={docked ? '粘贴或输入…' : '粘贴、输入，或把文件拖到这里…'}
              className="max-h-48 min-h-10 flex-1 resize-none bg-transparent py-2.5 text-[14px] text-[var(--fg)] outline-none [field-sizing:content] placeholder:text-[var(--fg-4)]"
            />
            {!docked ? (
              <button
                type="button"
                onClick={() => void pasteShot()}
                title="粘贴剪贴板里的截图"
                className="hidden h-10 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-[12px] text-[var(--fg-3)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)] sm:flex"
              >
                <ClipboardPasteIcon className="size-4" aria-hidden="true" /> 粘贴截图
              </button>
            ) : null}
            <motion.button
              type="submit"
              aria-label="发送"
              title="发送（Enter，Shift+Enter 换行）"
              disabled={!base || sending}
              whileTap={reduced ? undefined : { scale: 0.9 }}
              animate={{ opacity: draft.trim() ? 1 : 0.45 }}
              transition={springBounce}
              className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--brand)] text-[var(--brand-fg)] disabled:cursor-not-allowed"
              style={touchTarget}
            >
              <ArrowUpIcon className="size-4" aria-hidden="true" />
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
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
    </motion.form>
  )

  const deviceSections = layout === 'device' ? byDevice(looseShown, sender) : []
  const onlineIds = new Set(dots.filter((dot) => dot.online).map((dot) => dot.key))

  return (
    <section className={docked ? 'pb-[calc(76px+env(safe-area-inset-bottom))]' : undefined}>
      <div className="flex flex-col gap-4">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="dd-display text-[19px] font-semibold tracking-tight text-fg">{title}</h1>
          {subtitle ? <p className="text-[12px] text-[var(--fg-3)]">{subtitle}</p> : null}
          {deadline ? (
            <p className="text-[12px] text-[var(--fg-2)]">
              剩余 <b>{formatRemain(deadline - now)}</b> 后自动销毁
            </p>
          ) : null}
          {usedBytes === null ? (
            <p className="flex max-w-xs items-center gap-2 text-[11px] text-[var(--fg-3)]">
              <span className="shrink-0">房间配额 {formatBytes(roomUsed)} / {formatBytes(quotaBytes)}</span>
              <span className="h-1 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="房间配额" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio} data-quota-tone={tone}>
                <span className={`block h-full rounded-full ${quotaBar}`} style={{ width: `${ratio}%` }} />
              </span>
            </p>
          ) : null}
          {slot ? null : <span className="ml-auto">{presence}</span>}
        </header>
        {slot ? createPortal(presence, slot) : null}
        {docked ? null : composer}
        {uploadQueue}
        <MotionConfig reducedMotion="user">
          <LayoutGroup>
            <div className="dd-board flex flex-col gap-4" data-gesture={gesture} data-reduced={reduced || undefined}>
              {showPinBar && visible.length > 0 ? (
                <PinBarShell barRef={pinBarRef} hover={pinHover} reduced={reduced} empty={pinnedShown.length === 0} layout="chips">
                  <AnimatePresence initial={false} mode="popLayout">
                    {pinnedShown.map((item) => chipFor(item))}
                  </AnimatePresence>
                </PinBarShell>
              ) : null}
              {visible.length > 0 || groups.length > 0 ? (
                <GroupBar
                  groups={groups}
                  filter={groupFilter}
                  counts={groupCounts}
                  total={looseAll.length}
                  reduced={reduced}
                  dragging={false}
                  dropHover={null}
                  pulse={groupPulse}
                  chipRef={() => {}}
                  onFilter={setGroupFilter}
                  onCreate={createGroup}
                  onRename={renameGroup}
                  onDelete={deleteGroup}
                />
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  id="layout"
                  label="布局"
                  value={layout}
                  onChange={chooseLayout}
                  options={[
                    { value: 'grid', label: '网格', icon: <LayoutGridIcon className="size-3.5" /> },
                    { value: 'list', label: '列表', icon: <ListIcon className="size-3.5" /> },
                    { value: 'group', label: '按分组', icon: <FolderIcon className="size-3.5" /> },
                    { value: 'timeline', label: '时间线', icon: <CalendarDaysIcon className="size-3.5" /> },
                    { value: 'device', label: '按设备', icon: <TabletSmartphoneIcon className="size-3.5" /> },
                  ]}
                />
                <span className="dd-mono text-[11px] text-[var(--fg-3)]">{looseShown.length} 条</span>
                {activeTag ? (
                  <button type="button" className="dd-chip" aria-pressed="true" style={touchTarget} onClick={() => setActiveTag(null)}>
                    #{activeTag} · 清除标签
                  </button>
                ) : null}
                <label className="relative flex min-h-10 w-full items-center rounded-[var(--radius-md)] border border-[var(--line-1)] bg-[var(--surface-1)] transition-colors duration-(--dur-fast) focus-within:border-[var(--line-3)] sm:ml-auto sm:w-60">
                  <SearchIcon className="pointer-events-none absolute left-2.5 size-3.5 text-[var(--fg-4)]" aria-hidden="true" />
                  <span className="sr-only">搜索</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索文本、文件名或标签"
                    aria-label="搜索"
                    className="w-full bg-transparent py-2 pr-3 pl-8 text-[13px] text-fg outline-none placeholder:text-fg-4"
                  />
                </label>
              </div>
              {channel.status === 'connecting' || channel.status === 'reconnecting' ? (
                <p className="text-sm text-fg-3" role="status">
                  {channel.status === 'reconnecting' ? '连接中断，正在重连并补拉…' : '正在同步…'}
                </p>
              ) : null}
              {channel.status === 'connecting' && visible.length === 0 ? <BoardSkeletons view={layout === 'grid' || layout === 'group' ? 'grid' : 'rows'} /> : null}
              {channel.status !== 'connecting' && visible.length === 0 ? (
                <BoardEmpty title="这里还空着" body="还没有内容。发送文本或文件，其他设备会实时收到。到期的内容会自己褪色消失。" />
              ) : null}
              {visible.length > 0 && shown.length === 0 ? <p className="py-8 text-center text-sm text-fg-3">没有匹配的内容。</p> : null}
              {looseAll.length > 0 && looseShown.length === 0 && groupFilter !== null && layout !== 'group' ? (
                <GroupEmpty group={groupFilter} onAll={() => setGroupFilter(null)} />
              ) : layout === 'group' ? (
                looseAll.length > 0 || groupFilter !== null ? <GroupedSections items={looseShown} groups={groups} filter={groupFilter} reduced={reduced} card={(item) => cardFor(item, 'grid')} /> : null
              ) : layout === 'timeline' ? (
                <div className="flex flex-col gap-5" data-layout="timeline">
                  {timeline(looseShown, now).map(([day, list]) => (
                    <TimelineSection key={day} reduced={reduced} title={day} count={list.length}>
                      <ul className="flex flex-col gap-2">{list.map((item) => cardFor(item, 'row'))}</ul>
                    </TimelineSection>
                  ))}
                </div>
              ) : layout === 'device' ? (
                <div className="flex flex-col gap-5" data-layout="device">
                  {deviceSections.map((section) => (
                    <TimelineSection
                      key={section.key}
                      reduced={reduced}
                      dotColor={section.kind ? deviceColor(section.kind) : undefined}
                      title={
                        <>
                          {section.kind ? <DeviceGlyph kind={section.kind} className="size-3.5 text-[var(--fg-3)]" /> : null}
                          {section.name}
                          {section.key === selfId ? <span className="text-[11px] font-normal text-[var(--fg-3)]">（本设备）</span> : null}
                        </>
                      }
                      count={section.list.length}
                      extra={section.kind && !onlineIds.has(section.key) ? <span className="text-[11px] font-normal text-[var(--fg-4)]">离线</span> : null}
                    >
                      <ul className="flex flex-col gap-2">{section.list.map((item) => cardFor(item, 'row'))}</ul>
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
      {docked ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(44px+env(safe-area-inset-bottom))] z-30 flex justify-center px-3 pb-2 md:bottom-0 md:pb-[max(12px,env(safe-area-inset-bottom))]">{composer}</div>
      ) : null}
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
