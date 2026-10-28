import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText, loginErrorText } from '@/lib/api.ts'
import { openTempRoom } from '@/lib/temp-room.ts'
import { takeReturn } from '@/lib/machine.ts'
import { useSession } from '@/lib/session.tsx'
import { Logo } from '@/components/logo.tsx'
import { ProviderIcon } from '@/components/brand-icons.tsx'
import { originMismatch, type SiteInfo } from '@/lib/site.ts'
import { fieldClass, labelClass } from '@/components/settings-ui.tsx'
import type { AuthInfo } from '@/lib/types.ts'

const PROVIDER_NAME: Record<string, string> = { github: 'GitHub', google: 'Google' }

export function LoginPage({ invite }: { invite?: string }) {
  const { status, refresh } = useSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const loginError = invite ? null : loginErrorText(params.get('error'))
  const [providers, setProviders] = useState<string[] | null>(null)
  const [info, setInfo] = useState<AuthInfo | null>(null)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mismatch, setMismatch] = useState<string | null>(null)

  // RHEA-190 auth step 1: explain an APP_ORIGIN mismatch up front instead of a bare 403 later.
  useEffect(() => {
    let cancelled = false
    api<SiteInfo>('/api/site')
      .then((site) => {
        if (!cancelled) setMismatch(originMismatch(site, window.location.origin))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api<AuthInfo>('/api/auth/providers')
      .then((body) => {
        if (cancelled) return
        setProviders(body.providers)
        setInfo(body)
        // RHEA-190 auth step 2: a fresh install has no account yet — create the admin first.
        if (body.setupRequired) navigate('/setup', { replace: true })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProviders([])
          toast.error(errorText(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [navigate])

  useEffect(() => {
    if (!invite && status === 'ready') navigate(takeReturn() ?? '/', { replace: true })
  }, [invite, navigate, status])

  async function enterRoom() {
    setBusy(true)
    try {
      const room = await openTempRoom()
      navigate(`/rooms/${room.token}`)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFormError(null)
    try {
      const path = mode === 'register' ? '/api/auth/password/register' : '/api/auth/password/login'
      const body = { email, password, ...(mode === 'register' && name.trim() ? { name: name.trim() } : {}), ...(invite ? { invite } : {}) }
      const result = await api<{ mustChangePassword: boolean }>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      setPassword('')
      await refresh()
      if (result.mustChangePassword) navigate('/change-password', { replace: true })
      else if (invite) navigate('/', { replace: true })
    } catch (error) {
      setFormError(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const passwordEnabled = info?.password !== false
  const canRegister = Boolean(invite) || info?.registration === 'open'
  const query = invite ? `?invite=${encodeURIComponent(invite)}` : ''

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-medium">云剪贴板</p>
      <h1 className="mt-3">
        <Logo size="lg" />
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">跨设备传递文本和文件。用邮箱密码，或 GitHub / Google 登录。</p>
      <div className="mt-8 flex flex-col gap-3 border-t border-line-1 pt-6">
        {mismatch ? (
          <p role="alert" data-origin-mismatch="" className="rounded-md border border-line-1 border-l border-l-destructive bg-surface-2 px-3 py-2 text-sm">
            {mismatch}
          </p>
        ) : null}
        {loginError ? (
          <p role="alert" className="rounded-md border border-line-1 border-l border-l-brand bg-surface-2 px-3 py-2 text-sm">
            {loginError}
          </p>
        ) : null}
        {providers === null ? <p className="text-sm text-muted-foreground">正在读取登录方式…</p> : null}
        {providers?.length === 0 ? (
          <p className="rounded-md border border-line-1 border-l border-l-brand bg-surface-2 px-3 py-2 text-sm">
            尚未配置 GitHub / Google。可以先用邮箱和密码登录；管理员可在 管理 → OAuth 登录 填写凭据（或使用环境变量），配置后刷新此页。
          </p>
        ) : null}
        {providers && providers.length > 0 ? (
          <div className="flex flex-col gap-2.5" role="group" aria-label="登录方式" data-login-providers="">
            {providers.map((provider) => {
              const name = PROVIDER_NAME[provider] ?? provider
              const label = `使用 ${name} 继续`
              return (
                <Button
                  key={provider}
                  type="button"
                  variant="outline"
                  className="relative h-11 min-h-11 w-full justify-center gap-3 px-4 text-sm font-medium normal-case tracking-normal"
                  asChild
                >
                  <a href={`/api/auth/${provider}${query}`} aria-label={label} title={`用 ${name} 账号登录`} data-login-provider={provider}>
                    <ProviderIcon provider={provider} className="absolute left-4 size-5" />
                    <span>{label}</span>
                  </a>
                </Button>
              )
            })}
          </div>
        ) : null}
        {providers !== null && passwordEnabled ? (
          <form className="grid gap-3" onSubmit={(event) => void submitPassword(event)} aria-label={mode === 'register' ? '注册' : '邮箱登录'} data-password-form={mode}>
            {providers.length > 0 ? <p className="text-center text-xs text-fg-4">或使用邮箱</p> : null}
            <label className={labelClass}>
              邮箱
              <input className={fieldClass} type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            {mode === 'register' ? (
              <label className={labelClass}>
                名字（可选）
                <input className={fieldClass} autoComplete="name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
              </label>
            ) : null}
            <label className={labelClass}>
              密码
              <input
                className={fieldClass}
                type="password"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                required
                minLength={mode === 'register' ? 8 : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {formError ? (
              <p role="alert" className="rounded-md border border-line-1 border-l border-l-destructive bg-surface-2 px-3 py-2 text-sm">
                {formError}
              </p>
            ) : null}
            <Button type="submit" variant="outline" disabled={busy}>
              {mode === 'register' ? '注册并登录' : '用密码登录'}
            </Button>
            {canRegister ? (
              <button
                type="button"
                className="text-xs font-medium text-fg-3 underline-offset-4 hover:underline"
                onClick={() => {
                  setMode(mode === 'register' ? 'login' : 'register')
                  setFormError(null)
                }}
              >
                {mode === 'register' ? '已有账号？用密码登录' : invite ? '还没有账号？设置密码注册' : '还没有账号？注册'}
              </button>
            ) : null}
          </form>
        ) : null}
        {invite ? null : (
          <Button type="button" onClick={() => void enterRoom()} disabled={busy}>
            进入临时房间
          </Button>
        )}
      </div>
    </main>
  )
}
