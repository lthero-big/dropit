import type { ReactNode } from 'react'
import { CalendarDaysIcon, FolderIcon, LayoutGridIcon, ListIcon, SearchIcon, TabletSmartphoneIcon } from 'lucide-react'
import { Segmented } from '@/components/board-parts.tsx'
import { touchTarget, type BoardLayout } from '@/lib/board-layout.ts'
import { formatBytes, formatRemain, type quotaTone } from '@/lib/format.ts'

/** Room title, countdown for temporary rooms, and the quota bar for rooms without a per-user quota. */
export function BoardHeader({
  title,
  subtitle,
  deadlineLeft,
  usedBytes,
  roomUsed,
  quotaBytes,
  ratio,
  tone,
  quotaBar,
  trailing,
}: {
  title: string
  subtitle?: string
  /** ms until a temporary room self-destructs; null when the room has no deadline */
  deadlineLeft: number | null
  usedBytes: number | null
  roomUsed: number
  quotaBytes: number
  ratio: number
  tone: ReturnType<typeof quotaTone>
  quotaBar: string
  trailing: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h1 className="dd-display text-[19px] font-semibold tracking-tight text-fg">{title}</h1>
      {subtitle ? <p className="text-[12px] text-[var(--fg-3)]">{subtitle}</p> : null}
      {deadlineLeft !== null ? (
        <p className="text-[12px] text-[var(--fg-2)]">
          剩余 <b>{formatRemain(deadlineLeft)}</b> 后自动销毁
        </p>
      ) : null}
      {usedBytes === null ? (
        <p className="flex max-w-xs items-center gap-2 text-[11px] text-[var(--fg-3)]">
          <span className="shrink-0">房间配额 {formatBytes(roomUsed)} / {formatBytes(quotaBytes)}</span>
          <span className="h-1 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="房间配额" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio} data-quota-tone={tone}>
            <span className={`block h-full rounded-full ${quotaBar}`} style={{ width: `${ratio}%` }} />
          </span>
        </p>
      ) : null}
      {trailing ? <span className="ml-auto">{trailing}</span> : null}
    </header>
  )
}

/** The row above the list: layout switch, item count, running-upload summary and search. */
export function BoardToolbar({
  layout,
  onLayout,
  count,
  uploadBusy,
  uploadCount,
  onCancelAll,
  query,
  onQuery,
}: {
  layout: BoardLayout
  onLayout: (next: BoardLayout) => void
  count: number
  uploadBusy: boolean
  uploadCount: number
  onCancelAll: () => void
  query: string
  onQuery: (next: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        id="layout"
        label="布局"
        value={layout}
        onChange={onLayout}
        options={[
          { value: 'grid', label: '网格', icon: <LayoutGridIcon className="size-3.5" /> },
          { value: 'list', label: '列表', icon: <ListIcon className="size-3.5" /> },
          { value: 'group', label: '按分组', icon: <FolderIcon className="size-3.5" /> },
          { value: 'timeline', label: '时间线', icon: <CalendarDaysIcon className="size-3.5" /> },
          { value: 'device', label: '按设备', icon: <TabletSmartphoneIcon className="size-3.5" /> },
        ]}
      />
      <span className="dd-mono text-[11px] text-[var(--fg-3)]">{count} 条</span>
      {uploadBusy ? (
        <span className="flex items-center gap-1 text-[11px] text-[var(--fg-3)]" data-upload-summary="">
          <span className="dd-mono">上传 {uploadCount}</span>
          <button type="button" className="inline-flex min-h-10 items-center rounded-[var(--radius-sm)] px-2 font-medium text-[var(--fg-2)] transition-colors duration-(--dur-fast) hover:bg-[var(--surface-2)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" style={touchTarget} onClick={onCancelAll}>
            全部取消
          </button>
        </span>
      ) : null}
      <label className="relative flex min-h-10 w-full items-center rounded-[var(--radius-md)] border border-[var(--line-1)] bg-[var(--surface-1)] transition-colors duration-(--dur-fast) focus-within:border-[var(--line-3)] sm:ml-auto sm:w-60">
        <SearchIcon className="pointer-events-none absolute left-2.5 size-3.5 text-[var(--fg-4)]" aria-hidden="true" />
        <span className="sr-only">搜索</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索文本或文件名"
          aria-label="搜索"
          className="w-full bg-transparent py-2 pr-3 pl-8 text-[13px] text-fg outline-none placeholder:text-fg-4"
        />
      </label>
    </div>
  )
}
