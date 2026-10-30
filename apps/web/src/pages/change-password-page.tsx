import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { Logo } from '@/components/logo.tsx'
import { PasswordForm } from '@/components/password-form.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useSession } from '@/lib/session.tsx'
import { PageLoading } from '@/components/page-loading.tsx'

/** RHEA-190 auth step 2: shown after signing in with a temporary password (admin reset or dropit-admin). */
export function ChangePasswordPage() {
  const { status, me, refresh, logout } = useSession()
  const navigate = useNavigate()

  useEffect(() => {
    if (status === 'anon') navigate('/login', { replace: true })
  }, [navigate, status])

  if (!me) return <PageLoading label="正在读取…" />
  const forced = Boolean(me.mustChangePassword)
  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6 py-16">
      <h1>
        <Logo size="lg" />
      </h1>
      <h2 className="mt-6 text-xl font-semibold">{forced ? '请设置新密码' : '修改密码'}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {forced ? `${me.user.email} 正在使用管理员发的临时密码。设置自己的新密码后才能继续使用。` : `为 ${me.user.email} 设置新密码。`}
      </p>
      <div className="mt-6 border-t border-line-1 pt-6">
        <PasswordForm
          hasPassword={Boolean(me.hasPassword)}
          currentLabel={forced ? '临时密码' : '当前密码'}
          onDone={async () => {
            await refresh()
            navigate('/', { replace: true })
          }}
        />
      </div>
      <Button type="button" variant="ghost" className="mt-6 self-start" onClick={() => void logout().then(() => navigate('/login', { replace: true }))}>
        退出登录
      </Button>
    </main>
  )
}
