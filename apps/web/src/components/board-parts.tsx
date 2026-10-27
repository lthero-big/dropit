/**
 * Board pieces lifted from the RHEA-191 demo for the real board (RHEA-190 step 5):
 * the segmented view switch, pin chips, named presence dots, grouped sections,
 * the empty-group note, and the phone-width docked composer hooks.
 */
import { useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, type PanInfo } from 'motion/react'
import { CheckIcon, ChevronDownIcon, CopyIcon, PinOffIcon } from 'lucide-react'
import { DeviceDot } from '@/components/board-chrome.tsx'
import { GroupDot, type GroupFilter } from '@/components/board-groups.tsx'
import { DeviceGlyph } from '@/components/device-glyph.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import type { PresenceDot } from '@/lib/board-hooks.ts'
import { deviceColor } from '@/lib/device.ts'
import { useIsolatePointer } from '@/components/clip-media.tsx'
import type { ClipVisual } from '@/components/clip-visual.tsx'
import { groupColor, groupName } from '@/lib/groups.ts'
import { dur, easeIn, springBounce, springSettle, springTether } from '@/lib/motion.ts'
import type { Item } from '@/lib/types.ts'

const touchTarget = { minWidth: 40, minHeight: 40 }

/* ------------------------------------------------------------ segmented */

/**
 * The demo's segmented view switch. Buttons keep a 40px hit target (aria-pressed
 * for the existing layout tests) while the visible pill stays 28px like the demo.
 */
export function Segmented<T extends string>(props: { id: string; label: string; value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string; icon: ReactNode }> }) {
  const { id, label, value, onChange, options } = props
  return (
    <div role="group" aria-label={label} className="dd-scroll-x relative flex max-w-full overflow-x-auto rounded-[var(--radius-md)] border border-[var(--line-1)] bg-[var(--surface-2)] p-0.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            aria-label={o.label}
            title={o.label}
            onClick={() => onChange(o.value)}
            style={touchTarget}
            className={`relative -my-1.5 flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-[12px] sm:px-2.5 transition-colors duration-(--dur-fast) ${active ? 'text-[var(--fg)]' : 'text-[var(--fg-3)] hover:text-[var(--fg-2)]'}`}
          >
            {active ? (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-x-0 inset-y-1.5 rounded-[var(--radius-sm)] border border-[var(--line-2)] bg-[var(--surface-1)] shadow-[var(--elev-1)]"
                transition={springBounce}
              />
            ) : null}
            <span className="relative flex items-center gap-1.5" aria-hidden="true">
              {o.icon}
              {o.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------- presence */

const DOT_COLORS = ['var(--dev-mac)', 'var(--dev-phone)', 'var(--dev-pad)', 'var(--dev-pc)']

export function PresencePill(props: {
  count: number
  dots: PresenceDot[]
  live: boolean
  reduced: boolean
  ripples: Record<string, number>
  dotRef: (key: string, el: HTMLElement | null) => void
  /** RHEA-190 r4: where 登录设备 lives (spaces only; rooms have no accounts). */
  manageHref?: string
}) {
  const { count, dots, live, reduced, ripples, dotRef, manageHref } = props
  const label = `${count} 台设备在线`
  const body = (
    <>
      <span className="flex items-center" aria-hidden="true">
        {dots.map((dot, index) => {
          const color = dot.kind ? deviceColor(dot.kind) : DOT_COLORS[index % DOT_COLORS.length]
          return (
            <DeviceDot
              key={dot.key}
              color={color}
              online={live && dot.online}
              title={`${dot.name}${dot.self ? '（本设备）' : ''}${dot.online && live ? ' · 在线' : ' · 离线'}`}
              ripple={reduced ? 0 : (ripples[dot.key] ?? 0)}
              dotRef={(el) => dotRef(dot.key, el)}
              label={
                dot.kind ? (
                  <>
                    <DeviceGlyph kind={dot.kind} className="size-3" /> {dot.name}
                    {dot.self ? '（本设备）' : ''}
                  </>
                ) : undefined
              }
            />
          )
        })}
      </span>
      <span className="ml-0.5 hidden whitespace-nowrap text-[11px] text-[var(--fg-3)] tabular-nums sm:inline">
        {count}
        <span className="hidden sm:inline"> 台在线</span>
      </span>
    </>
  )
  const online = dots.filter((dot) => live && dot.online)
  const offline = dots.filter((dot) => !(live && dot.online))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex min-h-8 items-center rounded-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          aria-label={`${label}，查看设备`}
          aria-haspopup="menu"
          data-presence-trigger=""
        >
          <span
            className="inline-flex min-h-8 items-center gap-0.5 rounded-full py-0.5 pl-1 text-xs font-medium text-fg-2 sm:border sm:border-[var(--line-1)] sm:bg-[var(--surface-1)] sm:pr-2.5"
            role="status"
            title={label}
            aria-label={label}
            data-presence=""
          >
            {body}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-0" data-presence-list="">
        <DropdownMenuLabel className="px-3 pt-3 pb-1 text-[11px] font-medium text-muted-foreground normal-case">
          {live ? `在线设备 · ${count}` : '离线 · 正在重新连接'}
        </DropdownMenuLabel>
        {[
          { key: 'online', title: null, rows: online },
          { key: 'offline', title: online.length ? '最近使用 · 离线' : null, rows: offline },
        ].filter((group) => group.rows.length).map((group) => (
          <ul key={group.key} className="px-1 pb-1" aria-label={group.key === 'online' ? '在线设备' : '离线设备'} data-presence-group={group.key}>
            {group.title ? <li className="px-2 pt-1 pb-0.5 text-[11px] text-muted-foreground" aria-hidden="true">{group.title}</li> : null}
            {group.rows.map((dot) => {
              const on = live && dot.online
              return (
                <li key={dot.key} className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm" data-presence-row={dot.key}>
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: on ? (dot.kind ? deviceColor(dot.kind) : 'var(--primary)') : 'transparent', boxShadow: on ? undefined : 'inset 0 0 0 1.5px var(--line-3)' }}
                  />
                  {dot.kind ? <DeviceGlyph kind={dot.kind} className="size-3.5 shrink-0 text-fg-2" /> : null}
                  <span className="min-w-0 flex-1 truncate">
                    {dot.name}
                    {dot.self ? <span className="text-muted-foreground">（本设备）</span> : null}
                  </span>
                  <span className={`text-[11px] ${on ? 'text-primary' : 'text-muted-foreground'}`}>{on ? '在线' : '离线'}</span>
                </li>
              )
            })}
          </ul>
          ))}
        {manageHref ? (
          <>
            <DropdownMenuSeparator className="my-0" />
            <a href={manageHref} className="flex min-h-10 items-center justify-between px-3 text-xs font-medium no-underline hover:bg-surface-2" data-presence-manage="">
              管理登录设备（可单独登出）
              <span aria-hidden="true">→</span>
            </a>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ------------------------------------------------------------- pin chip */

function ChipAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  const ref = useIsolatePointer<HTMLButtonElement>()
  return (
    <button
      ref={ref}
      type="button"
      data-action=""
      aria-label={label}
      title={label}
      onClick={onClick}
      style={touchTarget}
      className="-my-1.5 grid size-7 place-items-center rounded-[var(--radius-sm)] text-[var(--fg-3)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
    >
      {children}
    </button>
  )
}

function ChipPreview({ visual }: { visual: ClipVisual }) {
  switch (visual.kind) {
    case 'color':
      return (
        <>
          <span className="size-3.5 shrink-0 rounded-[3px] ring-1 ring-black/10" style={{ background: visual.value }} />
          <span className="dd-mono">{visual.value}</span>
        </>
      )
    case 'code':
      return <span className="dd-mono max-w-48 truncate text-[11.5px] text-[var(--fg-2)]">{visual.code.split('\n')[0]}</span>
    case 'link':
      return <span className="max-w-56 truncate">{visual.title}</span>
    case 'image':
      return (
        <>
          <img src={visual.src} alt="" className="size-5 shrink-0 rounded-[3px] object-cover" />
          <span className="max-w-40 truncate">{visual.name}</span>
        </>
      )
    case 'file':
      return <span className="max-w-48 truncate">{visual.name}</span>
    default:
      return <span className="max-w-48 truncate">{visual.text.split('\n')[0]}</span>
  }
}

/** A pinned clip as a chip in the 置顶栏: tap for actions, drag it down off the bar to unpin. */
export function PinChip(props: {
  item: Item
  visual: ClipVisual
  reduced: boolean
  open: boolean
  copied: boolean
  canLabel: boolean
  onOpen: (open: boolean) => void
  onCopy: () => void
  onUnpin: () => void
}) {
  const { item, visual, reduced, open, copied, canLabel } = props
  const [pull, setPull] = useState(0)
  const dragged = useRef(false)
  const threshold = 56
  const device = item.device
  const onDrag = (_: unknown, info: PanInfo) => setPull(Math.min(1, Math.hypot(info.offset.x, info.offset.y) / threshold))
  const onDragEnd = (_: unknown, info: PanInfo) => {
    window.setTimeout(() => {
      dragged.current = false
    }, 0)
    setPull(0)
    if (canLabel && Math.abs(info.offset.y) > threshold) props.onUnpin()
  }
  const toggle = () => props.onOpen(!open)
  return (
    <motion.div
      layout={!reduced}
      layoutId={reduced ? undefined : `pin-${item.id}`}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8, transition: { duration: dur.fast, ease: easeIn } }}
      transition={{ ...springBounce, layout: springBounce }}
      drag={!reduced && canLabel}
      dragSnapToOrigin
      dragElastic={0.45}
      dragTransition={{ bounceStiffness: (springTether as { stiffness: number }).stiffness, bounceDamping: (springTether as { damping: number }).damping }}
      whileDrag={{ scale: 1.05, zIndex: 30, cursor: 'grabbing' }}
      onDragStart={() => {
        dragged.current = true
      }}
      onDrag={onDrag}
      onDragEnd={onDragEnd}
      onClick={(event) => {
        if (dragged.current || (event.target as HTMLElement | null)?.closest('[data-action]')) return
        toggle()
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggle()
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      id={`clip-${item.id}`}
      data-clip-id={item.id}
      data-pin-chip=""
      data-open={open || undefined}
      title={canLabel ? '点按显示操作；向下拖离取消置顶' : '点按显示操作'}
      className={`relative flex min-h-9 shrink-0 select-none items-center gap-2 rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-1)] py-1 pl-2.5 pr-1 text-[12.5px] text-[var(--fg)] shadow-[var(--elev-1)] ${canLabel && !reduced ? 'cursor-grab touch-none' : 'cursor-pointer'}`}
      style={{ borderColor: pull > 0.98 ? 'var(--brand)' : open ? 'var(--line-3)' : undefined }}
    >
      <span className="size-1.5 shrink-0 rounded-full" title={device?.name} style={{ background: device ? deviceColor(device.kind) : 'var(--fg-4)' }} />
      <ChipPreview visual={visual} />
      <AnimatePresence initial={false}>
        {open ? (
          <motion.span
            key="acts"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 'auto', opacity: 1 }}
            exit={{ width: 0, opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
            transition={springBounce}
            className="flex items-center gap-0.5 overflow-hidden"
          >
            {item.kind === 'text' || item.kind === 'file' ? (
              <ChipAction label={copied ? '已复制' : '复制'} onClick={props.onCopy}>
                {copied ? <CheckIcon className="size-3.5 text-[var(--ok)]" /> : <CopyIcon className="size-3.5" />}
              </ChipAction>
            ) : null}
            {canLabel ? (
              <ChipAction label="取消置顶" onClick={props.onUnpin}>
                <PinOffIcon className="size-3.5" />
              </ChipAction>
            ) : null}
          </motion.span>
        ) : (
          <motion.span key="pad" className="w-1.5" />
        )}
      </AnimatePresence>
      {pull > 0 ? (
        <span className="dd-mono absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-[var(--brand)]" style={{ opacity: pull }}>
          {pull > 0.98 ? '松手取消置顶' : '继续拖…'}
        </span>
      ) : null}
    </motion.div>
  )
}

/* ------------------------------------------------------ grouped sections */

/** 按分组: one collapsible section per group (plus 未分组), cards in a grid. */
export function GroupedSections(props: { items: Item[]; groups: string[]; filter: GroupFilter; reduced: boolean; card: (item: Item) => ReactNode }) {
  const { items, groups, filter, reduced, card } = props
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const keys = filter !== null ? [filter] : [...groups, '']
  return (
    <div className="flex flex-col gap-3" data-layout="group">
      {keys.map((key) => {
        const list = items.filter((item) => (item.group ?? '') === key)
        if (key === '' && list.length === 0 && filter === null) return null
        const isFolded = folded[key] ?? false
        return (
          <motion.section
            key={`g-${key}`}
            layout={!reduced}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-[var(--radius-lg)] border border-[var(--line-1)] bg-[color-mix(in_oklab,var(--surface-1)_45%,transparent)]"
            style={{ borderLeft: `3px solid ${key ? groupColor(key) : 'var(--line-2)'}` }}
            data-group-section={key || '-'}
            aria-label={groupName(key)}
          >
            <button
              type="button"
              aria-expanded={!isFolded}
              onClick={() => setFolded((f) => ({ ...f, [key]: !isFolded }))}
              className="flex min-h-10 w-full items-center gap-2 px-3 py-2.5 text-left"
            >
              <motion.span animate={{ rotate: isFolded ? -90 : 0 }} transition={springBounce} className="text-[var(--fg-3)]">
                <ChevronDownIcon className="size-3.5" aria-hidden="true" />
              </motion.span>
              <GroupDot group={key || undefined} className="size-2" />
              <span className="dd-display text-[13px] font-semibold text-[var(--fg)]">{groupName(key)}</span>
              <span className="dd-mono text-[11px] text-[var(--fg-3)]">{list.length}</span>
            </button>
            <AnimatePresence initial={false}>
              {!isFolded ? (
                <motion.div
                  key="body"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1, transition: { ...springSettle, opacity: { duration: dur.base } } }}
                  exit={{ height: 0, opacity: 0, transition: { duration: dur.base, ease: easeIn } }}
                  className="overflow-hidden"
                >
                  {list.length ? (
                    <ul className="clip-board grid grid-cols-1 items-start gap-3 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-3">{list.map((item) => card(item))}</ul>
                  ) : (
                    <p className="m-0 px-3 pb-3 text-[12px] text-[var(--fg-4)]">还没有内容 · 在卡片上点分组标签，或发送时选这个分组</p>
                  )}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.section>
        )
      })}
    </div>
  )
}

export function GroupEmpty({ group, onAll }: { group: string; onAll: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[var(--line-2)] px-6 py-12 text-center"
    >
      <GroupDot group={group || undefined} className="size-3" />
      <p className="m-0 text-[13px] text-[var(--fg-3)]">「{groupName(group)}」里还没有内容。发送时选这个分组，或在卡片上点分组标签移进来。</p>
      <button type="button" className="dd-chip" style={touchTarget} onClick={onAll}>
        看全部
      </button>
    </motion.div>
  )
}
