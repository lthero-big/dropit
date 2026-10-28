import { useCallback, useEffect, useRef, useState } from 'react'
import { toDataURL } from 'qrcode'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { ClipboardBoard } from '@/components/clipboard-board.tsx'
import { EnterRoomForm } from '@/components/enter-room.tsx'
import { RoomCodeBar } from '@/components/room-code.tsx'
import { RoomPinForm } from '@/components/room-pin.tsx'
import { Shell } from '@/components/shell.tsx'
import { Button } from '@/components/ui/button.tsx'
import { ApiError, api, errorText } from '@/lib/api.ts'
import { copyText } from '@/lib/format.ts'
import { enterRoomByCode, forgetRoom, isOwnTempRoom, isRoomAccessToken, openTempRoom, rememberRoom, roomPath, savedRoomToken } from '@/lib/temp-room.ts'
import { useSession } from '@/lib/session.tsx'
import type { ConnectionStatus, ScopeInfo } from '@/lib/types.ts'

type Resolved = { access: string; scope: ScopeInfo }

/**
 * RHEA-190 auth step 4: /r/<code> is the room link and the code at the same time. Opening it is the same as
 * typing the code: the browser uses the access token it already has for that code (owner, or entered before),
 * otherwise it enters the code — and asks for the PIN when the room has one. Old links (/rooms/<token>, and
 * the 6-character /r/ links of step 3) still open the room and are replaced by /r/<code>.
 */
export function RoomPage() {
  const { token: param = '' } = useParams()
  const navigate = useNavigate()
  const { me } = useSession()
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const [missing, setMissing] = useState(false)
  const [needPin, setNeedPin] = useState(false)
  const [, setConnection] = useState<ConnectionStatus>('idle')
  const [qr, setQr] = useState<string | null>(null)
  const [qrOpen, setQrOpen] = useState(false)
  const [qrLarge, setQrLarge] = useState(false)
  const qrRootRef = useRef<HTMLDivElement>(null)
  const scope = resolved?.scope ?? null
  const token = resolved?.access ?? ''
  const shareCode = scope?.code ?? param
  const shareUrl = `${window.location.origin}/r/${encodeURIComponent(shareCode)}`

  const open = useCallback(
    async (access: string, cancelled: () => boolean) => {
      const body = await api<ScopeInfo>(`/api/rooms/${encodeURIComponent(access)}`)
      if (cancelled()) return
      if (body.code) rememberRoom(body.code, access)
      if (body.code && body.code !== param) {
        navigate(`/r/${encodeURIComponent(body.code)}`, { replace: true })
        return
      }
      setResolved({ access, scope: body })
    },
    [navigate, param],
  )

  // the owner just changed the code: the page already shows the room, only the address moved to /r/<new code>
  const resolvedRef = useRef<Resolved | null>(null)
  resolvedRef.current = resolved

  useEffect(() => {
    if (resolvedRef.current?.scope.code === param) return
    let done = false
    const cancelled = () => done
    setMissing(false)
    setNeedPin(false)
    setResolved(null)
    const fail = (error: unknown) => {
      if (cancelled()) return
      if (error instanceof ApiError && error.code === 'PIN_REQUIRED') setNeedPin(true)
      else if (error instanceof ApiError && (error.status === 404 || error.status === 403 || error.status === 400)) setMissing(true)
      else toast.error(errorText(error))
    }
    async function resolve() {
      if (isRoomAccessToken(param)) return open(param, cancelled)
      const saved = savedRoomToken(param)
      if (saved) {
        try {
          return await open(saved, cancelled)
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error
          forgetRoom(param)
        }
      }
      const entry = await enterRoomByCode(param)
      if (cancelled()) return
      return open(entry.token, cancelled)
    }
    resolve().catch(fail)
    return () => {
      done = true
    }
  }, [param, open])

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
      navigate(roomPath(room))
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  if (needPin) {
    return (
      <Shell>
        <h1 className="text-4xl font-semibold">这个房间需要 PIN</h1>
        <p className="mt-4 max-w-md text-sm text-muted-foreground">
          房间 <code>{param}</code> 设置了 PIN。输入一次后，这台设备之后打开链接不会再问。
        </p>
        <div className="mt-6 max-w-sm">
          <RoomPinForm
            code={param}
            onEntered={(entry) => {
              setNeedPin(false)
              void open(entry.token, () => false).catch((error: unknown) => toast.error(errorText(error)))
            }}
          />
        </div>
        <Link to="/" className="mt-6 inline-block text-sm font-medium">
          返回
        </Link>
      </Shell>
    )
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
            owner={isOwnTempRoom(token)}
            onChanged={(next) => {
              // a new code is a new link: move to it (the access token stays the same)
              if (scope.code && next.code !== scope.code) forgetRoom(scope.code)
              setResolved((current) => (current ? { ...current, scope: { ...current.scope, ...next } } : current))
              if (next.code !== param) navigate(`/r/${encodeURIComponent(next.code)}`, { replace: true })
            }}
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
