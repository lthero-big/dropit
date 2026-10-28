import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'

/**
 * RHEA-190 auth step 2: set or change the account password. The current password is
 * required when one exists; an OAuth-only account can add one without it.
 */
export function PasswordForm({ hasPassword, currentLabel = '当前密码', onDone }: { hasPassword: boolean; currentLabel?: string; onDone?: () => void | Promise<void> }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (next !== confirm) {
      setError('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api<{ revokedSessions: number }>('/api/me/password', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(hasPassword ? { currentPassword: current } : {}), newPassword: next }),
      })
      setCurrent('')
      setNext('')
      setConfirm('')
      toast.success(result.revokedSessions ? `密码已更新，已登出其他 ${result.revokedSessions} 台设备` : '密码已更新')
      await onDone?.()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="grid max-w-sm gap-3" onSubmit={(event) => void submit(event)} aria-label={hasPassword ? '修改密码' : '设置密码'} data-password-change="">
      {hasPassword ? (
        <label className={labelClass}>
          {currentLabel}
          <input className={fieldClass} type="password" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} />
        </label>
      ) : null}
      <label className={labelClass}>
        新密码（至少 8 位）
        <input className={fieldClass} type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(event) => setNext(event.target.value)} />
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
      <div>
        <Button type="submit" disabled={busy}>
          {hasPassword ? '修改密码' : '设置密码'}
        </Button>
      </div>
    </form>
  )
}
