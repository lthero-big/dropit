import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/noto-sans-sc'
import '@fontsource-variable/noto-serif-sc'
import './demo.css'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useMotionValue, useReducedMotion, useSpring, type PanInfo } from 'motion/react'
import {
  ArrowUpIcon,
  CalendarDaysIcon,
  ClipboardPasteIcon,
  LayoutGridIcon,
  MoonIcon,
  PaperclipIcon,
  PinIcon,
  RotateCcwIcon,
  SparklesIcon,
  SunIcon,
  TabletSmartphoneIcon,
  TurtleIcon,
  UploadIcon,
} from 'lucide-react'
import { ClipCard, type GestureMode } from './clip-card.tsx'
import { clipCopyText, dayLabel, deviceById, devices, droppedFile, nextIncoming, pastedShot, seedClips, textClip, type Clip } from './data.ts'
import { DeviceGlyph } from './icons.tsx'
import { deviceColor, labelFor } from './visuals.ts'
import { dur, easeIn, easeOut, enter, springBounce, springSettle, springTether } from './motion-tokens.ts'

type Direction = 'paper' | 'ink'
type Mode = 'light' | 'dark'
type View = 'grid' | 'date' | 'device'

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

export function UiDemoPage() {
  const [direction, setDirection] = useState<Direction>(() => readParam('dir', ['paper', 'ink'] as const, 'paper'))
  const [mode, setMode] = useState<Mode>(() =>
    readParam('mode', ['light', 'dark'] as const, typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  )
  const [view, setView] = useState<View>(() => readParam('view', ['grid', 'date', 'device'] as const, 'grid'))
  const [simReduced, setSimReduced] = useState(() => readParam('reduced', ['1', '0'] as const, '0') === '1')
  const systemReduced = useReducedMotion() ?? false
  const reduced = simReduced || systemReduced
  const gesture = useGestureMode()
  const now = useNow()

  const [clips, setClips] = useState<Clip[]>(() => (readParam('empty', ['1', '0'] as const, '0') === '1' ? [] : seedClips(Date.now())))
  const [loading, setLoading] = useState(() => readParam('skeleton', ['1', '0', 'hold'] as const, '1') !== '0')
  const holdSkeleton = readParam('skeleton', ['1', '0', 'hold'] as const, '1') === 'hold'
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [pinHover, setPinHover] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [ripples, setRipples] = useState<Record<string, number>>({})
  const pinBarRef = useRef<HTMLElement | null>(null)
  const dotRefs = useRef(new Map<string, HTMLElement>())

  useEffect(() => {
    document.title = 'dropit · UI demo'
    if (!loading || holdSkeleton) return
    const t = window.setTimeout(() => setLoading(false), 1100)
    return () => window.clearTimeout(t)
  }, [loading, holdSkeleton])

  const live = useMemo(() => clips.filter((c) => c.expiresAt > now), [clips, now])
  const pinned = live.filter((c) => c.pinned)
  const board = live.filter((c) => !c.pinned)

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

  const add = useCallback((clip: Clip) => setClips((list) => [clip, ...list]), [])
  const simulateArrival = useCallback(() => {
    const clip = nextIncoming(Date.now())
    // Ripple the source device's dot the moment the item leaves it.
    setRipples((r) => ({ ...r, [clip.deviceId]: (r[clip.deviceId] ?? 0) + 1 }))
    add(clip)
  }, [add])
  const simulatePaste = useCallback(() => add(pastedShot(Date.now())), [add])

  const deviceDot = useCallback((id: string) => dotRefs.current.get(id) ?? null, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('textarea, input')) return
      if (e.key === 'n') simulateArrival()
      if (e.key === 'd') setDirection((d) => (d === 'paper' ? 'ink' : 'paper'))
      if (e.key === 'm') setMode((m) => (m === 'light' ? 'dark' : 'light'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [simulateArrival])

  return (
    <MotionConfig reducedMotion={simReduced ? 'always' : 'user'} transition={enter}>
      <div className="dd min-h-dvh overflow-x-clip" data-dir={direction} data-mode={mode} data-reduced={reduced || undefined}>
        <TopBar
          direction={direction}
          mode={mode}
          reduced={reduced}
          simReduced={simReduced}
          ripples={ripples}
          dotRef={(id, el) => {
            if (el) dotRefs.current.set(id, el)
            else dotRefs.current.delete(id)
          }}
          onDirection={setDirection}
          onMode={setMode}
          onReduced={() => setSimReduced((v) => !v)}
        />
        <main className="mx-auto flex max-w-[1120px] flex-col gap-4 px-4 pb-10 pt-5 sm:px-6">
          <Composer reduced={reduced} onAdd={add} onPasteShot={simulatePaste} />
          <LayoutGroup>
            <PinBar
              barRef={pinBarRef}
              pinned={pinned}
              hover={pinHover}
              reduced={reduced}
              onUnpin={(c) => setPinned(c, false)}
              onCopy={copy}
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
              }}
            />
            {loading ? (
              <Skeletons view={view} />
            ) : board.length === 0 && pinned.length === 0 ? (
              <EmptyState onReset={() => setClips(seedClips(Date.now()))} onArrive={simulateArrival} />
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
              />
            )}
          </LayoutGroup>
        </main>
        <ToastHost toast={toast} onClose={() => setToast(null)} />
        <p className="mx-auto hidden max-w-[1120px] px-4 pb-8 text-[11px] text-[var(--fg-4)] sm:block sm:px-6">
          快捷键：N 模拟新内容 · D 切换风格 · M 切换明暗 · {gesture === 'swipe' ? '右滑复制 / 左滑撤回' : '点卡片复制 · 拖到置顶栏'}
        </p>
      </div>
    </MotionConfig>
  )
}

/* ---------------------------------------------------------------- top bar */

function TopBar(props: {
  direction: Direction
  mode: Mode
  reduced: boolean
  simReduced: boolean
  ripples: Record<string, number>
  dotRef: (id: string, el: HTMLElement | null) => void
  onDirection: (d: Direction) => void
  onMode: (m: Mode) => void
  onReduced: () => void
}) {
  const { direction, mode, reduced, simReduced, ripples, dotRef, onDirection, onMode, onReduced } = props
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
          <Segmented
            id="dir"
            label="风格方向"
            value={direction}
            onChange={onDirection}
            options={[
              { value: 'paper', label: '纸感', hint: 'Paper · Geist + 思源黑体' },
              { value: 'ink', label: '墨刊', hint: 'Ink · 思源宋体 + Geist Mono' },
            ]}
          />
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

function Composer({ reduced, onAdd, onPasteShot }: { reduced: boolean; onAdd: (c: Clip) => void; onPasteShot: () => void }) {
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
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
          onAdd(droppedFile(now + i, file.name, file.size))
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

  return (
    <motion.section
      ref={zoneRef}
      layout={!reduced}
      aria-label="投放区"
      data-dragging={dragging || undefined}
      className="relative overflow-hidden rounded-[var(--radius-lg)] border bg-[var(--surface-1)]"
      animate={
        dragging
          ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 4px var(--accent-soft), var(--shadow-3)', scale: reduced ? 1 : 1.01 }
          : absorbing
            ? { scale: [1.01, 0.985, 1], borderColor: 'var(--line-2)', boxShadow: 'var(--shadow-2)' }
            : { borderColor: 'var(--line-2)', boxShadow: 'var(--shadow-1)', scale: 1 }
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
        ) : (
          <motion.div key="input" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: dur.fast } }} className="flex items-end gap-2 p-2.5">
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
            <textarea
              value={text}
              rows={1}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder="粘贴、输入，或把文件拖到这里…"
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
}

/* ---------------------------------------------------------------- pin bar */

function PinBar(props: { barRef: RefObject<HTMLElement | null>; pinned: Clip[]; hover: boolean; reduced: boolean; onUnpin: (c: Clip) => void; onCopy: (c: Clip) => void }) {
  const { barRef, pinned, hover, reduced, onUnpin, onCopy } = props
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
          <PinChip key={c.id} clip={c} reduced={reduced} onUnpin={onUnpin} onCopy={onCopy} />
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

function PinChip({ clip, reduced, onUnpin, onCopy }: { clip: Clip; reduced: boolean; onUnpin: (c: Clip) => void; onCopy: (c: Clip) => void }) {
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
      onTap={() => {
        if (!dragged.current) onCopy(clip)
      }}
      role="button"
      tabIndex={0}
      title="点击复制；向下拖离取消置顶"
      className="relative flex h-9 shrink-0 cursor-grab touch-none select-none items-center gap-2 rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-1)] px-2.5 text-[12.5px] text-[var(--fg)] shadow-[var(--shadow-1)]"
      style={{ borderColor: pull > 0.98 ? 'var(--accent)' : undefined }}
    >
      <span className="size-1.5 rounded-full" style={{ background: deviceColor(d.kind) }} />
      <ChipPreview clip={clip} />
      {pull > 0 ? (
        <span className="dd-mono absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-[var(--accent)]" style={{ opacity: pull }}>
          {pull > 0.98 ? '松手取消置顶' : '继续拖…'}
        </span>
      ) : null}
    </motion.div>
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
    />
  )

  if (view === 'grid') {
    return (
      <motion.div layout={!props.reduced} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-view="grid">
        <AnimatePresence mode="popLayout">{clips.map((c) => card(c, 'grid'))}</AnimatePresence>
      </motion.div>
    )
  }

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

function ToastHost({ toast, onClose }: { toast: Toast | null; onClose: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
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
