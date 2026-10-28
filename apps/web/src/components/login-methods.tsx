import { useCallback, useEffect, useState } from 'react'
import { ProviderIcon } from '@/components/brand-icons.tsx'
import { toast } from 'sonner'
import { Panel, StatusPill } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText, linkErrorText } from '@/lib/api.ts'
import { formatStamp } from '@/lib/machine.ts'

type LinkedIdentity = { provider: string; email: string | null; linkedAt: number | null }

export const providerLabel = (provider: string) => (provider === 'github' ? 'GitHub' : provider === 'google' ? 'Google' : provider)

/**
 * RHEA-190 m11: 登录方式. One account can sign in with GitHub and Google. Binding
 * is explicit and only while signed in, so a matching email never merges
 * accounts silently. The last method cannot be removed (a password counts as one).
 */
export function LoginMethods({ hasPassword = false }: { hasPassword?: boolean }) {
  const [identities, setIdentities] = useState<LinkedIdentity[] | null>(null)
  const [available, setAvailable] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const body = await api<{ identities: LinkedIdentity[]; available: string[] }>('/api/me/identities')
      setIdentities(body.identities)
      setAvailable(body.available)
      setError(null)
    } catch (caught) {
      setError(errorText(caught))
    }
  }, [])

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(id)
  }, [load])

  // Result of a bind round-trip: /settings?linked=github or ?link_error=CODE.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const linked = params.get('linked')
    const failure = linkErrorText(params.get('link_error'))
    if (linked) toast.success(params.get('already') ? `${providerLabel(linked)} 早已绑定在这个账号上` : `已绑定 ${providerLabel(linked)}`)
    else if (failure) toast.error(`绑定失败：${failure}`)
    if (linked || params.get('link_error')) window.history.replaceState(null, '', `${window.location.pathname}#login-methods`)
  }, [])

  async function unlink(provider: string) {
    try {
      await api(`/api/me/identities/${encodeURIComponent(provider)}`, { method: 'DELETE' })
      setPending(null)
      toast.success(`已解绑 ${providerLabel(provider)}`)
      await load()
    } catch (caught) {
      toast.error(errorText(caught))
    }
  }

  const providers = [...new Set([...(identities ?? []).map((identity) => identity.provider), ...available])]
  return (
    <Panel id="login-methods" title="登录方式" description="同一个账号可以同时绑定 GitHub 和 Google，任选其一登录。绑定只能在已登录时进行，不会按邮箱自动合并账号。">
      {error ? <p className="rounded-md border border-line-2 p-4 text-sm text-muted-foreground">{error}</p> : null}
      {identities === null && !error ? <p className="text-sm text-muted-foreground">正在读取…</p> : null}
      {identities ? (
        <ul className="grid gap-3">
          {providers.map((provider) => {
            const bound = identities.find((identity) => identity.provider === provider)
            const canBind = available.includes(provider)
            return (
              <li key={provider} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-1 bg-surface-0 px-4 py-3" data-provider={provider}>
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
                    <ProviderIcon provider={provider} className="size-4" />
                    {providerLabel(provider)}
                    <StatusPill tone={bound ? 'good' : 'neutral'}>{bound ? '已连接' : '未连接'}</StatusPill>
                  </h3>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">
                    {bound
                      ? `已绑定${bound.email ? ` · ${bound.email}` : ''}${bound.linkedAt ? ` · ${formatStamp(bound.linkedAt)}` : ''}`
                      : canBind
                        ? '未绑定'
                        : '未绑定 · 管理员尚未配置'}
                  </p>
                </div>
                {bound ? (
                  identities.length <= 1 && !hasPassword ? (
                    <span className="text-xs text-fg-4">唯一的登录方式，不能解绑</span>
                  ) : pending === provider ? (
                    <div className="flex gap-2">
                      <Button type="button" variant="destructive" onClick={() => void unlink(provider)}>
                        确认解绑
                      </Button>
                      <Button type="button" variant="outline" onClick={() => setPending(null)}>
                        取消
                      </Button>
                    </div>
                  ) : (
                    <Button type="button" variant="outline" onClick={() => setPending(provider)}>
                      解绑
                    </Button>
                  )
                ) : canBind ? (
                  <Button type="button" asChild>
                    <a href={`/api/auth/${encodeURIComponent(provider)}?link=1`}>绑定 {providerLabel(provider)}</a>
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </Panel>
  )
}
