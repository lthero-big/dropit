import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ImageLightbox } from '@/components/image-lightbox.tsx'
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
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setShare(null)
    setMissing(false)
    setOpen(false)
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

  return (
    <main className="mx-auto min-h-svh max-w-3xl px-4 py-8">
      <Link to="/" className="text-[22px] font-black tracking-tight">
        dropit
      </Link>
      {missing ? (
        <>
          <h1 className="mt-8 border-l-[14px] border-primary pl-4 text-4xl font-black">链接无效</h1>
          <p className="mt-4 text-sm text-muted-foreground">链接不存在、已过期、已撤销，或已达到查看次数。</p>
        </>
      ) : share ? (
        <>
          <h1 className="mt-8 border-l-[14px] border-primary pl-4 text-4xl font-black">分享的内容</h1>
          <p className="mt-3 text-xs text-muted-foreground">只读。此页面不需要登录。</p>
          {share.item.kind === 'text' ? (
            <div className="mt-6">
              <MarkdownText text={share.item.text ?? ''} />
            </div>
          ) : (
            <div className="mt-6">
              {share.item.hasThumbnail ? (
                <button
                  type="button"
                  aria-label={`查看 ${share.item.filename?.trim() || '图片'}`}
                  className="block border-0 bg-transparent p-0 text-left"
                  onClick={() => setOpen(true)}
                >
                  <img
                    src={`/api/s/${encodeURIComponent(token)}/thumbnail?access=${encodeURIComponent(share.access)}`}
                    alt=""
                    className="max-h-80 border border-foreground object-contain"
                  />
                </button>
              ) : mediaKind({ ...share.item, hasThumbnail: share.item.hasThumbnail }) === 'video' ? (
                <video
                  controls
                  preload="metadata"
                  src={`/api/s/${encodeURIComponent(token)}/media?access=${encodeURIComponent(share.access)}`}
                  className="max-h-80 w-full bg-foreground"
                />
              ) : mediaKind({ ...share.item, hasThumbnail: share.item.hasThumbnail }) === 'audio' ? (
                <audio
                  controls
                  preload="metadata"
                  src={`/api/s/${encodeURIComponent(token)}/media?access=${encodeURIComponent(share.access)}`}
                  className="w-full"
                />
              ) : null}
              <p className="mt-3 text-sm font-bold break-words">{share.item.filename}</p>
              <p className="text-xs text-muted-foreground">{formatBytes(share.item.size)}</p>
              <Button type="button" className="mt-4" asChild>
                <a href={`/api/s/${encodeURIComponent(token)}/file?access=${encodeURIComponent(share.access)}`}>下载</a>
              </Button>
              {open && share.item.hasThumbnail ? (
                <ImageLightbox
                  slides={[
                    {
                      key: token,
                      filename: share.item.filename?.trim() || '未命名图片',
                      byteSize: share.item.size,
                      thumbnailSrc: `/api/s/${encodeURIComponent(token)}/thumbnail?access=${encodeURIComponent(share.access)}`,
                      previewSrc: `/api/s/${encodeURIComponent(token)}/preview?access=${encodeURIComponent(share.access)}`,
                      downloadHref: `/api/s/${encodeURIComponent(token)}/file?access=${encodeURIComponent(share.access)}`,
                    },
                  ]}
                  index={0}
                  onClose={() => setOpen(false)}
                  onIndex={() => {}}
                />
              ) : null}
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
