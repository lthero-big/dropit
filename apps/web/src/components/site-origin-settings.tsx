import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { CopyRow } from '@/components/oauth-settings.tsx'
import { Facts, Note, Panel, StatusPill, fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { ApiError, api, errorText } from '@/lib/api.ts'
import { normalizeOrigin, originMismatch, sourceLabel, type SiteSettings } from '@/lib/site.ts'

/**
 * RHEA-190 auth step 1: 管理 → 站点地址 (APP_ORIGIN). Saved here it overrides the
 * environment variable; cleared, the environment value (or the browser's address) applies.
 */
export function SiteOriginSettings() {
  const [view, setView] = useState<SiteSettings | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ origin: string | null; target: string } | null>(null)
  const current = typeof window === 'undefined' ? '' : window.location.origin

  function apply(next: SiteSettings) {
    setView(next)
    setValue(next.adminOrigin ?? '')
  }

  useEffect(() => {
    let cancelled = false
    api<SiteSettings>('/api/admin/site')
      .then((body) => {
        if (!cancelled) apply(body)
      })
      .catch((error: unknown) => toast.error(errorText(error)))
    return () => {
      cancelled = true
    }
  }, [])

  const trimmed = value.trim()
  const normalized = trimmed ? normalizeOrigin(trimmed) : null
  const invalid = Boolean(trimmed) && !normalized

  async function send(origin: string | null, confirm: boolean) {
    setBusy(true)
    try {
      const next = await api<SiteSettings>('/api/admin/site', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin, ...(confirm ? { confirm: true } : {}) }),
      })
      apply(next)
      setPending(null)
      if (next.effectiveOrigin !== current) toast.success(`已保存。请改用 ${next.effectiveOrigin} 访问`)
      else toast.success(origin ? '站点地址已保存' : '已清除页面设置')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ORIGIN_CONFIRM_REQUIRED') {
        setPending({ origin, target: error.details?.origin ?? origin ?? '' })
      } else toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  function save(event: FormEvent) {
    event.preventDefault()
    if (invalid) return
    void send(normalized, false)
  }

  if (!view) return <p className="text-sm text-muted-foreground">正在读取…</p>
  const mismatch = originMismatch(view, current)
  const httpInProduction = view.production && view.effectiveOrigin.startsWith('http:')

  return (
    <div id="site" role="region" aria-label="站点地址" className="scroll-mt-24">
      <Panel
        title="当前生效"
        description="浏览器访问本站用的地址。防跨站请求检查、OAuth 回调、邀请 / 分享 / 临时房间链接和命令行登录（/device）都用它。"
        actions={
          <StatusPill role="status" tone={mismatch ? 'bad' : 'good'}>
            {mismatch ? '与当前访问地址不一致' : '与当前访问地址一致'}
          </StatusPill>
        }
      >
        <div className="grid gap-4">
          <Facts
            items={[
              { label: '生效地址', value: <code data-site-effective="">{view.effectiveOrigin}</code> },
              { label: '来源', value: <span data-site-source={view.source}>{sourceLabel[view.source]}</span> },
              { label: '页面设置', value: view.adminOrigin ?? '未设置' },
              { label: '环境变量 APP_ORIGIN', value: view.envOrigin ?? '未设置' },
              { label: '浏览器当前地址', value: current },
            ]}
          />
          {mismatch ? <Note tone="warn">{mismatch}</Note> : null}
          {view.source === 'request' ? (
            <Note>
              没有固定地址时，任何能访问到这台服务器的地址（IP、局域网域名、localhost）都能直接使用，跨站请求仍会被拒绝。确定正式域名后建议在下面保存，这样生成的链接和 OAuth 回调始终是同一个地址。
            </Note>
          ) : null}
          {httpInProduction ? (
            <Note tone="warn">当前是 http 地址：登录 Cookie 不带 Secure 标记。如果站点对公网开放，建议用反向代理加上 https，再把地址改成 https://…</Note>
          ) : null}
        </div>
      </Panel>
      <Panel title="修改站点地址" description="优先级：这里的设置 > 环境变量 APP_ORIGIN > 自动使用访问地址。保存后立即生效，不用重启。">
        <form className="grid gap-3" onSubmit={save}>
          <label className={labelClass} htmlFor="site-origin">
            站点地址（协议 + 域名或 IP + 端口，不要带路径）
            <input
              id="site-origin"
              className={`${fieldClass} font-mono`}
              value={value}
              placeholder={view.envOrigin ?? 'https://dropit.example.com'}
              maxLength={300}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? 'site-origin-error' : undefined}
              onChange={(event) => {
                setValue(event.target.value)
                setPending(null)
              }}
            />
          </label>
          {invalid ? (
            <p id="site-origin-error" role="alert" className="text-xs text-destructive">
              格式不对。示例：https://dropit.example.com 或 http://192.168.1.10:8787（不能带路径、参数）
            </p>
          ) : null}
          {pending ? (
            <div role="alertdialog" aria-label="确认修改站点地址" className="grid gap-2 rounded-md bg-surface-2 p-3 text-[13px] text-fg-2">
              <p>
                保存后只接受来自 <code>{pending.target}</code> 的请求，当前地址 <code>{current}</code> 上的操作会被拒绝，OAuth 登录也会回到新地址。请确认新地址能打开。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="destructive" disabled={busy} onClick={() => void send(pending.origin, true)}>
                  确认保存
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
                  取消
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 border-t border-line-1 pt-4">
            <Button type="submit" disabled={busy || invalid || !trimmed}>
              保存
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setValue(current)}>
              填入当前地址
            </Button>
            {view.adminOrigin ? (
              <Button type="button" variant="ghost" className="text-destructive sm:ml-auto" disabled={busy} onClick={() => void send(null, false)}>
                清除页面设置（{view.envOrigin ? '改用环境变量' : '改为自动'}）
              </Button>
            ) : null}
          </div>
        </form>
      </Panel>
      <Panel title="OAuth 回调地址" description="在 GitHub / Google 控制台登记的回调地址必须和这里完全一致。修改站点地址后，记得到控制台同步更新。">
        <div className="grid gap-3" data-site-callbacks="">
          {view.callbacks.map((callback) => (
            <CopyRow key={callback.provider} label={`${callback.label} 回调地址`} value={callback.url} />
          ))}
        </div>
      </Panel>
    </div>
  )
}
