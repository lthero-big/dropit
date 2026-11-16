import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Panel, fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { customShareExpiries, defaultShareViews, emptySharePresets, expiryUnits, shareExpiryChoices, type ExpiryUnit, type SharePresets as Presets } from '@/lib/share-presets.ts'

export function SharePresets() {
  const [presets, setPresets] = useState<Presets>(emptySharePresets)
  const [duration, setDuration] = useState('')
  const [unit, setUnit] = useState<ExpiryUnit>('days')
  const [views, setViews] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    api<Presets>('/api/me/share-presets')
      .then((body) => { if (!cancelled) { setPresets({ ...emptySharePresets, ...body }); setLoaded(true) } })
      .catch((error: unknown) => { if (!cancelled) { setFailed(true); toast.error(errorText(error)) } })
    return () => { cancelled = true }
  }, [])

  function add(kind: keyof Presets) {
    const raw = kind === 'views' ? views : duration
    const max = kind === 'views' ? 1000000 : expiryUnits[kind].max
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) {
      toast.error(kind === 'views' ? '次数须为 1 到 1000000 的整数' : `有效期须为 1 到 ${max} 的整数（${expiryUnits[kind].label}）`)
      return
    }
    const duplicate = kind === 'views'
      ? [...defaultShareViews, ...presets.views].includes(value)
      : shareExpiryChoices(presets).some((entry) => entry.hours === value * expiryUnits[kind].hours)
    if (duplicate) {
      toast.error('已有相同的选项')
      return
    }
    if ((kind === 'views' ? presets.views.length : customShareExpiries(presets).length) >= 20) {
      toast.error('每类最多添加 20 个选项')
      return
    }
    setPresets((current) => ({ ...current, [kind]: [...current[kind], value].sort((a, b) => a - b) }))
    setDirty(true)
    if (kind === 'views') setViews('')
    else setDuration('')
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !loaded) return
    setBusy(true)
    try {
      const saved = await api<Presets>('/api/me/share-presets', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(presets),
      })
      setPresets({ ...emptySharePresets, ...saved })
      setDirty(false)
      toast.success('分享选项已保存')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel id="share-presets" title="分享选项" description="添加常用的分享有效期和查看次数，保存后可在创建分享时选择。选项随账号保存，仅影响新建分享；原条目到期或撤回后，分享仍会失效。">
      {!loaded && !failed ? <p className="mb-3 text-sm text-muted-foreground">正在加载分享选项…</p> : null}
      {failed ? <p role="alert" className="text-sm text-destructive">分享选项加载失败，请刷新页面重试。</p> : null}
      <form onSubmit={(event) => void save(event)}>
        <fieldset disabled={!loaded || busy} className="grid gap-5 disabled:opacity-60">
          <div className="grid gap-2">
            <p className="text-sm font-medium">有效期</p>
            <p className="text-xs text-muted-foreground">内置：1 小时、1 天、3 天、7 天、不过期。自定义有效期最多 20 个，最长 3650 天；1 个月按 30 天计算。</p>
            <div className="flex flex-wrap gap-2">
              {customShareExpiries(presets).map(({ kind, value, label }) => (
                <Button key={`${kind}-${value}`} type="button" variant="outline" size="sm" aria-label={`移除 ${label}`} onClick={() => {
                  setPresets((current) => ({ ...current, [kind]: current[kind].filter((entry) => entry !== value) }))
                  setDirty(true)
                }}>{label} ×</Button>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className={`${labelClass} w-32 max-w-full`}>
                自定义有效期
                <input className={fieldClass} type="number" inputMode="numeric" min="1" max={expiryUnits[unit].max} step="1" value={duration} onChange={(event) => setDuration(event.target.value)} />
              </label>
              <label className={`${labelClass} w-24`}>
                单位
                <select className={fieldClass} value={unit} onChange={(event) => setUnit(event.target.value as ExpiryUnit)}>
                  {(Object.keys(expiryUnits) as ExpiryUnit[]).map((kind) => <option key={kind} value={kind}>{expiryUnits[kind].label}</option>)}
                </select>
              </label>
              <Button type="button" variant="outline" onClick={() => add(unit)}>添加有效期</Button>
            </div>
          </div>
          <div className="grid gap-2">
            <p className="text-sm font-medium">查看次数</p>
            <p className="text-xs text-muted-foreground">内置：1、5、10 次、不限。自定义 1–1000000 次，最多添加 20 个选项。</p>
            <div className="flex flex-wrap gap-2">
              {presets.views.map((value) => (
                <Button key={value} type="button" variant="outline" size="sm" aria-label={`移除 ${value} 次`} onClick={() => {
                  setPresets((current) => ({ ...current, views: current.views.filter((entry) => entry !== value) }))
                  setDirty(true)
                }}>{value} 次 ×</Button>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className={`${labelClass} w-48 max-w-full`}>
                自定义次数
                <input className={fieldClass} type="number" inputMode="numeric" min="1" max="1000000" step="1" value={views} onChange={(event) => setViews(event.target.value)} />
              </label>
              <Button type="button" variant="outline" onClick={() => add('views')}>添加次数</Button>
            </div>
          </div>
          <div><Button type="submit" disabled={!dirty}>{busy ? '正在保存…' : '保存分享选项'}</Button></div>
        </fieldset>
      </form>
    </Panel>
  )
}
