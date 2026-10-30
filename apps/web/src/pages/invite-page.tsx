import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { LoginPage } from './login-page.tsx'
import { Button } from '@/components/ui/button.tsx'
import { ApiError, api, errorText } from '@/lib/api.ts'
import { formatRemain, useClock } from '@/lib/format.ts'
import { useSession } from '@/lib/session.tsx'
import type { InvitePreview } from '@/lib/types.ts'
import { PageLoading } from '@/components/page-loading.tsx'

const ROLE_TEXT = { viewer: '只读：可以查看和复制，不能发送、编辑或删除', editor: '可编辑：可以查看、发送和整理内容' } as const

export function InvitePage() {
  const { token = '' } = useParams()
  const now = useClock(0)
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [missing, setMissing] = useState(false)
  const [joining, setJoining] = useState(false)
  const { status, me } = useSession()
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    api<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`)
      .then((body) => {
        if (!cancelled) setPreview(body)
      })
      .catch((error: unknown) => {
        if (!cancelled && error instanceof ApiError && error.status === 404) setMissing(true)
        else if (!cancelled) setMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  if (missing) {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6">
        <h1 className="text-4xl font-semibold">邀请无效</h1>
        <p className="mt-4 text-sm text-muted-foreground">链接已过期、已撤销或已用完。</p>
        <Link to="/login" className="mt-6 text-sm font-medium">
          返回登录
        </Link>
      </main>
    )
  }

  if (!preview) {
    return <PageLoading label="正在核对邀请…" />
  }

  const spaceTitle = preview.spaceName === 'Private space' ? (preview.inviterName ? `${preview.inviterName} 的空间` : '私人空间') : preview.spaceName
  const roleText = preview.role ? ROLE_TEXT[preview.role] : null

  function enter(spaceId: string | null | undefined) {
    if (spaceId) sessionStorage.setItem('dropit-space', spaceId)
    navigate('/')
  }

  async function join() {
    setJoining(true)
    try {
      const joined = await api<{ spaceId: string }>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' })
      toast.success(`已加入「${spaceTitle}」`)
      enter(joined.spaceId)
    } catch (error) {
      toast.error(errorText(error))
      setJoining(false)
    }
  }

  // RHEA-190 m50: a signed-in user joins the space with one click (no second login).
  if (!preview.personal && status === 'ready' && me) {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6" data-space-invite="">
        <h1 className="text-3xl font-semibold">加入「{spaceTitle}」</h1>
        <p className="mt-4 text-sm text-fg-2">
          {preview.inviterName ? `${preview.inviterName} 邀请你加入 TA 的空间。` : '你被邀请加入一个空间。'}
          {roleText ? `权限：${roleText}。` : ''}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          当前账号 {me.user.email} · 剩余 {preview.remainingUses} 次 · {formatRemain(preview.expiresAt - now)}
        </p>
        {preview.member ? (
          <Button type="button" className="mt-6" onClick={() => enter(preview.spaceId)}>
            你已是成员，进入空间
          </Button>
        ) : (
          <Button type="button" className="mt-6" disabled={joining} onClick={() => void join()}>
            加入空间
          </Button>
        )}
      </main>
    )
  }

  return (
    <div>
      <p className="mx-auto mt-10 max-w-md rounded-md border border-line-1 border-l border-l-brand bg-surface-2 px-3 py-2 text-sm">
        {preview.personal
          ? `${preview.inviterName ? `${preview.inviterName} 邀请你` : '你被邀请'}注册 dropit，你会得到自己的私人空间 · 剩余 ${preview.remainingUses} 次 · `
          : `${preview.inviterName ? `${preview.inviterName} 邀请你` : '你被邀请'}加入「${spaceTitle}」${roleText ? `（${roleText}）` : ''}，登录后自动加入 · 剩余 ${preview.remainingUses} 次 · `}
        {formatRemain(preview.expiresAt - now)}
        {!preview.personal && preview.canRegister === false ? <span className="mt-1 block text-xs text-muted-foreground">这个邀请不能用来注册新账号：请用已有账号登录。</span> : null}
      </p>
      <LoginPage invite={token} />
    </div>
  )
}
