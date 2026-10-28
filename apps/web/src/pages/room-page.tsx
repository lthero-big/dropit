import { useCallback, useEffect, useRef, useState } from 'react'
import { toDataURL } from 'qrcode'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { ClipboardBoard } from '@/components/clipboard-board.tsx'
import { EnterRoomForm } from '@/components/enter-room.tsx'
import { RoomCodeBar } from '@/components/room-code.tsx'
import { Shell } from '@/components/shell.tsx'
import { Button } from '@/components/ui/button.tsx'
import { ApiError, api, errorText } from '@/lib/api.ts'
import { copyText } from '@/lib/format.ts'
import { isOwnTempRoom, openTempRoom } from '@/lib/temp-room.ts'
import { useSession } from '@/lib/session.tsx'
import type { ConnectionStatus, ScopeInfo } from '@/lib/types.ts'

export function RoomPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const { me } = useSession()
  const [scope, setScope] = useState<ScopeInfo | null>(null)
  const [missing, setMissing] = useState(false)
  const [, setConnection] = useState<ConnectionStatus>('idle')
  const [qr, setQr] = useState<string | null>(null)
  const [qrOpen, setQrOpen] = useState(false)
  const [qrLarge, setQrLarge] = useState(false)
  const qrRootRef = useRef<HTMLDivElement>(null)
  // A token with a dot came from entering the room code: it is not the room link, so share the code instead.
  const entered = token.includes('.')
  const shareUrl = entered ? `${window.location.origin}/join${scope?.code ? `?code=${encodeURIComponent(scope.code)}` : ''}` : `${window.location.origin}/r/${token}`

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

  useEffect(() => {
    let cancelled = false
    setQr(null)
    void toDataURL(shareUrl, { margin: 1, width: 384, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setQr(url)
      })
      .catch(() => {
        if (!cancelled) setQr(null)
      })
    return () => {
      cancelled = true
    }
  }, [shareUrl])

  const onStatus = useCallback((next: ConnectionStatus) => setConnection(next), [])
  const onAuthLost = useCallback(() => setMissing(true), [])

  useEffect(() => {
    if (!qrOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setQrOpen(false)
        setQrLarge(false)
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      const root = qrRootRef.current
      if (root && event.target instanceof Node && root.contains(event.target)) return
      setQrOpen(false)
      setQrLarge(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [qrOpen])

  // RHEA-190 step 7: one temporary room per browser — this opens (or, if it expired, renews) this browser's own room
  async function openMine() {
    try {
      const room = await openTempRoom()
      navigate(`/r/${room.token}`)
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  if (missing) {
    return (
      <Shell>
        <h1 className="text-4xl font-semibold">房间不存在或已过期</h1>
        <p className="mt-4 text-sm text-muted-foreground">临时房间不会出现在任何列表里。可以进入你自己的临时房间，再把链接发给对方。</p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button type="button" onClick={() => void openMine()}>
            进入我的临时房间
          </Button>
          <Button type="button" variant="outline" asChild>
            <Link to="/">返回</Link>
          </Button>
        </div>
        <section className="mt-8 max-w-sm border-t border-line-1 pt-5">
          <h2 className="mb-3 text-sm font-medium">有房间码？</h2>
          <EnterRoomForm />
        </section>
      </Shell>
    )
  }

  return (
    <Shell>
      {scope ? (
        <>
          <div ref={qrRootRef} className="relative mb-4 flex flex-wrap items-center gap-2 border border-line-2 px-3 py-2">
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
            {isOwnTempRoom(token) ? null : (
              <Button type="button" variant="outline" size="sm" onClick={() => void openMine()}>
                我的临时房间
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={qrOpen}
              aria-label="二维码"
              title="二维码"
              className="ml-auto"
              onClick={() => {
                setQrOpen((open) => !open)
                setQrLarge(false)
              }}
            >
              二维码
            </Button>
            {qrOpen ? (
              <div role="dialog" aria-label="房间二维码" className="absolute top-full right-0 z-30 mt-2 rounded-md border border-line-2 bg-card p-3">
                {qr ? (
                  <img
                    src={qr}
                    alt="房间二维码"
                    width={qrLarge ? 192 : 96}
                    height={qrLarge ? 192 : 96}
                    className="border border-line-2 bg-white p-1"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">正在生成二维码…</p>
                )}
                <div className="mt-2 flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setQrLarge((large) => !large)} disabled={!qr}>
                    {qrLarge ? '还原' : '放大'}
                  </Button>
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
                </div>
              </div>
            ) : null}
          </div>
          <RoomCodeBar
            token={token}
            code={scope.code ?? null}
            hasPin={Boolean(scope.hasPin)}
            owner={!entered && isOwnTempRoom(token)}
            onChanged={(next) => setScope((current) => (current ? { ...current, ...next } : current))}
          />
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
            canShare={() => true}
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
