import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { DeviceGlyph } from '@/components/device-glyph.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { formatWhen, useClock } from '@/lib/format.ts'
import { sessionKind, sessionTitle } from '@/lib/sessions.ts'
import type { DeviceSession } from '@/lib/types.ts'


/**
 * RHEA-190 r4: 登录设备. Lists every browser signed in to an account with a
 * readable name, IP range and last activity, and signs devices out one by one.
 * `userId` switches to the admin endpoints for that user.
 */
export function DeviceSessions({ userId, onSelfSignedOut }: { userId?: string; onSelfSignedOut?: () => void }) {
  const now = useClock(0)
  const admin = userId !== undefined
  const listUrl = admin ? `/api/admin/users/${encodeURIComponent(userId)}/sessions` : '/api/sessions'
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const body = await api<{ sessions: DeviceSession[] }>(listUrl)
      setSessions(body.sessions)
      setError(null)
    } catch (caught) {
      setError(errorText(caught))
    }
  }, [listUrl])

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0)
    const id = window.setInterval(() => void load(), 30_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [load])

  async function signOut(session: DeviceSession) {
    setBusy(true)
    try {
      await api(admin ? `/api/admin/sessions/${encodeURIComponent(session.id)}` : `/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' })
      setPending(null)
      if (session.current) {
        toast.success('本设备已登出')
        onSelfSignedOut?.()
        return
      }
      toast.success(`已登出「${sessionTitle(session)}」`)
      await load()
    } catch (caught) {
      toast.error(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function signOutOthers() {
    setBusy(true)
    try {
      const body = await api<{ revoked: number }>('/api/sessions/revoke-others', { method: 'POST' })
      setPending(null)
      toast.success(body.revoked ? `已登出其他 ${body.revoked} 台设备` : '没有其他设备')
      await load()
    } catch (caught) {
      toast.error(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const others = sessions?.filter((session) => !session.current).length ?? 0
  const onlineCount = sessions?.filter((session) => session.online).length ?? 0

  return (
    <div data-device-sessions={admin ? 'admin' : 'self'}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {sessions === null ? '正在加载…' : `${sessions.length} 台已登录 · ${onlineCount} 台正在打开 dropit`}
        </p>
        {!admin && others > 0 ? (
          pending === '*others' ? (
            <div className="flex gap-2">
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void signOutOthers()}>
                确认登出其他 {others} 台
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setPending(null)}>
                取消
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" disabled={busy} onClick={() => setPending('*others')}>
              登出其他所有设备
            </Button>
          )
        ) : null}
      </div>
      {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
      {sessions !== null && sessions.length === 0 ? <p className="rounded-md border border-line-2 p-4 text-sm text-muted-foreground">没有已登录的浏览器。</p> : null}
      <ul className="grid gap-2" aria-label="登录设备">
        {(sessions ?? []).map((session) => {
          const title = sessionTitle(session)
          const seen = session.lastSeenAt ?? session.createdAt
          return (
            <li key={session.id} className="flex flex-wrap items-center gap-3 rounded-md border border-line-1 bg-surface-0 px-3 py-3" data-session-id={session.id}>
              <span className="grid size-9 shrink-0 place-items-center rounded-md border border-line-1 bg-surface-2 text-fg-2" aria-hidden="true">
                <DeviceGlyph kind={sessionKind(session)} className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                  <span className="truncate">{title}</span>
                  {session.current ? <span className="rounded-sm border border-l-2 border-line-1 border-l-brand bg-surface-2 px-1.5 text-[11px] font-medium">本设备</span> : null}
                  {session.online ? <span className="text-[11px] font-medium text-primary">● 在线</span> : null}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {session.browser} · {session.os}
                  {session.ipSummary ? ` · IP ${session.ipSummary}` : ''}
                  {seen ? ` · 最近活动 ${formatWhen(seen, now)}` : ''}
                </p>
              </div>
              {pending === session.id ? (
                <div className="flex gap-2">
                  <Button type="button" variant="destructive" disabled={busy} onClick={() => void signOut(session)}>
                    确认登出
                  </Button>
                  <Button type="button" variant="outline" disabled={busy} onClick={() => setPending(null)}>
                    取消
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="outline" disabled={busy} aria-label={`登出 ${title}`} onClick={() => setPending(session.id)}>
                  {session.current ? '登出本设备' : '登出'}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">IP 只显示所在网段。登出后该浏览器需要重新登录；命令行令牌不在这里，请在「令牌」里撤销。</p>
    </div>
  )
}
