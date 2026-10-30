import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react'
import { ArrowUpIcon, ClipboardPasteIcon, PaperclipIcon } from 'lucide-react'
import { toast } from 'sonner'
import { BoardCard, itemVisual, type Arrival, type DragPhase } from '@/components/board-card.tsx'
import { BoardEmpty, BoardSkeletons, MagnetDropZone, PinBarShell, TimelineSection } from '@/components/board-chrome.tsx'
import { BoardHeader, BoardToolbar } from '@/components/board-toolbar.tsx'
import { GroupBar, GroupTarget, type GroupFilter } from '@/components/board-groups.tsx'
import { GroupEmpty, GroupedSections, PinChip, PresencePill } from '@/components/board-parts.tsx'
import { DeviceGlyph } from '@/components/device-glyph.tsx'
import { onlineDeviceCount, presenceDots, useCoarsePointer, useDockedComposer, useScrollCollapse } from '@/lib/board-hooks.ts'
import { CommandPalette } from '@/components/command-palette.tsx'
import { MediaViewer, type ViewerMedia } from '@/components/clip-media.tsx'
import { UploadCard } from '@/components/upload-card.tsx'
import { TrashBin } from '@/components/trash-bin.tsx'
import { ApiError, api, errorText, uploadFile } from '@/lib/api.ts'
import type { ChunkTransport, ResumeStore } from '@/lib/chunked-upload.ts'
import { byDevice, layoutKey, readLayout, timeline, touchTarget, type BoardLayout } from '@/lib/board-layout.ts'
import { useChannel } from '@/lib/channel.ts'
import { filesFromList, useBoardUploads } from '@/lib/use-board-uploads.ts'
import { useBoardFilter } from '@/lib/use-board-filter.ts'
import { PRESENCE_SLOT, deviceColor, itemHeaders, localDevice, setUploadGroup } from '@/lib/device.ts'
import { chipAtSticky, groupName, layoutBox, type Box } from '@/lib/groups.ts'
import { copyText, formatBytes, quotaTone, useClock, utf8Size } from '@/lib/format.ts'
import { clipKind, codeSource } from '@/lib/clip-kind.ts'
import { dur, easeIn, easeOut, springBounce, springSettle } from '@/lib/motion.ts'
import { trashAnchorFor, type TrashAnchor, type TrashHandle } from '@/lib/trash-anchor.ts'
import type { ConnectionStatus, Item } from '@/lib/types.ts'

const COPIED_MS = 1400

const RETRACT_MS = 3000

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
  canShare: canShareProp,
  readOnly = false,
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
  /** RHEA-190 m50: a read-only member (view and copy only): no composer, drop, paste, edit, pin, share or retract. */
  readOnly?: boolean
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
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [shareFor, setShareFor] = useState<string | null>(null)
  const canShare = readOnly ? () => false : canShareProp
  const uploads = useBoardUploads({ base, readOnly, channel, maxFileBytes, upload, chunkBytes, resumeStore, transport, onActivity, onAuthLost, onBusyChange, onBindCancel })
  const { rows, dragOver, uploadBusy, localIds, uploadedIds, resumeRef, sendFiles, pasteShot, onResumePicked, cancelAll, previewFor, uploadActions } = uploads
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
  const [target, setTarget] = useState('')
  const [groupPulse, setGroupPulse] = useState<Record<string, number>>({})
  // RHEA-190 step 7: drag a card straight onto a group chip (desktop pin-drag)
  const [dragging, setDragging] = useState(false)
  const [groupHover, setGroupHover] = useState<string | null>(null)
  const chipEls = useRef(new Map<string, HTMLElement>())
  // hit zones for the drag, measured from untransformed layout when the drag starts (and again on scroll)
  const chipZones = useRef<Array<readonly [string, Box]>>([])
  const groupHoverRef = useRef<string | null>(null)
  const docked = useDockedComposer()
  const [composerFocus, setComposerFocus] = useState(false)
  const [collapsed, setCollapsed] = useScrollCollapse(docked, composerFocus || draft.trim().length > 0 || dragOver || sending)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const selfId = localDevice().id
  const seenIds = useRef<Set<string> | null>(null)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const seenAuth = useRef(0)
  const visible = channel.items.filter((item) => item.expiresAt > now)
  const groups = channel.groups
  const { query, setQuery, groupFilter, setGroupFilter, shown, pinnedShown, looseAll, looseShown, groupCounts } = useBoardFilter(visible)
  const slides = base
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
  const openSlide = openIndex >= 0 ? slides[openIndex] : null
  const viewerMedia: ViewerMedia | null = openSlide
    ? {
        type: 'image',
        src: openSlide.thumbnailSrc,
        full: openSlide.previewSrc,
        name: openSlide.filename,
        meta: formatBytes(openSlide.byteSize),
        layoutId: `img-${openSlide.key}`,
        download: openSlide.downloadHref,
      }
    : null
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
      localIds.add(result.item.id)
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

  async function saveLabels(item: Item, patch: { pinned?: boolean; group?: string | null }) {
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
  }, [channel.status, groups, groupFilter, setGroupFilter, target])

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
    // RHEA-190 m52: a new group only joins the chip bar; the board stays on the
    // group the user is looking at (they can tap the new chip to switch).
    channel.setGroups((current) => (current.includes(name) ? current : [...current, name]))
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
          if (!localIds.has(item.id)) toast(`新内容进了「${groupName(item.group)}」`)
        }
      }
    }
    if (reduced) return
    const next: Record<string, Arrival> = {}
    let remote = false
    for (const item of fresh) {
      const mine = localIds.has(item.id)
      next[item.id] = mine ? (uploadedIds.has(item.id) ? 'uploaded' : 'landed') : 'arrived'
      remote ||= !mine
    }
    setArrivals((current) => ({ ...current, ...next }))
    if (remote) {
      const bumped: Record<string, number> = {}
      for (const item of fresh) if (!localIds.has(item.id)) bumped[latest ? latest.sourceKey(item) : item.id] = 1
      setRipples((current) => {
        const out = { ...current }
        for (const key of Object.keys(bumped)) out[key] = (out[key] ?? 0) + 1
        return out
      })
    }
  }, [channel.items, channel.status, channel.devices, reduced, localIds, uploadedIds])

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
    setDragging('rect' in phase)
    groupHoverRef.current = null
    setGroupHover(null)
    if ('rect' in phase) measureChips()
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

  /**
   * Which group chip the dragged card's pointer is over ('' = 未分组), with a
   * generous hit area around each chip. With `drop` it also files the card there.
   */
  function measureChips() {
    chipZones.current = [...chipEls.current].map(([key, el]) => [key, layoutBox(el)] as const)
  }

  // Scrolling (the page or the chip bar) moves the chips under a still pointer: re-measure then.
  useEffect(() => {
    if (!dragging) return
    window.addEventListener('scroll', measureChips, { capture: true, passive: true })
    window.addEventListener('resize', measureChips)
    return () => {
      window.removeEventListener('scroll', measureChips, { capture: true })
      window.removeEventListener('resize', measureChips)
    }
  }, [dragging])

  function onGroupDrag(item: Item, x: number, y: number, drop: boolean): string | null {
    if (!chipZones.current.length) measureChips()
    const hit = chipAtSticky(chipZones.current, x, y, groupHoverRef.current)
    const next = drop ? null : hit
    if (next !== groupHoverRef.current) {
      groupHoverRef.current = next
      setGroupHover(next)
    }
    if (drop && hit !== null) {
      if ((item.group ?? '') !== hit) {
        moveToGroup(item, hit || null)
        toast(hit ? `已移到「${hit}」` : '已移出分组')
      }
    }
    return hit
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

  const showPinBar = pinnedShown.length > 0 || (gesture === 'pin-drag' && visible.some((item) => canShare(item)))
  const live = channel.status === 'live'
  const dots = presenceDots(channel.devices, channel.peers, visible, selfId, channel.others)
  const onlineCount = onlineDeviceCount(channel.devices, channel.peers, dots)

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
        canEdit={!readOnly && canEdit(item)}
        canRetract={!readOnly && canRetract(item)}
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
        imageOpen={openId === item.id}
        groups={groups}
        onMoveGroup={canShare(item) && (groups.length > 0 || item.group) ? (group) => moveToGroup(item, group) : undefined}
        onGroupDrag={gesture === 'pin-drag' && canShare(item) && groups.length > 0 ? (x, y, drop) => onGroupDrag(item, x, y, drop) : undefined}
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
      count={onlineCount}
      dots={dots}
      live={live}
      reduced={reduced}
      ripples={ripples}
      dotRef={(key, el) => {
        if (el) dotRefs.current.set(key, el)
        else dotRefs.current.delete(key)
      }}
      manageHref={base?.startsWith('/api/spaces/') ? '/settings#devices' : undefined}
    />
  )

  // RHEA-190 step 6: uploads live on the board as translucent cards (finished ones hand over to the real clip).
  const uploadsPending = rows.filter((row) => row.status !== 'done')
  const uploadCards = (variant: 'grid' | 'row') =>
    uploadsPending.map((row) => <UploadCard key={`upload-${row.id}`} row={row} preview={previewFor(row)} variant={variant} reduced={reduced} actions={uploadActions(row)} />)
  const uploadsInline = (layout === 'grid' || layout === 'list') && !(looseAll.length > 0 && looseShown.length === 0 && groupFilter !== null)

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
                <GroupTarget groups={groups} value={target} onChange={setTarget} compact={docked} reduced={reduced} />
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
    <section className={`dd-noselect ${docked ? 'pb-[calc(76px+env(safe-area-inset-bottom))]' : ''}`} data-board-root="">
      <div className="flex flex-col gap-4">
        <BoardHeader title={title} subtitle={subtitle} deadlineLeft={deadline ? deadline - now : null} usedBytes={usedBytes} roomUsed={roomUsed} quotaBytes={quotaBytes} ratio={ratio} tone={tone} quotaBar={quotaBar} trailing={slot ? null : presence} />
        {slot ? createPortal(presence, slot) : null}
        {readOnly ? (
          <p className="rounded-md border border-[var(--line-1)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--fg-3)]" data-read-only="">
            你是这个空间的只读成员：可以查看和复制，不能发送、编辑或删除。
          </p>
        ) : docked ? null : composer}
        <MotionConfig reducedMotion="user">
          <LayoutGroup>
            <div ref={boardRef} className="dd-board flex flex-col gap-4" data-gesture={gesture} data-reduced={reduced || undefined}>
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
                  dragging={dragging && gesture === 'pin-drag' && groups.length > 0}
                  dropHover={groupHover}
                  pulse={groupPulse}
                  chipRef={(key, el) => {
                    if (el) chipEls.current.set(key, el)
                    else chipEls.current.delete(key)
                  }}
                  onFilter={setGroupFilter}
                  onCreate={createGroup}
                  onRename={renameGroup}
                  onDelete={deleteGroup}
                  readOnly={readOnly}
                />
              ) : null}
              <BoardToolbar
                layout={layout}
                onLayout={chooseLayout}
                count={looseShown.length}
                uploadBusy={uploadBusy}
                uploadCount={uploadsPending.filter((row) => row.status !== 'failed' && row.status !== 'cancelled').length}
                onCancelAll={cancelAll}
                query={query}
                onQuery={setQuery}
              />
              {channel.status === 'connecting' || channel.status === 'reconnecting' ? (
                <p className="text-sm text-fg-3" role="status">
                  {channel.status === 'reconnecting' ? '连接中断，正在重连并补拉…' : '正在同步…'}
                </p>
              ) : null}
              {channel.status === 'connecting' && visible.length === 0 ? <BoardSkeletons view={layout === 'grid' || layout === 'group' ? 'grid' : 'rows'} /> : null}
              {uploadsPending.length > 0 && !uploadsInline ? (
                <ul className={layout === 'group' ? 'grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3' : 'flex flex-col gap-2'} data-upload-strip="">
                  <AnimatePresence initial={false} mode="popLayout">{uploadCards(layout === 'group' ? 'grid' : 'row')}</AnimatePresence>
                </ul>
              ) : null}
              {channel.status !== 'connecting' && visible.length === 0 && uploadsPending.length === 0 ? (
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
                  <AnimatePresence initial={false} mode="popLayout">{uploadsInline ? uploadCards(layout === 'grid' ? 'grid' : 'row') : null}</AnimatePresence>
                  {looseShown.map((item) => cardFor(item, layout === 'grid' ? 'grid' : 'row'))}
                </ul>
              )}
            </div>
            <MediaViewer
              media={viewerMedia}
              anchor={boardRef}
              reduced={reduced}
              onClose={() => setOpenId(null)}
              gallery={
                openIndex >= 0
                  ? {
                      index: openIndex,
                      count: slides.length,
                      onStep: (delta) => {
                        const slide = slides[openIndex + delta]
                        if (slide) setOpenId(slide.key)
                      },
                    }
                  : undefined
              }
            />
          </LayoutGroup>
          {gesture === 'pin-drag' ? <TrashBin handle={trashRef} anchor={trash?.anchor ?? null} gulp={trash?.gulp ?? false} reduced={reduced} /> : null}
        </MotionConfig>
      </div>
      {docked && !readOnly ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(44px+env(safe-area-inset-bottom))] z-30 flex justify-center px-3 pb-2 md:bottom-0 md:pb-[max(12px,env(safe-area-inset-bottom))]">{composer}</div>
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
