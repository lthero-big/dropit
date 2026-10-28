import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Logo } from '@/components/logo.tsx'
import { fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { useSession } from '@/lib/session.tsx'

/**
 * RHEA-190 auth step 2 — first run. While no account exists, the first admin is created
 * here with the one-time code the server prints at startup (`docker logs dropit`).
 */
export function SetupPage() {
  const { refresh } = useSession()
  const navigate = useNavigate()
  const [required, setRequired] = useState<boolean | null>(null)
  const [code, setCode] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api<{ required: boolean }>('/api/setup')
      .then((body) => {
        if (!cancelled) setRequired(body.required)
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setRequired(false)
          setError(errorText(caught))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), email, name: name.trim() || undefined, password }),
      })
      await refresh()
      navigate('/', { replace: true })
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-medium">首次设置</p>
      <h1 className="mt-3">
        <Logo size="lg" />
      </h1>
      {required === null ? <p className="mt-6 text-sm text-muted-foreground">正在读取…</p> : null}
      {required === false ? (
        <div className="mt-6 grid gap-3 text-sm">
          <p>{error ?? '这个站点已经初始化，管理员账号已存在。'}</p>
          <Link to="/login" className="font-medium">
            去登录
          </Link>
        </div>
      ) : null}
      {required ? (
        <>
          <p className="mt-4 text-sm text-muted-foreground">
            还没有任何账号。创建第一个管理员：初始化码在服务启动日志里，运行 <code className="font-mono">docker logs dropit</code>，找到
            <code className="font-mono"> dropit setup code: XXXX-XXXX</code>。
          </p>
          <form className="mt-8 grid gap-3 border-t border-line-1 pt-6" onSubmit={(event) => void submit(event)} aria-label="创建管理员">
            <label className={labelClass}>
              初始化码
              <input className={`${fieldClass} font-mono uppercase`} autoComplete="off" spellCheck={false} required placeholder="XXXX-XXXX" value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
            <label className={labelClass}>
              管理员邮箱
              <input className={fieldClass} type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label className={labelClass}>
              名字（可选）
              <input className={fieldClass} autoComplete="name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className={labelClass}>
              密码（至少 8 位）
              <input className={fieldClass} type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <label className={labelClass}>
              再输入一次
              <input className={fieldClass} type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            </label>
            {error ? (
              <p role="alert" className="rounded-md border border-line-1 border-l border-l-destructive bg-surface-2 px-3 py-2 text-sm">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={busy}>
              创建管理员并登录
            </Button>
          </form>
        </>
      ) : null}
    </main>
  )
}
