import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { copyText, formatRemain } from '@/lib/format.ts'
import type { ShareCreated, ShareLink } from '@/lib/types.ts'

const expiryOptions = [
  ['1h', '1 小时'],
  ['1d', '1 天'],
  ['7d', '7 天'],
  ['never', '不过期'],
] as const

const viewOptions = [
  ['1', '仅一次'],
  ['5', '5 次'],
  ['10', '10 次'],
  ['', '不限'],
] as const

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
  const [expiresIn, setExpiresIn] = useState<(typeof expiryOptions)[number][0]>('1d')
  const [maxViews, setMaxViews] = useState('1')
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
      setCreatedUrl(created.url)
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
      <p className="mt-2 text-xs text-muted-foreground">只读。知道链接的人无需登录即可查看。条目到期或撤回后链接失效。完整链接只在生成时出现一次。</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs">
          有效期
          <select
            aria-label="有效期"
            value={expiresIn}
            onChange={(event) => setExpiresIn(event.target.value as (typeof expiryOptions)[number][0])}
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
      {createdUrl ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input readOnly aria-label="分享链接" value={createdUrl} className="min-w-0 flex-1 border border-line-2 bg-transparent px-2 py-1 text-xs" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void copyText(createdUrl).then(() => toast.success('链接已复制'))
            }}
          >
            复制分享链接
          </Button>
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
