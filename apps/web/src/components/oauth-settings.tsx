import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { ArrowUpRightIcon, CopyIcon } from 'lucide-react'
import { ProviderIcon } from '@/components/brand-icons.tsx'
import { Note, Panel, StatusPill, SubTabs, Switch, fieldClass, labelClass } from '@/components/settings-ui.tsx'
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
  // RHEA-190 m24: GitHub / Google are sub-tabs; #oauth-google links open that tab.
  const [active, setActive] = useState(hashProvider)

  useEffect(() => {
    const sync = () => {
      const provider = hashProvider()
      if (provider) setActive(provider)
    }
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

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
  const providers = view.providers
  const current = providers.some((entry) => entry.provider === active) ? active : providers[0]?.provider ?? ''

  function select(provider: string) {
    setActive(provider)
    const { pathname, search } = window.location
    window.history.replaceState(window.history.state, '', `${pathname}${search}#oauth-${provider}`)
  }

  return (
    <div id="oauth" role="region" aria-label="OAuth 配置" className="scroll-mt-24">
      <div className="mb-5">
        <Note>
          在各平台控制台创建 OAuth 应用，把下面的回调地址原样填进去，再把拿到的 Client ID / Secret 填到这里。保存后立即生效，不用重启。Secret 只保存在服务器，页面只显示末尾几位。
        </Note>
      </div>
      {providers.length > 1 ? (
        <SubTabs
          label="OAuth 提供方"
          active={current}
          onSelect={select}
          items={providers.map((entry) => ({
            id: `oauth-${entry.provider}`,
            value: entry.provider,
            label: entry.label,
            name: entry.label,
            icon: <ProviderIcon provider={entry.provider} className="size-4" />,
            hint: entry.source === 'none' ? '未配置' : entry.active ? '登录页已显示' : '登录页未显示',
          }))}
        />
      ) : null}
      {providers.map((provider) => (
        <ProviderCard key={provider.provider} view={provider} onChange={setView} tabbed={providers.length > 1} hidden={providers.length > 1 && provider.provider !== current} />
      ))}
    </div>
  )
}

function hashProvider(): string {
  return typeof window === 'undefined' ? '' : (/^#oauth-(.+)$/.exec(window.location.hash)?.[1] ?? '')
}

export function CopyRow({ label, value }: { label: string; value: string }) {
  const id = useId()
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-fg-2">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          className="min-h-10 min-w-0 grow rounded-md border border-dashed border-line-2 bg-surface-2 px-3 py-2 font-mono text-[13px] text-fg-2 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/35"
          value={value}
          onFocus={(event) => event.target.select()}
        />
        <Button type="button" variant="outline" className="h-10" onClick={() => void copyText(value).then(() => toast.success('已复制'))}>
          <CopyIcon aria-hidden="true" />
          复制
        </Button>
      </div>
    </div>
  )
}

function ProviderCard({ view, onChange, tabbed = false, hidden = false }: { view: OAuthProviderView; onChange: (view: OAuthView) => void; tabbed?: boolean; hidden?: boolean }) {
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
    <Panel
      id={`oauth-${view.provider}`}
      data-provider={view.provider}
      {...(tabbed ? { role: 'tabpanel', 'aria-labelledby': `oauth-${view.provider}-tab` } : {})}
      hidden={hidden}
      title={
        <span className="inline-flex items-center gap-2">
          <ProviderIcon provider={view.provider} className="size-4" />
          {view.label}
        </span>
      }
      description={
        <>
          来源：{view.source === 'database' ? '页面配置' : view.source === 'env' ? '环境变量' : '无'}
          {view.active ? ' · 登录页已显示' : ' · 登录页未显示'}
          {view.check ? ` · 上次验证 ${formatStamp(view.check.at)}` : ''}
        </>
      }
      actions={
        <StatusPill role="status" tone={status.tone === 'good' ? 'good' : status.tone === 'bad' ? 'bad' : 'neutral'} className="max-w-[22rem] whitespace-normal">
          {status.text}
        </StatusPill>
      }
    >
      <div className="grid gap-5">
        <div className="rounded-md bg-surface-0 p-3.5 ring-1 ring-line-1">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-fg-2">第 1 步 · 在 {view.label} 创建 OAuth 应用</p>
            <Button type="button" variant="outline" size="sm" asChild>
              <a href={view.consoleUrl} target="_blank" rel="noreferrer">
                打开控制台
                <ArrowUpRightIcon aria-hidden="true" />
              </a>
            </Button>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-[13px] text-fg-3">
            <li>
              打开{' '}
              <a className="font-medium text-fg-2 underline underline-offset-2 hover:text-fg" href={view.consoleUrl} target="_blank" rel="noreferrer">
                {isGoogle ? 'Google Cloud Console → 凭据' : 'GitHub → Settings → Developer settings → OAuth Apps'}
              </a>
              {isGoogle ? '，创建“OAuth 客户端 ID”，类型选“Web 应用”' : '，点“New OAuth App”'}。
            </li>
            <li>{isGoogle ? '“已获授权的重定向 URI”填下面的回调地址（“已获授权的 JavaScript 来源”可填网站地址）。' : '“Homepage URL”填网站地址，“Authorization callback URL”填下面的回调地址。'}</li>
            <li>把生成的 Client ID 和 Client Secret 填到下面，保存后点“验证”。</li>
          </ol>
        </div>
        <div className="grid gap-3">
          <p className="text-xs font-semibold text-fg-2">第 2 步 · 复制到控制台</p>
          <CopyRow label="回调地址（Callback / Redirect URI）" value={view.callbackUrl} />
          <CopyRow label={isGoogle ? '网站地址（JavaScript 来源）' : '网站地址（Homepage URL）'} value={view.homepageUrl} />
          {isGoogle && /^http:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/.test(view.callbackUrl) && (
            <Note tone="warn">Google 只接受 https 域名的回调地址（localhost 除外），当前地址不能用于 Google 登录。</Note>
          )}
        </div>
        <form className="grid gap-3" onSubmit={(event) => void save(event)}>
          <p className="text-xs font-semibold text-fg-2">第 3 步 · 填入凭据</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelClass} htmlFor={`oauth-id-${view.provider}`}>
              Client ID
              <input
                id={`oauth-id-${view.provider}`}
                className={`${fieldClass} font-mono`}
                value={clientId}
                maxLength={256}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setClientId(event.target.value)}
              />
            </label>
            <label className={labelClass} htmlFor={`oauth-secret-${view.provider}`}>
              Client Secret
              <input
                id={`oauth-secret-${view.provider}`}
                type="password"
                className={`${fieldClass} font-mono`}
                value={secret}
                maxLength={512}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={view.secretSet ? `已保存 ${view.secretHint ?? ''}，留空则不修改` : '粘贴 Client Secret'}
                onChange={(event) => setSecret(event.target.value)}
              />
            </label>
          </div>
          <Switch label={`在登录页启用 ${view.label}`} description="关闭后保留凭据，但登录页不再显示这个按钮" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-line-1 pt-4">
            <Button type="submit" disabled={busy}>
              保存
            </Button>
            <Button type="button" variant="outline" disabled={busy || view.source === 'none'} onClick={() => void verify()}>
              验证
            </Button>
            {view.source === 'database' ? (
              confirmReset ? (
                <>
                  <Button type="button" variant="destructive" className="sm:ml-auto" disabled={busy} onClick={() => void reset()}>
                    {view.envConfigured ? '确认删除（改用环境变量）' : '确认删除'}
                  </Button>
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirmReset(false)}>
                    取消
                  </Button>
                </>
              ) : (
                <Button type="button" variant="ghost" className="text-destructive sm:ml-auto" disabled={busy} onClick={() => setConfirmReset(true)}>
                  删除页面配置
                </Button>
              )
            ) : null}
          </div>
        </form>
        <p className="text-xs text-muted-foreground">“验证”会用一个故意无效的授权码调用 {view.label} 的令牌接口：能区分 ID/Secret 是否正确，但回调地址要等第一次真实登录（或在“登录方式”里绑定）成功后才算最终确认。</p>
      </div>
    </Panel>
  )
}
