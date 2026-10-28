import { useEffect, useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Panel, StatusPill, fieldClass, selectClass } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import {
  LIMIT_SPECS,
  UNIT_LABEL,
  defaultUnit,
  formatLimit,
  formatStamp,
  labelFor,
  localLimitError,
  toCanonical,
  toInput,
  unitsFor,
  type LimitSpec,
  type LimitUnit,
} from '@/lib/limits-form.ts'
import type { AdminLimits, LimitAuditEntry } from '@/lib/types.ts'

interface AuditPage {
  entries: LimitAuditEntry[]
  nextCursor: number | null
}

export function LimitsEditor({ limits, onChange }: { limits: AdminLimits; onChange: (next: AdminLimits) => void }) {
  const [entries, setEntries] = useState<LimitAuditEntry[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [auditLoading, setAuditLoading] = useState(true)
  const [auditBusy, setAuditBusy] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let active = true
    void api<AuditPage>('/api/admin/limits/audit?limit=50')
      .then((body) => {
        if (!active) return
        setEntries(body.entries)
        setCursor(body.nextCursor)
        setAuditError(null)
      })
      .catch((error: unknown) => {
        if (active) setAuditError(errorText(error))
      })
      .finally(() => {
        if (active) setAuditLoading(false)
      })
    return () => {
      active = false
    }
  }, [generation])

  function handleUpdated(next: AdminLimits) {
    onChange(next)
    setGeneration((value) => value + 1)
  }

  async function loadMore() {
    if (cursor === null) return
    setAuditBusy(true)
    try {
      const body = await api<AuditPage>(`/api/admin/limits/audit?limit=50&cursor=${cursor}`)
      setEntries((current) => [...current, ...body.entries])
      setCursor(body.nextCursor)
    } catch (error) {
      setAuditError(errorText(error))
    } finally {
      setAuditBusy(false)
    }
  }

  const groups = LIMIT_GROUPS

  return (
    <div>
      <LimitsSubnav counts={Object.fromEntries(groups.map((group) => [group, LIMIT_SPECS.filter((spec) => spec.group === group).length]))} auditCount={entries.length} />
      <div className="mb-5 rounded-md border-l-2 border-l-line-3 bg-surface-2 px-3 py-2 text-sm text-fg-2">
        <p>覆盖值保存在数据库，重启后保留；只读项仍需改环境变量。</p>
        <p className="mt-1 text-xs text-muted-foreground">
          只读项包括 APP_ORIGIN、TRUST_PROXY、DATA_DIR、OAuth 凭据、RATE_TOKEN 和清理间隔。调低上限或配额不会删除已有内容。保留时间只影响新条目和新房间，会话时长只影响新会话。
        </p>
      </div>
      {groups.map((group) => (
        <Panel key={group} id={GROUP_ANCHOR[group]} data-limit-group={group} className="scroll-mt-32" title={group} description={GROUP_HINT[group]} flush>
          <ul>
            {LIMIT_SPECS.filter((spec) => spec.group === group).map((spec) => (
              <LimitRow
                key={`${spec.key}:${limits[spec.key].value}:${limits[spec.key].overridden}`}
                spec={spec}
                field={limits[spec.key]}
                limits={limits}
                onUpdated={handleUpdated}
              />
            ))}
          </ul>
        </Panel>
      ))}
      <Panel id={GROUP_ANCHOR.变更记录} data-limit-group="变更记录" className="scroll-mt-32" title="变更记录" description={GROUP_HINT.变更记录}>
        {auditError ? <p role="alert" className="text-sm text-destructive">{auditError}</p> : null}
        {auditLoading ? <p className="text-sm text-muted-foreground">正在加载变更记录…</p> : null}
        {!auditLoading && entries.length === 0 && !auditError ? <p className="text-sm text-muted-foreground">还没有修改记录。</p> : null}
        {entries.length > 0 ? (
          <ul className="-my-3" aria-label="变更记录">
            {entries.map((entry) => (
              <li key={entry.id} className="grid gap-1 border-b border-line-1 py-3 text-sm last:border-b-0 sm:grid-cols-[minmax(0,1.4fr)_9rem_minmax(0,1.4fr)] sm:items-baseline sm:gap-3">
                <span className="truncate">{entry.actorEmail || entry.actorId}</span>
                <time dateTime={new Date(entry.createdAt).toISOString()} className="text-xs text-muted-foreground">{formatStamp(entry.createdAt)}</time>
                <span>
                  <span className="text-muted-foreground">{labelFor(entry.key)} </span>
                  <b>{formatLimit(entry.key, entry.oldValue)} → {formatLimit(entry.key, entry.newValue)}</b>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {cursor !== null ? (
          <Button type="button" variant="outline" className="mt-3 min-h-10" disabled={auditBusy} onClick={() => void loadMore()}>
            更早的记录
          </Button>
        ) : null}
      </Panel>
    </div>
  )
}

const LIMIT_GROUPS = ['容量', '时间', '限流'] as const
type NavTarget = (typeof LIMIT_GROUPS)[number] | '变更记录'
const GROUP_ANCHOR: Record<NavTarget, string> = {
  容量: 'limits-capacity',
  时间: 'limits-time',
  限流: 'limits-rate',
  变更记录: 'limits-audit',
}
const NAV_TARGETS: NavTarget[] = [...LIMIT_GROUPS, '变更记录']
const GROUP_HINT: Record<NavTarget, string> = {
  容量: '文件、文本、配额、分片',
  时间: '保留、会话、超时',
  限流: '请求频率与并发',
  变更记录: '谁在何时改了什么',
}

/**
 * RHEA-190 r4: the 限制 tab is long (23 rows). A paper-style secondary nav,
 * sticky under the page header, jumps straight to 容量 / 时间 / 限流 / 变更记录
 * and follows the scroll position.
 */
function LimitsSubnav({ counts, auditCount }: { counts: Record<string, number>; auditCount: number }) {
  const targets = NAV_TARGETS
  const [active, setActive] = useState<NavTarget>('容量')
  const lock = useRef(false)
  const release = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return
    const sections = targets.map((target) => document.getElementById(GROUP_ANCHOR[target])).filter((el): el is HTMLElement => Boolean(el))
    const observer = new IntersectionObserver(
      (records) => {
        if (lock.current) return
        const visible = records.filter((record) => record.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        const group = visible?.target.getAttribute('data-limit-group') as NavTarget | null | undefined
        if (group) setActive(group)
      },
      { rootMargin: '-120px 0px -55% 0px' },
    )
    for (const section of sections) observer.observe(section)
    return () => {
      observer.disconnect()
      window.clearTimeout(release.current)
    }
  }, [targets])

  function jump(target: NavTarget) {
    setActive(target)
    lock.current = true
    window.clearTimeout(release.current)
    release.current = window.setTimeout(() => {
      lock.current = false
    }, 800)
    const el = document.getElementById(GROUP_ANCHOR[target])
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', `#${GROUP_ANCHOR[target]}`)
  }

  return (
    <nav
      aria-label="限制分类"
      data-limits-subnav=""
      className="sticky top-14 z-20 mb-4 flex gap-1 overflow-x-auto rounded-lg border border-line-1 bg-[color-mix(in_oklab,var(--bg)_92%,transparent)] p-1 backdrop-blur-md"
    >
      {targets.map((target) => {
        const current = active === target
        const count = target === '变更记录' ? auditCount : counts[target]
        return (
          <a
            key={target}
            href={`#${GROUP_ANCHOR[target]}`}
            aria-current={current ? 'location' : undefined}
            title={GROUP_HINT[target]}
            className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-medium no-underline transition-colors ${
              current ? 'border-line-2 bg-surface-1 text-fg shadow-elev-1' : 'border-transparent text-fg-2 hover:border-line-1 hover:bg-surface-2 hover:text-fg'
            }`}
            onClick={(event) => {
              event.preventDefault()
              jump(target)
            }}
          >
            {target}
            <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
          </a>
        )
      })}
    </nav>
  )
}

function LimitRow({
  spec,
  field,
  limits,
  onUpdated,
}: {
  spec: LimitSpec
  field: AdminLimits[LimitSpec['key']]
  limits: AdminLimits
  onUpdated: (next: AdminLimits) => void
}) {
  const [unit, setUnit] = useState<LimitUnit>(() => defaultUnit(spec.key, field.value))
  const [raw, setRaw] = useState(() => toInput(field.value, defaultUnit(spec.key, field.value)))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const units = unitsFor(spec.key)
  const canonical = toCanonical(raw, unit)
  const unchanged = canonical !== null && canonical === field.value
  const errorId = `limit-${spec.key}-error`

  async function commit(value: number | null) {
    setBusy(true)
    setError(null)
    try {
      const next = await api<AdminLimits>('/api/admin/limits', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [spec.key]: value }),
      })
      onUpdated(next)
      toast.success(value === null ? '已恢复默认，立即生效' : '已保存，立即生效')
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  function save(event: FormEvent) {
    event.preventDefault()
    const next = toCanonical(raw, unit)
    if (next === null) {
      setError(unit === 'count' ? '请输入大于 0 的整数' : '请输入大于 0 的数字')
      return
    }
    const message = localLimitError(spec.key, next, limits)
    if (message) {
      setError(message)
      return
    }
    if (next === field.value) return
    void commit(next)
  }

  function restore() {
    const message = localLimitError(spec.key, field.default, limits)
    if (message) {
      setError(`${message}。请先调整相关项，再恢复默认。`)
      return
    }
    void commit(null)
  }

  function changeUnit(next: LimitUnit) {
    const parsed = toCanonical(raw, unit)
    setUnit(next)
    if (parsed !== null) setRaw(toInput(parsed, next))
    setError(null)
  }

  return (
    <li data-limit={spec.key} className="border-b border-line-1 px-4 py-4 last:border-b-0 sm:px-5">
      <form onSubmit={save} className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start lg:gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`limit-${spec.key}`} className="text-sm font-medium text-fg">
              {spec.label}
            </label>
            <StatusPill tone={field.overridden ? 'brand' : 'neutral'}>{field.overridden ? '已覆盖' : '未覆盖'}</StatusPill>
          </div>
          <p className="mt-1 text-xs text-fg-3">
            <span>当前 {formatLimit(spec.key, field.value)}</span>
            <span aria-hidden="true"> · </span>
            <span>默认 {formatLimit(spec.key, field.default)}</span>
          </p>
          {spec.hint ? <p className="mt-1 text-xs text-muted-foreground">{spec.hint}</p> : null}
        </div>
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap lg:justify-end">
            <input
              id={`limit-${spec.key}`}
              className={`${fieldClass} w-full tabular-nums sm:w-32`}
              inputMode={unit === 'count' ? 'numeric' : 'decimal'}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              disabled={busy}
              value={raw}
              onChange={(event) => {
                setRaw(event.target.value)
                setError(null)
              }}
            />
            {units.length > 1 ? (
              <select
                className={`${selectClass} w-full sm:w-24`}
                aria-label={`${spec.label}单位`}
                disabled={busy}
                value={unit}
                onChange={(event) => changeUnit(event.target.value as LimitUnit)}
              >
                {units.map((choice) => (
                  <option key={choice} value={choice}>{UNIT_LABEL[choice]}</option>
                ))}
              </select>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" className="h-10 flex-1 sm:flex-none" disabled={busy || unchanged}>保存</Button>
              <Button type="button" variant="outline" className="h-10 flex-1 sm:flex-none" disabled={busy || !field.overridden} onClick={restore}>
                恢复默认
              </Button>
            </div>
          </div>
          {error ? <p id={errorId} role="alert" className="text-xs text-destructive lg:text-right">{error}</p> : null}
        </div>
      </form>
    </li>
  )
}
