import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { LoginPage } from './login-page.tsx'
import { ClipboardBoard } from '@/components/clipboard-board.tsx'
import { Shell } from '@/components/shell.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api } from '@/lib/api.ts'
import { spaceLabel } from '@/lib/format.ts'
import { takeReturn } from '@/lib/machine.ts'
import { useSession } from '@/lib/session.tsx'
import type { ConnectionStatus, Item, SpaceSummary } from '@/lib/types.ts'

const spaceKey = 'dropit-space'

export function HomePage() {
  const { status, me, refresh } = useSession()
  const navigate = useNavigate()
  const [spaces, setSpaces] = useState<SpaceSummary[]>([])
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionStatus>('idle')
  const uploadBusy = useRef(false)
  const cancelUploads = useRef<() => void>(() => {})

  useEffect(() => {
    if (!me) return
    const next = takeReturn()
    if (next) navigate(next, { replace: true })
  }, [me, navigate])

  useEffect(() => {
    if (!me) return
    let cancelled = false
    api<{ spaces: SpaceSummary[] }>('/api/spaces')
      .then((body) => {
        if (cancelled) return
        setSpaces(body.spaces)
        const stored = sessionStorage.getItem(spaceKey)
        const picked = body.spaces.find((space) => space.id === stored) ?? body.spaces.find((space) => space.ownerId === me.user.id) ?? body.spaces[0]
        setSpaceId(picked?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setSpaces([])
      })
    return () => {
      cancelled = true
    }
  }, [me])

  const onBusyChange = useCallback((busy: boolean) => {
    uploadBusy.current = busy
  }, [])
  const onBindCancel = useCallback((cancel: () => void) => {
    cancelUploads.current = cancel
  }, [])
  const onSpace = useCallback((id: string) => {
    if (id === spaceId) return
    if (uploadBusy.current && !window.confirm('还有未完成的上传，离开会取消这些上传。')) return
    cancelUploads.current()
    setSpaceId(id)
    sessionStorage.setItem(spaceKey, id)
  }, [spaceId])

  const onStatus = useCallback((next: ConnectionStatus) => setConnection(next), [])
  const onAuthLost = useCallback(() => {
    void refresh()
  }, [refresh])

  if (status === 'loading') return <main className="px-6 py-16 text-sm text-muted-foreground">正在连接…</main>
  if (status === 'error') {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-3xl font-black">无法连接</h1>
        <Button type="button" className="mt-6" onClick={() => void refresh()}>
          重试
        </Button>
      </main>
    )
  }
  if (!me) return <LoginPage />

  const current = spaces.find((space) => space.id === spaceId) ?? null

  return (
    <Shell connection={connection} spaces={spaces} spaceId={current?.id} onSpace={onSpace}>
      {current ? (
        <ClipboardBoard
          base={`/api/spaces/${current.id}`}
          title={spaceLabel(current, me.user.id, spaces)}
          subtitle="文本、文件和截图会同步到这个空间里的其他设备。"
          quotaBytes={me.quotaBytes}
          usedBytes={me.usedBytes}
          maxFileBytes={me.maxFileBytes}
          maxTextBytes={me.maxTextBytes}
          sender={(item: Item) => (item.userId === me.user.id ? '我' : '成员')}
          canEdit={(item) => item.kind === 'text' && item.userId === me.user.id}
          canRetract={(item) => item.userId === me.user.id || current.ownerId === me.user.id}
          canShare={(item) => item.userId === me.user.id || current.ownerId === me.user.id}
          onActivity={() => void refresh()}
          onAuthLost={onAuthLost}
          onStatus={onStatus}
          onBusyChange={onBusyChange}
          onBindCancel={onBindCancel}
        />
      ) : (
        <p className="text-sm text-muted-foreground">没有可用空间。</p>
      )}
    </Shell>
  )
}
