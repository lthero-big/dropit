import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { CopyIcon, DoorOpenIcon, GaugeIcon, GlobeIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon, SlidersHorizontalIcon, TicketIcon, UsersIcon } from 'lucide-react'
import { DeviceSessions } from '@/components/device-sessions.tsx'
import { LimitsEditor } from '@/components/limits-editor.tsx'
import { OAuthSettings } from '@/components/oauth-settings.tsx'
import { RegistrationSettings } from '@/components/registration-settings.tsx'
import { SiteOriginSettings } from '@/components/site-origin-settings.tsx'
import { Panel, SectionHeader, SettingsLayout, SideNav, StatusPill, Switch, fieldClass, labelClass, selectClass, type NavGroup, type Tone } from '@/components/settings-ui.tsx'
import { PageTitle, Shell } from '@/components/shell.tsx'
import { UpdateNotice, UpdatePanel } from '@/components/update-panel.tsx'
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

type Tab = 'invites' | 'users' | 'registration' | 'usage' | 'limits' | 'site' | 'oauth' | 'update'
const tabIds: Tab[] = ['invites', 'users', 'registration', 'usage', 'limits', 'site', 'oauth', 'update']

/**
 * RHEA-190 m22: 管理 is grouped by what the admin is doing, and OAuth (an
 * installation-wide setting) moved here from 设置, which is per-account.
 */
const NAV: NavGroup<Tab>[] = [
  {
    label: '成员与访问',
    items: [
      { id: 'invites', label: '邀请', icon: TicketIcon, hint: '生成一次性邀请链接' },
      { id: 'users', label: '用户', icon: UsersIcon, hint: '预创建、编辑、停用用户' },
      { id: 'registration', label: '注册', icon: DoorOpenIcon, hint: '关闭 / 仅邀请 / 开放' },
    ],
  },
  {
    label: '资源与限制',
    items: [
      { id: 'usage', label: '用量', icon: GaugeIcon, hint: '每个用户的存储占用' },
      { id: 'limits', label: '限制', icon: SlidersHorizontalIcon, hint: '容量、时间、限流' },
    ],
  },
  {
    label: '登录与安全',
    items: [
      { id: 'site', label: '站点地址', icon: GlobeIcon, hint: 'APP_ORIGIN、链接与回调地址' },
      { id: 'oauth', label: 'OAuth 登录', icon: KeyRoundIcon, hint: 'GitHub / Google 应用凭据' },
    ],
  },
  { label: '系统', items: [{ id: 'update', label: '更新', icon: RefreshCwIcon, hint: '版本与升级' }] },
]

const HEADERS: Record<Tab, { title: string; description: string }> = {
  invites: { title: '邀请', description: '为某个空间生成邀请链接。链接只在生成时显示一次，过期、撤销或用尽后立即失效。' },
  users: { title: '用户', description: '预创建账号、调整角色与配额、重置密码、停用或强制下线。预创建的账号可用临时密码登录，或首次 OAuth 登录时按邮箱绑定。' },
  registration: { title: '注册', description: '谁可以创建新账号：关闭、仅邀请（默认）或开放注册。' },
  usage: { title: '用量', description: '每个用户当前占用的存储与配额。调低配额不会删除已有内容。' },
  limits: { title: '限制', description: '上传大小、保留时间、会话与限流。修改立即生效，并写入变更记录。' },
  site: { title: '站点地址', description: '浏览器访问本站的地址（APP_ORIGIN）。可以在这里改，不用重启；优先级高于环境变量。' },
  oauth: { title: 'OAuth 登录', description: '配置登录页使用的 GitHub / Google 应用。这是整个站点的设置，只有管理员能看到。' },
  update: { title: '更新', description: '当前版本、可用更新和升级方式。' },
}

function initialTab(): Tab {
  const requested = new URLSearchParams(window.location.search).get('tab')
  return tabIds.includes(requested as Tab) ? (requested as Tab) : 'invites'
}
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

const stateTone = (state: string): Tone => (state === '有效' || state === '正常' ? 'good' : state === '待首次登录' ? 'warn' : 'neutral')

function loginSummary(user: AdminUser): string {
  const methods = [...(user.hasPassword ? ['密码'] : []), ...(user.providers ?? []).map((provider) => (provider === 'github' ? 'GitHub' : provider === 'google' ? 'Google' : provider))]
  return methods.length ? methods.join(' · ') : '尚未设置登录方式'
}

function mbToBytes(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('invalid')
  const mb = Number(value)
  if (mb < 1 || mb > quotaCapMb) throw new Error('invalid')
  return mb * 1024 * 1024
}

const thClass = 'px-4 py-2.5 text-left text-[11px] font-medium text-fg-3 first:pl-4 sm:first:pl-5 last:pr-4 sm:last:pr-5'
const tdClass = 'px-4 py-3 align-middle first:pl-4 sm:first:pl-5 last:pr-4 sm:last:pr-5'

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
  const [tab, setTab] = useState<Tab>(initialTab)
  const [editor, setEditor] = useState<Editor>(null)
  const contentRef = useRef<HTMLDivElement>(null)

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

  function selectTab(next: Tab) {
    setTab(next)
    const params = new URLSearchParams(window.location.search)
    params.set('tab', next)
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
    // Keep the nav where it is; only bring the top of the new panel into view if it scrolled away.
    const top = contentRef.current?.getBoundingClientRect().top ?? 0
    if (top < 0) window.scrollBy({ top: top - 88 })
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

  const header = HEADERS[tab]

  return (
    <Shell>
      <PageTitle title="管理" />
      {tab === 'update' ? null : <UpdateNotice onOpen={() => selectTab('update')} />}
      <SettingsLayout nav={<SideNav label="管理分类" groups={NAV} active={tab} onSelect={selectTab} mode="tabs" />}>
        <div ref={contentRef} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} data-admin-panel={tab}>
          <SectionHeader
            title={header.title}
            description={header.description}
            actions={
              tab === 'users' ? (
                <Button type="button" onClick={() => setEditor('new')}>
                  <PlusIcon aria-hidden="true" />
                  新建用户
                </Button>
              ) : null
            }
          />
          {tab === 'invites' ? (
            <>
              <Panel title="生成邀请" description="选择空间、可用次数和有效期。">
                <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8.5rem_8.5rem_auto] sm:items-end" onSubmit={(event) => void createInvite(event)}>
                  <label className={labelClass}>
                    空间
                    <select className={selectClass} value={spaceId} onChange={(event) => setSpaceId(event.target.value)}>
                      {spaces.map((space) => (
                        <option key={space.id} value={space.id}>
                          {spaceLabel(space, me.user.id, spaces)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={labelClass}>
                    次数
                    <select className={selectClass} value={maxUses} onChange={(event) => setMaxUses(event.target.value)}>
                      {useChoices.map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={labelClass}>
                    有效期
                    <select className={selectClass} value={hours} onChange={(event) => setHours(event.target.value)}>
                      {hourChoices.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button type="submit" className="h-10">
                    生成邀请
                  </Button>
                </form>
                {freshUrl ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-brand/40 bg-brand-soft px-3 py-2">
                    <code className="min-w-0 flex-1 truncate text-sm">{freshUrl}</code>
                    <Button type="button" variant="outline" size="sm" onClick={() => void copyText(freshUrl).then(() => toast.success('已复制'))}>
                      <CopyIcon aria-hidden="true" />
                      复制
                    </Button>
                  </div>
                ) : null}
              </Panel>
              <Panel title="邀请记录" flush>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-0">
                      <tr className="border-b border-line-1">
                        <th className={thClass}>空间</th>
                        <th className={thClass}>使用</th>
                        <th className={thClass}>剩余</th>
                        <th className={thClass}>状态</th>
                        <th className={thClass}>
                          <span className="sr-only">操作</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {invites.map((invite) => {
                        const space = spaces.find((item) => item.id === invite.spaceId)
                        const state = inviteState(invite, now)
                        return (
                          <tr key={invite.id} className="border-b border-line-1 last:border-b-0">
                            <td className={tdClass} data-l="空间">
                              {invite.joinSpace === 0 ? `个人邀请 · ${invite.createdByEmail ?? '未知'}` : space ? spaceLabel(space, me.user.id, spaces) : invite.spaceId.slice(0, 8)}
                            </td>
                            <td className={`${tdClass} tabular-nums`} data-l="使用">{invite.uses}/{invite.maxUses}</td>
                            <td className={`${tdClass} text-fg-2`} data-l="剩余">{formatRemain(invite.expiresAt - now)}</td>
                            <td className={tdClass} data-l="状态">
                              <StatusPill tone={stateTone(state)}>{state}</StatusPill>
                            </td>
                            <td className={`${tdClass} text-right`}>
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
                  {invites.length === 0 ? <p className="px-5 py-6 text-sm text-muted-foreground">还没有邀请。</p> : null}
                </div>
              </Panel>
            </>
          ) : null}
          {tab === 'users' ? (
            <>
              {editor ? (
                <UserEditor
                  key={editor === 'new' ? 'new' : editor.id}
                  user={editor === 'new' ? null : editor}
                  onClose={() => setEditor(null)}
                  onSaved={load}
                />
              ) : null}
              <Panel title={`全部用户 · ${users.length}`} flush>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-0">
                      <tr className="border-b border-line-1">
                        <th className={thClass}>用户</th>
                        <th className={thClass}>角色</th>
                        <th className={thClass}>配额</th>
                        <th className={thClass}>状态</th>
                        <th className={thClass}>
                          <span className="sr-only">操作</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr key={user.id} className={`border-b border-line-1 last:border-b-0 ${user.disabled ? 'text-fg-3' : ''}`}>
                          <td className={tdClass} data-l="用户">
                            <b className="font-semibold">{user.name}</b>
                            <small className="mt-0.5 block text-xs text-muted-foreground">{user.email}</small>
                            <small className="mt-0.5 block text-[11px] text-fg-4" data-login-summary="">
                              {loginSummary(user)}
                              {user.mustChangePassword ? ' · 待改临时密码' : ''}
                            </small>
                          </td>
                          <td className={tdClass} data-l="角色">
                            {user.role === 'admin' ? <StatusPill tone="brand">管理员</StatusPill> : <span className="text-fg-2">用户</span>}
                          </td>
                          <td className={`${tdClass} tabular-nums text-fg-2`} data-l="配额">
                            {formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)}
                          </td>
                          <td className={tdClass} data-l="状态">
                            <StatusPill tone={stateTone(userState(user))}>{userState(user)}</StatusPill>
                          </td>
                          <td className={`${tdClass} text-right`}>
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
              </Panel>
            </>
          ) : null}
          {tab === 'usage' ? (
            <Panel flush>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-0">
                    <tr className="border-b border-line-1">
                      <th className={thClass}>用户</th>
                      <th className={thClass}>用量</th>
                      <th className={`${thClass} text-right`}>占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => {
                      const ratio = user.quotaBytes > 0 ? Math.min(100, Math.round((user.usedBytes / user.quotaBytes) * 100)) : 0
                      return (
                        <tr key={user.id} className="border-b border-line-1 last:border-b-0">
                          <td className={tdClass} data-l="用户">
                            <b className="font-semibold">{user.name}</b>
                            <small className="mt-0.5 block text-xs text-muted-foreground">{user.email}</small>
                          </td>
                          <td className={`${tdClass} w-[40%]`} data-l="用量">
                            <div className="h-2 max-w-64 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={`${user.name} 用量`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio}>
                              <div className={`h-full rounded-full ${ratio > 85 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${ratio}%` }} />
                            </div>
                          </td>
                          <td className={`${tdClass} text-right tabular-nums text-fg-2`} data-l="占比">
                            {formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)} · {ratio}%
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}
          {tab === 'limits' ? limits ? <LimitsEditor limits={limits} onChange={setLimits} /> : <p className="text-sm text-muted-foreground">正在读取…</p> : null}
          {tab === 'site' ? <SiteOriginSettings /> : null}
          {tab === 'oauth' ? <OAuthSettings /> : null}
          {tab === 'registration' ? <RegistrationSettings /> : null}
          {tab === 'update' ? <UpdatePanel /> : null}
        </div>
      </SettingsLayout>
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
  const [inviteLimit, setInviteLimit] = useState(user?.inviteLimit == null ? '' : String(user.inviteLimit))
  const [quotaMb, setQuotaMb] = useState(user ? String(Math.max(1, Math.round(user.quotaBytes / (1024 * 1024)))) : '1024')
  const [busy, setBusy] = useState(false)
  const [withPassword, setWithPassword] = useState(false)
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  async function resetPassword() {
    if (!user) return
    setBusy(true)
    try {
      const body = await api<{ temporaryPassword: string }>(`/api/admin/users/${user.id}/password`, { method: 'POST' })
      setIssued({ email: user.email, password: body.temporaryPassword })
      setConfirmReset(false)
      toast.success('已生成临时密码，对方的所有设备已下线')
      await onSaved()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    let quotaBytes: number | null
    try {
      quotaBytes = useDefault ? null : mbToBytes(quotaMb)
    } catch {
      toast.error(`配额需为 1–${quotaCapMb} MB`)
      return
    }
    let inviteLimitValue: number | null = null
    if (!creating && inviteLimit.trim() !== '') {
      inviteLimitValue = Number(inviteLimit)
      if (!/^\d+$/.test(inviteLimit.trim()) || !Number.isSafeInteger(inviteLimitValue) || inviteLimitValue > 1000) {
        toast.error('邀请上限需为 0–1000 的整数，留空使用默认值')
        return
      }
    }
    setBusy(true)
    try {
      if (creating) {
        const created = await api<AdminUser>('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            ...(name.trim() ? { name: name.trim() } : {}),
            role,
            ...(quotaBytes === null ? {} : { quotaBytes }),
            ...(withPassword ? { temporaryPassword: true } : {}),
          }),
        })
        toast.success('用户已预创建，等待首次登录')
        if (created.temporaryPassword) {
          // Shown once: keep the editor open so the admin can copy it.
          setIssued({ email: created.email, password: created.temporaryPassword })
          await onSaved()
          return
        }
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
            inviteLimit: inviteLimitValue,
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
    <Panel
      title={creating ? '新建用户' : `编辑用户 · ${user.name}`}
      description={
        creating
          ? '预创建账号和私人空间，无需邀请链接。可以生成一个临时密码交给对方（首次登录后必须改掉），也可以等对方首次用该邮箱完成 OAuth 登录时自动绑定。'
          : '邮箱是登录身份，不能修改。调低配额不会删除已有内容，但超额后无法再上传。'
      }
      className="border-line-2 shadow-elev-2"
      data-user-editor=""
    >
      {issued ? (
        <div className="mb-5 rounded-md border border-line-2 border-l border-l-brand bg-surface-2 px-4 py-3 text-sm" data-temporary-password="">
          <p className="font-medium text-fg">{issued.email} 的临时密码（只显示这一次）</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-surface-0 px-2 py-1 font-mono text-base tracking-wide">{issued.password}</code>
            <Button type="button" variant="outline" size="sm" onClick={() => void copyText(issued.password).then(() => toast.success('已复制'))}>
              <CopyIcon className="size-3.5" />
              复制
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">把它通过安全渠道交给对方。用它登录后会被要求立即设置新密码。</p>
        </div>
      ) : null}
      <form onSubmit={(event) => void save(event)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>
            邮箱
            <input
              className={fieldClass}
              type="email"
              required
              value={creating ? email : user.email}
              disabled={!creating}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
            />
          </label>
          <label className={labelClass}>
            显示名称
            <input className={fieldClass} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="可留空，默认用邮箱名" />
          </label>
          <label className={labelClass}>
            角色
            <select className={selectClass} value={role} onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'user')}>
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </label>
          {creating ? null : (
            <label className={labelClass}>
              状态
              <select className={selectClass} value={disabled ? 'off' : 'on'} onChange={(event) => setDisabled(event.target.value === 'off')}>
                <option value="on">正常</option>
                <option value="off">已停用</option>
              </select>
            </label>
          )}
          <label className={labelClass}>
            配额（MB）
            <input className={fieldClass} inputMode="numeric" value={quotaMb} disabled={useDefault} onChange={(event) => setQuotaMb(event.target.value)} />
          </label>
          <Switch className="self-end" label="使用安装默认配额" description="关闭后可单独设置这个用户的配额" checked={useDefault} onChange={(event) => setUseDefault(event.target.checked)} />
          {creating ? null : (
            <label className={labelClass}>
              邀请上限（留空使用默认值 {user?.inviteLimitEffective !== undefined && user.inviteLimit == null ? `：${user.inviteLimitEffective}` : ''}）
              <input className={fieldClass} inputMode="numeric" value={inviteLimit} placeholder="默认" onChange={(event) => setInviteLimit(event.target.value)} />
              <span className="text-[11px] text-muted-foreground">已用 {user?.invitesUsed ?? 0}</span>
            </label>
          )}
          {creating ? (
            <Switch label="生成临时密码" description="创建后显示一次；对方首次登录必须修改。关闭则只能用 OAuth 绑定。" checked={withPassword} onChange={(event) => setWithPassword(event.target.checked)} />
          ) : null}
        </div>
        {!creating && user ? <p className="mt-3 text-xs text-muted-foreground">已用 {formatBytes(user.usedBytes)}</p> : null}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line-1 pt-4">
          <Button type="submit" disabled={busy}>
            {creating ? '创建用户' : '保存修改'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          {creating ? null : confirmReset ? (
            <>
              <Button type="button" variant="destructive" className="sm:ml-auto" disabled={busy} onClick={() => void resetPassword()} data-confirm-reset="">
                确认重置密码
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmReset(false)}>
                不重置
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" className="sm:ml-auto" disabled={busy} onClick={() => setConfirmReset(true)} data-reset-password="">
              重置密码
            </Button>
          )}
          {creating ? null : (
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void forceLogout()}>
              强制下线（全部设备）
            </Button>
          )}
        </div>
      </form>
      {!creating && user && !user.pending ? (
        <section className="mt-6 border-t border-line-1 pt-4">
          <h3 className="mb-3 text-sm font-medium text-fg">登录设备</h3>
          <DeviceSessions userId={user.id} onSelfSignedOut={() => window.location.assign('/login')} />
        </section>
      ) : null}
    </Panel>
  )
}
