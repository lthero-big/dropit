import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { LoginPage } from './login-page.tsx'
import { ApiError, api } from '@/lib/api.ts'
import { formatRemain, useClock } from '@/lib/format.ts'
import type { InvitePreview } from '@/lib/types.ts'

export function InvitePage() {
  const { token = '' } = useParams()
  const now = useClock(0)
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [missing, setMissing] = useState(false)

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
        <h1 className="border-l-[14px] border-primary pl-4 text-4xl font-black">邀请无效</h1>
        <p className="mt-4 text-sm text-muted-foreground">链接已过期、已撤销或已用完。</p>
        <Link to="/login" className="mt-6 text-sm font-extrabold tracking-widest uppercase">
          返回登录
        </Link>
      </main>
    )
  }

  if (!preview) {
    return <main className="px-6 py-16 text-sm text-muted-foreground">正在核对邀请…</main>
  }

  return (
    <div>
      <p className="mx-auto mt-10 max-w-md border-l-4 border-primary bg-secondary px-3 py-2 text-sm">
        加入「{preview.spaceName === 'Private space' ? '私人空间' : preview.spaceName}」· 剩余 {preview.remainingUses} 次 ·{' '}
        {formatRemain(preview.expiresAt - now)}
      </p>
      <LoginPage invite={token} />
    </div>
  )
}
