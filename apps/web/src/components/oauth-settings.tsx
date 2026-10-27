import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { api, ApiError, errorText } from '@/lib/api.ts'
import { copyText } from '@/lib/format.ts'
import { formatStamp } from '@/lib/machine.ts'

export type OAuthProviderView = {
  provider: string
  label: string
  consoleUrl: string
  docsUrl: string
  callbackUrl: string
  homepageUrl: string
  source: 'database' | 'env' | 'none'
  enabled: boolean
  active: boolean
  clientId: string
  secretSet: boolean
  secretHint: string | null
  envConfigured: boolean
  updatedAt: number | null
  check: { at: number; ok: boolean; code: string } | null
}
type OAuthView = { origin: string; providers: OAuthProviderView[] }
type CheckResult = { ok: boolean; code: string; checkedAt: number }

const checkLabels: Record<string, string> = {
  CREDENTIALS_OK: 'Client ID / Secret 有效（回调地址在首次真实登录后确认）',
  LOGIN_OK: '已通过真实登录验证（ID、Secret、回调地址均正确）',
  INVALID_CLIENT: 'Client ID 或 Client Secret 不正确',
  REDIRECT_MISMATCH: '回调地址与控制台里登记的不一致',
  REDIRECT_NOT_ALLOWED: 'Google 不接受 http 或纯 IP 的回调地址，需要 https 域名',
  PROVIDER_UNREACHABLE: '服务器连不上该登录服务，稍后再试',
  UNEXPECTED_RESPONSE: '登录服务返回了无法识别的结果',
}

function statusOf(view: OAuthProviderView, check: CheckResult | null) {
  const latest = check ?? view.check
  if (view.source === 'none') return { tone: 'muted', text: '未配置' }
  if (!view.enabled) return { tone: 'muted', text: '已停用' }
  if (latest && !latest.ok) return { tone: 'bad', text: `验证失败：${checkLabels[latest.code] ?? latest.code}` }
  if (latest?.ok) return { tone: 'good', text: checkLabels[latest.code] ?? '验证通过' }
  return { tone: 'muted', text: view.source === 'env' ? '已配置（环境变量），尚未验证' : '已保存，尚未验证' }
}

/**
 * RHEA-190 m11: OAuth 配置 for admins. Shows the exact callback URL to register in
 * each provider console, saves Client ID / Secret on the server (the secret is
 * write-only: the browser only ever sees a masked hint) and checks them.
 */
export function OAuthSettings() {
  const [view, setView] = useState<OAuthView | null>(null)
  const [hidden, setHidden] = useState(false)

  const load = useCallback(async () => {
    try {
      setView(await api<OAuthView>('/api/admin/oauth'))
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 401)) setHidden(true)
      else toast.error(errorText(caught))
    }
  }, [])

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(id)
  }, [load])

  if (hidden || !view) return null
  return (
    <section id="oauth" className="mb-8 scroll-mt-20" aria-labelledby="oauth-title">
      <h2 id="oauth-title" className="mb-1 text-xs font-medium">
        OAuth 配置（管理员）
      </h2>
      <p className="mb-3 text-sm text-muted-foreground">
        在各平台控制台创建 OAuth 应用，把下面的回调地址原样填进去，再把拿到的 Client ID / Secret 填到这里。保存后立即生效，不用重启。Secret 只保存在服务器，页面只显示末尾几位。
      </p>
      <ul className="grid gap-3">
        {view.providers.map((provider) => (
          <ProviderCard key={provider.provider} view={provider} onChange={setView} />
        ))}
      </ul>
    </section>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex gap-2">
        <input readOnly aria-label={label} className="min-w-0 grow rounded-md border border-line-2 bg-surface-2 px-2 py-1 font-mono text-sm" value={value} onFocus={(event) => event.target.select()} />
        <Button type="button" variant="outline" onClick={() => void copyText(value).then(() => toast.success('已复制'))}>
          复制
        </Button>
      </div>
    </div>
  )
}

function ProviderCard({ view, onChange }: { view: OAuthProviderView; onChange: (view: OAuthView) => void }) {
  const [clientId, setClientId] = useState(view.clientId)
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(view.enabled || view.source === 'none')
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const status = statusOf(view, check)
  const isGoogle = view.provider === 'google'

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!clientId.trim()) {
      toast.error('请填写 Client ID')
      return
    }
    if (!secret.trim() && !view.secretSet) {
      toast.error('请填写 Client Secret')
      return
    }
    setBusy(true)
    try {
      const next = await api<OAuthView>(`/api/admin/oauth/${view.provider}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: secret.trim() || undefined, enabled }),
      })
      setSecret('')
      setCheck(null)
      onChange(next)
      toast.success(`${view.label} 已保存，建议点“验证”`)
    } catch (caught) {
      toast.error(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    setBusy(true)
    try {
      const result = await api<CheckResult & OAuthView>(`/api/admin/oauth/${view.provider}/verify`, { method: 'POST' })
      setCheck({ ok: result.ok, code: result.code, checkedAt: result.checkedAt })
      onChange({ origin: result.origin, providers: result.providers })
      if (result.ok) toast.success(`${view.label}：${checkLabels[result.code] ?? '验证通过'}`)
      else toast.error(`${view.label}：${checkLabels[result.code] ?? result.code}`)
    } catch (caught) {
      toast.error(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    setBusy(true)
    try {
      const next = await api<OAuthView>(`/api/admin/oauth/${view.provider}`, { method: 'DELETE' })
      const fresh = next.providers.find((entry) => entry.provider === view.provider)
      setClientId(fresh?.clientId ?? '')
      setEnabled(true)
      setCheck(null)
      setConfirmReset(false)
      onChange(next)
      toast.success(fresh?.source === 'env' ? '已删除页面配置，改用环境变量里的凭据' : '已删除配置')
    } catch (caught) {
      toast.error(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-md border border-line-2 p-4" data-provider={view.provider}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-lg font-semibold">{view.label}</h3>
        <span
          role="status"
          data-tone={status.tone}
          className={`rounded-md border px-2 py-0.5 text-xs ${status.tone === 'good' ? 'border-brand text-fg' : status.tone === 'bad' ? 'border-destructive text-destructive' : 'border-line-2 text-muted-foreground'}`}
        >
          {status.text}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        来源：{view.source === 'database' ? '页面配置' : view.source === 'env' ? '环境变量' : '无'}
        {view.active ? ' · 登录页已显示' : ' · 登录页未显示'}
        {view.check ? ` · 上次验证 ${formatStamp(view.check.at)}` : ''}
      </p>
      <div className="mt-3 grid gap-3">
        <ol className="list-decimal pl-5 text-sm text-muted-foreground">
          <li>
            打开{' '}
            <a className="underline" href={view.consoleUrl} target="_blank" rel="noreferrer">
              {isGoogle ? 'Google Cloud Console → 凭据' : 'GitHub → Settings → Developer settings → OAuth Apps'}
            </a>
            {isGoogle ? '，创建“OAuth 客户端 ID”，类型选“Web 应用”' : '，点“New OAuth App”'}。
          </li>
          <li>{isGoogle ? '“已获授权的重定向 URI”填下面的回调地址（“已获授权的 JavaScript 来源”可填网站地址）。' : '“Homepage URL”填网站地址，“Authorization callback URL”填下面的回调地址。'}</li>
          <li>把生成的 Client ID 和 Client Secret 填到下面，保存后点“验证”。</li>
        </ol>
        <CopyRow label="回调地址（Callback / Redirect URI）" value={view.callbackUrl} />
        <CopyRow label={isGoogle ? '网站地址（JavaScript 来源）' : '网站地址（Homepage URL）'} value={view.homepageUrl} />
        {isGoogle && /^http:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/.test(view.callbackUrl) && (
          <p className="text-xs text-destructive">Google 只接受 https 域名的回调地址（localhost 除外），当前地址不能用于 Google 登录。</p>
        )}
        <form className="grid gap-3" onSubmit={(event) => void save(event)}>
          <label className="text-xs font-medium" htmlFor={`oauth-id-${view.provider}`}>
            Client ID
            <input
              id={`oauth-id-${view.provider}`}
              className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-1 font-mono text-sm normal-case"
              value={clientId}
              maxLength={256}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setClientId(event.target.value)}
            />
          </label>
          <label className="text-xs font-medium" htmlFor={`oauth-secret-${view.provider}`}>
            Client Secret
            <input
              id={`oauth-secret-${view.provider}`}
              type="password"
              className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-1 font-mono text-sm normal-case"
              value={secret}
              maxLength={512}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={view.secretSet ? `已保存 ${view.secretHint ?? ''}，留空则不修改` : '粘贴 Client Secret'}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm normal-case">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            在登录页启用 {view.label}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              保存
            </Button>
            <Button type="button" variant="outline" disabled={busy || view.source === 'none'} onClick={() => void verify()}>
              验证
            </Button>
            {view.source === 'database' ? (
              confirmReset ? (
                <Button type="button" variant="destructive" disabled={busy} onClick={() => void reset()}>
                  {view.envConfigured ? '确认删除（改用环境变量）' : '确认删除'}
                </Button>
              ) : (
                <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmReset(true)}>
                  删除页面配置
                </Button>
              )
            ) : null}
          </div>
        </form>
        <p className="text-xs text-muted-foreground">“验证”会用一个故意无效的授权码调用 {view.label} 的令牌接口：能区分 ID/Secret 是否正确，但回调地址要等第一次真实登录（或在“登录方式”里绑定）成功后才算最终确认。</p>
      </div>
    </li>
  )
}
