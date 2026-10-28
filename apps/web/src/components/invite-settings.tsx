import { useCallback, useEffect, useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Note, Panel, StatusPill } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { copyText, formatRemain, useClock } from '@/lib/format.ts'
import type { PersonalInvite, PersonalInvites } from '@/lib/types.ts'

const STATE: Record<PersonalInvite['status'], string> = { open: '有效', used: '已使用', expired: '已过期', revoked: '已撤销' }

/** RHEA-190 auth step 3: 设置 → 邀请. Invite someone to register; the invite is single use and never adds them to your space. */
export function InviteSettings() {
  const now = useClock(0)
  const [view, setView] = useState<PersonalInvites | null>(null)
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setView(await api<PersonalInvites>('/api/me/invites'))
  }, [])

  useEffect(() => {
    let cancelled = false
    api<PersonalInvites>('/api/me/invites')
      .then((body) => {
        if (!cancelled) setView(body)
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function create() {
    setBusy(true)
    try {
      const created = await api<{ id: string; url: string }>('/api/me/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      setFresh({ id: created.id, url: created.url })
      await load()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/api/me/invites/${id}`, { method: 'DELETE' })
      if (fresh?.id === id) setFresh(null)
      await load()
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  if (!view) return null
  const full = view.remaining !== null && view.remaining <= 0
  return (
    <Panel
      id="invites"
      title="邀请"
      description={
        view.limit === null
          ? '生成一次性邀请链接，让别人注册自己的账号。对方不会加入你的空间。'
          : `生成一次性邀请链接，让别人注册自己的账号。对方不会加入你的空间。已用 ${view.used} / ${view.limit}（有效或已使用的邀请都算；撤销未使用的邀请可以腾出名额）。`
      }
      actions={
        <Button type="button" disabled={busy || !view.enabled || full} onClick={() => void create()}>
          <PlusIcon aria-hidden="true" />
          生成邀请
        </Button>
      }
    >
      <div className="grid gap-3 px-4 py-3.5 sm:px-5">
        {!view.enabled ? <Note>管理员暂时关闭了普通用户的邀请功能。</Note> : null}
        {view.enabled && full ? <Note>邀请名额已用完，请联系管理员提高上限，或撤销未使用的邀请。</Note> : null}
        {view.registration === 'closed' ? <Note tone="warn">本站目前关闭注册，邀请链接暂时无法使用。</Note> : null}
        {view.registration === 'open' ? <Note>本站目前开放注册，不需要邀请也能注册。</Note> : null}
        {fresh ? (
          <div className="flex flex-wrap items-center gap-2 border border-line-2 px-3 py-2" data-new-invite="">
            <code className="min-w-0 flex-1 truncate text-sm">{fresh.url}</code>
            <Button type="button" variant="outline" size="sm" onClick={() => void copyText(fresh.url).then(() => toast.success('邀请链接已复制'))}>
              复制链接
            </Button>
            <p className="w-full text-xs text-muted-foreground">链接只在这里显示一次，7 天内有效，只能用一次。</p>
          </div>
        ) : null}
        {view.invites.length ? (
          <ul className="grid gap-2" aria-label="我的邀请">
            {view.invites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center gap-3 border-b border-line-1 pb-2 text-sm last:border-b-0">
                <StatusPill tone={invite.status === 'open' ? 'good' : 'neutral'}>{STATE[invite.status]}</StatusPill>
                <span className="text-fg-2">{invite.status === 'open' ? formatRemain(invite.expiresAt - now) : ''}</span>
                {invite.status === 'open' ? (
                  <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => void revoke(invite.id)}>
                    撤销
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">还没有邀请。</p>
        )}
      </div>
    </Panel>
  )
}
