import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { DeviceSessions } from '@/components/device-sessions.tsx'
import { LimitsEditor } from '@/components/limits-editor.tsx'
import { PageTitle, Shell } from '@/components/shell.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { copyText, formatBytes, formatRemain, spaceLabel, useClock } from '@/lib/format.ts'
import { useSession } from '@/lib/session.tsx'
import type { AdminLimits, AdminUser, Invite, InviteCreated, SpaceSummary } from '@/lib/types.ts'

const useChoices = [1, 3, 5, 20, 100]
const hourChoices = [
  { value: 1, label: '1 小时' },
  { value: 24, label: '1 天' },
  { value: 168, label: '7 天' },
  { value: 720, label: '30 天' },
]
const quotaCapMb = 102400

type Tab = 'invites' | 'users' | 'usage' | 'limits'
type Editor = 'new' | AdminUser | null

function inviteState(invite: Invite, now: number): string {
  if (invite.revoked) return '已撤销'
  if (invite.expiresAt <= now) return '已过期'
  if (invite.uses >= invite.maxUses) return '已用尽'
  return '有效'
}

function userState(user: AdminUser): string {
  if (user.pending) return '待首次登录'
  if (user.disabled) return '已停用'
  return '正常'
}

function mbToBytes(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('invalid')
  const mb = Number(value)
  if (mb < 1 || mb > quotaCapMb) throw new Error('invalid')
  return mb * 1024 * 1024
}

export function AdminPage() {
  const { status, me } = useSession()
  const now = useClock(0)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [spaces, setSpaces] = useState<SpaceSummary[]>([])
  const [limits, setLimits] = useState<AdminLimits | null>(null)
  const [spaceId, setSpaceId] = useState('')
  const [maxUses, setMaxUses] = useState('5')
  const [hours, setHours] = useState('168')
  const [freshUrl, setFreshUrl] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('invites')
  const [editor, setEditor] = useState<Editor>(null)

  const load = useCallback(async () => {
    const [userBody, inviteBody, spaceBody, limitBody] = await Promise.all([
      api<{ users: AdminUser[] }>('/api/admin/users'),
      api<{ invites: Invite[] }>('/api/admin/invites'),
      api<{ spaces: SpaceSummary[] }>('/api/spaces'),
      api<AdminLimits>('/api/admin/limits'),
    ])
    setUsers(userBody.users)
    setInvites(inviteBody.invites)
    setSpaces(spaceBody.spaces)
    setLimits(limitBody)
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
        <h1 className="text-3xl font-semibold">请先登录</h1>
        <Link to="/login" className="mt-4 inline-block text-sm font-medium">
          登录
        </Link>
      </main>
    )
  }
  if (me.user.role !== 'admin') {
    return (
      <Shell>
        <h1 className="text-3xl font-semibold">需要管理员权限</h1>
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

  const tabs: { id: Tab; label: string }[] = [
    { id: 'invites', label: '邀请' },
    { id: 'users', label: '用户' },
    { id: 'usage', label: '用量' },
    { id: 'limits', label: '限制' },
  ]

  return (
    <Shell>
      <PageTitle title="管理" sub="邀请、预创建用户、配额。普通用户不能打开这些接口。" />
      <div className="mb-6 flex flex-wrap border-b border-line-1" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`px-4 py-2 text-xs font-medium ${tab === item.id ? 'bg-surface-2 text-fg' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'invites' ? (
        <div>
          <form className="mb-6 grid gap-3 rounded-md border border-line-2 p-4 sm:grid-cols-[1fr_140px_140px_auto] sm:items-end" onSubmit={(event) => void createInvite(event)}>
            <label className="text-xs font-medium">
              空间
              <select className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm font-medium normal-case" value={spaceId} onChange={(event) => setSpaceId(event.target.value)}>
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {spaceLabel(space, me.user.id, spaces)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium">
              次数
              <select className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm font-medium normal-case" value={maxUses} onChange={(event) => setMaxUses(event.target.value)}>
                {useChoices.map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium">
              有效期
              <select className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm font-medium normal-case" value={hours} onChange={(event) => setHours(event.target.value)}>
                {hourChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit">生成邀请</Button>
          </form>
          {freshUrl ? (
            <div className="mb-6 flex flex-wrap items-center gap-2 rounded-md border border-line-1 border-l border-l-brand bg-surface-2 px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-sm">{freshUrl}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyText(freshUrl).then(() => toast.success('已复制'))}>
                复制
              </Button>
            </div>
          ) : null}
          <p className="mb-3 text-xs text-muted-foreground">邀请链接只在生成时显示一次。过期、撤销或用尽后立即失效。</p>
          <div className="overflow-x-auto border-t border-line-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-1 text-left text-[11px]">
                  <th className="py-2 font-medium">空间</th>
                  <th className="py-2 font-medium">使用</th>
                  <th className="py-2 font-medium">剩余</th>
                  <th className="py-2 font-medium">状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => {
                  const space = spaces.find((item) => item.id === invite.spaceId)
                  const state = inviteState(invite, now)
                  return (
                    <tr key={invite.id} className="border-b border-line-2">
                      <td className="py-3" data-l="空间">{space ? spaceLabel(space, me.user.id, spaces) : invite.spaceId.slice(0, 8)}</td>
                      <td className="py-3" data-l="使用">{invite.uses}/{invite.maxUses}</td>
                      <td className="py-3" data-l="剩余">{formatRemain(invite.expiresAt - now)}</td>
                      <td className="py-3" data-l="状态">{state}</td>
                      <td className="py-3 text-right">
                        {state === '有效' ? (
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
      ) : null}
      {tab === 'users' ? (
        <div>
          <div className="mb-4">
            <Button type="button" onClick={() => setEditor('new')}>
              新建用户
            </Button>
          </div>
          {editor ? (
            <UserEditor
              key={editor === 'new' ? 'new' : editor.id}
              user={editor === 'new' ? null : editor}
              onClose={() => setEditor(null)}
              onSaved={load}
            />
          ) : null}
          <div className="overflow-x-auto border-t border-line-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-1 text-left text-[11px]">
                  <th className="py-2 font-medium">用户</th>
                  <th className="py-2 font-medium">角色</th>
                  <th className="py-2 font-medium">配额</th>
                  <th className="py-2 font-medium">状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className={`border-b border-line-2 ${user.disabled ? 'opacity-60' : ''}`}>
                    <td className="py-3" data-l="用户">
                      <b>{user.name}</b>
                      <small className="mt-1 block text-muted-foreground">{user.email}</small>
                    </td>
                    <td className="py-3" data-l="角色">{user.role === 'admin' ? '管理员' : '用户'}</td>
                    <td className="py-3" data-l="配额">
                      {formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)}
                    </td>
                    <td className="py-3" data-l="状态">{userState(user)}</td>
                    <td className="py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => setEditor(user)}>
                          编辑
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => void toggleUser(user)}>
                          {user.disabled ? '启用' : '停用'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {tab === 'usage' ? (
        <div className="overflow-x-auto border-t border-line-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-1 text-left text-[11px]">
                <th className="py-2 font-medium">用户</th>
                <th className="py-2 font-medium">用量</th>
                <th className="py-2 text-right font-medium">占比</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const ratio = user.quotaBytes > 0 ? Math.min(100, Math.round((user.usedBytes / user.quotaBytes) * 100)) : 0
                return (
                  <tr key={user.id} className="border-b border-line-2">
                    <td className="py-3" data-l="用户">
                      <b>{user.name}</b>
                      <small className="mt-1 block text-muted-foreground">{user.email}</small>
                    </td>
                    <td className="py-3" data-l="用量">
                      <div className="h-1.5 max-w-48 bg-secondary">
                        <div className={`h-full ${ratio > 85 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${ratio}%` }} />
                      </div>
                    </td>
                    <td className="py-3 text-right" data-l="占比">
                      {formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)} · {ratio}%
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="py-4 text-xs text-muted-foreground">调低配额不会删除已有内容。超过配额后无法继续上传，直到用量降下来。</p>
        </div>
      ) : null}
      {tab === 'limits' && limits ? <LimitsEditor limits={limits} onChange={setLimits} /> : null}
    </Shell>
  )
}

function UserEditor({ user, onClose, onSaved }: { user: AdminUser | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const creating = user === null
  const [email, setEmail] = useState('')
  const [name, setName] = useState(user?.name ?? '')
  const [role, setRole] = useState<'admin' | 'user'>(user?.role ?? 'user')
  const [disabled, setDisabled] = useState(user ? user.disabled !== 0 : false)
  const [useDefault, setUseDefault] = useState(user ? user.quotaOverride == null : true)
  const [quotaMb, setQuotaMb] = useState(user ? String(Math.max(1, Math.round(user.quotaBytes / (1024 * 1024)))) : '1024')
  const [busy, setBusy] = useState(false)

  async function save(event: FormEvent) {
    event.preventDefault()
    let quotaBytes: number | null
    try {
      quotaBytes = useDefault ? null : mbToBytes(quotaMb)
    } catch {
      toast.error(`配额需为 1–${quotaCapMb} MB`)
      return
    }
    setBusy(true)
    try {
      if (creating) {
        await api('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            ...(name.trim() ? { name: name.trim() } : {}),
            role,
            ...(quotaBytes === null ? {} : { quotaBytes }),
          }),
        })
        toast.success('用户已预创建，等待首次登录')
      } else {
        if (!name.trim()) {
          toast.error('名称不能为空')
          return
        }
        await api(`/api/admin/users/${user.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            role,
            disabled,
            quotaBytes,
          }),
        })
        toast.success('已保存')
      }
      await onSaved()
      onClose()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function forceLogout() {
    if (!user) return
    setBusy(true)
    try {
      await api(`/api/admin/users/${user.id}/logout`, { method: 'POST' })
      toast.success('已强制下线')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="mb-6 rounded-md border border-line-2 p-4" onSubmit={(event) => void save(event)}>
      <h2 className="text-xs font-medium">{creating ? '新建用户' : '编辑用户'}</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium">
          邮箱
          <input
            className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm font-medium normal-case disabled:opacity-60"
            type="email"
            required
            value={creating ? email : user.email}
            disabled={!creating}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
          />
        </label>
        <label className="text-xs font-medium">
          显示名称
          <input
            className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm font-medium normal-case"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="可留空，默认用邮箱名"
          />
        </label>
        <label className="text-xs font-medium">
          角色
          <select className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm font-medium normal-case" value={role} onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'user')}>
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        {creating ? null : (
          <label className="text-xs font-medium">
            状态
            <select className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm font-medium normal-case" value={disabled ? 'off' : 'on'} onChange={(event) => setDisabled(event.target.value === 'off')}>
              <option value="on">正常</option>
              <option value="off">已停用</option>
            </select>
          </label>
        )}
        <label className="text-xs font-medium">
          配额（MB）
          <input
            className="mt-1 block w-full rounded-md border border-line-2 bg-background px-2 py-2 text-sm font-medium normal-case disabled:opacity-60"
            inputMode="numeric"
            value={quotaMb}
            disabled={useDefault}
            onChange={(event) => setQuotaMb(event.target.value)}
          />
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm font-medium normal-case">
          <input type="checkbox" checked={useDefault} onChange={(event) => setUseDefault(event.target.checked)} />
          使用安装默认配额
        </label>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {creating
          ? '无密码。这里只预创建账号和私人空间。用户首次用该邮箱完成 OAuth 登录时自动绑定，无需邀请链接。'
          : '邮箱是登录身份，不能修改。调低配额不会删除已有内容，但超额后无法再上传。'}
      </p>
      {!creating && user ? <p className="mt-2 text-xs text-muted-foreground">已用 {formatBytes(user.usedBytes)}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>{creating ? '创建用户' : '保存修改'}</Button>
        <Button type="button" variant="outline" onClick={onClose}>取消</Button>
        {creating ? null : (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void forceLogout()}>
            强制下线（全部设备）
          </Button>
        )}
      </div>
      {!creating && user && !user.pending ? (
        <section className="mt-6 border-t border-line-1 pt-4">
          <h3 className="mb-3 text-xs font-medium">登录设备</h3>
          <DeviceSessions userId={user.id} onSelfSignedOut={() => window.location.assign('/login')} />
        </section>
      ) : null}
    </form>
  )
}
