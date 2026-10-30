import { useEffect, useRef, useState, type RefObject } from 'react'
import { Download, Link2Off, RefreshCw } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { Link, useParams } from 'react-router'
import { MediaViewer, type ViewerMedia } from '@/components/clip-media.tsx'
import { GridBody, type ClipVisual } from '@/components/clip-visual.tsx'
import { Logo } from '@/components/logo.tsx'
import { PageLoading } from '@/components/page-loading.tsx'
import { Button } from '@/components/ui/button.tsx'
import { ApiError, api } from '@/lib/api.ts'
import { formatBytes } from '@/lib/format.ts'
import { MarkdownText } from '@/lib/markdown.tsx'
import { mediaKind } from '@/lib/media.ts'
import type { PublicShare } from '@/lib/types.ts'

type ShareState = { kind: 'loading' } | { kind: 'ready'; share: PublicShare } | { kind: 'invalid' } | { kind: 'failed' }

/** The server answers 404 for unknown, expired, revoked and used-up links alike, so they are one "invalid" state. */
function isGone(error: unknown) {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status)
}

/** RHEA-190 m51: one link is one item, so the share page is a single centered item on desktop and mobile. */
export function SharePage() {
  const { token = '' } = useParams()
  const [state, setState] = useState<ShareState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [viewer, setViewer] = useState<ViewerMedia | null>(null)
  const anchor = useRef<HTMLDivElement | null>(null)
  const reduced = useReducedMotion() ?? false

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    setViewer(null)
    api<PublicShare>(`/api/s/${encodeURIComponent(token)}`)
      .then((share) => {
        if (!cancelled) setState({ kind: 'ready', share })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: isGone(error) ? 'invalid' : 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [token, attempt])

  if (state.kind === 'loading') return <PageLoading label="正在打开链接…" />

  return (
    <main className="flex min-h-svh flex-col px-4 py-5 sm:px-6 sm:py-6" data-share-page="">
      <header className="flex justify-center">
        <Link to="/" className="rounded-md">
          <Logo />
        </Link>
      </header>
      <section className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center py-10 text-center" data-share-state={state.kind}>
        {state.kind === 'ready' ? (
          <ShareItem token={token} share={state.share} viewer={viewer} setViewer={setViewer} anchor={anchor} reduced={reduced} />
        ) : state.kind === 'invalid' ? (
          <>
            <span className="grid size-12 place-items-center rounded-full bg-surface-2 text-muted-foreground" aria-hidden="true">
              <Link2Off className="size-5" />
            </span>
            <h1 className="mt-5 text-3xl font-semibold sm:text-4xl">链接无效</h1>
            <p className="mt-3 max-w-sm text-sm text-muted-foreground">链接不存在、已过期、已撤销，或已达到查看次数。</p>
            <Button type="button" variant="outline" className="mt-6" asChild>
              <Link to="/">打开 dropit</Link>
            </Button>
          </>
        ) : (
          <>
            <span className="grid size-12 place-items-center rounded-full bg-surface-2 text-muted-foreground" aria-hidden="true">
              <RefreshCw className="size-5" />
            </span>
            <h1 className="mt-5 text-3xl font-semibold sm:text-4xl">暂时打不开</h1>
            <p className="mt-3 max-w-sm text-sm text-muted-foreground">网络或服务器出了问题，链接本身可能没事。稍后再试一次。</p>
            <Button type="button" className="mt-6" onClick={() => setAttempt((n) => n + 1)}>
              重试
            </Button>
          </>
        )}
      </section>
    </main>
  )
}

function ShareItem({
  token,
  share,
  viewer,
  setViewer,
  anchor,
  reduced,
}: {
  token: string
  share: PublicShare
  viewer: ViewerMedia | null
  setViewer: (media: ViewerMedia | null) => void
  anchor: RefObject<HTMLDivElement | null>
  reduced: boolean
}) {
  const visual = shareVisual(token, share)
  return (
    <>
      <h1 className="text-3xl font-semibold sm:text-4xl">分享的内容</h1>
      <p className="mt-2 text-xs text-muted-foreground">只读。此页面不需要登录。</p>
      {share.item.kind === 'text' ? (
        <div className="mt-6 w-full rounded-xl border border-line-1 bg-surface-1 p-4 text-left break-words sm:p-5" data-share-item="text">
          <MarkdownText text={share.item.text ?? ''} />
        </div>
      ) : (
        <div className="mt-6 flex w-full flex-col items-center" data-share-item="file">
          {visual ? (
            <div className="dd-board w-full max-w-md" ref={anchor}>
              <div className="dd-card w-full overflow-hidden text-left" data-share-media={visual.kind === 'image' ? 'image' : visual.kind === 'file' ? visual.media : undefined}>
                <GridBody clip={visual} viewing={viewer !== null} onView={setViewer} slots={{ imageLabel: `查看 ${share.item.filename?.trim() || '图片'}` }} />
              </div>
              <MediaViewer media={viewer} anchor={anchor} reduced={reduced} onClose={() => setViewer(null)} />
            </div>
          ) : null}
          <p className={`${visual ? 'mt-4' : ''} max-w-full text-base font-bold break-all`}>{share.item.filename}</p>
          <p className="mt-1 text-xs text-muted-foreground">{formatBytes(share.item.size)}</p>
          <Button type="button" className="mt-5 w-full max-w-xs sm:w-auto sm:min-w-40" asChild>
            <a href={`/api/s/${encodeURIComponent(token)}/file?access=${encodeURIComponent(share.access)}`}>
              <Download className="size-4" aria-hidden="true" />
              下载
            </a>
          </Button>
        </div>
      )}
      <p className="mt-6 text-xs text-muted-foreground">
        {share.maxViews === null ? `已查看 ${share.views} 次` : `已查看 ${share.views} / ${share.maxViews} 次`}
        {share.linkExpiresAt === null ? ' · 链接本身不过期' : ''}
      </p>
    </>
  )
}

/** RHEA-190 step 6: the shared file plays / opens exactly like a clip on the board (RHEA-191 demo). */
function shareVisual(token: string, share: PublicShare): ClipVisual | null {
  if (share.item.kind !== 'file') return null
  const url = (path: string) => `/api/s/${encodeURIComponent(token)}/${path}?access=${encodeURIComponent(share.access)}`
  const name = share.item.filename?.trim() || (share.item.hasThumbnail ? '未命名图片' : '未命名文件')
  if (share.item.hasThumbnail) return { id: `share-${token}`, kind: 'image', name, src: url('thumbnail'), full: url('preview'), meta: formatBytes(share.item.size) }
  const media = mediaKind({ ...share.item, hasThumbnail: share.item.hasThumbnail })
  if (media !== 'video' && media !== 'audio') return null
  return { id: `share-${token}`, kind: 'file', name, size: share.item.size, media, src: url('media') }
}
