import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Panel, fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { defaultShareDays, defaultShareViews, emptySharePresets, type SharePresets as Presets } from '@/lib/share-presets.ts'

export function SharePresets() {
  const [presets, setPresets] = useState<Presets>(emptySharePresets)
  const [days, setDays] = useState('')
  const [views, setViews] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    api<Presets>('/api/me/share-presets')
      .then((body) => { if (!cancelled) { setPresets(body); setLoaded(true) } })
      .catch((error: unknown) => { if (!cancelled) { setFailed(true); toast.error(errorText(error)) } })
    return () => { cancelled = true }
  }, [])

  function add(kind: keyof Presets) {
    const raw = kind === 'days' ? days : views
    const max = kind === 'days' ? 3650 : 1000000
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) {
      toast.error(kind === 'days' ? '天数须为 1 到 3650 的整数' : '次数须为 1 到 1000000 的整数')
      return
    }
    const defaults = kind === 'days' ? defaultShareDays : defaultShareViews
    if (defaults.includes(value) || presets[kind].includes(value)) {
      toast.error('已有相同的选项')
      return
    }
    if (presets[kind].length >= 20) {
      toast.error('每类最多添加 20 个选项')
      return
    }
    setPresets((current) => ({ ...current, [kind]: [...current[kind], value].sort((a, b) => a - b) }))
    setDirty(true)
    if (kind === 'days') setDays('')
    else setViews('')
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !loaded) return
    setBusy(true)
    try {
      const saved = await api<Presets>('/api/me/share-presets', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(presets),
      })
      setPresets(saved)
      setDirty(false)
      toast.success('分享选项已保存')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel id="share-presets" title="分享选项" description="添加常用的分享天数和查看次数，保存后可在创建分享时选择。选项随账号保存，仅影响新建分享；原条目到期或撤回后，分享仍会失效。">
      {!loaded && !failed ? <p className="mb-3 text-sm text-muted-foreground">正在加载分享选项…</p> : null}
      {failed ? <p role="alert" className="text-sm text-destructive">分享选项加载失败，请刷新页面重试。</p> : null}
      <form onSubmit={(event) => void save(event)}>
        <fieldset disabled={!loaded || busy} className="grid gap-5 disabled:opacity-60">
          {(['days', 'views'] as const).map((kind) => (
            <div key={kind} className="grid gap-2">
              <p className="text-sm font-medium">{kind === 'days' ? '有效期天数' : '查看次数'}</p>
              <p className="text-xs text-muted-foreground">{kind === 'days' ? '内置：1 小时、1 天、7 天、不过期。自定义 1–3650 天。' : '内置：1、5、10 次、不限。自定义 1–1000000 次。'}每类最多添加 20 个选项。</p>
              <div className="flex flex-wrap gap-2">
                {presets[kind].map((value) => (
                  <Button key={value} type="button" variant="outline" size="sm" aria-label={`移除 ${value} ${kind === 'days' ? '天' : '次'}`} onClick={() => {
                    setPresets((current) => ({ ...current, [kind]: current[kind].filter((entry) => entry !== value) }))
                    setDirty(true)
                  }}>{value} {kind === 'days' ? '天' : '次'} ×</Button>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className={`${labelClass} w-48 max-w-full`}>
                  {kind === 'days' ? '自定义天数' : '自定义次数'}
                  <input className={fieldClass} type="number" inputMode="numeric" min="1" max={kind === 'days' ? 3650 : 1000000} step="1" value={kind === 'days' ? days : views} onChange={(event) => {
                    if (kind === 'days') setDays(event.target.value)
                    else setViews(event.target.value)
                  }} />
                </label>
                <Button type="button" variant="outline" onClick={() => add(kind)}>{kind === 'days' ? '添加天数' : '添加次数'}</Button>
              </div>
            </div>
          ))}
          <div><Button type="submit" disabled={!dirty}>{busy ? '正在保存…' : '保存分享选项'}</Button></div>
        </fieldset>
      </form>
    </Panel>
  )
}
