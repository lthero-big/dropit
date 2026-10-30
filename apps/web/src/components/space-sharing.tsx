import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { PlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Note, Panel, StatusPill, fieldClass, labelClass, selectClass } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { copyText, formatRemain, useClock } from '@/lib/format.ts'
import type { MemberRole, SpaceInvite, SpaceInvites, SpaceMember, SpaceSummary } from '@/lib/types.ts'

const STATE: Record<SpaceInvite['status'], string> = { open: '有效', active: '有效', used: '已用完', expired: '已过期', revoked: '已撤销' }
const ROLE: Record<string, string> = { owner: '所有者', editor: '可编辑', viewer: '只读' }
const EXPIRY = [
  { value: '1', label: '1 小时' },
  { value: '24', label: '1 天' },
  { value: '168', label: '7 天' },
  { value: '720', label: '30 天' },
]

/**
 * RHEA-190 m50: 设置 → 空间成员. The owner invites people into their private space (read-only by default:
 * they can view and copy, not send, edit or delete), limits and revokes the links, and manages members.
 * The private space has no room code or PIN: only these invite links lead into it.
 */
export function SpaceSharing({ meId }: { meId: string }) {
  const now = useClock(0)
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [invites, setInvites] = useState<SpaceInvites | null>(null)
  const [members, setMembers] = useState<SpaceMember[]>([])
  const [fresh, setFresh] = useState<{ id: string; url: string; role: MemberRole } | null>(null)
  const [role, setRole] = useState<MemberRole>('viewer')
  const [maxUses, setMaxUses] = useState('1')
  const [hours, setHours] = useState('168')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (id: string) => {
    const [nextInvites, nextMembers] = await Promise.all([
      api<SpaceInvites>(`/api/spaces/${id}/invites`),
      api<{ members: SpaceMember[] }>(`/api/spaces/${id}/members`),
    ])
    setInvites(nextInvites)
    setMembers(nextMembers.members)
  }, [])

  useEffect(() => {
    let cancelled = false
    api<{ spaces: SpaceSummary[] }>('/api/spaces')
      .then(async (body) => {
        const own = body.spaces.find((space) => space.ownerId === meId)
        if (cancelled || !own) return
        setSpaceId(own.id)
        await load(own.id)
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [load, meId])

  async function create(event: FormEvent) {
    event.preventDefault()
    if (!spaceId) return
    const uses = Number(maxUses)
    if (!Number.isInteger(uses) || uses < 1 || uses > 100) {
      toast.error('可用次数需要是 1–100 的整数')
      return
    }
    setBusy(true)
    try {
      const created = await api<SpaceInvite & { url: string }>(`/api/spaces/${spaceId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, maxUses: uses, expiresInHours: Number(hours) }),
      })
      setFresh({ id: created.id, url: created.url, role: created.role })
      await load(spaceId)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function act(run: () => Promise<unknown>, message: string) {
    if (!spaceId) return
    try {
      await run()
      toast.success(message)
      await load(spaceId)
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  if (!spaceId || !invites) return null
  const full = invites.remaining !== null && invites.remaining <= 0
  const others = members.filter((member) => member.role !== 'owner')
  return (
    <Panel
      id="space-sharing"
      title="空间成员与邀请"
      description={
        invites.limit === null
          ? '邀请别人加入你的私人空间。默认只读：对方可以查看和复制，不能发送、编辑或删除。私人空间没有房间码和 PIN，只能通过你的邀请链接进入。'
          : `邀请别人加入你的私人空间。默认只读：对方可以查看和复制，不能发送、编辑或删除。私人空间没有房间码和 PIN，只能通过你的邀请链接进入。同时有效的邀请 ${invites.active} / ${invites.limit}。`
      }
    >
      <div className="grid gap-4 px-4 py-3.5 sm:px-5">
        {!invites.enabled ? <Note>管理员关闭了你的空间邀请（上限为 0）。</Note> : null}
        {invites.enabled && full ? <Note>有效邀请已达上限：撤销一个，或等它过期 / 用完；也可以请管理员提高上限。</Note> : null}
        <form className="grid gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end" onSubmit={(event) => void create(event)} aria-label="生成空间邀请">
          <label className={labelClass}>
            权限
            <select className={selectClass} value={role} onChange={(event) => setRole(event.target.value as MemberRole)}>
              <option value="viewer">只读（查看、复制）</option>
              <option value="editor">可编辑（也能发送）</option>
            </select>
          </label>
          <label className={labelClass}>
            可用次数
            <input className={fieldClass} type="number" min={1} max={100} value={maxUses} onChange={(event) => setMaxUses(event.target.value)} />
          </label>
          <label className={labelClass}>
            有效期
            <select className={selectClass} value={hours} onChange={(event) => setHours(event.target.value)}>
              {EXPIRY.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy || !invites.enabled || full}>
            <PlusIcon aria-hidden="true" />
            生成空间邀请
          </Button>
        </form>
        {fresh ? (
          <div className="flex flex-wrap items-center gap-2 border border-line-2 px-3 py-2" data-new-space-invite="">
            <code className="min-w-0 flex-1 truncate text-sm">{fresh.url}</code>
            <Button type="button" variant="outline" size="sm" onClick={() => void copyText(fresh.url).then(() => toast.success('邀请链接已复制'))}>
              复制链接
            </Button>
            <p className="w-full text-xs text-muted-foreground">链接只在这里显示一次。对方需要已有账号：登录后打开链接即可加入（{ROLE[fresh.role]}）。</p>
          </div>
        ) : null}
        <div>
          <h3 className="mb-2 text-xs font-semibold text-fg-3">邀请链接</h3>
          {invites.invites.length ? (
            <ul className="grid gap-2" aria-label="空间邀请">
              {invites.invites.map((invite) => (
                <li key={invite.id} className="flex flex-wrap items-center gap-3 border-b border-line-1 pb-2 text-sm last:border-b-0">
                  <StatusPill tone={invite.status === 'open' ? 'good' : 'neutral'}>{STATE[invite.status]}</StatusPill>
                  <span>{ROLE[invite.role]}</span>
                  <span className="text-fg-2">
                    已用 {invite.uses} / {invite.maxUses}
                  </span>
                  <span className="text-fg-2">{invite.status === 'open' ? formatRemain(invite.expiresAt - now) : ''}</span>
                  {invite.status === 'open' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      onClick={() => void act(async () => {
                        await api(`/api/spaces/${spaceId}/invites/${invite.id}`, { method: 'DELETE' })
                        if (fresh?.id === invite.id) setFresh(null)
                      }, '邀请已撤销')}
                    >
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
        <div>
          <h3 className="mb-2 text-xs font-semibold text-fg-3">成员</h3>
          {others.length ? (
            <ul className="grid gap-2" aria-label="空间成员">
              {others.map((member) => (
                <li key={member.userId} className="flex flex-wrap items-center gap-3 border-b border-line-1 pb-2 text-sm last:border-b-0">
                  <span className="min-w-0 flex-1 truncate">
                    {member.name} <span className="text-fg-3">{member.email}</span>
                  </span>
                  <select
                    aria-label={`${member.email} 的权限`}
                    className={`${selectClass} w-auto`}
                    value={member.role}
                    onChange={(event) =>
                      void act(
                        () => api(`/api/spaces/${spaceId}/members/${member.userId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: event.target.value }) }),
                        '权限已更新',
                      )
                    }
                  >
                    <option value="viewer">只读</option>
                    <option value="editor">可编辑</option>
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (!window.confirm(`把 ${member.email} 移出你的空间？对方会立即失去访问权限。`)) return
                      void act(() => api(`/api/spaces/${spaceId}/members/${member.userId}`, { method: 'DELETE' }), '已移除成员')
                    }}
                  >
                    移除
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">只有你自己。</p>
          )}
        </div>
      </div>
    </Panel>
  )
}
