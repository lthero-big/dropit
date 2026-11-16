import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { ApiError, api, errorText } from '@/lib/api.ts'
import { copyText, formatRemain } from '@/lib/format.ts'
import type { ShareCreated, ShareLink } from '@/lib/types.ts'
import { defaultShareViews, emptySharePresets, shareChoices, shareExpiryChoices, type SharePresets } from '@/lib/share-presets.ts'

function shareState(share: ShareLink, now: number): string {
  if (share.revoked) return '已撤销'
  if (share.expiresAt !== null && share.expiresAt <= now) return '已过期'
  if (share.maxViews !== null && share.views >= share.maxViews) return '已用尽'
  return '有效'
}

type Place = { left: number; top: number; width: number; up: boolean }

/**
 * Share options for one clip (opened from 更多 → 分享). RHEA-190 step 8: a
 * popover anchored to the card and portalled to <body>, so opening it never
 * changes the height of the card or its row.
 */
export function SharePanel({
  base,
  itemId,
  now,
  anchorRef,
  onClose,
}: {
  base: string
  itemId: string
  now: number
  anchorRef?: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  const [place, setPlace] = useState<Place | null>(null)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  useLayoutEffect(() => {
    const anchor = anchorRef?.current ?? null
    const measure = () => {
      const width = Math.min(360, window.innerWidth - 16)
      if (!anchor) {
        setPlace({ left: 8, top: 8, width, up: false })
        return
      }
      const r = anchor.getBoundingClientRect()
      const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
      const below = window.innerHeight - r.bottom
      const up = below < 300 && r.top > below
      setPlace({ left, top: up ? r.top - 8 : r.bottom + 8, width, up })
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [anchorRef])
  useEffect(() => {
    const anchor = anchorRef?.current ?? null
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || panelRef.current?.contains(target) || anchor?.contains(target)) return
      // the browser's own <select> popup is not in the DOM; ignore presses that land on <html>
      if (target === document.documentElement) return
      closeRef.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchorRef])
  const [shares, setShares] = useState<ShareLink[]>([])
  const [presets, setPresets] = useState<SharePresets>(emptySharePresets)
  const [expiresIn, setExpiresIn] = useState('1d')
  const [maxViews, setMaxViews] = useState('1')
  const [createdLink, setCreatedLink] = useState<ShareCreated | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api<SharePresets>('/api/me/share-presets')
      .then((body) => { if (!cancelled) setPresets({ ...emptySharePresets, ...body }) })
      .catch((error: unknown) => {
        // Anonymous temporary-room visitors use the built-in options.
        if (!cancelled && !(error instanceof ApiError && (error.status === 401 || error.status === 404))) toast.error(errorText(error))
      })
    return () => { cancelled = true }
  }, [])

  const expiryOptions = [...shareExpiryChoices(presets).map(({ expiresIn, label }) => [expiresIn, label]), ['never', '不过期']]
  const viewOptions = [...shareChoices(defaultShareViews, presets.views).map((views) => [String(views), views === 1 ? '仅一次' : `${views} 次`]), ['', '不限']]

  useEffect(() => {
    let cancelled = false
    api<{ shares: ShareLink[] }>(`${base}/items/${itemId}/shares`)
      .then((body) => {
        if (!cancelled) setShares(body.shares)
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [base, itemId])

  async function createLink() {
    if (busy) return
    setBusy(true)
    try {
      const created = await api<ShareCreated>(`${base}/items/${itemId}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn, maxViews: maxViews ? Number(maxViews) : null }),
      })
      setCreatedLink(created)
      setShares((current) => [{ ...created }, ...current.filter((share) => share.id !== created.id)])
      toast.success('链接已生成，请现在复制')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    try {
      await api(`${base}/shares/${id}`, { method: 'DELETE' })
      setShares((current) => current.map((share) => (share.id === id ? { ...share, revoked: 1 } : share)))
      setCreatedLink((current) => current?.id === id ? null : current)
      toast.success('已撤销')
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="分享链接"
      data-share-panel=""
      data-keep-open=""
      className="fixed z-[70] max-h-[min(70vh,520px)] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--line-2)] bg-[var(--surface-1)] p-3 text-[var(--fg)] shadow-[var(--elev-3)]"
      style={place ? { left: place.left, top: place.top, width: place.width, transform: place.up ? 'translateY(-100%)' : undefined } : { visibility: 'hidden' }}
    >
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium">分享链接</h3>
        <button type="button" className="ml-auto text-xs" onClick={onClose}>
          关闭
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">只读。知道链接的人无需登录即可查看。条目到期或撤回后链接失效。新创建且有效的链接可在设置的分享链接管理中再次复制；旧版本链接无法恢复。</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs">
          有效期
          <select
            aria-label="有效期"
            value={expiresIn}
            onChange={(event) => setExpiresIn(event.target.value)}
            className="mt-1 block border border-line-2 bg-transparent px-2 py-1"
          >
            {expiryOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          查看次数
          <select
            aria-label="查看次数"
            value={maxViews}
            onChange={(event) => setMaxViews(event.target.value)}
            className="mt-1 block border border-line-2 bg-transparent px-2 py-1"
          >
            {viewOptions.map(([value, label]) => (
              <option key={label} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" size="sm" onClick={() => void createLink()} disabled={busy}>
          生成链接
        </Button>
      </div>
      <a href="/settings#share-presets" className="mt-2 inline-block text-xs text-muted-foreground underline">在设置中添加分享选项</a>
      {createdLink && shareState(createdLink, now) === '有效' ? (
        <div className="mt-3 space-y-2">
          {([['分享链接', createdLink.url], ['文件直链', createdLink.directUrl]] as const).map(([label, url]) => url ? (
            <div key={label}>
              <label className="text-xs">
                {label}
                <input readOnly aria-label={label} value={url} className="mt-1 w-full border border-line-2 bg-transparent px-2 py-1 text-xs" />
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1"
                onClick={() => {
                  void copyText(url)
                    .then(() => toast.success(`${label}已复制`))
                    .catch(() => toast.error('复制链接失败，请重试'))
                }}
              >
                复制{label}
              </Button>
            </div>
          ) : null)}
          {createdLink.directUrl ? <p className="text-xs text-muted-foreground">文件直链打开即下载，与分享页共用有效期和次数。</p> : null}
        </div>
      ) : null}
      <ul className="mt-3">
        {shares.length === 0 ? <li className="text-xs text-muted-foreground">还没有分享链接。</li> : null}
        {shares.map((share) => {
          const state = shareState(share, now)
          const views = share.maxViews === null ? `${share.views} 次 · 不限` : `${share.views} / ${share.maxViews}`
          const expiry = share.expiresAt === null ? '链接本身不过期' : state === '已过期' ? '已过期' : `剩余 ${formatRemain(share.expiresAt - now)}`
          return (
            <li key={share.id} className="flex flex-wrap items-center gap-2 border-t border-line-2 py-2 text-xs">
              <span className="font-medium">{state}</span>
              <span className="text-muted-foreground">{views}</span>
              <span className="text-muted-foreground">{expiry}</span>
              {state === '有效' ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void revoke(share.id)}>
                  撤销
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>,
    document.body,
  )
}
