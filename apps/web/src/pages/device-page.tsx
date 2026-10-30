import { Link, useSearchParams } from 'react-router'
import { DeviceConfirm } from '@/components/device-confirm.tsx'
import { LoginRedirect } from '@/components/login-redirect.tsx'
import { PageTitle, Shell } from '@/components/shell.tsx'
import { Button } from '@/components/ui/button.tsx'
import { normalizeUserCode, readVerificationId } from '@/lib/machine.ts'
import { useSession } from '@/lib/session.tsx'
import { PageLoading } from '@/components/page-loading.tsx'

export function DevicePage() {
  const { status, me, refresh } = useSession()
  const [params] = useSearchParams()
  const code = normalizeUserCode(params.get('user_code') ?? '')
  const verificationId = readVerificationId(params.get('verification_id'))

  if (status === 'loading') return <PageLoading label="正在连接…" />
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
  // Signed out: /login?next=/device?user_code=… keeps the device code across login (RHEA-190 m48).
  if (!me) return <LoginRedirect />

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
