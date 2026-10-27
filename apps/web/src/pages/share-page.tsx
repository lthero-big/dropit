import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { Link, useParams } from 'react-router'
import { MediaViewer, type ViewerMedia } from '@/components/clip-media.tsx'
import { GridBody, type ClipVisual } from '@/components/clip-visual.tsx'
import { Button } from '@/components/ui/button.tsx'
import { ApiError, api } from '@/lib/api.ts'
import { formatBytes } from '@/lib/format.ts'
import { MarkdownText } from '@/lib/markdown.tsx'
import { mediaKind } from '@/lib/media.ts'
import type { PublicShare } from '@/lib/types.ts'

export function SharePage() {
  const { token = '' } = useParams()
  const [share, setShare] = useState<PublicShare | null>(null)
  const [missing, setMissing] = useState(false)
  const [viewer, setViewer] = useState<ViewerMedia | null>(null)
  const anchor = useRef<HTMLDivElement | null>(null)
  const reduced = useReducedMotion() ?? false

  useEffect(() => {
    let cancelled = false
    setShare(null)
    setMissing(false)
    setViewer(null)
    api<PublicShare>(`/api/s/${encodeURIComponent(token)}`)
      .then((body) => {
        if (!cancelled) setShare(body)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && (error.status === 404 || error.status === 403 || error.status === 401)) setMissing(true)
        else setMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const visual = share ? shareVisual(token, share) : null

  return (
    <main className="mx-auto min-h-svh max-w-3xl px-4 py-8">
      <Link to="/" className="text-[22px] font-semibold tracking-tight">
        dropit
      </Link>
      {missing ? (
        <>
          <h1 className="mt-8 text-4xl font-semibold">链接无效</h1>
          <p className="mt-4 text-sm text-muted-foreground">链接不存在、已过期、已撤销，或已达到查看次数。</p>
        </>
      ) : share ? (
        <>
          <h1 className="mt-8 text-4xl font-semibold">分享的内容</h1>
          <p className="mt-3 text-xs text-muted-foreground">只读。此页面不需要登录。</p>
          {share.item.kind === 'text' ? (
            <div className="mt-6">
              <MarkdownText text={share.item.text ?? ''} />
            </div>
          ) : (
            <div className="mt-6">
              {visual ? (
                <div className="dd-board" ref={anchor}>
                  <div className="dd-card max-w-md overflow-hidden" data-share-media={visual.kind === 'image' ? 'image' : visual.kind === 'file' ? visual.media : undefined}>
                    <GridBody clip={visual} viewing={viewer !== null} onView={setViewer} slots={{ imageLabel: `查看 ${share.item.filename?.trim() || '图片'}` }} />
                  </div>
                  <MediaViewer media={viewer} anchor={anchor} reduced={reduced} onClose={() => setViewer(null)} />
                </div>
              ) : null}
              <p className="mt-3 text-sm font-bold break-words">{share.item.filename}</p>
              <p className="text-xs text-muted-foreground">{formatBytes(share.item.size)}</p>
              <Button type="button" className="mt-4" asChild>
                <a href={`/api/s/${encodeURIComponent(token)}/file?access=${encodeURIComponent(share.access)}`}>下载</a>
              </Button>
            </div>
          )}
          <p className="mt-6 text-xs text-muted-foreground">
            {share.maxViews === null ? `已查看 ${share.views} 次` : `已查看 ${share.views} / ${share.maxViews} 次`}
            {share.linkExpiresAt === null ? ' · 链接本身不过期' : ''}
          </p>
        </>
      ) : (
        <p className="mt-8 text-sm text-muted-foreground">正在打开链接…</p>
      )}
    </main>
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
