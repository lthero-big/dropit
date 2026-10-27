import './demo.css'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useMotionValue, useReducedMotion, useSpring, type PanInfo } from 'motion/react'
import {
  ArrowUpIcon,
  CalendarDaysIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FolderIcon,
  ClipboardPasteIcon,
  LayoutGridIcon,
  MoonIcon,
  PaperclipIcon,
  PinIcon,
  PinOffIcon,
  RotateCcwIcon,
  SparklesIcon,
  SunIcon,
  TabletSmartphoneIcon,
  TurtleIcon,
  UploadIcon,
} from 'lucide-react'
import { ClipCard, type GestureMode } from './clip-card.tsx'
import { TrashBin } from './trash-bin.tsx'
import { useIsolatePointer } from './media.tsx'
import { trashAnchorFor, type TrashAnchor, type TrashHandle } from './trash-anchor.ts'
import { clipCopyText, dayLabel, deviceById, devices, droppedFile, nextIncoming, pastedShot, seedClips, seedGroups, textClip, type Clip } from './data.ts'
import { GroupBar, GroupDot, GroupTarget, type GroupFilter } from './groups.tsx'
import { DeviceGlyph } from './icons.tsx'
import { deviceColor, groupColor, groupName, labelFor } from './visuals.ts'
import { dur, easeIn, easeOut, enter, springBounce, springSettle, springTether } from '../lib/motion.ts'

type Mode = 'light' | 'dark'
type View = 'grid' | 'group' | 'date' | 'device'

type Toast = { id: number; text: string; undo?: () => void }

function readParam<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === 'undefined') return fallback
  const v = new URLSearchParams(window.location.search).get(key)
  return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback
}

function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

function useGestureMode(): GestureMode {
  const query = '(pointer: coarse), (max-width: 640px)'
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setCoarse(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return coarse ? 'swipe' : 'pin-drag'
}

/** Phone-width layout: the composer docks to the bottom edge instead of sitting above the board. */
function useDockedComposer() {
  const query = '(max-width: 640px)'
  const [docked, setDocked] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setDocked(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return docked
}

/**
 * Scroll-aware collapse for the docked composer: shrinks to a pill while the
 * reader scrolls down through the board, comes back on scroll up, at the end
 * of the page, or when tapped. Never collapses while focused or holding a draft.
 */
function useScrollCollapse(enabled: boolean, hold: boolean) {
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setCollapsed(false)
      return
    }
    let last = window.scrollY
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const y = window.scrollY
        const delta = y - last
        const atEnd = window.innerHeight + y >= document.documentElement.scrollHeight - 8
        if (y < 48 || atEnd) setCollapsed(false)
        else if (delta > 6) setCollapsed(true)
        else if (delta < -10) setCollapsed(false)
        if (Math.abs(delta) > 6) last = y
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
    }
  }, [enabled])
  return [collapsed && enabled && !hold, setCollapsed] as const
}

export function UiDemoPage() {
  const [mode, setMode] = useState<Mode>(() =>
    readParam('mode', ['light', 'dark'] as const, typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  )
  const [view, setView] = useState<View>(() => readParam('view', ['grid', 'group', 'date', 'device'] as const, 'grid'))
  const [simReduced, setSimReduced] = useState(() => readParam('reduced', ['1', '0'] as const, '0') === '1')
  const systemReduced = useReducedMotion() ?? false
  const reduced = simReduced || systemReduced
  const gesture = useGestureMode()
  const docked = useDockedComposer()
  const now = useNow()

  const [clips, setClips] = useState<Clip[]>(() => (readParam('empty', ['1', '0'] as const, '0') === '1' ? [] : seedClips(Date.now())))
  const [loading, setLoading] = useState(() => readParam('skeleton', ['1', '0', 'hold'] as const, '1') !== '0')
  const holdSkeleton = readParam('skeleton', ['1', '0', 'hold'] as const, '1') === 'hold'
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [pinHover, setPinHover] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [ripples, setRipples] = useState<Record<string, number>>({})
  const pinBarRef = useRef<HTMLElement | null>(null)
  // PC drag-to-delete: the bin parks next to whichever card is being dragged.
  const trashRef = useRef<TrashHandle | null>(null)
  const [trash, setTrash] = useState<{ anchor: TrashAnchor; gulp: boolean } | null>(null)
  const gulpTimer = useRef(0)
  const [dragging, setDragging] = useState(false)
  const onDragPhase = useCallback((phase: { clip: Clip; rect: DOMRect } | { clip: Clip; end: 'cancel' | 'deleted' }) => {
    window.clearTimeout(gulpTimer.current)
    setDragging('rect' in phase)
    if ('rect' in phase) return setTrash({ anchor: trashAnchorFor(phase.rect), gulp: false })
    if (phase.end === 'cancel') return setTrash(null)
    setTrash((t) => (t ? { ...t, gulp: true } : t))
    gulpTimer.current = window.setTimeout(() => setTrash(null), 560)
  }, [])
  const dotRefs = useRef(new Map<string, HTMLElement>())

  useEffect(() => {
    document.title = 'dropit · UI demo'
    if (!loading || holdSkeleton) return
    const t = window.setTimeout(() => setLoading(false), 1100)
    return () => window.clearTimeout(t)
  }, [loading, holdSkeleton])

  // 分组: user-defined groups, a filter over the board, and the composer's target.
  const [groups, setGroups] = useState<string[]>(() => [...seedGroups])
  const [filter, setFilterRaw] = useState<GroupFilter>(null)
  const [target, setTarget] = useState<string>(seedGroups[0])
  const setFilter = useCallback((f: GroupFilter) => {
    setFilterRaw(f)
    // New clips follow the group you're looking at.
    if (f !== null) setTarget(f)
  }, [])
  const [groupHover, setGroupHover] = useState<string | null>(null)
  const [groupPulse, setGroupPulse] = useState<Record<string, number>>({})
  const chipEls = useRef(new Map<string, HTMLElement>())
  const pulseGroup = useCallback((g: string | undefined) => setGroupPulse((p) => ({ ...p, [g ?? '']: (p[g ?? ''] ?? 0) + 1 })), [])

  // Tap-to-reveal: one card at a time shows 置顶 / 撤回 / 复制.
  const [openId, setOpenId] = useState<string | null>(null)
  const onOpen = useCallback((c: Clip | null) => setOpenId(c ? c.id : null), [])
  useEffect(() => {
    if (!openId) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest(`[data-clip-id="${openId}"], [data-keep-open]`)) return
      setOpenId(null)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenId(null)
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [openId])

  const live = useMemo(() => clips.filter((c) => c.expiresAt > now), [clips, now])
  const pinned = live.filter((c) => c.pinned)
  const unpinned = live.filter((c) => !c.pinned)
  const board = filter === null ? unpinned : unpinned.filter((c) => (c.group ?? '') === filter)
  const groupCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of unpinned) m.set(c.group ?? '', (m.get(c.group ?? '') ?? 0) + 1)
    return m
  }, [unpinned])

  const showToast = useCallback((text: string, undo?: () => void) => {
    setToast({ id: Date.now(), text, undo })
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), toast.undo ? 4200 : 1800)
    return () => window.clearTimeout(t)
  }, [toast])

  const copy = useCallback(
    (clip: Clip) => {
      void navigator.clipboard?.writeText(clipCopyText(clip)).catch(() => undefined)
      setCopiedId(clip.id)
      window.setTimeout(() => setCopiedId((id) => (id === clip.id ? null : id)), 1400)
      // Let the 已复制 check register, then fold the actions away again.
      window.setTimeout(() => setOpenId((id) => (id === clip.id ? null : id)), 900)
      showToast(`已复制 · ${labelFor(clip)}`)
    },
    [showToast],
  )

  const retract = useCallback(
    (clip: Clip) => {
      let index = -1
      setClips((list) => {
        index = list.findIndex((c) => c.id === clip.id)
        return list.filter((c) => c.id !== clip.id)
      })
      showToast(`已撤回 · ${labelFor(clip)}`, () => {
        setClips((list) => {
          const next = [...list]
          next.splice(Math.max(0, index), 0, { ...clip, arrived: false, landed: false })
          return next
        })
      })
    },
    [showToast],
  )

  const setPinned = useCallback((clip: Clip, value: boolean) => {
    setClips((list) => list.map((c) => (c.id === clip.id ? { ...c, pinned: value } : c)))
  }, [])

  const arrivedDone = useCallback((clip: Clip) => {
    setClips((list) => list.map((c) => (c.id === clip.id ? { ...c, arrived: false, landed: false } : c)))
  }, [])

  const moveToGroup = useCallback(
    (clip: Clip, group: string | undefined) => {
      if ((clip.group ?? '') === (group ?? '')) return
      const before = clip.group
      setClips((list) => list.map((c) => (c.id === clip.id ? { ...c, group } : c)))
      pulseGroup(group)
      showToast(group ? `已移到「${group}」` : '已移出分组', () => setClips((list) => list.map((c) => (c.id === clip.id ? { ...c, group: before } : c))))
    },
    [pulseGroup, showToast],
  )

  // Desktop: drop a dragged card on a group chip to file it there.
  const onGroupDrag = useCallback(
    (clip: Clip, x: number, y: number, drop: boolean) => {
      let hit: string | null = null
      for (const [key, el] of chipEls.current) {
        const r = el.getBoundingClientRect()
        if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 6 && y <= r.bottom + 6) hit = key
      }
      setGroupHover(drop ? null : hit)
      if (drop && hit !== null) moveToGroup(clip, hit || undefined)
      return hit
    },
    [moveToGroup],
  )

  const createGroup = useCallback(
    (name: string) => {
      if (groups.includes(name) || name === '未分组') {
        showToast(`已有「${name}」`)
        return false
      }
      setGroups((g) => [...g, name])
      setFilter(name)
      showToast(`已新建分组「${name}」`)
      return true
    },
    [groups, setFilter, showToast],
  )
  const renameGroup = useCallback(
    (from: string, to: string) => {
      if (groups.includes(to) || to === '未分组') {
        showToast(`已有「${to}」`)
        return false
      }
      setGroups((g) => g.map((x) => (x === from ? to : x)))
      setClips((list) => list.map((c) => (c.group === from ? { ...c, group: to } : c)))
      setFilterRaw((f) => (f === from ? to : f))
      setTarget((t) => (t === from ? to : t))
      return true
    },
    [groups, showToast],
  )
  const deleteGroup = useCallback(
    (name: string) => {
      const prevGroups = groups
      let moved: string[] = []
      setClips((list) => {
        moved = list.filter((c) => c.group === name).map((c) => c.id)
        return list.map((c) => (c.group === name ? { ...c, group: undefined } : c))
      })
      setGroups((g) => g.filter((x) => x !== name))
      setFilterRaw((f) => (f === name ? null : f))
      setTarget((t) => (t === name ? '' : t))
      showToast(`已删除「${name}」，内容移到未分组`, () => {
        setGroups(prevGroups)
        setClips((list) => list.map((c) => (moved.includes(c.id) ? { ...c, group: name } : c)))
        setFilterRaw(name)
      })
    },
    [groups, showToast],
  )

  const add = useCallback((clip: Clip) => setClips((list) => [clip, ...list]), [])
  // Composer / paste: the clip goes to the composer's target group.
  const addToTarget = useCallback(
    (clip: Clip) => {
      const g = target || undefined
      add({ ...clip, group: g })
      if (filter !== null && filter !== (g ?? '')) pulseGroup(g)
    },
    [add, filter, pulseGroup, target],
  )
  const simulateArrival = useCallback(() => {
    const clip = nextIncoming(Date.now())
    // Ripple the source device's dot the moment the item leaves it.
    setRipples((r) => ({ ...r, [clip.deviceId]: (r[clip.deviceId] ?? 0) + 1 }))
    // Arriving into a group that's filtered out: no flight, just pulse its chip.
    if (filter !== null && filter !== (clip.group ?? '')) {
      pulseGroup(clip.group)
      add({ ...clip, arrived: false })
      showToast(`新内容进了「${groupName(clip.group)}」`)
      return
    }
    add(clip)
  }, [add, filter, pulseGroup, showToast])
  const simulatePaste = useCallback(() => addToTarget(pastedShot(Date.now())), [addToTarget])

  const deviceDot = useCallback((id: string) => dotRefs.current.get(id) ?? null, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('textarea, input')) return
      if (e.key === 'n') simulateArrival()
      if (e.key === 'm') setMode((m) => (m === 'light' ? 'dark' : 'light'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [simulateArrival])

  return (
    <MotionConfig reducedMotion={simReduced ? 'always' : 'user'} transition={enter}>
      <div className="dd min-h-dvh overflow-x-clip" data-mode={mode} data-reduced={reduced || undefined} data-gesture={gesture}>
        <TopBar
          mode={mode}
          reduced={reduced}
          simReduced={simReduced}
          ripples={ripples}
          dotRef={(id, el) => {
            if (el) dotRefs.current.set(id, el)
            else dotRefs.current.delete(id)
          }}
          onMode={setMode}
          onReduced={() => setSimReduced((v) => !v)}
        />
        <main className={`mx-auto flex max-w-[1120px] flex-col gap-4 px-4 pt-5 sm:px-6 ${docked ? 'pb-[calc(112px+env(safe-area-inset-bottom))]' : 'pb-10'}`}>
          {docked ? null : <Composer reduced={reduced} docked={false} onAdd={addToTarget} onPasteShot={simulatePaste} groups={groups} target={target} onTarget={setTarget} />}
          <LayoutGroup>
            <PinBar
              barRef={pinBarRef}
              pinned={pinned}
              hover={pinHover}
              reduced={reduced}
              onUnpin={(c) => setPinned(c, false)}
              onCopy={copy}
              openId={openId}
              onOpen={onOpen}
              copiedId={copiedId}
            />
            <GroupBar
              groups={groups}
              filter={filter}
              counts={groupCounts}
              total={unpinned.length}
              reduced={reduced}
              dragging={dragging && gesture === 'pin-drag'}
              dropHover={groupHover}
              pulse={groupPulse}
              chipRef={(key, el) => {
                if (el) chipEls.current.set(key, el)
                else chipEls.current.delete(key)
              }}
              onFilter={setFilter}
              onCreate={createGroup}
              onRename={renameGroup}
              onDelete={deleteGroup}
            />
            <Toolbar
              view={view}
              onView={setView}
              count={board.length}
              onArrive={simulateArrival}
              onPaste={simulatePaste}
              onSkeleton={() => setLoading(true)}
              onEmpty={() => setClips([])}
              onReset={() => {
                setClips(seedClips(Date.now()))
                setGroups([...seedGroups])
                setFilterRaw(null)
              }}
            />
            {loading ? (
              <Skeletons view={view} />
            ) : unpinned.length === 0 && pinned.length === 0 ? (
              <EmptyState onReset={() => setClips(seedClips(Date.now()))} onArrive={simulateArrival} />
            ) : board.length === 0 && view !== 'group' ? (
              <GroupEmpty group={filter ?? ''} onAll={() => setFilter(null)} />
            ) : (
              <Board
                view={view}
                clips={board}
                now={now}
                gesture={gesture}
                reduced={reduced}
                copiedId={copiedId}
                pinBarRef={pinBarRef}
                deviceDot={deviceDot}
                onCopy={copy}
                onRetract={retract}
                onPin={(c) => setPinned(c, true)}
                onPinHover={setPinHover}
                onArrived={arrivedDone}
                trashRef={trashRef}
                onDragPhase={onDragPhase}
                openId={openId}
                onOpen={onOpen}
                groups={groups}
                filter={filter}
                onMoveGroup={moveToGroup}
                onGroupDrag={gesture === 'pin-drag' ? onGroupDrag : undefined}
              />
            )}
          </LayoutGroup>
        </main>
        {docked ? <Composer reduced={reduced} docked onAdd={addToTarget} onPasteShot={simulatePaste} groups={groups} target={target} onTarget={setTarget} /> : null}
        {gesture === 'pin-drag' ? <TrashBin handle={trashRef} anchor={trash?.anchor ?? null} gulp={trash?.gulp ?? false} reduced={reduced} /> : null}
        <ToastHost toast={toast} docked={docked} onClose={() => setToast(null)} />
        <p className="mx-auto hidden max-w-[1120px] px-4 pb-8 text-[11px] text-[var(--fg-4)] sm:block sm:px-6">
          快捷键：N 模拟新内容 · D 切换风格 · M 切换明暗 · {gesture === 'swipe' ? '点卡片显示操作 · 右滑复制 / 左滑再点确认撤回' : '点卡片显示操作（悬停也会显示）· 拖到置顶栏或分组标签 · 拖到旁边的垃圾桶或长按 ↶ 撤回'}
        </p>
      </div>
    </MotionConfig>
  )
}

/* ---------------------------------------------------------------- top bar */

function TopBar(props: {
  mode: Mode
  reduced: boolean
  simReduced: boolean
  ripples: Record<string, number>
  dotRef: (id: string, el: HTMLElement | null) => void
  onMode: (m: Mode) => void
  onReduced: () => void
}) {
  const { mode, reduced, simReduced, ripples, dotRef, onMode, onReduced } = props
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--line-1)] bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1120px] items-center gap-2 px-3 sm:gap-3 sm:px-6">
        <a href="/demo/ui" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-[var(--fg)] no-underline">
          <span className="relative grid size-6 place-items-center rounded-[var(--radius-sm)] bg-[var(--fg)] text-[var(--bg)]">
            <span className="dd-display text-[13px] leading-none">d</span>
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-[var(--accent)] ring-2 ring-[var(--bg)]" />
          </span>
          <span className="dd-display">dropit</span>
          <span className="dd-mono hidden rounded-[var(--radius-xs)] border border-[var(--line-2)] px-1.5 sm:inline py-px text-[10px] font-normal uppercase tracking-[0.08em] text-[var(--fg-3)]">demo</span>
        </a>

        <div className="ml-2 hidden items-center gap-1 rounded-full border border-[var(--line-1)] bg-[var(--surface-1)] px-2 py-1 sm:flex" aria-label="在线设备">
          {devices.map((d) => (
            <DeviceDot key={d.id} id={d.id} ripple={reduced ? 0 : (ripples[d.id] ?? 0)} dotRef={dotRef} />
          ))}
          <span className="ml-1 text-[11px] text-[var(--fg-3)]">{devices.filter((d) => d.online).length} 台在线</span>
        </div>
        <div className="flex items-center gap-1 sm:hidden" aria-label="在线设备">
          {devices.map((d) => (
            <DeviceDot key={d.id} id={d.id} ripple={reduced ? 0 : (ripples[d.id] ?? 0)} dotRef={dotRef} compact />
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {reduced ? (
            <span className="dd-mono hidden rounded-[var(--radius-xs)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)] md:inline">reduced motion</span>
          ) : null}
          <IconToggle label={mode === 'light' ? '切到暗色' : '切到亮色'} onClick={() => onMode(mode === 'light' ? 'dark' : 'light')}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={mode}
                initial={{ rotate: -90, scale: 0.5, opacity: 0 }}
                animate={{ rotate: 0, scale: 1, opacity: 1 }}
                exit={{ rotate: 90, scale: 0.5, opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
                transition={springBounce}
                className="grid place-items-center"
              >
                {mode === 'light' ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
              </motion.span>
            </AnimatePresence>
          </IconToggle>
          <IconToggle label="模拟减少动效（prefers-reduced-motion）" pressed={simReduced} onClick={onReduced}>
            <TurtleIcon className="size-4" />
          </IconToggle>
        </div>
      </div>
    </header>
  )
}

function DeviceDot({ id, ripple, dotRef, compact }: { id: string; ripple: number; dotRef: (id: string, el: HTMLElement | null) => void; compact?: boolean }) {
  const d = deviceById(id)
  return (
    <span className="group relative grid size-6 place-items-center" title={`${d.name}${d.online ? ' · 在线' : ' · 离线'}`}>
      <span
        ref={compact ? undefined : (el) => dotRef(id, el)}
        className="relative block size-2.5 rounded-full"
        style={{ background: d.online ? deviceColor(d.kind) : 'transparent', boxShadow: d.online ? undefined : `inset 0 0 0 1.5px var(--line-3)` }}
      >
        <AnimatePresence>
          {ripple > 0 ? (
            <motion.span
              key={ripple}
              aria-hidden
              className="absolute inset-0 rounded-full"
              style={{ boxShadow: `0 0 0 1.5px ${deviceColor(d.kind)}` }}
              initial={{ scale: 1, opacity: 0.9 }}
              animate={{ scale: 4.2, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, ease: easeOut }}
            />
          ) : null}
        </AnimatePresence>
        {ripple > 0 ? (
          <motion.span
            key={`b${ripple}`}
            aria-hidden
            className="absolute inset-0 rounded-full"
            style={{ boxShadow: `0 0 0 1px ${deviceColor(d.kind)}` }}
            initial={{ scale: 1, opacity: 0.6 }}
            animate={{ scale: 2.6, opacity: 0 }}
            transition={{ duration: 0.9, ease: easeOut, delay: 0.18 }}
          />
        ) : null}
      </span>
      {!compact ? (
        <span className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 hidden -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--fg)] px-1.5 py-0.5 text-[10px] text-[var(--bg)] group-hover:flex">
          <DeviceGlyph kind={d.kind} className="size-3" /> {d.name}
        </span>
      ) : null}
    </span>
  )
}

function Segmented<T extends string>(props: { id: string; label: string; value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; hint?: string }> }) {
  const { id, label, value, onChange, options } = props
  return (
    <div role="radiogroup" aria-label={label} className="relative flex rounded-[var(--radius-md)] border border-[var(--line-1)] bg-[var(--surface-2)] p-0.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={`relative flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] px-2 text-[12px] sm:px-2.5 transition-colors duration-[var(--dur-fast)] ${active ? 'text-[var(--fg)]' : 'text-[var(--fg-3)] hover:text-[var(--fg-2)]'}`}
          >
            {active ? (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-[var(--radius-sm)] border border-[var(--line-2)] bg-[var(--surface-1)] shadow-[var(--shadow-1)]"
                transition={springBounce}
              />
            ) : null}
            <span className="relative flex items-center gap-1.5">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function IconToggle({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: ReactNode }) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      whileTap={{ scale: 0.92 }}
      transition={springBounce}
      className={`grid size-8 place-items-center overflow-hidden rounded-[var(--radius-md)] border ${pressed ? 'border-[var(--fg)] bg-[var(--fg)] text-[var(--bg)]' : 'border-[var(--line-1)] bg-[var(--surface-1)] text-[var(--fg-2)] hover:border-[var(--line-2)] hover:text-[var(--fg)]'}`}
    >
      {children}
    </motion.button>
  )
}

/* ---------------------------------------------------------------- composer */

function Composer(props: { reduced: boolean; docked: boolean; onAdd: (c: Clip) => void; onPasteShot: () => void; groups: string[]; target: string; onTarget: (g: string) => void }) {
  const { reduced, docked, onAdd, onPasteShot, groups, target, onTarget } = props
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const [focused, setFocused] = useState(false)
  const [collapsed, setCollapsed] = useScrollCollapse(docked, focused || text.trim().length > 0 || dragging)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const expand = () => {
    setCollapsed(false)
    // Wait for the pill to morph back before raising the keyboard.
    window.setTimeout(() => inputRef.current?.focus(), reduced ? 0 : 120)
  }
  const [absorbing, setAbsorbing] = useState(false)
  const depth = useRef(0)
  const zoneRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const sx = useSpring(mx, { stiffness: 300, damping: 22 })
  const sy = useSpring(my, { stiffness: 300, damping: 22 })

  const ingest = useCallback(
    (files: File[]) => {
      const now = Date.now()
      files.forEach((file, i) => {
        if (file.type.startsWith('image/')) {
          const reader = new FileReader()
          reader.onload = () => onAdd(pastedShot(now + i, String(reader.result)))
          reader.readAsDataURL(file)
        } else {
          // Real audio / video dropped in plays straight from the card.
          const playable = /^(audio|video)\//.test(file.type) ? URL.createObjectURL(file) : undefined
          onAdd(droppedFile(now + i, file.name, file.size, playable))
        }
      })
      if (files.length) {
        setAbsorbing(true)
        window.setTimeout(() => setAbsorbing(false), 360)
      }
    },
    [onAdd],
  )

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current += 1
      setDragging(true)
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const r = zoneRef.current?.getBoundingClientRect()
      if (r) {
        // Magnetic pull: the target leans toward the cursor, capped.
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        mx.set(Math.max(-60, Math.min(60, (e.clientX - cx) * 0.18)))
        my.set(Math.max(-24, Math.min(24, (e.clientY - cy) * 0.18)))
      }
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      mx.set(0)
      my.set(0)
      ingest(Array.from(e.dataTransfer?.files ?? []))
    }
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length) {
        e.preventDefault()
        ingest(files)
        return
      }
      const target = e.target as HTMLElement
      if (target.closest('textarea, input')) return
      const t = e.clipboardData?.getData('text/plain')
      if (t?.trim()) onAdd(textClip(Date.now(), t))
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [ingest, mx, my, onAdd])

  const send = () => {
    if (!text.trim()) return
    onAdd(textClip(Date.now(), text))
    setText('')
  }

  const section = (
    <motion.section
      ref={zoneRef}
      layout={!reduced}
      aria-label="投放区"
      data-dragging={dragging || undefined}
      data-docked={docked || undefined}
      data-collapsed={collapsed || undefined}
      style={{ borderRadius: docked ? (collapsed ? 999 : 20) : undefined }}
      className={`relative overflow-hidden border ${
        docked
          ? `pointer-events-auto bg-[color-mix(in_oklab,var(--surface-1)_88%,transparent)] backdrop-blur-xl ${collapsed ? 'w-auto' : 'w-full'}`
          : 'rounded-[var(--radius-lg)] bg-[var(--surface-1)]'
      }`}
      animate={
        dragging
          ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 4px var(--accent-soft), var(--shadow-3)', scale: reduced ? 1 : 1.01 }
          : absorbing
            ? { scale: [1.01, 0.985, 1], borderColor: 'var(--line-2)', boxShadow: 'var(--shadow-2)' }
            : { borderColor: 'var(--line-2)', boxShadow: docked ? 'var(--shadow-3)' : 'var(--shadow-1)', scale: 1 }
      }
      transition={{ ...springSettle, borderColor: { duration: dur.base }, boxShadow: { duration: dur.base } }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {dragging ? (
          <motion.div
            key="zone"
            initial={{ opacity: 0, height: 64 }}
            animate={{ opacity: 1, height: 168, transition: { ...springSettle, opacity: { duration: dur.base, ease: easeOut } } }}
            exit={{ opacity: 0, height: 64, transition: { duration: dur.fast, ease: easeIn } }}
            className="dd-grid-bg grid place-items-center"
          >
            <motion.div style={{ x: sx, y: sy }} className="flex flex-col items-center gap-2 text-[var(--accent)]">
              <motion.span
                className="grid size-14 place-items-center rounded-full border border-dashed border-[var(--accent)] bg-[var(--accent-soft)]"
                animate={reduced ? undefined : { scale: [1, 1.06, 1] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
              >
                <UploadIcon className="size-5" />
              </motion.span>
              <span className="text-[13px] font-medium">松手，吸进来</span>
              <span className="text-[11px] text-[var(--fg-3)]">图片会落进列表，其他文件按类型归档</span>
            </motion.div>
          </motion.div>
        ) : collapsed ? (
          <motion.button
            key="pill"
            type="button"
            layout="position"
            onClick={expand}
            aria-label="展开输入框"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: dur.base, ease: easeOut } }}
            exit={{ opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
            className="flex h-11 items-center gap-2 pl-4 pr-1.5 text-[13px] text-[var(--fg-3)]"
          >
            <span className="whitespace-nowrap">粘贴或输入…</span>
            <span className="grid size-8 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)]">
              <ArrowUpIcon className="size-3.5" />
            </span>
          </motion.button>
        ) : (
          <motion.div key="input" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: dur.fast } }} className="flex items-end gap-2 p-2.5">
            <button
              type="button"
              aria-label="添加附件"
              title="添加附件"
              onClick={() => fileRef.current?.click()}
              className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] text-[var(--fg-3)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
            >
              <PaperclipIcon className="size-4" />
            </button>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => ingest(Array.from(e.target.files ?? []))} />
            <GroupTarget groups={groups} value={target} onChange={onTarget} compact={docked} />
            <textarea
              ref={inputRef}
              value={text}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              rows={1}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={docked ? "粘贴或输入…" : "粘贴、输入，或把文件拖到这里…"}
              className="min-h-9 flex-1 resize-none bg-transparent py-2 text-[14px] text-[var(--fg)] outline-none placeholder:text-[var(--fg-4)]"
            />
            <button
              type="button"
              onClick={onPasteShot}
              title="模拟粘贴一张截图"
              className="hidden h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-[12px] text-[var(--fg-3)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)] sm:flex"
            >
              <ClipboardPasteIcon className="size-4" /> 粘贴截图
            </button>
            <motion.button
              type="button"
              aria-label="发送"
              onClick={send}
              whileTap={{ scale: 0.9 }}
              animate={{ opacity: text.trim() ? 1 : 0.45 }}
              transition={springBounce}
              className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-fg)]"
            >
              <ArrowUpIcon className="size-4" />
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  )
  if (!docked) return section
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      {section}
    </div>
  )
}

/* ---------------------------------------------------------------- pin bar */

type PinBarProps = {
  barRef: RefObject<HTMLElement | null>
  pinned: Clip[]
  hover: boolean
  reduced: boolean
  onUnpin: (c: Clip) => void
  onCopy: (c: Clip) => void
  openId: string | null
  onOpen: (c: Clip | null) => void
  copiedId: string | null
}

function PinBar(props: PinBarProps) {
  const { barRef, pinned, hover, reduced, onUnpin, onCopy, openId, onOpen, copiedId } = props
  return (
    <motion.section
      ref={barRef}
      layout={!reduced}
      aria-label="置顶栏"
      data-hover={hover || undefined}
      className="dd-scroll-x relative flex min-h-[52px] items-center gap-2 overflow-x-auto rounded-[var(--radius-lg)] border border-dashed px-2.5 py-2"
      animate={
        hover
          ? { borderColor: 'var(--accent)', backgroundColor: 'var(--accent-soft)', scale: reduced ? 1 : 1.015 }
          : { borderColor: 'var(--line-2)', backgroundColor: 'var(--surface-0)', scale: 1 }
      }
      transition={{ ...springBounce, borderColor: { duration: dur.fast }, backgroundColor: { duration: dur.fast } }}
    >
      <span className="flex shrink-0 items-center gap-1.5 pr-1 text-[11px] text-[var(--fg-3)]">
        <motion.span animate={hover && !reduced ? { rotate: [0, -18, 12, 0] } : { rotate: 0 }} transition={{ duration: dur.slow }}>
          <PinIcon className={`size-3.5 ${hover ? 'text-[var(--accent)]' : ''}`} />
        </motion.span>
        置顶
      </span>
      <AnimatePresence initial={false} mode="popLayout">
        {pinned.map((c) => (
          <PinChip key={c.id} clip={c} reduced={reduced} onUnpin={onUnpin} onCopy={onCopy} open={openId === c.id} onOpen={onOpen} copied={copiedId === c.id} />
        ))}
      </AnimatePresence>
      {pinned.length === 0 ? <span className="text-[12px] text-[var(--fg-4)]">把卡片拖到这里置顶</span> : null}
      <AnimatePresence>
        {hover ? (
          <motion.span
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: dur.fast } }}
            className="ml-auto shrink-0 pr-1 text-[12px] font-medium text-[var(--accent)]"
          >
            松手吸附
          </motion.span>
        ) : null}
      </AnimatePresence>
    </motion.section>
  )
}

function PinChip(props: { clip: Clip; reduced: boolean; onUnpin: (c: Clip) => void; onCopy: (c: Clip) => void; open: boolean; onOpen: (c: Clip | null) => void; copied: boolean }) {
  const { clip, reduced, onUnpin, onCopy, open, onOpen, copied } = props
  const [pull, setPull] = useState(0)
  const dragged = useRef(false)
  const threshold = 56
  const d = deviceById(clip.deviceId)
  const onDrag = (_: unknown, info: PanInfo) => setPull(Math.min(1, Math.hypot(info.offset.x, info.offset.y) / threshold))
  const onDragEnd = (_: unknown, info: PanInfo) => {
    window.setTimeout(() => {
      dragged.current = false
    }, 0)
    setPull(0)
    if (Math.abs(info.offset.y) > threshold) onUnpin(clip)
  }
  return (
    <motion.div
      layout={!reduced}
      layoutId={reduced ? undefined : `clip-${clip.id}`}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8, transition: { duration: dur.fast, ease: easeIn } }}
      transition={{ ...springBounce, layout: springBounce }}
      drag={!reduced}
      dragSnapToOrigin
      dragElastic={0.45}
      dragTransition={{ bounceStiffness: (springTether as { stiffness: number }).stiffness, bounceDamping: (springTether as { damping: number }).damping }}
      whileDrag={{ scale: 1.05, zIndex: 30, cursor: 'grabbing' }}
      onDragStart={() => {
        dragged.current = true
      }}
      onDrag={onDrag}
      onDragEnd={onDragEnd}
      onTap={(e) => {
        if (dragged.current || (e.target as HTMLElement | null)?.closest('[data-action]')) return
        onOpen(open ? null : clip)
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(open ? null : clip)
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      data-clip-id={clip.id}
      data-open={open || undefined}
      title="点按显示操作；向下拖离取消置顶"
      className="relative flex h-9 shrink-0 cursor-grab touch-none select-none items-center gap-2 rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-1)] pl-2.5 pr-1 text-[12.5px] text-[var(--fg)] shadow-[var(--shadow-1)]"
      style={{ borderColor: pull > 0.98 ? 'var(--accent)' : open ? 'var(--line-3)' : undefined }}
    >
      <span className="size-1.5 rounded-full" style={{ background: deviceColor(d.kind) }} />
      <ChipPreview clip={clip} />
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
            <ChipAction label={copied ? '已复制' : '复制'} onClick={() => onCopy(clip)}>
              {copied ? <CheckIcon className="size-3.5 text-[var(--ok)]" /> : <CopyIcon className="size-3.5" />}
            </ChipAction>
            <ChipAction label="取消置顶" onClick={() => onUnpin(clip)}>
              <PinOffIcon className="size-3.5" />
            </ChipAction>
          </motion.span>
        ) : (
          <motion.span key="pad" className="w-1.5" />
        )}
      </AnimatePresence>
      {pull > 0 ? (
        <span className="dd-mono absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-[var(--accent)]" style={{ opacity: pull }}>
          {pull > 0.98 ? '松手取消置顶' : '继续拖…'}
        </span>
      ) : null}
    </motion.div>
  )
}

function ChipAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  const ref = useIsolatePointer<HTMLButtonElement>()
  return (
    <button
      ref={ref}
      type="button"
      data-action
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-[var(--radius-sm)] text-[var(--fg-3)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
    >
      {children}
    </button>
  )
}

function ChipPreview({ clip }: { clip: Clip }) {
  switch (clip.kind) {
    case 'color':
      return <><span className="size-3.5 rounded-[3px] ring-1 ring-black/10" style={{ background: clip.value }} /><span className="dd-mono">{clip.value}</span></>
    case 'code':
      return <span className="dd-mono max-w-48 truncate text-[11.5px] text-[var(--fg-2)]">{clip.code.split('\n')[0]}</span>
    case 'link':
      return <span className="max-w-56 truncate">{clip.title}</span>
    default:
      return <span className="max-w-48 truncate">{labelFor(clip)}</span>
  }
}

/* ---------------------------------------------------------------- toolbar */

function Toolbar(props: { view: View; onView: (v: View) => void; count: number; onArrive: () => void; onPaste: () => void; onSkeleton: () => void; onEmpty: () => void; onReset: () => void }) {
  const { view, onView, count, onArrive, onPaste, onSkeleton, onEmpty, onReset } = props
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        id="view"
        label="视图"
        value={view}
        onChange={onView}
        options={[
          { value: 'grid', label: <><LayoutGridIcon className="size-3.5" /> 网格</> },
          { value: 'group', label: <><FolderIcon className="size-3.5" /> 按分组</> },
          { value: 'date', label: <><CalendarDaysIcon className="size-3.5" /> 按日期</> },
          { value: 'device', label: <><TabletSmartphoneIcon className="size-3.5" /> 按设备</> },
        ]}
      />
      <span className="dd-mono text-[11px] text-[var(--fg-3)]">{count} 条</span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5" aria-label="演示控制">
        <button type="button" className="dd-chip" onClick={onArrive}><SparklesIcon className="size-3.5" /> 模拟新内容</button>
        <button type="button" className="dd-chip sm:hidden" onClick={onPaste}><ClipboardPasteIcon className="size-3.5" /> 粘贴截图</button>
        <button type="button" className="dd-chip" onClick={onSkeleton}>骨架屏</button>
        <button type="button" className="dd-chip" onClick={onEmpty}>空态</button>
        <button type="button" className="dd-chip" onClick={onReset} aria-label="重置示例数据"><RotateCcwIcon className="size-3.5" /></button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- board */

type BoardProps = {
  view: View
  clips: Clip[]
  now: number
  gesture: GestureMode
  reduced: boolean
  copiedId: string | null
  pinBarRef: RefObject<HTMLElement | null>
  deviceDot: (id: string) => HTMLElement | null
  onCopy: (c: Clip) => void
  onRetract: (c: Clip) => void
  onPin: (c: Clip) => void
  onPinHover: (over: boolean) => void
  onArrived: (c: Clip) => void
  trashRef: RefObject<TrashHandle | null>
  onDragPhase: (phase: { clip: Clip; rect: DOMRect } | { clip: Clip; end: 'cancel' | 'deleted' }) => void
  openId: string | null
  onOpen: (c: Clip | null) => void
  groups: string[]
  filter: GroupFilter
  onMoveGroup: (c: Clip, g: string | undefined) => void
  onGroupDrag?: (c: Clip, x: number, y: number, drop: boolean) => string | null
}

function Board(props: BoardProps) {
  const { view, clips, now } = props
  const card = (c: Clip, variant: 'grid' | 'row') => (
    <ClipCard
      key={c.id}
      clip={c}
      now={now}
      variant={variant}
      gesture={props.gesture}
      reduced={props.reduced}
      copied={props.copiedId === c.id}
      pinBarRef={props.pinBarRef}
      deviceDot={props.deviceDot}
      onCopy={props.onCopy}
      onRetract={props.onRetract}
      onPin={props.onPin}
      onPinHover={props.onPinHover}
      onArrived={props.onArrived}
      trashRef={props.trashRef}
      onDragPhase={props.onDragPhase}
      open={props.openId === c.id}
      onOpen={props.onOpen}
      groups={props.groups}
      onMoveGroup={props.onMoveGroup}
      onGroupDrag={props.onGroupDrag}
    />
  )

  if (view === 'grid') {
    return (
      <motion.div layout={!props.reduced} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-view="grid">
        <AnimatePresence mode="popLayout">{clips.map((c) => card(c, 'grid'))}</AnimatePresence>
      </motion.div>
    )
  }

  if (view === 'group') return <GroupedBoard clips={clips} groups={props.groups} filter={props.filter} reduced={props.reduced} card={card} />

  const groups = new Map<string, Clip[]>()
  for (const c of clips) {
    const key = view === 'date' ? dayLabel(c.createdAt, now) : c.deviceId
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  return (
    <div className="flex flex-col gap-6" data-view={view}>
      <AnimatePresence mode="popLayout">
        {[...groups.entries()].map(([key, list]) => {
          const d = view === 'device' ? deviceById(key) : null
          return (
            <motion.section
              key={`${view}-${key}`}
              layout={!props.reduced}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
              className="grid grid-cols-[18px_1fr] gap-x-3"
            >
              <div className="relative flex justify-center">
                <span
                  className="relative z-10 mt-[3px] size-2.5 rounded-full ring-4 ring-[var(--bg)]"
                  style={{ background: d ? deviceColor(d.kind) : 'var(--fg-3)' }}
                />
                <span className="absolute bottom-0 top-3 w-px bg-[var(--line-2)]" />
              </div>
              <div className="flex flex-col gap-2 pb-1">
                <h3 className="dd-display m-0 flex items-center gap-2 text-[13px] font-semibold text-[var(--fg)]">
                  {d ? <DeviceGlyph kind={d.kind} className="size-3.5 text-[var(--fg-3)]" /> : null}
                  {d ? d.name : key}
                  <span className="dd-mono text-[11px] font-normal text-[var(--fg-3)]">{list.length}</span>
                  {d && !d.online ? <span className="text-[11px] font-normal text-[var(--fg-4)]">离线</span> : null}
                </h3>
                <AnimatePresence mode="popLayout">{list.map((c) => card(c, 'row'))}</AnimatePresence>
              </div>
            </motion.section>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

/** 按分组: one collapsible section per group (plus 未分组), cards in a grid. */
function GroupedBoard(props: { clips: Clip[]; groups: string[]; filter: GroupFilter; reduced: boolean; card: (c: Clip, v: 'grid' | 'row') => ReactNode }) {
  const { clips, groups, filter, reduced, card } = props
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const keys = filter !== null ? [filter] : [...groups, '']
  return (
    <div className="flex flex-col gap-3" data-view="group">
      <AnimatePresence mode="popLayout" initial={false}>
        {keys.map((key) => {
          const list = clips.filter((c) => (c.group ?? '') === key)
          if (key === '' && list.length === 0 && filter === null) return null
          const isFolded = folded[key] ?? false
          return (
            <motion.section
              key={`g-${key}`}
              layout={!reduced}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
              className="rounded-[var(--radius-lg)] border border-[var(--line-1)] bg-[color-mix(in_oklab,var(--surface-1)_45%,transparent)]"
              style={{ borderLeft: `3px solid ${key ? groupColor(key) : 'var(--line-2)'}` }}
              data-group-section={key || '-'}
            >
              <motion.button
                layout="position"
                type="button"
                aria-expanded={!isFolded}
                onClick={() => setFolded((f) => ({ ...f, [key]: !isFolded }))}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
              >
                <motion.span animate={{ rotate: isFolded ? -90 : 0 }} transition={springBounce} className="text-[var(--fg-3)]">
                  <ChevronDownIcon className="size-3.5" />
                </motion.span>
                <GroupDot group={key || undefined} className="size-2" />
                <span className="dd-display text-[13px] font-semibold text-[var(--fg)]">{groupName(key)}</span>
                <span className="dd-mono text-[11px] text-[var(--fg-3)]">{list.length}</span>
              </motion.button>
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
                      <div className="grid grid-cols-1 gap-3 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-3">
                        <AnimatePresence mode="popLayout">{list.map((c) => card(c, 'grid'))}</AnimatePresence>
                      </div>
                    ) : (
                      <p className="m-0 px-3 pb-3 text-[12px] text-[var(--fg-4)]">还没有内容 · 在卡片上点分组标签，或把卡片拖到上方的分组上</p>
                    )}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </motion.section>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

function GroupEmpty({ group, onAll }: { group: string; onAll: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[var(--line-2)] px-6 py-12 text-center"
    >
      <GroupDot group={group || undefined} className="size-3" />
      <p className="m-0 text-[13px] text-[var(--fg-3)]">「{groupName(group)}」里还没有内容。发送时选这个分组，或在卡片上点分组标签移进来。</p>
      <button type="button" className="dd-chip" onClick={onAll}>看全部</button>
    </motion.div>
  )
}

/* ---------------------------------------------------------------- states */

function Skeletons({ view }: { view: View }) {
  const n = view === 'grid' ? 6 : 5
  return (
    <div aria-busy="true" aria-label="加载中" className={view === 'grid' ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3' : 'flex flex-col gap-2 pl-[30px]'}>
      {Array.from({ length: n }, (_, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: dur.base, delay: i * 0.04 }}
          className="dd-card overflow-hidden"
        >
          {view === 'grid' ? (
            <div className="flex flex-col gap-3 p-3">
              <div className="dd-skel h-2.5 w-12" />
              <div className="flex gap-2.5">
                <div className="dd-skel size-7 shrink-0" />
                <div className="flex flex-1 flex-col gap-2">
                  <div className="dd-skel h-3 w-[85%]" />
                  <div className="dd-skel h-3 w-[55%]" />
                </div>
              </div>
              <div className="dd-skel h-12 w-full" style={{ opacity: i % 2 ? 1 : 0 }} />
            </div>
          ) : (
            <div className="flex items-center gap-3 px-3 py-3">
              <div className="dd-skel size-6 shrink-0" />
              <div className="dd-skel h-3 flex-1" style={{ maxWidth: `${60 + ((i * 13) % 30)}%` }} />
            </div>
          )}
          <div className="flex gap-2 border-t border-[var(--line-1)] px-3 py-2.5">
            <div className="dd-skel h-2.5 w-20" />
            <div className="dd-skel ml-auto h-2.5 w-10" />
          </div>
        </motion.div>
      ))}
    </div>
  )
}

function EmptyState({ onReset, onArrive }: { onReset: () => void; onArrive: () => void }) {
  const reduced = useReducedMotion()
  const sheet = (i: number) => ({
    initial: { opacity: 0, y: 16, rotate: 0 },
    animate: { opacity: 1, y: reduced ? 0 : [0, -4, 0], rotate: [-8, 3, 10][i] },
    transition: { opacity: { duration: dur.slow, delay: i * 0.06 }, rotate: { ...springBounce, delay: i * 0.06 }, y: { duration: 3.2, repeat: Infinity, ease: 'easeInOut' as const, delay: i * 0.4 } },
  })
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: dur.slow, ease: easeOut }}
      className="flex flex-col items-center gap-5 rounded-[var(--radius-lg)] border border-dashed border-[var(--line-2)] px-6 py-16 text-center"
    >
      <div className="relative h-24 w-28" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            {...sheet(i)}
            className="absolute left-5 top-2 h-20 w-16 rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-1)] shadow-[var(--shadow-2)]"
            style={{ zIndex: i }}
          >
            <div className="m-2 h-1.5 w-8 rounded-full bg-[var(--surface-2)]" />
            <div className="mx-2 h-1.5 w-10 rounded-full bg-[var(--surface-2)]" />
            {i === 2 ? <span className="absolute bottom-2 right-2 size-2 rounded-full bg-[var(--accent)]" /> : null}
          </motion.div>
        ))}
      </div>
      <div className="flex max-w-sm flex-col gap-1.5">
        <p className="dd-display m-0 text-[17px] font-semibold text-[var(--fg)]">这里还空着</p>
        <p className="m-0 text-[13px] leading-relaxed text-[var(--fg-3)]">在任何一台设备上复制，内容会飞到这里；也可以把文件拖进上面的投放区。到期的内容会自己褪色消失。</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className="dd-chip" onClick={onArrive}><SparklesIcon className="size-3.5" /> 来一条</button>
        <button type="button" className="dd-chip" onClick={onReset}><RotateCcwIcon className="size-3.5" /> 放回示例</button>
      </div>
    </motion.div>
  )
}

function ToastHost({ toast, docked, onClose }: { toast: Toast | null; docked: boolean; onClose: () => void }) {
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4 ${docked ? 'bottom-[calc(76px+env(safe-area-inset-bottom))]' : 'bottom-5'}`}
    >
      <AnimatePresence mode="popLayout">
        {toast ? (
          <motion.div
            key={toast.id}
            role="status"
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: springBounce }}
            exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: dur.fast, ease: easeIn } }}
            className="pointer-events-auto flex max-w-[min(92vw,420px)] items-center gap-3 rounded-[var(--radius-lg)] bg-[var(--fg)] py-2 pl-3.5 pr-2 text-[13px] text-[var(--bg)] shadow-[var(--shadow-3)]"
          >
            <span className="truncate">{toast.text}</span>
            {toast.undo ? (
              <button
                type="button"
                onClick={() => {
                  toast.undo?.()
                  onClose()
                }}
                className="shrink-0 rounded-[var(--radius-sm)] bg-[color-mix(in_oklab,var(--bg)_16%,transparent)] px-2 py-1 text-[12px] font-medium text-[var(--bg)] hover:bg-[color-mix(in_oklab,var(--bg)_26%,transparent)]"
              >
                撤销
              </button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default UiDemoPage
