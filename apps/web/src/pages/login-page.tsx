import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { useSession } from '@/lib/session.tsx'

export function LoginPage({ invite }: { invite?: string }) {
  const { status } = useSession()
  const navigate = useNavigate()
  const [providers, setProviders] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api<{ providers: string[] }>('/api/auth/providers')
      .then((body) => {
        if (!cancelled) setProviders(body.providers)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProviders([])
          toast.error(errorText(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!invite && status === 'ready') navigate('/', { replace: true })
  }, [invite, navigate, status])

  async function createRoom() {
    setBusy(true)
    try {
      const room = await api<{ token: string }>('/api/rooms', { method: 'POST' })
      navigate(`/rooms/${room.token}`)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const query = invite ? `?invite=${encodeURIComponent(invite)}` : ''

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-extrabold tracking-widest uppercase">云剪贴板</p>
      <h1 className="mt-3 border-l-[14px] border-primary pl-4 text-6xl font-black tracking-tight">dropit</h1>
      <p className="mt-4 text-sm text-muted-foreground">跨设备传递文本和文件。没有密码，使用 GitHub 或 Google 登录。</p>
      <div className="mt-8 flex flex-col gap-3 border-t-2 border-foreground pt-6">
        {providers === null ? <p className="text-sm text-muted-foreground">正在读取登录方式…</p> : null}
        {providers?.length === 0 ? (
          <p className="border-l-4 border-primary bg-secondary px-3 py-2 text-sm">
            尚未配置 GitHub / Google。凭据通过环境变量提供，配置后刷新此页。
          </p>
        ) : null}
        {providers?.map((provider) => (
          <Button key={provider} type="button" variant="outline" className="justify-start" asChild>
            <a href={`/api/auth/${provider}${query}`}>{provider === 'github' ? '使用 GitHub 继续' : provider === 'google' ? '使用 Google 继续' : provider}</a>
          </Button>
        ))}
        {invite ? null : (
          <Button type="button" onClick={() => void createRoom()} disabled={busy}>
            创建临时房间
          </Button>
        )}
      </div>
    </main>
  )
}
