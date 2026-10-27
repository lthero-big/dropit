import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { DeviceConfirm } from '@/components/device-confirm.tsx'
import { DeviceSessions } from '@/components/device-sessions.tsx'
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
    if (!me || window.location.hash !== '#devices') return
    const id = window.setTimeout(() => document.getElementById('devices')?.scrollIntoView?.({ block: 'start' }), 50)
    return () => window.clearTimeout(id)
  }, [me])

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
      <PageTitle title="设置" sub="管理登录设备，确认设备码，或手动创建个人访问令牌。明文只显示一次。" />
      {me.user.role === 'admin' ? <UpdateNotice /> : null}
      <section id="devices" className="mb-8 scroll-mt-20">
        <h2 className="mb-3 text-xs font-medium">登录设备</h2>
        <DeviceSessions onSelfSignedOut={() => void refresh().then(() => window.location.assign('/login'))} />
      </section>
      <DeviceConfirm initialCode="" initialVerificationId={null} auto={false} />
      <section className="mt-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xs font-medium">令牌</h2>
          <Button type="button" onClick={() => setCreating(true)}>
            创建令牌
          </Button>
        </div>
        {tokens.length === 0 ? <p className="rounded-md border border-line-2 p-4 text-sm text-muted-foreground">还没有令牌。用设备码登录，或手动创建一个。</p> : null}
        <ul className="grid gap-3">
          {tokens.map((token) => {
            const state = tokenState(token, now)
            const active = state === '有效'
            return (
              <li key={token.id} className="rounded-md border border-line-2 p-4">
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
                      <input
                        id={`rename-${token.id}`}
                        className="grow rounded-md border border-line-2 bg-background px-2 py-1 text-sm"
                        value={draft}
                        maxLength={80}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                      <Button type="submit" variant="outline">
                        保存
                      </Button>
                      <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                        取消
                      </Button>
                    </form>
                  ) : (
                    <h3 className="text-lg font-semibold break-all">{token.name}</h3>
                  )}
                  {editing === token.id ? null : (
                    <div className="flex flex-wrap gap-2">
                      {active ? (
                        <Button
                          type="button"
                          variant="outline"
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
                        <Button type="button" variant="destructive" onClick={() => void revoke(token.id)}>
                          确认撤销
                        </Button>
                      ) : (
                        <Button type="button" variant="destructive" onClick={() => setPendingRevoke(token.id)}>
                          撤销
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
                  <div>
                    <dt className="text-xs font-medium">状态</dt>
                    <dd>{state}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium">范围</dt>
                    <dd>{token.scopes.map(scopeLabel).join('、')}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium">创建</dt>
                    <dd>{formatWhen(token.createdAt, now)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium">最近使用</dt>
                    <dd>{token.lastUsedAt === null ? '从未使用' : formatStamp(token.lastUsedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium">过期</dt>
                    <dd>{token.expiresAt === null ? '永不' : formatStamp(token.expiresAt)}</dd>
                  </div>
                </dl>
              </li>
            )
          })}
        </ul>
      </section>
      {creating ? (
        <div
          className="fixed inset-0 z-30 grid place-items-end bg-foreground/40 p-0 sm:place-items-center sm:p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !secret) closeDialog()
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="create-token-title" className="max-h-svh w-full max-w-lg overflow-y-auto rounded-md border border-line-2 bg-background p-4">
            <h2 id="create-token-title" className="text-2xl font-semibold">
              {secret ? '保存令牌' : '创建令牌'}
            </h2>
            {secret ? (
              <div className="mt-4">
                <p className="rounded-md border border-line-1 border-l border-l-brand bg-surface-2 px-3 py-2 text-sm">只显示这一次。关闭后无法再查看，请立即复制并保存。</p>
                <label className="mt-4 block text-xs font-medium" htmlFor="fresh-token">
                  令牌
                  <input id="fresh-token" className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 font-mono text-sm normal-case" readOnly value={secret} />
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
                <label className="text-xs font-medium" htmlFor="token-name">
                  名称
                  <input
                    id="token-name"
                    className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm font-medium normal-case"
                    value={name}
                    maxLength={80}
                    autoFocus
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <fieldset className="grid gap-2">
                  <legend className="text-xs font-medium">范围</legend>
                  <label className="flex items-center gap-2 text-sm normal-case">
                    <input type="checkbox" checked={read} onChange={(event) => setRead(event.target.checked)} />
                    读取
                  </label>
                  <label className="flex items-center gap-2 text-sm normal-case">
                    <input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} />
                    写入
                  </label>
                </fieldset>
                <label className="text-xs font-medium" htmlFor="token-expiry">
                  有效期
                  <select
                    id="token-expiry"
                    className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm font-medium normal-case"
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
                  <label className="text-xs font-medium" htmlFor="token-days">
                    天数
                    <input
                      id="token-days"
                      className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm normal-case"
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
