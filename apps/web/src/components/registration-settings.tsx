import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Note, Panel, Switch, fieldClass, labelClass } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { formatStamp } from '@/lib/machine.ts'

type Policy = 'closed' | 'invite' | 'open'
type UserInvites = { enabled: boolean; defaultLimit: number }
type RegistrationView = { policy: Policy; default: Policy; updatedAt: number | null; updatedBy: string | null; userInvites?: UserInvites }

const CHOICES: { value: Policy; label: string; description: string }[] = [
  { value: 'invite', label: '仅邀请（默认）', description: '只有拿到邀请链接，或管理员预创建了账号的人才能加入。' },
  { value: 'closed', label: '关闭注册', description: '不接受新账号，邀请链接也不能注册新用户；已有账号照常登录。' },
  { value: 'open', label: '开放注册', description: '任何人都能用邮箱 + 密码或 OAuth 注册。邮箱不做验证，公网站点慎用。' },
]

/** RHEA-190 auth step 2: 管理 → 注册. Who may create a new account. */
export function RegistrationSettings() {
  const [view, setView] = useState<RegistrationView | null>(null)
  const [draft, setDraft] = useState<Policy>('invite')
  const [busy, setBusy] = useState(false)
  const [inviteDraft, setInviteDraft] = useState<UserInvites>({ enabled: true, defaultLimit: 5 })
  const [limitText, setLimitText] = useState('5')
  const [inviteBusy, setInviteBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api<RegistrationView>('/api/admin/registration')
      .then((body) => {
        if (cancelled) return
        setView(body)
        setDraft(body.policy)
        if (body.userInvites) {
          setInviteDraft(body.userInvites)
          setLimitText(String(body.userInvites.defaultLimit))
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function save() {
    setBusy(true)
    try {
      const body = await api<RegistrationView>('/api/admin/registration', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy: draft }),
      })
      setView(body)
      toast.success('注册策略已保存')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function saveInvites() {
    const defaultLimit = Number(limitText)
    if (!/^\d+$/.test(limitText.trim()) || !Number.isSafeInteger(defaultLimit) || defaultLimit > 1000) {
      toast.error('默认上限需为 0–1000 的整数')
      return
    }
    setInviteBusy(true)
    try {
      const body = await api<RegistrationView>('/api/admin/registration', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userInvites: { enabled: inviteDraft.enabled, defaultLimit } }),
      })
      setView(body)
      if (body.userInvites) setInviteDraft(body.userInvites)
      toast.success('用户邀请设置已保存')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setInviteBusy(false)
    }
  }

  if (!view) return <p className="text-sm text-muted-foreground">正在读取…</p>
  return (
    <>
    <Panel id="registration" title="注册策略" description="决定陌生人能否创建新账号。第一个账号（/setup 或 ADMIN_EMAIL）不受限制。">
      <fieldset className="grid gap-2.5" aria-label="注册策略">
        {CHOICES.map((choice) => (
          <label key={choice.value} className="flex cursor-pointer items-start gap-3 rounded-md border border-line-1 bg-surface-0 px-4 py-3 text-sm" data-policy={choice.value}>
            <input type="radio" name="registration" className="mt-1" value={choice.value} checked={draft === choice.value} onChange={() => setDraft(choice.value)} />
            <span>
              <b className="font-semibold text-fg">{choice.label}</b>
              <small className="mt-0.5 block text-[13px] text-muted-foreground">{choice.description}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {draft === 'open' ? (
        <div className="mt-3">
          <Note tone="warn">开放注册不验证邮箱：别人可以抢先用某个邮箱注册。之后那个人再用同一邮箱的 GitHub / Google 登录会被拒绝（需先登录再绑定）。</Note>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" disabled={busy || draft === view.policy} onClick={() => void save()}>
          保存
        </Button>
        <span className="text-xs text-fg-4">
          {view.updatedAt ? `上次修改：${formatStamp(view.updatedAt)}${view.updatedBy ? ` · ${view.updatedBy}` : ''}` : '使用默认值（仅邀请）'}
        </span>
      </div>
    </Panel>
      <Panel id="user-invites" title="用户邀请" description="普通用户可以在「设置 → 邀请」里生成一次性邀请链接。被邀请的人只得到自己的账号，不会加入邀请人的空间。管理员不受限制；个别用户的上限可在「用户」里单独修改。">
        <div className="grid gap-4 px-4 py-3.5 sm:px-5">
          <Switch label="允许普通用户邀请" description="关闭后普通用户不能再生成邀请，已有的邀请仍然有效。" checked={inviteDraft.enabled} onChange={(event) => setInviteDraft({ ...inviteDraft, enabled: event.target.checked })} />
          <label className={labelClass}>
            每人默认邀请上限（有效或已使用的邀请都计入）
            <input className={`${fieldClass} max-w-40`} inputMode="numeric" value={limitText} onChange={(event) => setLimitText(event.target.value)} />
          </label>
          <div>
            <Button type="button" disabled={inviteBusy} onClick={() => void saveInvites()}>
              保存邀请设置
            </Button>
          </div>
        </div>
      </Panel>
    </>
  )
}
