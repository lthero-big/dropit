import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CopyIcon, RefreshCwIcon, Trash2Icon, Undo2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { Panel } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import { copyText } from '@/lib/format.ts'
import type { ManagedShare, ManagedShareState } from '@/lib/types.ts'

type SharePage = { shares: ManagedShare[]; nextCursor: string | null }
type ShareAction = 'copy' | 'revoke' | 'delete'

const stateLabels: Record<ManagedShareState, string> = {
  active: '有效',
  expired: '已过期',
  exhausted: '已用尽',
  revoked: '已撤销',
  source_unavailable: '来源已失效',
}

const unavailableCopyLabels: Partial<Record<ManagedShareState, string>> = {
  expired: '链接已过期，无法复制。',
  exhausted: '链接已用尽，无法复制。',
  revoked: '链接已撤销，无法复制。',
  source_unavailable: '来源已不可用，无法复制。',
}

const filters: { value: 'all' | ManagedShareState; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '仅有效' },
  { value: 'expired', label: '仅过期' },
  { value: 'exhausted', label: '仅用尽' },
  { value: 'revoked', label: '仅撤回' },
  { value: 'source_unavailable', label: '仅来源失效' },
]

function stamp(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

function expiryLabel(share: ManagedShare) {
  return share.expiresAt === null ? '链接不过期' : `有效至 ${stamp(share.expiresAt)}`
}

export function ShareLinks() {
  const [shares, setShares] = useState<ManagedShare[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | ManagedShareState>('all')
  const [loading, setLoading] = useState(true)
  const pendingRef = useRef(new Map<string, ShareAction>())
  const [pending, setPending] = useState<Record<string, ShareAction>>({})
  const [pendingDelete, setPendingDelete] = useState<Set<string>>(() => new Set())

  const load = useCallback(async (cursor?: string | null, replace = false) => {
    try {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : ''
      const body = await api<SharePage>(`/api/shares${query}`)
      setShares((current) => replace ? body.shares : [...current, ...body.shares])
      setNextCursor(body.nextCursor)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(null, true), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const visible = useMemo(() => filter === 'all' ? shares : shares.filter((share) => share.state === filter), [filter, shares])

  function begin(shareId: string, action: ShareAction) {
    if (pendingRef.current.has(shareId)) return false
    pendingRef.current.set(shareId, action)
    setPending((current) => ({ ...current, [shareId]: action }))
    return true
  }

  function finish(shareId: string) {
    pendingRef.current.delete(shareId)
    setPending((current) => {
      const { [shareId]: _finished, ...remaining } = current
      return remaining
    })
  }

  function setDeleteConfirmation(shareId: string, open: boolean) {
    setPendingDelete((current) => {
      const next = new Set(current)
      if (open) next.add(shareId)
      else next.delete(shareId)
      return next
    })
  }

  async function copy(share: ManagedShare) {
    if (!begin(share.id, 'copy')) return
    try {
      const { url } = await api<{ url: string }>(`/api/shares/${share.id}/link`)
      await copyText(url)
      toast.success('链接已复制')
    } catch {
      toast.error('复制链接失败，请重试')
    } finally {
      finish(share.id)
    }
  }

  async function revoke(share: ManagedShare) {
    if (!begin(share.id, 'revoke')) return
    try {
      await api(`/api/shares/${share.id}/revoke`, { method: 'POST' })
      setShares((current) => current.map((entry) => entry.id === share.id
        ? { ...entry, revoked: 1, state: 'revoked', copyStatus: 'unavailable' }
        : entry))
      toast.success('分享链接已撤销')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      finish(share.id)
    }
  }

  async function remove(share: ManagedShare) {
    if (!begin(share.id, 'delete')) return
    try {
      await api(`/api/shares/${share.id}`, { method: 'DELETE' })
      setShares((current) => current.filter((entry) => entry.id !== share.id))
      setDeleteConfirmation(share.id, false)
      toast.success('记录已删除')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      finish(share.id)
    }
  }

  return (
    <Panel
      id="share-links"
      title="分享链接"
      description="管理由你创建的链接。新创建且仍有效的链接可再次复制；旧版本链接无法恢复，请从原条目重新分享。"
      actions={
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="share-state-filter">状态筛选</label>
          <select id="share-state-filter" aria-label="状态筛选" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className="h-9 border border-line-2 bg-transparent px-2 text-sm">
            {filters.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
          <Button type="button" variant="outline" size="icon" aria-label="刷新分享链接" title="刷新" disabled={loading} onClick={() => { setLoading(true); void load(null, true) }}>
            <RefreshCwIcon aria-hidden="true" />
          </Button>
        </div>
      }
    >
      {loading && shares.length === 0 ? <p className="text-sm text-muted-foreground">正在加载分享链接…</p> : null}
      {!loading && shares.length === 0 ? <p className="rounded-md border border-dashed border-line-2 p-4 text-sm text-muted-foreground">还没有你创建的分享链接。</p> : null}
      {!loading && shares.length > 0 && visible.length === 0 ? <p className="rounded-md border border-dashed border-line-2 p-4 text-sm text-muted-foreground">没有符合当前状态的分享链接。</p> : null}
      <ul className="grid gap-3">
        {visible.map((share) => {
          const action = pending[share.id]
          const rowBusy = Boolean(action)
          const deleting = action === 'delete'
          const revoking = action === 'revoke'
          const copying = action === 'copy'
          const confirmingDelete = pendingDelete.has(share.id)
          return (
            <li key={share.id} className="rounded-md border border-line-1 bg-surface-0 p-4" data-share-id={share.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{share.sourceName ?? '来源已不可用'}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{share.spaceName ?? '空间已不可用'} · 创建于 {stamp(share.createdAt)}</p>
                </div>
                <span className="shrink-0 border border-line-2 px-2 py-0.5 text-xs">{stateLabels[share.state]}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{share.maxViews === null ? `${share.views} 次访问，不限次数` : `${share.views} / ${share.maxViews} 次访问`}</span>
                <span>{expiryLabel(share)}</span>
              </div>
              {share.state === 'active' && share.copyStatus === 'legacy' ? <p className="mt-3 text-xs text-muted-foreground">旧版本链接无法恢复，可从原条目重新分享。</p> : null}
              {share.state !== 'active' ? <p className="mt-3 text-xs text-muted-foreground">{unavailableCopyLabels[share.state]}</p> : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {share.state === 'active' && share.copyStatus === 'available' ? (
                  <Button type="button" variant="outline" size="sm" disabled={rowBusy} onClick={() => void copy(share)}>
                    <CopyIcon aria-hidden="true" />
                    {copying ? '正在复制…' : '复制链接'}
                  </Button>
                ) : null}
                {share.state !== 'revoked' ? (
                  <Button type="button" variant="outline" size="sm" disabled={rowBusy} onClick={() => void revoke(share)}>
                    <Undo2Icon aria-hidden="true" />
                    {revoking ? '正在撤回…' : '撤回'}
                  </Button>
                ) : confirmingDelete ? (
                  <div className="flex flex-wrap items-center gap-2" role="alertdialog" aria-label="删除分享记录确认">
                    <span className="text-xs text-muted-foreground">删除后无法恢复。</span>
                    <Button type="button" variant="outline" size="sm" disabled={rowBusy} onClick={() => setDeleteConfirmation(share.id, false)}>取消</Button>
                    <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={rowBusy} onClick={() => void remove(share)}>
                      <Trash2Icon aria-hidden="true" />
                      {deleting ? '正在删除…' : '确认删除记录'}
                    </Button>
                  </div>
                ) : (
                  <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={rowBusy} onClick={() => setDeleteConfirmation(share.id, true)}>
                    <Trash2Icon aria-hidden="true" />
                    删除记录
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Button type="button" variant="outline" disabled={loading} onClick={() => { setLoading(true); void load(nextCursor) }}>{loading ? '正在加载…' : '加载更多'}</Button>
        </div>
      ) : null}
    </Panel>
  )
}
