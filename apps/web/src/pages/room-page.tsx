import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { ClipboardBoard } from '@/components/clipboard-board.tsx'
import { Shell } from '@/components/shell.tsx'
import { Button } from '@/components/ui/button.tsx'
import { ApiError, api, errorText } from '@/lib/api.ts'
import { copyText } from '@/lib/format.ts'
import { useSession } from '@/lib/session.tsx'
import type { ConnectionStatus, ScopeInfo } from '@/lib/types.ts'

export function RoomPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const { me } = useSession()
  const [scope, setScope] = useState<ScopeInfo | null>(null)
  const [missing, setMissing] = useState(false)
  const [connection, setConnection] = useState<ConnectionStatus>('idle')
  const shareUrl = `${window.location.origin}/rooms/${token}`

  useEffect(() => {
    let cancelled = false
    setMissing(false)
    setScope(null)
    api<ScopeInfo>(`/api/rooms/${encodeURIComponent(token)}`)
      .then((body) => {
        if (!cancelled) setScope(body)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) setMissing(true)
        else toast.error(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const onStatus = useCallback((next: ConnectionStatus) => setConnection(next), [])
  const onAuthLost = useCallback(() => setMissing(true), [])

  async function createAnother() {
    try {
      const room = await api<{ token: string }>('/api/rooms', { method: 'POST' })
      navigate(`/rooms/${room.token}`)
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  if (missing) {
    return (
      <Shell connection="stopped">
        <h1 className="border-l-[14px] border-primary pl-4 text-4xl font-black">房间不存在或已过期</h1>
        <p className="mt-4 text-sm text-muted-foreground">临时房间不会出现在任何列表里。可以新建一个再把链接发给对方。</p>
        <Button type="button" className="mt-6" asChild>
          <Link to="/">返回</Link>
        </Button>
      </Shell>
    )
  }

  return (
    <Shell connection={connection}>
      {scope ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 border border-foreground p-3">
            <code className="min-w-0 flex-1 truncate text-sm">{shareUrl}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void copyText(shareUrl).then(() => toast.success('链接已复制'))
              }}
            >
              复制链接
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void createAnother()}>
              新建房间
            </Button>
          </div>
          <ClipboardBoard
            base={`/api/rooms/${token}`}
            title="临时房间"
            subtitle={me ? '已登录也会使用房间自己的配额和保留期。' : '无需登录。把链接发给对方即可互传。'}
            quotaBytes={scope.quotaBytes}
            usedBytes={null}
            maxFileBytes={scope.maxFileBytes}
            maxTextBytes={me?.maxTextBytes ?? 65536}
            deadline={scope.expiresAt}
            sender={() => '访客'}
            canEdit={(item) => item.kind === 'text'}
            canRetract={() => true}
            onAuthLost={onAuthLost}
            onStatus={onStatus}
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">正在打开房间…</p>
      )}
    </Shell>
  )
}
