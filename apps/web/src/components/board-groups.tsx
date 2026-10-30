// 分组 (groups), shared by the real board and the RHEA-191 UI demo (moved here
// from demo/groups.tsx in RHEA-190 step 5). Every clip may belong to one
// user-defined group; the board filters by group chips, can be viewed grouped
// into sections, and new clips go to the composer's target group.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { CheckIcon, ChevronDownIcon, EllipsisIcon, FolderIcon, FolderPlusIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useIsolatePointer } from '@/components/clip-media.tsx'
import { groupColor, groupName } from '@/lib/groups.ts'
import { dur, easeIn, easeOut, springBounce } from '@/lib/motion.ts'

/** filter value: null = 全部, '' = 未分组, otherwise a group name */
export type GroupFilter = string | null


export function GroupDot({ group, className = 'size-1.5' }: { group?: string; className?: string }) {
  return <span aria-hidden className={`inline-block shrink-0 rounded-full ${className}`} style={group ? { background: groupColor(group) } : { boxShadow: 'inset 0 0 0 1px var(--fg-4)' }} />
}

/** Small anchored menu, portalled to the demo root so cards can't clip it. */
function Popover({ anchor, onClose, children, label, role = 'menu', id, reduced = false }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; label: string; role?: 'menu' | 'listbox'; id?: string; reduced?: boolean }) {
  // Mounted fresh on every open, so measuring once in the initializer is enough.
  const [pos] = useState(() => {
    if (!anchor) return null
    const r = anchor.getBoundingClientRect()
    // A listbox opened from the docked composer must not live inside its transformed, overflow-hidden form.
    const host = role === 'listbox' ? document.body : ((anchor.closest('.dd, .dd-board') as HTMLElement | null) ?? document.body)
    const up = r.bottom + 200 > window.innerHeight
    return { host, x: Math.max(8, Math.min(r.left, window.innerWidth - 176)), y: up ? r.top - 6 : r.bottom + 6, up }
  })
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', onClose, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])
  if (!pos) return null
  return createPortal(
    <motion.div
      ref={ref}
      id={id}
      role={role}
      aria-label={label}
      data-keep-open
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: pos.up ? 6 : -6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: reduced ? { duration: dur.fast } : springBounce }}
      exit={{ opacity: 0, scale: reduced ? 1 : 0.97, transition: { duration: dur.fast, ease: easeIn } }}
      style={{ left: pos.x, top: pos.y, transformOrigin: pos.up ? 'bottom left' : 'top left', translateY: pos.up ? '-100%' : 0 }}
      className="dd-noselect fixed z-[60] min-w-40 rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-1)] p-1 text-[12.5px] text-[var(--fg)] shadow-[var(--elev-3)]"
    >
      {children}
    </motion.div>,
    pos.host,
  )
}

function MenuRow({ onSelect, children, current, danger }: { onSelect: () => void; children: ReactNode; current?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left hover:!bg-[var(--surface-2)] ${current ? 'font-medium' : ''} ${danger ? 'text-[var(--brand)]' : ''}`}
    >
      {children}
      {current ? <CheckIcon className="ml-auto size-3.5 text-[var(--fg-3)]" /> : null}
    </button>
  )
}

/** The group tag in a card footer; tap it to move the clip to another group. */
export function GroupBadge({ group, groups, onMove }: { group?: string; groups: string[]; onMove: (g: string | undefined) => void }) {
  const ref = useIsolatePointer<HTMLButtonElement>()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const open = anchor !== null
  return (
    <>
      <motion.button
        ref={ref}
        type="button"
        data-action
        layout="position"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={group ? `分组：${group}，点按更改` : '加入分组'}
        title={group ? '更改分组' : '加入分组'}
        onClick={(e) => setAnchor(open ? null : e.currentTarget)}
        className={`inline-flex h-5 max-w-28 items-center gap-1 rounded-full border px-1.5 text-[10.5px] leading-none ${
          group ? 'border-[var(--line-2)] text-[var(--fg-2)] hover:border-[var(--line-3)]' : 'dd-reveal border-dashed border-[var(--line-3)] text-[var(--fg-3)]'
        }`}
      >
        {group ? <GroupDot group={group} /> : <PlusIcon className="size-2.5" />}
        <span className="truncate">{group ?? '分组'}</span>
      </motion.button>
      <AnimatePresence>
        {open ? (
          <Popover anchor={anchor} label="移到分组" onClose={() => setAnchor(null)}>
            <p className="px-2 pb-1 pt-1.5 text-[10.5px] tracking-[0.06em] text-[var(--fg-3)]">移到分组</p>
            {[...groups, ''].map((g) => (
              <MenuRow
                key={g || '-'}
                current={(group ?? '') === g}
                onSelect={() => {
                  setAnchor(null)
                  if ((group ?? '') !== g) onMove(g || undefined)
                }}
              >
                <GroupDot group={g || undefined} className="size-2" />
                {groupName(g)}
              </MenuRow>
            ))}
          </Popover>
        ) : null}
      </AnimatePresence>
    </>
  )
}

type BarProps = {
  groups: string[]
  filter: GroupFilter
  counts: Map<string, number>
  total: number
  reduced: boolean
  /** a card is being dragged (desktop): chips become drop targets */
  dragging: boolean
  dropHover: string | null
  pulse: Record<string, number>
  chipRef: (key: string, el: HTMLElement | null) => void
  onFilter: (f: GroupFilter) => void
  onCreate: (name: string) => boolean
  onRename: (from: string, to: string) => boolean
  onDelete: (name: string) => void
  /** RHEA-190 m50: read-only members filter by group but cannot create, rename or delete groups. */
  readOnly?: boolean
}

/** Group filter chips: 全部 · each group · 未分组 · ＋ new; manage the active group. */
export function GroupBar(props: BarProps) {
  const { groups, filter, counts, total, reduced, dragging, dropHover, pulse, chipRef, onFilter, onCreate, onRename, onDelete, readOnly = false } = props
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const ungrouped = counts.get('') ?? 0
  const keys: Array<{ key: GroupFilter; label: string; n: number }> = [
    { key: null, label: '全部', n: total },
    ...groups.map((g) => ({ key: g, label: g, n: counts.get(g) ?? 0 })),
    ...(ungrouped > 0 || filter === '' ? [{ key: '', label: '未分组', n: ungrouped }] : []),
  ]
  const active = filter !== null && filter !== '' && groups.includes(filter) ? filter : null

  return (
    <motion.div
      layout={!reduced ? 'position' : false}
      data-dragging={dragging || undefined}
      // while a card is dragged the bar sits above it, so the ghost never hides a group's name
      className={`dd-scroll-x -mx-1 flex items-center gap-1.5 overflow-x-auto px-1 py-2 ${dragging ? 'relative z-[45]' : ''}`}
      role="toolbar"
      aria-label="分组"
    >
      <span className="flex shrink-0 items-center gap-1 pr-0.5 text-[11px] text-[var(--fg-3)]">
        <FolderIcon className="size-3.5" /> 分组
      </span>
      {keys.map(({ key, label, n }) => {
        const on = filter === key
        const target = key !== null
        const hot = dragging && target && dropHover === key
        if (renaming !== null && key === renaming) {
          return <NameInput key={`r-${key}`} initial={renaming} onDone={(v) => { if (v === null || onRename(renaming, v)) setRenaming(null) }} />
        }
        return (
          <motion.button
            key={key ?? '*'}
            ref={(el: HTMLButtonElement | null) => {
              if (target) chipRef(key, el)
            }}
            type="button"
            // RHEA-190 step 8: nothing in the bar may change layout while a card is dragged over it
            // (hit zones are measured once at drag start); the hot chip only scales about its centre.
            layout={!reduced && !dragging}
            aria-pressed={on}
            data-group-chip={key ?? '*'}
            data-drop-hot={hot || undefined}
            onClick={() => onFilter(key)}
            animate={hot && !reduced ? { scale: 1.16 } : { scale: 1 }}
            transition={springBounce}
            style={hot ? { zIndex: 50, ['--hot' as string]: groupColor(key || undefined) } : undefined}
            className={`relative flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] ${
              on && !hot ? 'text-[var(--bg)]' : hot ? 'text-[var(--fg)]' : 'text-[var(--fg-2)] hover:text-[var(--fg)]'
            } ${dragging && target && !hot ? 'outline-dashed outline-1 outline-offset-1 outline-[var(--line-3)]' : ''}`}
          >
            {hot ? (
              <motion.span
                aria-hidden
                data-drop-glow=""
                className="pointer-events-none absolute -inset-[3px] rounded-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                style={{ background: 'color-mix(in oklab, var(--hot) 22%, var(--surface-1))', boxShadow: '0 0 0 2px var(--hot), 0 8px 22px -8px var(--hot)' }}
              />
            ) : null}
            {hot ? null : on ? <motion.span layoutId="group-pill" transition={springBounce} className="absolute inset-0 rounded-full bg-[var(--fg)]" /> : <span className="absolute inset-0 rounded-full border border-[var(--line-1)] bg-[var(--surface-1)]" />}
            {key !== null ? <span className="relative"><GroupDot group={key || undefined} /></span> : null}
            <span className="relative whitespace-nowrap">{label}</span>
            <span className={`dd-mono relative ${hot ? 'invisible' : ''} min-w-[1ch] text-[10.5px] tabular-nums ${on ? 'opacity-70' : 'text-[var(--fg-4)]'}`}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={n} initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 8, opacity: 0 }} transition={{ duration: dur.base, ease: easeOut }} className="inline-block">
                  {n}
                </motion.span>
              </AnimatePresence>
            </span>
            <AnimatePresence>
              {key !== null && (pulse[key] ?? 0) > 0 && !reduced ? (
                <motion.span
                  key={pulse[key]}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full"
                  style={{ boxShadow: `0 0 0 1.5px ${groupColor(key || undefined)}` }}
                  initial={{ scale: 1, opacity: 0.9 }}
                  animate={{ scale: 1.35, opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.8, ease: easeOut }}
                />
              ) : null}
            </AnimatePresence>
          </motion.button>
        )
      })}
      <AnimatePresence initial={false} mode="popLayout">
        {readOnly ? null : adding ? (
          <NameInput key="new" onDone={(v) => { if (v === null || onCreate(v)) setAdding(false) }} />
        ) : (
          <motion.button
            key="add"
            type="button"
            layout={!reduced && !dragging}
            aria-label="新建分组"
            title="新建分组"
            onClick={() => setAdding(true)}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8, transition: { duration: dur.fast } }}
            className="grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-[var(--line-3)] text-[var(--fg-3)] hover:text-[var(--fg)]"
          >
            <FolderPlusIcon className="size-3.5" />
          </motion.button>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {active && renaming === null && !readOnly ? (
          <motion.button
            key="mgr"
            type="button"
            aria-label={`管理分组「${active}」`}
            title={`管理分组「${active}」`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => setMenu(menu ? null : e.currentTarget)}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: dur.fast } }}
            className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--fg-3)] hover:text-[var(--fg)]"
          >
            <EllipsisIcon className="size-4" />
          </motion.button>
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {menu && active ? (
          <Popover anchor={menu} label="管理分组" onClose={() => setMenu(null)}>
            <MenuRow onSelect={() => { setMenu(null); setRenaming(active) }}>
              <PencilIcon className="size-3.5" /> 重命名
            </MenuRow>
            <MenuRow danger onSelect={() => { setMenu(null); onDelete(active) }}>
              <Trash2Icon className="size-3.5" /> 删除分组（内容移到未分组）
            </MenuRow>
          </Popover>
        ) : null}
      </AnimatePresence>
    </motion.div>
  )
}

function NameInput({ initial = '', onDone }: { initial?: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial)
  return (
    <motion.input
      autoFocus
      maxLength={12}
      value={v}
      placeholder="分组名，回车"
      aria-label="分组名"
      initial={{ opacity: 0, width: 28 }}
      animate={{ opacity: 1, width: 116 }}
      exit={{ opacity: 0, width: 28, transition: { duration: dur.fast } }}
      transition={springBounce}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim() && v.trim() !== initial ? v.trim() : null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onDone(v.trim() && v.trim() !== initial ? v.trim() : null)
        }
        if (e.key === 'Escape') onDone(null)
      }}
      className="h-7 shrink-0 rounded-full border border-[var(--fg)] bg-[var(--surface-1)] px-2.5 text-[12px] text-[var(--fg)] outline-none placeholder:text-[var(--fg-4)]"
    />
  )
}

/**
 * Composer target: which group a pasted / typed clip goes to (RHEA-190 step 7).
 * A paper listbox instead of the native <select>: every option shows its group
 * colour, a highlight glides between options, the chosen one gets a check, and
 * it opens / closes with a short spring. Focus stays on the trigger
 * (aria-activedescendant) so ↑ ↓ Home End Enter Esc work like a native select.
 */
export function GroupTarget({ groups, value, onChange, compact, reduced = false }: { groups: string[]; value: string; onChange: (g: string) => void; compact?: boolean; reduced?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [active, setActive] = useState(0)
  const button = useRef<HTMLButtonElement | null>(null)
  const listId = useId()
  const open = anchor !== null
  const options = [...groups, '']
  const optionId = (i: number) => `${listId}-opt-${i}`
  const show = (el: HTMLElement) => {
    setActive(Math.max(0, options.indexOf(value)))
    setAnchor(el)
  }
  const close = (refocus: boolean) => {
    setAnchor(null)
    if (refocus) button.current?.focus()
  }
  const pick = (g: string) => {
    close(true)
    if (g !== value) onChange(g)
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        show(e.currentTarget)
      }
      return
    }
    const last = options.length - 1
    if (e.key === 'ArrowDown') setActive((i) => (i >= last ? 0 : i + 1))
    else if (e.key === 'ArrowUp') setActive((i) => (i <= 0 ? last : i - 1))
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(last)
    else if (e.key === 'Enter' || e.key === ' ') pick(options[active] ?? '')
    else if (e.key === 'Escape') close(true)
    else if (e.key === 'Tab') {
      close(false)
      return
    } else return
    e.preventDefault()
    e.stopPropagation()
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        title="发送到分组"
        aria-label="发送到分组"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        data-group-target={value || '-'}
        onClick={(e) => (open ? close(false) : show(e.currentTarget))}
        onKeyDown={onKeyDown}
        className={`relative flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] border px-2 text-[12px] transition-colors duration-(--dur-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
          open ? 'border-[var(--line-2)] bg-[var(--surface-2)] text-[var(--fg)]' : 'border-transparent text-[var(--fg-2)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]'
        } ${compact ? 'max-w-[96px]' : 'max-w-[148px]'}`}
      >
        <motion.span key={value || '-'} initial={reduced ? false : { scale: 0.4 }} animate={{ scale: 1 }} transition={springBounce} className="grid shrink-0 place-items-center">
          <GroupDot group={value || undefined} className="size-2.5" />
        </motion.span>
        <span className="truncate">{groupName(value)}</span>
        <motion.span aria-hidden animate={{ rotate: open && !reduced ? 180 : 0 }} transition={springBounce} className="grid shrink-0 place-items-center text-[var(--fg-4)]">
          <ChevronDownIcon className="size-3" />
        </motion.span>
      </button>
      <AnimatePresence>
        {open ? (
          <Popover anchor={anchor} label="发送到分组" role="listbox" id={listId} reduced={reduced} onClose={() => close(false)}>
            <p aria-hidden className="px-2 pb-1 pt-1.5 text-[10.5px] tracking-[0.06em] text-[var(--fg-3)]">发送到分组</p>
            {options.map((g, i) => {
              const selected = g === value
              return (
                <motion.div
                  key={g || '-'}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  data-group-option={g || '-'}
                  data-active={active === i || undefined}
                  onPointerEnter={() => setActive(i)}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => pick(g)}
                  initial={reduced ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0, transition: { ...springBounce, delay: reduced ? 0 : Math.min(i, 8) * 0.025 } }}
                  className={`relative flex h-8 cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 ${selected ? 'font-medium text-[var(--fg)]' : 'text-[var(--fg-2)]'}`}
                >
                  {active === i ? <motion.span layoutId={`${listId}-hl`} transition={reduced ? { duration: 0 } : springBounce} className="absolute inset-0 rounded-[var(--radius-sm)] bg-[var(--surface-2)]" /> : null}
                  <span
                    aria-hidden
                    data-group-swatch={g || '-'}
                    className="relative size-2.5 shrink-0 rounded-full"
                    style={g ? { ['--swatch' as string]: groupColor(g), background: 'var(--swatch)', boxShadow: '0 0 0 3px color-mix(in oklab, var(--swatch) 18%, transparent)' } : { boxShadow: 'inset 0 0 0 1px var(--fg-4)' }}
                  />
                  <span className="relative truncate">{groupName(g)}</span>
                  {selected ? (
                    <motion.span data-group-check initial={reduced ? false : { scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={springBounce} className="relative ml-auto grid place-items-center">
                      <CheckIcon className="size-3.5 text-[var(--fg-2)]" />
                    </motion.span>
                  ) : null}
                </motion.div>
              )
            })}
          </Popover>
        ) : null}
      </AnimatePresence>
    </>
  )
}
