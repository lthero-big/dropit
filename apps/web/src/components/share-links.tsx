import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCwIcon, Trash2Icon, Undo2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { Panel } from '@/components/settings-ui.tsx'
import { Button } from '@/components/ui/button.tsx'
import { api, errorText } from '@/lib/api.ts'
import type { ManagedShare, ManagedShareState } from '@/lib/types.ts'

type SharePage = { shares: ManagedShare[]; nextCursor: string | null }

const stateLabels: Record<ManagedShareState, string> = {
  active: '有效',
  expired: '已过期',
  exhausted: '已用尽',
  revoked: '已撤销',
  source_unavailable: '来源已失效',
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
  const [working, setWorking] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

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

  async function revoke(share: ManagedShare) {
    if (working) return
    setWorking(`revoke:${share.id}`)
    try {
      await api(`/api/shares/${share.id}/revoke`, { method: 'POST' })
      setShares((current) => current.map((entry) => entry.id === share.id ? { ...entry, revoked: 1, state: 'revoked' } : entry))
      toast.success('分享链接已撤销')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setWorking(null)
    }
  }

  async function remove(share: ManagedShare) {
    if (working) return
    setWorking(`delete:${share.id}`)
    try {
      await api(`/api/shares/${share.id}`, { method: 'DELETE' })
      setShares((current) => current.filter((entry) => entry.id !== share.id))
      setPendingDelete(null)
      toast.success('记录已删除')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setWorking(null)
    }
  }

  return (
    <Panel
      id="share-links"
      title="分享链接"
      description="管理由你创建的链接。完整链接只会在创建时出现一次，这里不会再次显示。"
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
          const revoking = working === `revoke:${share.id}`
          const deleting = working === `delete:${share.id}`
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
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {share.state !== 'revoked' ? (
                  <Button type="button" variant="outline" size="sm" disabled={Boolean(working)} onClick={() => void revoke(share)}>
                    <Undo2Icon aria-hidden="true" />
                    {revoking ? '正在撤回…' : '撤回'}
                  </Button>
                ) : pendingDelete === share.id ? (
                  <div className="flex flex-wrap items-center gap-2" role="alertdialog" aria-label="删除分享记录确认">
                    <span className="text-xs text-muted-foreground">删除后无法恢复。</span>
                    <Button type="button" variant="outline" size="sm" disabled={Boolean(working)} onClick={() => setPendingDelete(null)}>取消</Button>
                    <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={Boolean(working)} onClick={() => void remove(share)}>
                      <Trash2Icon aria-hidden="true" />
                      {deleting ? '正在删除…' : '确认删除记录'}
                    </Button>
                  </div>
                ) : (
                  <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={Boolean(working)} onClick={() => setPendingDelete(share.id)}>
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
