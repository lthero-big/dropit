import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { PageTitle, Shell } from '@/components/shell.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { copyText, formatBytes, formatRemain, spaceLabel, useClock } from '@/lib/format.ts'
import { useSession } from '@/lib/session.tsx'
import type { AdminUser, Invite, InviteCreated, SpaceSummary } from '@/lib/types.ts'

export function AdminPage() {
  const { status, me } = useSession()
  const now = useClock(0)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [spaces, setSpaces] = useState<SpaceSummary[]>([])
  const [spaceId, setSpaceId] = useState('')
  const [maxUses, setMaxUses] = useState('1')
  const [hours, setHours] = useState('24')
  const [freshUrl, setFreshUrl] = useState<string | null>(null)
  const [tab, setTab] = useState<'invites' | 'users'>('invites')

  const load = useCallback(async () => {
    const [userBody, inviteBody, spaceBody] = await Promise.all([
      api<{ users: AdminUser[] }>('/api/admin/users'),
      api<{ invites: Invite[] }>('/api/admin/invites'),
      api<{ spaces: SpaceSummary[] }>('/api/spaces'),
    ])
    setUsers(userBody.users)
    setInvites(inviteBody.invites)
    setSpaces(spaceBody.spaces)
    setSpaceId((current) => current || spaceBody.spaces.find((space) => space.ownerId === me?.user.id)?.id || spaceBody.spaces[0]?.id || '')
  }, [me?.user.id])

  useEffect(() => {
    if (me?.user.role !== 'admin') return
    void load().catch((error: unknown) => toast.error(errorText(error)))
  }, [load, me])

  if (status === 'loading') return <main className="px-6 py-16 text-sm text-muted-foreground">正在连接…</main>
  if (!me) {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-3xl font-black">请先登录</h1>
        <Link to="/login" className="mt-4 inline-block text-sm font-extrabold tracking-widest uppercase">
          登录
        </Link>
      </main>
    )
  }
  if (me.user.role !== 'admin') {
    return (
      <Shell>
        <h1 className="text-3xl font-black">需要管理员权限</h1>
      </Shell>
    )
  }

  async function createInvite(event: FormEvent) {
    event.preventDefault()
    try {
      const created = await api<InviteCreated>('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spaceId,
          maxUses: Number(maxUses),
          expiresInHours: Number(hours),
        }),
      })
      setFreshUrl(created.url)
      toast.success('邀请已生成。链接只显示这一次。')
      await load()
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/api/admin/invites/${id}`, { method: 'DELETE' })
      await load()
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  async function toggleUser(user: AdminUser) {
    try {
      await api(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: user.disabled === 0 }),
      })
      await load()
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  return (
    <Shell>
      <PageTitle title="管理" sub="邀请、用户和配额。普通用户不能打开这些接口。" />
      <div className="mb-6 flex border-b-2 border-foreground">
        <button type="button" className={`px-4 py-2 text-xs font-extrabold tracking-widest uppercase ${tab === 'invites' ? 'bg-foreground text-background' : ''}`} onClick={() => setTab('invites')}>
          邀请
        </button>
        <button type="button" className={`px-4 py-2 text-xs font-extrabold tracking-widest uppercase ${tab === 'users' ? 'bg-foreground text-background' : ''}`} onClick={() => setTab('users')}>
          用户
        </button>
      </div>
      {tab === 'invites' ? (
        <div>
          <form className="mb-6 grid gap-3 border-2 border-foreground p-4 sm:grid-cols-[1fr_100px_100px_auto] sm:items-end" onSubmit={(event) => void createInvite(event)}>
            <label className="text-xs font-extrabold tracking-widest uppercase">
              空间
              <select className="mt-1 block w-full border-2 border-foreground bg-background px-2 py-2 text-sm font-medium normal-case" value={spaceId} onChange={(event) => setSpaceId(event.target.value)}>
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {spaceLabel(space, me.user.id, spaces)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-extrabold tracking-widest uppercase">
              次数
              <input className="mt-1 block w-full border-2 border-foreground bg-background px-2 py-2 text-sm normal-case" inputMode="numeric" value={maxUses} onChange={(event) => setMaxUses(event.target.value)} />
            </label>
            <label className="text-xs font-extrabold tracking-widest uppercase">
              小时
              <input className="mt-1 block w-full border-2 border-foreground bg-background px-2 py-2 text-sm normal-case" inputMode="numeric" value={hours} onChange={(event) => setHours(event.target.value)} />
            </label>
            <Button type="submit">生成邀请</Button>
          </form>
          {freshUrl ? (
            <div className="mb-6 flex flex-wrap items-center gap-2 border-l-4 border-primary bg-secondary px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-sm">{freshUrl}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyText(freshUrl).then(() => toast.success('已复制'))}>
                复制
              </Button>
            </div>
          ) : null}
          <div className="overflow-x-auto border-t-2 border-foreground">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-foreground text-left text-[11px] tracking-widest uppercase">
                  <th className="py-2 font-extrabold">空间</th>
                  <th className="py-2 font-extrabold">使用</th>
                  <th className="py-2 font-extrabold">剩余</th>
                  <th className="py-2 font-extrabold">状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => {
                  const space = spaces.find((item) => item.id === invite.spaceId)
                  const dead = invite.revoked !== 0 || invite.uses >= invite.maxUses || invite.expiresAt <= now
                  return (
                    <tr key={invite.id} className="border-b border-foreground">
                      <td className="py-3" data-l="空间">{space ? spaceLabel(space, me.user.id, spaces) : invite.spaceId.slice(0, 8)}</td>
                      <td className="py-3" data-l="使用">{invite.uses}/{invite.maxUses}</td>
                      <td className="py-3" data-l="剩余">{formatRemain(invite.expiresAt - now)}</td>
                      <td className="py-3" data-l="状态">{dead ? '不可用' : '有效'}</td>
                      <td className="py-3 text-right">
                        {invite.revoked === 0 ? (
                          <Button type="button" variant="outline" size="sm" onClick={() => void revoke(invite.id)}>
                            撤销
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {invites.length === 0 ? <p className="py-6 text-sm text-muted-foreground">还没有邀请。</p> : null}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto border-t-2 border-foreground">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-foreground text-left text-[11px] tracking-widest uppercase">
                <th className="py-2 font-extrabold">用户</th>
                <th className="py-2 font-extrabold">角色</th>
                <th className="py-2 font-extrabold">配额</th>
                <th className="py-2 font-extrabold">状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-foreground">
                  <td className="py-3" data-l="用户">
                    <b>{user.name}</b>
                    <small className="mt-1 block text-muted-foreground">{user.email}</small>
                  </td>
                  <td className="py-3" data-l="角色">{user.role === 'admin' ? '管理员' : '用户'}</td>
                  <td className="py-3" data-l="配额">
                    {formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)}
                  </td>
                  <td className="py-3" data-l="状态">{user.disabled ? '已停用' : '正常'}</td>
                  <td className="py-3 text-right">
                    <Button type="button" variant="outline" size="sm" onClick={() => void toggleUser(user)}>
                      {user.disabled ? '启用' : '停用'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  )
}
