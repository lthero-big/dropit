import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { ArrowRightIcon, KeyRoundIcon, KeySquareIcon, MonitorSmartphoneIcon, PlusIcon, ShieldIcon, SquareTerminalIcon, UserRoundIcon } from 'lucide-react'
import { toast } from 'sonner'
import { DeviceConfirm } from '@/components/device-confirm.tsx'
import { DeviceSessions } from '@/components/device-sessions.tsx'
import { LoginMethods } from '@/components/login-methods.tsx'
import { ChoiceChip, Facts, NavLinkOut, Panel, SettingRow, SettingsLayout, SideNav, StatusPill, fieldClass, labelClass, selectClass, type NavGroup } from '@/components/settings-ui.tsx'
import { PageTitle, Shell } from '@/components/shell.tsx'
import { UpdateNotice } from '@/components/update-panel.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { copyText, formatWhen, useClock } from '@/lib/format.ts'
import { formatStamp, rememberReturn, scopeLabel } from '@/lib/machine.ts'
import { useSession } from '@/lib/session.tsx'
import type { AccessToken } from '@/lib/types.ts'

const expiryChoices = [
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '1 年' },
  { value: 'never', label: '永不' },
  { value: 'custom', label: '自定义' },
]

type SectionId = 'login-methods' | 'devices' | 'device-code' | 'tokens'
const SECTION_IDS: SectionId[] = ['login-methods', 'devices', 'device-code', 'tokens']
const SETTINGS_NAV: NavGroup<SectionId>[] = [
  {
    label: '账户',
    items: [
      { id: 'login-methods', label: '登录方式', icon: UserRoundIcon, hint: '绑定 GitHub / Google' },
      { id: 'devices', label: '登录设备', icon: MonitorSmartphoneIcon, hint: '已登录的浏览器' },
    ],
  },
  {
    label: '命令行与 API',
    items: [
      { id: 'device-code', label: '设备码', icon: SquareTerminalIcon, hint: '确认终端登录' },
      { id: 'tokens', label: '访问令牌', icon: KeySquareIcon, hint: '个人访问令牌' },
    ],
  },
]

function tokenState(token: AccessToken, now: number): string {
  if (token.revoked) return '已撤销'
  if (token.expiresAt !== null && token.expiresAt <= now) return '已过期'
  return '有效'
}

export function SettingsPage() {
  const { status, me, refresh } = useSession()
  const now = useClock(0)
  const [tokens, setTokens] = useState<AccessToken[]>([])
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [read, setRead] = useState(true)
  const [write, setWrite] = useState(true)
  const [expiry, setExpiry] = useState('90')
  const [customDays, setCustomDays] = useState('7')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null)
  const [section, setSection] = useState<SectionId>(() => {
    const anchor = window.location.hash.slice(1) as SectionId
    return SECTION_IDS.includes(anchor) ? anchor : 'login-methods'
  })
  const navigate = useNavigate()

  const load = useCallback(async () => {
    const body = await api<{ tokens: AccessToken[] }>('/api/tokens')
    setTokens(body.tokens)
  }, [])

  useEffect(() => {
    if (status !== 'anon') return
    rememberReturn(`${window.location.pathname}${window.location.search}`)
  }, [status])

  useEffect(() => {
    if (!me) return
    let cancelled = false
    load().catch((error: unknown) => {
      if (!cancelled) toast.error(errorText(error))
    })
    return () => {
      cancelled = true
    }
  }, [load, me])

  useEffect(() => {
    const anchor = window.location.hash.slice(1)
    if (!me) return
    // RHEA-190 m22: OAuth moved to 管理. Old links to /settings#oauth land there.
    if (anchor === 'oauth' && me.user.role === 'admin') {
      navigate('/admin?tab=oauth', { replace: true })
      return
    }
    if (!['devices', 'login-methods', 'device-code', 'tokens'].includes(anchor)) return
    const id = window.setTimeout(() => document.getElementById(anchor)?.scrollIntoView?.({ block: 'start' }), 50)
    return () => window.clearTimeout(id)
  }, [me, navigate])

  // Follow the scroll position so the side nav shows where you are.
  useEffect(() => {
    if (!me || typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver(
      (records) => {
        const visible = records.filter((record) => record.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible && SECTION_IDS.includes(visible.target.id as SectionId)) setSection(visible.target.id as SectionId)
      },
      { rootMargin: '-96px 0px -60% 0px' },
    )
    const timer = window.setTimeout(() => {
      for (const id of SECTION_IDS) {
        const el = document.getElementById(id)
        if (el) observer.observe(el)
      }
    }, 100)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [me])

  function jumpTo(id: SectionId) {
    setSection(id)
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(id)?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    window.history.replaceState(null, '', `#${id}`)
  }

  useEffect(() => {
    if (!creating || secret) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setCreating(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [creating, secret])

  function closeDialog() {
    setCreating(false)
    setSecret(null)
    setName('')
    setRead(true)
    setWrite(true)
    setExpiry('90')
    setCustomDays('7')
  }

  async function createToken(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('名称不能为空')
      return
    }
    const scopes: ('read' | 'write')[] = []
    if (read) scopes.push('read')
    if (write) scopes.push('write')
    if (!scopes.length) {
      toast.error('至少选择一项权限')
      return
    }
    let expiresInDays: number | null
    if (expiry === 'never') expiresInDays = null
    else if (expiry === 'custom') {
      if (!/^\d+$/.test(customDays)) {
        toast.error('有效期无效')
        return
      }
      expiresInDays = Number(customDays)
      if (expiresInDays < 1 || expiresInDays > 3650) {
        toast.error('有效期须在 1 到 3650 天之间')
        return
      }
    } else expiresInDays = Number(expiry)
    setBusy(true)
    try {
      const created = await api<AccessToken & { token: string }>('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, scopes, expiresInDays }),
      })
      setSecret(created.token)
      await load()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function rename(id: string) {
    const trimmed = draft.trim()
    if (!trimmed) {
      toast.error('名称不能为空')
      return
    }
    try {
      await api(`/api/tokens/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      setEditing(null)
      await load()
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/api/tokens/${id}`, { method: 'DELETE' })
      setPendingRevoke(null)
      await load()
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  if (status === 'loading') return <main className="px-6 py-16 text-sm text-muted-foreground">正在连接…</main>
  if (status === 'error') {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-3xl font-semibold">无法连接</h1>
        <Button type="button" className="mt-6" onClick={() => void refresh()}>
          重试
        </Button>
      </main>
    )
  }
  if (!me) {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6 py-16">
        <h1 className="text-4xl font-semibold">请先登录</h1>
        <p className="mt-4 text-sm text-muted-foreground">登录后可以确认设备码，并管理个人访问令牌。</p>
        <Link to="/login" className="mt-6 text-sm font-medium">
          登录后继续
        </Link>
      </main>
    )
  }

  return (
    <Shell>
      <PageTitle title="设置" sub="你自己的账号：登录方式、登录设备、设备码和个人访问令牌。站点级配置在「管理」里。" />
      {me.user.role === 'admin' ? <UpdateNotice /> : null}
      <SettingsLayout
        nav={
          <SideNav
            label="设置分类"
            groups={SETTINGS_NAV}
            active={section}
            onSelect={jumpTo}
            mode="anchors"
            footer={
              me.user.role === 'admin' ? (
                <div className="grid gap-0.5">
                  <p className="px-2.5 pb-1 text-[11px] font-semibold tracking-wide text-fg-4">站点管理</p>
                  <NavLinkOut to="/admin?tab=oauth" icon={KeyRoundIcon}>
                    OAuth 登录配置
                  </NavLinkOut>
                  <NavLinkOut to="/admin" icon={ShieldIcon}>
                    管理后台
                  </NavLinkOut>
                </div>
              ) : null
            }
          />
        }
      >
        <LoginMethods />
        <Panel id="devices" title="登录设备" description="所有登录了这个账号的浏览器。可以单独登出某一台，或一次登出其他所有设备。">
          <DeviceSessions onSelfSignedOut={() => void refresh().then(() => window.location.assign('/login'))} />
        </Panel>
        <DeviceConfirm initialCode="" initialVerificationId={null} auto={false} />
        <Panel
          id="tokens"
          title="访问令牌"
          description="给命令行、脚本或其他程序用的个人令牌。明文只在创建时显示一次。"
          actions={
            <Button type="button" onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" />
              创建令牌
            </Button>
          }
        >
          {tokens.length === 0 ? <p className="rounded-md border border-dashed border-line-2 p-4 text-sm text-muted-foreground">还没有令牌。用设备码登录，或手动创建一个。</p> : null}
          <ul className="grid gap-3">
            {tokens.map((token) => {
              const state = tokenState(token, now)
              const active = state === '有效'
              return (
                <li key={token.id} className={`rounded-md border border-line-1 bg-surface-0 p-4 ${active ? '' : 'text-fg-3'}`} data-token-id={token.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    {editing === token.id ? (
                      <form
                        className="flex grow flex-col gap-2 sm:flex-row"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void rename(token.id)
                        }}
                      >
                        <label className="sr-only" htmlFor={`rename-${token.id}`}>
                          新名称
                        </label>
                        <input id={`rename-${token.id}`} className={`${fieldClass} grow`} value={draft} maxLength={80} onChange={(event) => setDraft(event.target.value)} />
                        <Button type="submit" className="h-10">
                          保存
                        </Button>
                        <Button type="button" variant="outline" className="h-10" onClick={() => setEditing(null)}>
                          取消
                        </Button>
                      </form>
                    ) : (
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold break-all text-fg">{token.name}</h3>
                        <StatusPill tone={active ? 'good' : 'neutral'}>{state}</StatusPill>
                      </div>
                    )}
                    {editing === token.id ? null : (
                      <div className="flex flex-wrap gap-2">
                        {active ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditing(token.id)
                              setDraft(token.name)
                              setPendingRevoke(null)
                            }}
                          >
                            改名
                          </Button>
                        ) : null}
                        {token.revoked ? null : pendingRevoke === token.id ? (
                          <Button type="button" variant="destructive" size="sm" onClick={() => void revoke(token.id)}>
                            确认撤销
                          </Button>
                        ) : (
                          <Button type="button" variant="destructive" size="sm" onClick={() => setPendingRevoke(token.id)}>
                            撤销
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  <Facts
                    className="mt-3 border-t border-line-1 pt-3"
                    items={[
                      { label: '范围', value: token.scopes.map(scopeLabel).join('、') },
                      { label: '创建', value: formatWhen(token.createdAt, now) },
                      { label: '最近使用', value: token.lastUsedAt === null ? '从未使用' : formatStamp(token.lastUsedAt) },
                      { label: '过期', value: token.expiresAt === null ? '永不' : formatStamp(token.expiresAt) },
                    ]}
                  />
                </li>
              )
            })}
          </ul>
        </Panel>
        {me.user.role === 'admin' ? (
          <Panel title="站点设置" description="OAuth 登录（GitHub / Google 应用凭据）是整个站点的配置，已移到「管理 → 登录与安全」。" flush data-admin-moved="">
            <SettingRow title="OAuth 登录配置" description="回调地址、Client ID / Secret、启用与验证">
              <Button type="button" variant="outline" asChild>
                <Link to="/admin?tab=oauth">
                  前往管理
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
            </SettingRow>
          </Panel>
        ) : null}
      </SettingsLayout>

      {creating ? (
        <div
          className="fixed inset-0 z-30 grid place-items-end bg-foreground/40 p-0 sm:place-items-center sm:p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !secret) closeDialog()
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="create-token-title" className="max-h-svh w-full max-w-lg overflow-y-auto rounded-t-lg border border-line-2 bg-surface-1 p-5 shadow-elev-3 sm:rounded-lg">
            <h2 id="create-token-title" className="text-xl font-semibold text-fg">
              {secret ? '保存令牌' : '创建令牌'}
            </h2>
            {secret ? (
              <div className="mt-4">
                <p className="rounded-md border-l-2 border-l-brand bg-brand-soft px-3 py-2 text-sm">只显示这一次。关闭后无法再查看，请立即复制并保存。</p>
                <label className={`mt-4 ${labelClass}`} htmlFor="fresh-token">
                  令牌
                  <input id="fresh-token" className={`${fieldClass} font-mono`} readOnly value={secret} onFocus={(event) => event.target.select()} />
                </label>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => {
                      void copyText(secret).then(() => toast.success('已复制。请立即保存，关闭后无法再查看。'))
                    }}
                  >
                    复制
                  </Button>
                  <Button type="button" variant="outline" onClick={closeDialog}>
                    关闭
                  </Button>
                </div>
              </div>
            ) : (
              <form className="mt-4 grid gap-4" onSubmit={(event) => void createToken(event)}>
                <label className={labelClass} htmlFor="token-name">
                  名称
                  <input
                    id="token-name"
                    className={fieldClass}
                    value={name}
                    maxLength={80}
                    autoFocus
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <fieldset className="grid gap-1.5">
                  <legend className="mb-1.5 text-xs font-medium text-fg-2">范围</legend>
                  <div className="flex flex-wrap gap-2">
                    <ChoiceChip label="读取" checked={read} onChange={(event) => setRead(event.target.checked)} />
                    <ChoiceChip label="写入" checked={write} onChange={(event) => setWrite(event.target.checked)} />
                  </div>
                </fieldset>
                <label className={labelClass} htmlFor="token-expiry">
                  有效期
                  <select
                    id="token-expiry"
                    className={selectClass}
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value)}
                  >
                    {expiryChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
                {expiry === 'custom' ? (
                  <label className={labelClass} htmlFor="token-days">
                    天数
                    <input
                      id="token-days"
                      className={fieldClass}
                      inputMode="numeric"
                      value={customDays}
                      onChange={(event) => setCustomDays(event.target.value)}
                    />
                  </label>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy}>
                    创建
                  </Button>
                  <Button type="button" variant="outline" onClick={closeDialog}>
                    取消
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </Shell>
  )
}
