import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
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

  const groups = ['容量', '时间', '限流'] as const

  return (
    <div>
      <div className="mb-4 border-l-4 border-primary bg-secondary px-3 py-2 text-sm">
        <p>覆盖值保存在数据库，重启后保留；只读项仍需改环境变量。</p>
        <p className="mt-1 text-xs text-muted-foreground">
          只读项包括 APP_ORIGIN、TRUST_PROXY、DATA_DIR、OAuth 凭据、RATE_TOKEN 和清理间隔。调低上限或配额不会删除已有内容。保留时间只影响新条目和新房间，会话时长只影响新会话。
        </p>
      </div>
      {groups.map((group) => (
        <section key={group} className="mb-6">
          <h2 className="text-xs font-extrabold tracking-widest uppercase">{group}</h2>
          <ul className="border-t-2 border-foreground">
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
        </section>
      ))}
      <section>
        <h2 className="text-xs font-extrabold tracking-widest uppercase">变更记录</h2>
        {auditError ? <p role="alert" className="mt-3 text-sm text-destructive">{auditError}</p> : null}
        {auditLoading ? <p className="mt-3 text-sm text-muted-foreground">正在加载变更记录…</p> : null}
        {!auditLoading && entries.length === 0 && !auditError ? <p className="mt-3 text-sm text-muted-foreground">还没有修改记录。</p> : null}
        {entries.length > 0 ? (
          <ul className="mt-3 border-t-2 border-foreground" aria-label="变更记录">
            {entries.map((entry) => (
              <li key={entry.id} className="grid gap-1 border-b border-foreground py-3 text-sm sm:grid-cols-[minmax(0,1.4fr)_9rem_minmax(0,1.4fr)] sm:items-baseline sm:gap-3">
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
      </section>
    </div>
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
    <li data-limit={spec.key} className="border-b border-foreground py-3">
      <form onSubmit={save}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <label htmlFor={`limit-${spec.key}`} className="text-xs font-extrabold tracking-widest uppercase">
            {spec.label}
          </label>
          <span className={`text-[11px] font-extrabold tracking-widest uppercase ${field.overridden ? 'text-primary' : 'text-muted-foreground'}`}>
            {field.overridden ? '已覆盖' : '未覆盖'}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          <span>当前 {formatLimit(spec.key, field.value)}</span>
          <span aria-hidden="true"> · </span>
          <span>默认 {formatLimit(spec.key, field.default)}</span>
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            id={`limit-${spec.key}`}
            className="min-h-10 w-full border-2 border-foreground bg-background px-2 py-2 text-sm font-medium text-foreground sm:max-w-40"
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
              className="min-h-10 w-full border-2 border-foreground bg-background px-2 py-2 text-sm font-medium sm:w-28"
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
            <Button type="submit" className="min-h-10 flex-1 sm:flex-none" disabled={busy || unchanged}>保存</Button>
            <Button type="button" variant="outline" className="min-h-10 flex-1 sm:flex-none" disabled={busy || !field.overridden} onClick={restore}>
              恢复默认
            </Button>
          </div>
        </div>
        {spec.hint ? <p className="mt-2 text-xs text-muted-foreground">{spec.hint}</p> : null}
        {error ? <p id={errorId} role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      </form>
    </li>
  )
}
