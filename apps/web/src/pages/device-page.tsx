import { useEffect } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DeviceConfirm } from '@/components/device-confirm.tsx'
import { PageTitle, Shell } from '@/components/shell.tsx'
import { Button } from '@/components/ui/button.tsx'
import { normalizeUserCode, readVerificationId, rememberReturn } from '@/lib/machine.ts'
import { useSession } from '@/lib/session.tsx'

export function DevicePage() {
  const { status, me, refresh } = useSession()
  const [params] = useSearchParams()
  const code = normalizeUserCode(params.get('user_code') ?? '')
  const verificationId = readVerificationId(params.get('verification_id'))

  useEffect(() => {
    if (status !== 'anon') return
    rememberReturn(`${window.location.pathname}${window.location.search}`)
  }, [status])

  if (status === 'loading') return <main className="px-6 py-16 text-sm text-muted-foreground">正在连接…</main>
  if (status === 'error') {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-3xl font-semibold">无法连接</h1>
        <Button type="button" className="mt-6" onClick={() => void refresh()}>
          重试
        </Button>
      </main>
    )
  }
  if (!me) {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6 py-16">
        <p className="text-xs font-medium">设备登录</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">确认设备</h1>
        {code ? <p className="mt-6 font-mono text-3xl font-semibold tracking-[0.3em]">{code}</p> : null}
        <p className="mt-4 text-sm text-muted-foreground">请先登录。登录后会回到此页，核对设备名和网络概要再允许。</p>
        <Link to="/login" className="mt-6 inline-flex rounded-md border border-line-2 px-3 py-2 text-xs font-medium">
          登录后继续
        </Link>
      </main>
    )
  }

  return (
    <Shell>
      <PageTitle title="确认设备" sub="只批准你认识的终端。设备码十分钟内有效，且只能用一次。" />
      <DeviceConfirm initialCode={code} initialVerificationId={verificationId} auto />
      <p className="mt-6 text-sm">
        <Link to="/settings" className="font-medium">
          管理已有令牌
        </Link>
      </p>
    </Shell>
  )
}
