/**
 * One clip on the real board, drawn with the RHEA-191 paper card
 * (RHEA-190 step 4): shared kind bodies, aging fade/curl, footer countdown,
 * actions revealed on hover / tap, pin-drag + drag-to-trash on fine pointers,
 * swipe-to-copy / swipe-to-retract on touch, fly-in on arrival.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, animate as animateValue, motion, useAnimate, useDragControls, useMotionValue, useTransform, type PanInfo } from 'motion/react'
import { CheckIcon, CopyIcon, DownloadIcon, EllipsisIcon, PencilIcon, PinIcon, PinOffIcon, Share2Icon, TagIcon, Undo2Icon } from 'lucide-react'
import { GroupBadge, GroupDot } from '@/components/board-groups.tsx'
import { DeviceGlyph } from '@/components/device-glyph.tsx'
import { deviceColor } from '@/lib/device.ts'
import { ExpandCapsule } from '@/components/expand-capsule.tsx'
import { HoldToConfirm, MediaViewer, type ViewerMedia } from '@/components/clip-media.tsx'
import { CodeLines, GridBody, RowBody, shortLeft, type ClipVisual } from '@/components/clip-visual.tsx'
import { ConfirmRetract } from '@/components/confirm-retract.tsx'
import { SharePanel } from '@/components/share-panel.tsx'
import { Button } from '@/components/ui/button.tsx'
import { MarkdownText } from '@/lib/markdown.tsx'
import { AGING_WINDOW, clipKind, codeSource, parseColor, parseLink } from '@/lib/clip-kind.ts'
import { formatBytes, formatRemain, formatWhen } from '@/lib/format.ts'
import { mediaKind } from '@/lib/media.ts'
import { dur, easeIn, easeOut, springBounce, springSettle } from '@/lib/motion.ts'
import type { TrashHandle } from '@/lib/trash-anchor.ts'
import type { Item } from '@/lib/types.ts'

export type BoardGesture = 'pin-drag' | 'swipe'
export type Arrival = 'arrived' | 'landed'
export type DragPhase = { id: string; rect: DOMRect } | { id: string; end: 'cancel' | 'deleted' }

/** Horizontal travel (px) a touch swipe needs: right copies, left opens 确认撤回. */
export const SWIPE = 72
/** where a swiped-left card rests while 确认撤回 waits behind it */
const REVEAL = 92
const touchTarget = { minWidth: 40, minHeight: 40 }
const actionClass =
  'grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] border border-[var(--line-2)] bg-[var(--surface-1)] text-[var(--fg-2)] shadow-[var(--elev-1)] transition-colors duration-(--dur-fast) hover:border-[var(--line-3)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const confirmClass =
  'inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-[var(--radius-sm)] border border-primary bg-primary px-2 text-xs font-semibold text-primary-foreground shadow-[var(--elev-1)] hover:bg-primary/85'
const capsuleIconClass =
  'inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-transparent text-fg-2 transition-colors duration-(--dur-fast) hover:bg-surface-2 hover:text-fg'
const INTERACTIVE = 'button, a, input, textarea, select, label, video, audio, form, [data-action], [role="slider"]'

const SENDER_COLOR: Record<string, string> = { 我: 'var(--dev-mac)', 访客: 'var(--dev-pad)' }
export function senderColor(label: string): string {
  return SENDER_COLOR[label] ?? 'var(--dev-phone)'
}

function textOverflows(text: string): boolean {
  const lines = text.split('\n')
  return lines.length > 6 || lines.some((line) => line.length > 42)
}

/** Plain, short, single-line text gets the demo's big display type; anything else keeps Markdown / links. */
function displayable(text: string): boolean {
  return text.length <= 80 && !text.includes('\n') && !/https?:\/\/|[*_`#>[\]|]/.test(text)
}

/** Map a real item onto the shared card visual. */
export function itemVisual(item: Item, base: string | null): ClipVisual {
  const text = item.text ?? ''
  if (item.kind === 'text') {
    const url = parseLink(text)
    if (url) {
      const site = url.hostname.replace(/^www\./, '')
      const path = `${url.pathname === '/' ? '' : url.pathname}${url.search}`
      return { id: item.id, kind: 'link', url: url.href, title: `${site}${path}`, site, href: url.href }
    }
    const color = parseColor(text)
    if (color) return { id: item.id, kind: 'color', value: color }
    if (clipKind(item) === 'code') {
      const { lang, body } = codeSource(text)
      return { id: item.id, kind: 'code', lang, code: body }
    }
    return { id: item.id, kind: 'text', text }
  }
  const name = item.filename?.trim() || (item.hasThumbnail ? '未命名图片' : '未命名文件')
  if (item.hasThumbnail && base) return { id: item.id, kind: 'image', name, src: `${base}/items/${item.id}/thumbnail`, meta: formatBytes(item.size) }
  const media = mediaKind(item)
  return { id: item.id, kind: 'file', name, size: item.size, media, src: media && base ? `${base}/items/${item.id}/media` : undefined }
}

function inside(el: HTMLElement | null, x: number, y: number, pad = 24) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
}

function preHide(node: HTMLElement, transform?: string) {
  node.style.opacity = '0'
  if (transform) node.style.transform = transform
}

export type BoardCardProps = {
  item: Item
  base: string | null
  now: number
  variant: 'grid' | 'row'
  gesture: BoardGesture
  reduced: boolean
  sender: string
  canEdit: boolean
  canRetract: boolean
  canShare: boolean
  open: boolean
  onOpen: (open: boolean) => void
  copied: boolean
  pending: boolean
  editing: boolean
  editDraft: string
  savingEdit: boolean
  onEditDraft: (value: string) => void
  onStartEdit: () => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  shareOpen: boolean
  onToggleShare: () => void
  tagOpen: boolean
  onToggleTag: () => void
  tagDraft: string
  onTagDraft: (value: string) => void
  onAddTag: () => void
  onRemoveTag: (name: string) => void
  activeTag: string | null
  onTag: (name: string) => void
  textOpen: boolean
  onToggleText: () => void
  arrival: Arrival | null
  arrivalDot: () => HTMLElement | null
  onArrived: () => void
  pinBarRef: RefObject<HTMLElement | null>
  onPinHover: (over: boolean) => void
  trashRef: RefObject<TrashHandle | null>
  onDragPhase: (phase: DragPhase) => void
  onCopy: () => void
  /** two-step 撤回 → 确认撤回 */
  onRetractClick: () => void
  /** deliberate gestures (hold, trash drop, swipe confirm) skip the second step */
  onRetractNow: () => void
  onPin: (pinned: boolean) => void
  onOpenImage: () => void
  /** RHEA-190 step 5: known groups; with onMoveGroup the footer shows a group badge */
  groups?: string[]
  onMoveGroup?: (group: string | null) => void
}

export function BoardCard(props: BoardCardProps) {
  const { item, base, now, variant, gesture, reduced, sender, canEdit, canRetract, canShare, open, onOpen, copied, pending, editing } = props
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const cardRef = useRef<HTMLDivElement | null>(null)
  const controls = useDragControls()
  const x = useMotionValue(0)
  const dragX = useMotionValue(0)
  const dragY = useMotionValue(0)
  const copyHint = useTransform(x, [0, SWIPE], [0, 1])
  const undoHint = useTransform(x, [-SWIPE, 0], [1, 0])
  const overTrash = useRef(false)
  const dragged = useRef(false)
  const armedAtStart = useRef(false)
  const [hover, setHover] = useState(false)
  const [lifted, setLifted] = useState(false)
  const liftTimer = useRef(0)
  const [viewer, setViewer] = useState<ViewerMedia | null>(null)
  const remaining = item.expiresAt - now
  const aging = remaining < AGING_WINDOW
  const ratio = Math.max(0, Math.min(1, remaining / AGING_WINDOW))
  const life = aging ? 0.15 + ratio * 0.85 : 1
  const curl = aging ? 1 - ratio : 0
  const visual = itemVisual(item, base)
  const busy = editing || props.tagOpen || props.shareOpen
  const canDrag = gesture === 'pin-drag' ? !busy && (canRetract || canShare) : !busy
  // Touch: a left swipe parks the card aside while 确认撤回 waits behind it.
  const armed = gesture === 'swipe' && pending

  useEffect(() => () => window.clearTimeout(liftTimer.current), [])
  useEffect(() => {
    if (gesture !== 'swipe') return
    const c = animateValue(x, armed ? -REVEAL : 0, springBounce)
    return () => c.stop()
  }, [armed, gesture, x])

  // Fly in from a peer's dot in the top bar, or drop from above for our own sends.
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  const arrival = props.arrival
  useLayoutEffect(() => {
    const { arrivalDot, onArrived, reduced: still } = latest.current
    const el = scope.current
    if (!el || !arrival) return
    let cancelled = false
    const finish = () => {
      if (!cancelled) onArrived()
    }
    const b = el.getBoundingClientRect()
    if (still || b.width === 0) {
      finish()
      return
    }
    if (arrival === 'arrived') {
      const dot = arrivalDot()
      const a = dot?.getBoundingClientRect()
      if (!a || a.width === 0) {
        finish()
        return
      }
      const dx = a.left + a.width / 2 - (b.left + b.width / 2)
      const dy = a.top + a.height / 2 - (b.top + b.height / 2)
      preHide(el, `translate(${dx}px, ${dy}px) scale(0.12)`)
      void animate(el, { x: [dx, 0], y: [dy, 0], scale: [0.12, 1], opacity: [0, 1], rotate: [dx > 0 ? 8 : -8, 0] }, { ...springBounce, opacity: { duration: dur.fast } }).then(finish)
    } else {
      preHide(el)
      void animate([
        [el, { y: [-120, 0], scale: [0.7, 1], opacity: [0, 1] }, { type: 'spring', stiffness: 380, damping: 20 }],
        [el, { scaleY: [1, 0.94, 1], scaleX: [1, 1.03, 1] }, { duration: dur.slow, ease: easeOut, at: '-0.15' }],
      ]).then(finish)
    }
    return () => {
      cancelled = true
    }
  }, [arrival, animate, scope])

  const isInteractive = (target: EventTarget | null) => target instanceof Element && target.closest(INTERACTIVE) !== null

  const handleDrag = (_: unknown, info: PanInfo) => {
    if (gesture !== 'pin-drag') return
    const px = info.point.x - window.scrollX
    const py = info.point.y - window.scrollY
    const trash = canRetract && (props.trashRef.current?.track(px, py) ?? false)
    if (trash !== overTrash.current) {
      overTrash.current = trash
      const el = cardRef.current
      if (el && !reduced) void animate(el, trash ? { scale: 0.62, rotate: 4, opacity: 0.86 } : { scale: 1.04, rotate: -1.5, opacity: 1 }, springBounce)
    }
    props.onPinHover(canShare && !item.pinned && !trash && inside(props.pinBarRef.current, px, py))
  }

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    window.setTimeout(() => {
      dragged.current = false
    }, 0)
    if (gesture === 'swipe') {
      if (armedAtStart.current) {
        armedAtStart.current = false
        // Swiping back right only cancels the open confirm (offset is from -REVEAL).
        if (info.offset.x >= 24) props.onOpen(false)
        animateValue(x, info.offset.x < 24 ? -REVEAL : 0, springBounce)
        if (info.offset.x >= 24 && pending) props.onRetractClick()
        return
      }
      if (info.offset.x >= SWIPE) props.onCopy()
      else if (info.offset.x <= -SWIPE && canRetract && !pending) props.onRetractClick()
      animateValue(x, info.offset.x <= -SWIPE && canRetract ? -REVEAL : 0, springBounce)
      return
    }
    const px = info.point.x - window.scrollX
    const py = info.point.y - window.scrollY
    const trash = canRetract && ((props.trashRef.current?.track(px, py) ?? false) || overTrash.current)
    overTrash.current = false
    props.onPinHover(false)
    const mouth = props.trashRef.current?.mouth()
    const el = cardRef.current
    if (trash && mouth && el) {
      props.onDragPhase({ id: item.id, end: 'deleted' })
      const r = el.getBoundingClientRect()
      const dx = mouth.x - (r.left + r.width / 2)
      const dy = mouth.y - (r.top + r.height / 2)
      if (reduced) {
        props.onRetractNow()
        return
      }
      void animate(el, { x: dragX.get() + dx, y: dragY.get() + dy, scale: 0.08, rotate: 14, opacity: 0, filter: 'blur(2px)' }, { duration: 0.28, ease: easeIn }).then(() => props.onRetractNow())
      return
    }
    props.onDragPhase({ id: item.id, end: 'cancel' })
    window.clearTimeout(liftTimer.current)
    liftTimer.current = window.setTimeout(() => setLifted(false), 600)
    const overBar = inside(props.pinBarRef.current, px, py)
    if (!canShare) return
    if (overBar && !item.pinned) props.onPin(true)
    else if (!overBar && item.pinned && Math.hypot(info.offset.x, info.offset.y) > 56) props.onPin(false)
  }

  const textBody: ReactNode = (() => {
    if (item.kind !== 'text' || visual.kind !== 'text') return undefined
    const text = item.text ?? ''
    const long = textOverflows(text)
    const expander = long ? (
      <button
        type="button"
        data-action=""
        className="mt-1 inline-flex min-h-10 min-w-10 items-center justify-center self-start rounded-md px-2 text-xs font-medium text-fg-3 hover:text-fg"
        style={touchTarget}
        aria-expanded={props.textOpen}
        onClick={props.onToggleText}
      >
        {props.textOpen ? '收起' : '展开'}
      </button>
    ) : null
    if (variant === 'row' && !props.textOpen && !long && displayable(text)) return <p className="dd-display truncate text-[15px] font-medium">{text}</p>
    if (variant === 'grid' && displayable(text)) return <p className="dd-display text-[20px] font-medium leading-[1.35] tracking-[-0.01em] break-words text-[var(--fg)]">{text}</p>
    return (
      <div className="flex min-w-0 flex-col text-[var(--fg)]">
        <MarkdownText text={text} collapsed={!props.textOpen} />
        {expander}
      </div>
    )
  })()

  const codeBody: ReactNode = (() => {
    if (visual.kind !== 'code') return undefined
    const lines = visual.code.split('\n').length
    const long = lines > 5 || textOverflows(visual.code)
    return (
      <div className="flex min-w-0 flex-col">
        {variant === 'row' && !props.textOpen ? <p className="dd-mono truncate text-[12px] text-[var(--fg-2)]">{visual.code.split('\n')[0]}</p> : <CodeLines code={visual.code} lines={props.textOpen ? Infinity : 5} />}
        {long ? (
          <button
            type="button"
            data-action=""
            className="mt-1 inline-flex min-h-10 min-w-10 items-center justify-center self-start rounded-md px-2 text-xs font-medium text-fg-3 hover:text-fg"
            style={touchTarget}
            aria-expanded={props.textOpen}
            onClick={props.onToggleText}
          >
            {props.textOpen ? '收起' : '展开'}
          </button>
        ) : null}
      </div>
    )
  })()

  const slots = {
    text: textBody,
    code: codeBody,
    openImage: props.onOpenImage,
    imageLabel: `查看 ${item.filename?.trim() || '图片'}`,
  }
  const Body = variant === 'grid' ? GridBody : RowBody
  const tags = item.tags ?? []
  const more = (canEdit && !editing) || item.kind === 'file' || canShare

  return (
    <motion.li
      id={`clip-${item.id}`}
      tabIndex={-1}
      data-clip-card=""
      data-clip-id={item.id}
      data-pinned={item.pinned ? '' : undefined}
      data-aging={aging ? '' : undefined}
      data-copied={copied ? '' : undefined}
      layout={reduced ? false : 'position'}
      transition={{ layout: item.pinned ? springBounce : springSettle }}
      className={`relative list-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${variant === 'grid' ? 'h-full' : ''}`}
      style={{ zIndex: lifted || open ? 30 : undefined }}
    >
      {gesture === 'swipe' ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-between overflow-hidden rounded-[var(--radius-md)] px-4 text-[12px] font-medium">
          <motion.span style={{ opacity: copyHint }} className="flex items-center gap-1.5 text-[var(--ok)]">
            <CopyIcon className="size-4" /> 复制
          </motion.span>
          {canRetract ? (
            <motion.span style={{ opacity: undoHint }} className="flex items-center gap-1.5 text-[var(--brand)]">
              撤回 <Undo2Icon className="size-4" />
            </motion.span>
          ) : null}
        </div>
      ) : null}
      {gesture === 'swipe' && canRetract ? <AnimatePresence>{armed ? <ConfirmRetract onConfirm={props.onRetractNow} /> : null}</AnimatePresence> : null}
      <motion.div ref={scope} className={`relative ${variant === 'grid' ? 'h-full' : ''}`}>
        <motion.div
          ref={cardRef}
          data-card=""
          data-open={open || pending || undefined}
          data-aging={aging || undefined}
          data-copied={copied || undefined}
          className={`dd-card flex flex-col outline-none ${variant === 'grid' ? 'h-full' : ''} ${canDrag && gesture === 'pin-drag' ? 'cursor-grab' : ''}`}
          style={{
            ['--life' as string]: life,
            ['--curl' as string]: curl,
            x: gesture === 'swipe' ? x : dragX,
            y: gesture === 'swipe' ? undefined : dragY,
            touchAction: gesture === 'swipe' ? 'pan-y' : undefined,
          }}
          drag={canDrag ? (gesture === 'swipe' ? 'x' : true) : false}
          dragListener={gesture === 'swipe'}
          dragControls={controls}
          dragDirectionLock={gesture === 'swipe'}
          dragSnapToOrigin={gesture !== 'swipe'}
          dragMomentum={gesture !== 'swipe'}
          dragElastic={gesture === 'swipe' ? 0.6 : 0.9}
          dragTransition={{ bounceStiffness: 420, bounceDamping: 20 }}
          whileDrag={gesture === 'swipe' ? { cursor: 'grabbing' } : { scale: 1.04, rotate: -1.5, zIndex: 40, boxShadow: 'var(--elev-3)', cursor: 'grabbing' }}
          animate={copied && !reduced ? { y: -3, boxShadow: 'var(--elev-3)' } : { y: 0, boxShadow: 'var(--elev-1)' }}
          transition={springBounce}
          onPointerDown={(event) => {
            if (gesture !== 'pin-drag' || !canDrag || event.button !== 0 || event.pointerType === 'touch' || isInteractive(event.target)) return
            controls.start(event)
          }}
          onHoverStart={() => setHover(true)}
          onHoverEnd={() => setHover(false)}
          onDragStart={() => {
            dragged.current = true
            armedAtStart.current = armed
            setHover(false)
            overTrash.current = false
            if (gesture === 'pin-drag') {
              window.clearTimeout(liftTimer.current)
              setLifted(true)
              if (cardRef.current) props.onDragPhase({ id: item.id, rect: cardRef.current.getBoundingClientRect() })
            }
          }}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
          onTap={(event) => {
            if (dragged.current || isInteractive(event.target)) return
            if (window.getSelection?.()?.toString()) return
            onOpen(!open)
          }}
        >
          <div className="dd-card-body flex-1">
            {editing && item.kind === 'text' ? (
              <form
                className="p-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  props.onSaveEdit()
                }}
              >
                <label className="sr-only" htmlFor={`edit-${item.id}`}>
                  编辑文本
                </label>
                <textarea
                  id={`edit-${item.id}`}
                  value={props.editDraft}
                  onChange={(event) => props.onEditDraft(event.target.value)}
                  className="min-h-20 w-full resize-y rounded-[var(--radius-sm)] border border-[var(--line-2)] bg-[var(--surface-0)] p-2 text-[15px] text-fg outline-none focus:border-[var(--line-3)]"
                />
                <div className="mt-2 flex gap-2">
                  <Button type="submit" size="sm" disabled={props.savingEdit}>
                    保存
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={props.onCancelEdit}>
                    取消
                  </Button>
                </div>
              </form>
            ) : (
              <Body clip={visual} viewing={viewer !== null} onView={setViewer} slots={slots} />
            )}
          </div>
          {tags.length > 0 || props.tagOpen ? (
            <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
              {tags.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="inline-flex min-h-10 min-w-10 items-center justify-center px-0.5"
                  style={touchTarget}
                  onClick={() => props.onTag(name)}
                >
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-(--dur-fast) ${props.activeTag === name ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]' : 'border-[var(--line-2)] text-[var(--fg-2)] hover:border-[var(--line-3)] hover:text-[var(--fg)]'}`}>#{name}</span>
                </button>
              ))}
            </div>
          ) : null}
          {props.tagOpen ? (
            <form
              className="flex flex-wrap items-center gap-2 px-3 pb-2"
              onSubmit={(event) => {
                event.preventDefault()
                props.onAddTag()
              }}
            >
              <label className="sr-only" htmlFor={`tag-${item.id}`}>
                新标签
              </label>
              <input
                id={`tag-${item.id}`}
                value={props.tagDraft}
                onChange={(event) => props.onTagDraft(event.target.value)}
                placeholder="输入标签后回车"
                className="rounded-[var(--radius-sm)] border border-[var(--line-2)] bg-[var(--surface-0)] px-2 py-1 text-xs text-fg outline-none focus:border-[var(--line-3)]"
              />
              <Button type="submit" size="sm">
                添加
              </Button>
              {tags.map((name) => (
                <Button key={name} type="button" variant="outline" size="sm" onClick={() => props.onRemoveTag(name)}>
                  移除 #{name}
                </Button>
              ))}
            </form>
          ) : null}
          <footer className={`flex items-center gap-2 border-t border-[var(--line-1)] py-2 pl-3 ${aging ? 'pr-6' : 'pr-3'} text-[11px] text-[var(--fg-3)]`}>
            {item.device ? (
              <span className="inline-flex min-w-0 items-center gap-1" data-source-badge="" data-device-id={item.device.id} title={`${sender} · ${item.device.name}`} style={{ color: deviceColor(item.device.kind) }}>
                <DeviceGlyph kind={item.device.kind} className="size-3.5 shrink-0" />
                <span className="max-w-[10rem] truncate text-[var(--fg-2)]">{item.device.name}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1" data-source-badge="">
                <span aria-hidden className="size-2 rounded-full" style={{ background: senderColor(sender) }} />
                <span className="text-[var(--fg-2)]">{sender}</span>
              </span>
            )}
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">{formatWhen(item.createdAt, now)}</span>
            {item.updatedAt > item.createdAt ? <span className="shrink-0">已编辑</span> : null}
            {props.onMoveGroup && props.groups ? (
              <GroupBadge group={item.group ?? undefined} groups={props.groups} onMove={(group) => props.onMoveGroup?.(group ?? null)} />
            ) : item.group ? (
              <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-[var(--fg-3)]" data-group-badge={item.group}>
                <GroupDot group={item.group} />
                <span className="max-w-[6rem] truncate">{item.group}</span>
              </span>
            ) : null}
            <span className={`dd-mono ml-auto tabular-nums ${aging ? 'text-[var(--brand)]' : ''}`} title={`剩余 ${formatRemain(remaining)}`}>
              {shortLeft(remaining)}
            </span>
          </footer>
          <div className="dd-card-actions absolute right-1.5 top-1.5 flex items-center gap-1">
            {item.kind === 'text' || item.kind === 'file' ? (
              <button type="button" data-action="" title="复制" aria-label="复制" className={`${actionClass} ${copied ? 'text-[var(--ok)]' : ''}`} style={touchTarget} onClick={props.onCopy}>
                <AnimatePresence mode="popLayout" initial={false}>
                  {copied ? (
                    <motion.span key="ok" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={springBounce} className="grid place-items-center">
                      <CheckIcon className="size-4" aria-hidden="true" />
                    </motion.span>
                  ) : (
                    <motion.span key="cp" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={{ duration: dur.fast }} className="grid place-items-center">
                      <CopyIcon className="size-4" aria-hidden="true" />
                    </motion.span>
                  )}
                </AnimatePresence>
              </button>
            ) : null}
            {canShare ? (
              <button type="button" data-action="" title="分享" aria-label="分享" aria-expanded={props.shareOpen} className={actionClass} style={touchTarget} onClick={props.onToggleShare}>
                <Share2Icon className="size-4" aria-hidden="true" />
              </button>
            ) : null}
            {canRetract ? (
              <HoldToConfirm
                label="撤回"
                name={pending ? '确认撤回' : '撤回'}
                confirm={pending}
                onTap={props.onRetractClick}
                onConfirm={props.onRetractNow}
                className={pending ? confirmClass : `${actionClass} hover:text-[var(--brand)]`}
                style={touchTarget}
              >
                <Undo2Icon className="size-4" aria-hidden="true" />
                {pending ? <span>确认</span> : null}
              </HoldToConfirm>
            ) : null}
            {more ? (
              <ExpandCapsule label="更多" icon={<EllipsisIcon className="size-4" aria-hidden="true" />} className="!border-[var(--line-2)] !bg-[var(--surface-1)] shadow-[var(--elev-1)]">
                {canEdit && !editing ? (
                  <button type="button" title="编辑" aria-label="编辑" className={capsuleIconClass} style={touchTarget} onClick={props.onStartEdit}>
                    <PencilIcon className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
                {item.kind === 'file' ? (
                  <a href={`${base}/items/${item.id}/download`} title="下载" aria-label="下载" className={capsuleIconClass} style={touchTarget}>
                    <DownloadIcon className="size-4" aria-hidden="true" />
                  </a>
                ) : null}
                {canShare ? (
                  <button type="button" title={item.pinned ? '取消置顶' : '置顶'} aria-label={item.pinned ? '取消置顶' : '置顶'} className={capsuleIconClass} style={touchTarget} onClick={() => props.onPin(!item.pinned)}>
                    {item.pinned ? <PinOffIcon className="size-4" aria-hidden="true" /> : <PinIcon className="size-4" aria-hidden="true" />}
                  </button>
                ) : null}
                {canShare ? (
                  <button type="button" title="标签" aria-label="标签" className={capsuleIconClass} style={touchTarget} onClick={props.onToggleTag}>
                    <TagIcon className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
              </ExpandCapsule>
            ) : null}
          </div>
        </motion.div>
        <AnimatePresence>
          {hover && gesture === 'pin-drag' && !lifted ? (
            <motion.div
              role="tooltip"
              initial={{ opacity: 0, y: 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: dur.fast, ease: easeOut } }}
              exit={{ opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
              className="dd-mono pointer-events-none absolute -top-2 left-3 z-30 -translate-y-full whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--fg)] px-2 py-1 text-[11px] text-[var(--bg)] shadow-[var(--elev-2)]"
            >
              还剩 {formatRemain(remaining)} · {new Date(item.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 过期
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
      {props.shareOpen && base ? <SharePanel base={base} itemId={item.id} now={now} onClose={props.onToggleShare} /> : null}
      <MediaViewer media={viewer} anchor={scope} reduced={reduced} onClose={() => setViewer(null)} />
    </motion.li>
  )
}
