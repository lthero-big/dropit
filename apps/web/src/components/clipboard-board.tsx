import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CopyIcon, DownloadIcon, EllipsisIcon, PencilIcon, PinIcon, PinOffIcon, Share2Icon, TagIcon, Undo2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { CommandPalette } from '@/components/command-palette.tsx'
import { ExpandCapsule } from '@/components/expand-capsule.tsx'
import { ImageLightbox, type LightboxSlide } from '@/components/image-lightbox.tsx'
import { SharePanel } from '@/components/share-panel.tsx'
import { Button } from '@/components/ui/button.tsx'
import { ApiError, api, errorText, uploadFile } from '@/lib/api.ts'
import { useChannel } from '@/lib/channel.ts'
import { createUploadQueue, type UploadQueue, type UploadRow } from '@/lib/upload-queue.ts'
import { connectionText, copyText, formatBytes, formatRemain, formatWhen, useClock, utf8Size } from '@/lib/format.ts'
import { MarkdownText } from '@/lib/markdown.tsx'
import { mediaKind } from '@/lib/media.ts'
import type { ConnectionStatus, Item } from '@/lib/types.ts'

function filesFromList(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? [])
}

const iconButtonClass =
  'inline-flex size-10 shrink-0 items-center justify-center border-2 border-foreground bg-background text-foreground hover:bg-foreground hover:text-background'
const capsuleIconClass =
  'inline-flex size-10 shrink-0 items-center justify-center bg-transparent text-foreground hover:bg-foreground hover:text-background'
const touchTarget = { minWidth: 40, minHeight: 40 }

function IconAction({
  label,
  onClick,
  children,
  confirm = false,
  expanded,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  confirm?: boolean
  expanded?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
      className={confirm ? `${iconButtonClass} border-primary bg-primary text-primary-foreground hover:bg-primary/80` : iconButtonClass}
      style={touchTarget}
    >
      {children}
    </button>
  )
}

const uploadStatusLabel: Record<UploadRow['status'], string> = {
  queued: '排队中',
  uploading: '上传中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'FILE'
  return name.slice(dot + 1, dot + 5).toUpperCase()
}

export function ClipboardBoard({
  base,
  title,
  subtitle,
  quotaBytes,
  usedBytes,
  maxFileBytes,
  maxTextBytes,
  deadline = null,
  sender,
  canEdit,
  canRetract,
  canShare,
  onActivity,
  onAuthLost,
  onStatus,
  onBusyChange,
  onBindCancel,
  upload = uploadFile,
}: {
  base: string | null
  title: string
  subtitle?: string
  quotaBytes: number
  usedBytes: number | null
  maxFileBytes: number
  maxTextBytes: number
  deadline?: number | null
  sender: (item: Item) => string
  canEdit: (item: Item) => boolean
  canRetract: (item: Item) => boolean
  canShare: (item: Item) => boolean
  onActivity?: () => void
  onAuthLost?: () => void
  onStatus?: (status: ConnectionStatus) => void
  onBusyChange?: (busy: boolean) => void
  onBindCancel?: (cancel: () => void) => void
  upload?: typeof uploadFile
}) {
  const channel = useChannel(base)
  const now = useClock(channel.offset)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [shareFor, setShareFor] = useState<string | null>(null)
  const [tagFor, setTagFor] = useState<string | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [rows, setRows] = useState<UploadRow[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [sending, setSending] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const seenAuth = useRef(0)
  const sendFilesRef = useRef<(files: File[]) => void>(() => {})
  const queueRef = useRef<UploadQueue | null>(null)
  const baseRef = useRef(base)
  const maxFileRef = useRef(maxFileBytes)
  const channelRef = useRef(channel)
  const onActivityRef = useRef(onActivity)
  const onAuthLostRef = useRef(onAuthLost)
  const uploadRef = useRef(upload)
  const visible = channel.items.filter((item) => item.expiresAt > now)
  const needle = query.trim().toLowerCase()
  const shown = visible.filter((item) => {
    if (activeTag && !(item.tags ?? []).includes(activeTag)) return false
    if (!needle) return true
    const haystack = `${item.text ?? ''}\n${item.filename ?? ''}\n${(item.tags ?? []).join('\n')}`
    return haystack.toLowerCase().includes(needle)
  })
  const slides: LightboxSlide[] = base
    ? shown.flatMap((item) =>
        item.hasThumbnail
          ? [
              {
                key: item.id,
                filename: item.filename?.trim() || '未命名图片',
                byteSize: item.size,
                thumbnailSrc: `${base}/items/${item.id}/thumbnail`,
                previewSrc: `${base}/items/${item.id}/preview`,
                downloadHref: `${base}/items/${item.id}/download`,
              },
            ]
          : [],
      )
    : []
  const openIndex = openId === null ? -1 : slides.findIndex((slide) => slide.key === openId)
  const roomUsed = usedBytes ?? channel.items.reduce((sum, item) => sum + item.size, 0)

  useEffect(() => {
    onStatus?.(channel.status)
  }, [channel.status, onStatus])

  useEffect(() => {
    if (channel.authLost > seenAuth.current) {
      seenAuth.current = channel.authLost
      onAuthLost?.()
    }
  }, [channel.authLost, onAuthLost])

  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const onDrag = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
    }
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setDragOver(true)
    }
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragOver(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragOver(false)
      const files = filesFromList(event.dataTransfer?.files)
      if (files.length) void sendFilesRef.current(files)
    }
    const onPaste = (event: ClipboardEvent) => {
      const files: File[] = []
      for (const item of event.clipboardData?.items ?? []) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file) files.push(file)
      }
      if (!files.length) return
      event.preventDefault()
      void sendFilesRef.current(files)
    }
    window.addEventListener('dragover', onDrag)
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragover', onDrag)
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  function sendFiles(files: File[]) {
    if (!baseRef.current) return
    queueRef.current?.enqueue(files, maxFileRef.current)
  }

  useEffect(() => {
    baseRef.current = base
    maxFileRef.current = maxFileBytes
    channelRef.current = channel
    onActivityRef.current = onActivity
    onAuthLostRef.current = onAuthLost
    uploadRef.current = upload
    sendFilesRef.current = sendFiles
  })

  useEffect(() => {
    const queue = createUploadQueue({
      upload: (file, onProgress, signal) => uploadRef.current(baseRef.current ?? '', file, onProgress, signal),
      onItem: (item) => {
        channelRef.current.upsert(item)
        onActivityRef.current?.()
      },
      onAuthLost: () => onAuthLostRef.current?.(),
      onChange: setRows,
      onOversize: (name) => toast.error(`${name}超过大小上限（${formatBytes(maxFileRef.current)}）`),
      onFailed: (message) => toast.error(message),
    })
    queueRef.current = queue
    return () => {
      queue.dispose()
      if (queueRef.current === queue) queueRef.current = null
    }
  }, [])

  const uploadBusy = rows.some((row) => row.status === 'queued' || row.status === 'uploading')

  useEffect(() => {
    onBusyChange?.(uploadBusy)
  }, [onBusyChange, uploadBusy])

  useEffect(() => {
    onBindCancel?.(() => queueRef.current?.cancelAll())
  }, [onBindCancel])

  useEffect(() => {
    if (!uploadBusy) return
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [uploadBusy])

  async function sendText() {
    const text = draft.trim()
    if (!base || !text || sending) return
    if (utf8Size(text) > maxTextBytes) {
      toast.error(`文本超过长度上限（${formatBytes(maxTextBytes)}）`)
      return
    }
    setSending(true)
    try {
      const result = await api<{ item: Item }>(`${base}/items/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      channel.upsert(result.item)
      setDraft('')
      onActivity?.()
    } catch (error) {
      toast.error(errorText(error))
      if (error instanceof ApiError && error.status === 401) onAuthLost?.()
    } finally {
      setSending(false)
    }
  }

  async function saveEdit(item: Item) {
    const text = editDraft.trim()
    if (!base || savingEdit) return
    if (!text) {
      toast.error('文本不能为空')
      return
    }
    if (utf8Size(text) > maxTextBytes) {
      toast.error(`文本超过长度上限（${formatBytes(maxTextBytes)}）`)
      return
    }
    setSavingEdit(true)
    try {
      const result = await api<{ item: Item }>(`${base}/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      channel.upsert(result.item)
      setEditing(null)
      onActivity?.()
    } catch (error) {
      toast.error(errorText(error))
      if (error instanceof ApiError && error.status === 401) onAuthLost?.()
    } finally {
      setSavingEdit(false)
    }
  }

  async function saveLabels(item: Item, patch: { pinned?: boolean; tags?: string[] }) {
    if (!base) return
    try {
      const result = await api<{ item: Item }>(`${base}/items/${item.id}/labels`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      channel.upsert(result.item)
    } catch (error) {
      toast.error(errorText(error))
      if (error instanceof ApiError && error.status === 401) onAuthLost?.()
    }
  }

  async function retract(item: Item) {
    if (!base) return
    if (pending !== item.id) {
      setPending(item.id)
      return
    }
    try {
      await api(`${base}/items/${item.id}`, { method: 'DELETE' })
      channel.remove(item.id)
      setPending(null)
      onActivity?.()
      toast.success('已撤回')
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  const ratio = quotaBytes > 0 ? Math.min(100, Math.round((roomUsed / quotaBytes) * 100)) : 0

  return (
    <section className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div>
        <header className="mb-6 border-b-2 border-foreground pb-3">
          <h1 className="border-l-[14px] border-primary pl-4 text-4xl font-black tracking-tight md:text-[56px] md:leading-none">{title}</h1>
          {subtitle ? <p className="mt-3 text-sm text-muted-foreground">{subtitle}</p> : null}
          {deadline ? (
            <p className="mt-2 text-sm">
              剩余 <b>{formatRemain(deadline - now)}</b> 后自动销毁
            </p>
          ) : null}
        </header>
        <form
          className="border-2 border-foreground p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void sendText()
          }}
        >
          <label className="sr-only" htmlFor="draft">
            要发送的文本
          </label>
          <textarea
            id="draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void sendText()
              }
            }}
            placeholder="写点什么，或粘贴截图"
            className="min-h-20 w-full resize-y bg-transparent text-base outline-none"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!base || sending}>
              发送
            </Button>
            <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={!base}>
              文件
            </Button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="sr-only"
              aria-label="选择文件"
              onChange={(event) => {
                const files = filesFromList(event.target.files)
                event.target.value = ''
                if (files.length) void sendFiles(files)
              }}
            />
            <span className="text-xs text-muted-foreground">拖入文件，或直接粘贴截图 · Ctrl/⌘ Enter 发送</span>
          </div>
          {rows.length > 0 ? (
            <div className="mt-3 max-w-full border-2 border-foreground" role="region" aria-label="上传队列">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-foreground px-3 py-2">
                <p className="text-xs font-extrabold tracking-widest uppercase">上传</p>
                {uploadBusy ? (
                  <button
                    type="button"
                    className="inline-flex min-h-10 items-center border-2 border-foreground bg-background px-2 text-xs font-extrabold tracking-wider uppercase focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    onClick={() => queueRef.current?.cancelAll()}
                  >
                    全部取消
                  </button>
                ) : null}
              </div>
              <ul>
                {rows.map((row) => (
                  <li key={row.id} className="border-t border-foreground px-3 py-2 first:border-t-0">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-medium">{row.name}</p>
                      <div className="flex shrink-0 gap-2">
                        {row.status === 'failed' ? (
                          <button
                            type="button"
                            className="inline-flex min-h-10 items-center border-2 border-foreground bg-background px-2 text-xs font-extrabold tracking-wider uppercase focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            aria-label={`重试 ${row.name}`}
                            onClick={() => queueRef.current?.retry(row.id)}
                          >
                            重试
                          </button>
                        ) : null}
                        {row.status === 'queued' || row.status === 'uploading' ? (
                          <button
                            type="button"
                            className="inline-flex min-h-10 items-center border-2 border-foreground bg-background px-2 text-xs font-extrabold tracking-wider uppercase focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            aria-label={`取消 ${row.name}`}
                            onClick={() => queueRef.current?.cancel(row.id)}
                          >
                            取消
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatBytes(row.size)} · {uploadStatusLabel[row.status]}
                      {row.status === 'uploading' || row.status === 'done' ? ` · ${Math.round(row.ratio * 100)}%` : ''}
                    </p>
                    {row.status === 'failed' && row.error ? <p className="mt-1 text-xs break-words text-destructive">{row.error}</p> : null}
                    <div
                      className="mt-2 h-1.5 bg-secondary"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(row.ratio * 100)}
                      aria-label={row.name}
                    >
                      <div className="h-full bg-primary" style={{ width: `${Math.round(row.ratio * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </form>
        <label className="mt-6 block border-2 border-foreground">
          <span className="sr-only">搜索</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文本、文件名或标签"
            aria-label="搜索"
            className="w-full bg-transparent px-3 py-2 text-sm outline-none"
          />
        </label>
        {dragOver ? (
          <div className="pointer-events-none fixed inset-0 z-30 grid place-items-center border-4 border-primary bg-background/80">
            <p className="border-2 border-primary bg-background px-6 py-4 text-sm font-extrabold tracking-widest uppercase">松开以上传</p>
          </div>
        ) : null}
        <div className="mt-8 hidden grid-cols-[90px_1fr_90px] border-t-2 border-foreground py-2 text-[11px] font-extrabold tracking-widest text-muted-foreground uppercase sm:grid">
          <span>类型</span>
          <span>内容</span>
          <span className="text-right">操作</span>
        </div>
        {channel.status === 'connecting' || channel.status === 'reconnecting' ? (
          <p className="border-t border-foreground py-8 text-sm text-muted-foreground" role="status">
            {channel.status === 'reconnecting' ? '连接中断，正在重连并补拉…' : '正在同步…'}
          </p>
        ) : null}
        {channel.status !== 'connecting' && visible.length === 0 ? (
          <p className="border-t border-foreground py-8 text-sm text-muted-foreground">还没有内容。发送文本或文件，其他设备会实时收到。</p>
        ) : null}
        {activeTag ? (
          <button type="button" className="mt-3 border border-foreground px-2 py-1 text-xs font-extrabold" onClick={() => setActiveTag(null)}>
            #{activeTag} · 清除标签
          </button>
        ) : null}
        {visible.length > 0 && shown.length === 0 ? (
          <p className="border-t border-foreground py-8 text-sm text-muted-foreground">没有匹配的内容。</p>
        ) : null}
        <ul>
          {shown.map((item) => (
            <li id={`clip-${item.id}`} tabIndex={-1} key={item.id} className="border-b border-foreground px-3 py-4 hover:shadow-[inset_0_0_0_2px_var(--primary)]">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="bg-foreground px-2 py-0.5 font-extrabold tracking-wider text-background uppercase">{sender(item)}</span>
                <span className="text-muted-foreground">{formatWhen(item.createdAt, now)}</span>
                {item.pinned ? <span className="font-extrabold text-primary">置顶</span> : null}
                {item.updatedAt > item.createdAt ? <span className="text-muted-foreground">已编辑</span> : null}
                <span className="text-muted-foreground">剩余 {formatRemain(item.expiresAt - now)}</span>
              </div>
              {item.kind === 'text' && editing === item.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void saveEdit(item)
                  }}
                >
                  <label className="sr-only" htmlFor={`edit-${item.id}`}>
                    编辑文本
                  </label>
                  <textarea
                    id={`edit-${item.id}`}
                    value={editDraft}
                    onChange={(event) => setEditDraft(event.target.value)}
                    className="min-h-20 w-full resize-y border border-foreground bg-transparent p-2 text-[15px] outline-none"
                  />
                  <div className="mt-2 flex gap-2">
                    <Button type="submit" size="sm" disabled={savingEdit}>
                      保存
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </div>
                </form>
              ) : item.kind === 'text' ? (
                <MarkdownText text={item.text ?? ''} />
              ) : (
                <div>
                  {item.hasThumbnail ? (
                    <button
                      type="button"
                      aria-label={`查看 ${item.filename?.trim() || '图片'}`}
                      className="mb-2 block max-w-full border-0 bg-transparent p-0 text-left"
                      onClick={() => setOpenId(item.id)}
                    >
                      <img src={`${base}/items/${item.id}/thumbnail`} alt="" className="max-h-80 max-w-full border border-foreground object-contain" />
                    </button>
                  ) : mediaKind(item) === 'video' ? (
                    <video controls preload="metadata" src={`${base}/items/${item.id}/media`} className="mb-2 max-h-80 w-full bg-foreground" />
                  ) : mediaKind(item) === 'audio' ? (
                    <audio controls preload="metadata" src={`${base}/items/${item.id}/media`} className="mb-2 w-full" />
                  ) : (
                    <span className="mb-2 grid size-16 place-items-center bg-foreground text-xs font-extrabold text-background">
                      {extension(item.filename || 'file')}
                    </span>
                  )}
                  <p className="text-sm font-bold break-words">{item.filename}</p>
                  <p className="text-xs text-muted-foreground">{formatBytes(item.size)}</p>
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {item.kind === 'text' ? (
                  <IconAction
                    label="复制"
                    onClick={() => {
                      void copyText(item.text ?? '').then(() => toast.success('已复制'))
                    }}
                  >
                    <CopyIcon className="size-5" aria-hidden="true" />
                  </IconAction>
                ) : null}
                {canShare(item) ? (
                  <IconAction
                    label="分享"
                    expanded={shareFor === item.id}
                    onClick={() => {
                      setShareFor((current) => (current === item.id ? null : item.id))
                      setPending(null)
                    }}
                  >
                    <Share2Icon className="size-5" aria-hidden="true" />
                  </IconAction>
                ) : null}
                {canRetract(item) ? (
                  <IconAction label={pending === item.id ? '确认撤回' : '撤回'} confirm={pending === item.id} onClick={() => void retract(item)}>
                    <Undo2Icon className="size-5" aria-hidden="true" />
                  </IconAction>
                ) : null}
                {(canEdit(item) && editing !== item.id) || item.kind === 'file' || canShare(item) ? (
                  <ExpandCapsule label="更多" icon={<EllipsisIcon className="size-4" aria-hidden="true" />}>
                    {canEdit(item) && editing !== item.id ? (
                      <button
                        type="button"
                        title="编辑"
                        aria-label="编辑"
                        className={capsuleIconClass}
                        style={touchTarget}
                        onClick={() => {
                          setEditing(item.id)
                          setEditDraft(item.text ?? '')
                          setPending(null)
                        }}
                      >
                        <PencilIcon className="size-5" aria-hidden="true" />
                      </button>
                    ) : null}
                    {item.kind === 'file' ? (
                      <a
                        href={`${base}/items/${item.id}/download`}
                        title="下载"
                        aria-label="下载"
                        className={capsuleIconClass}
                        style={touchTarget}
                      >
                        <DownloadIcon className="size-5" aria-hidden="true" />
                      </a>
                    ) : null}
                    {canShare(item) ? (
                      <button
                        type="button"
                        title={item.pinned ? '取消置顶' : '置顶'}
                        aria-label={item.pinned ? '取消置顶' : '置顶'}
                        className={capsuleIconClass}
                        style={touchTarget}
                        onClick={() => void saveLabels(item, { pinned: !item.pinned })}
                      >
                        {item.pinned ? <PinOffIcon className="size-5" aria-hidden="true" /> : <PinIcon className="size-5" aria-hidden="true" />}
                      </button>
                    ) : null}
                    {canShare(item) ? (
                      <button
                        type="button"
                        title="标签"
                        aria-label="标签"
                        className={capsuleIconClass}
                        style={touchTarget}
                        onClick={() => {
                          setTagFor((current) => (current === item.id ? null : item.id))
                          setTagDraft('')
                        }}
                      >
                        <TagIcon className="size-5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </ExpandCapsule>
                ) : null}
              </div>
              {(item.tags ?? []).length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {(item.tags ?? []).map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={`border px-1.5 py-0.5 text-xs ${activeTag === name ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground'}`}
                      onClick={() => setActiveTag((current) => (current === name ? null : name))}
                    >
                      #{name}
                    </button>
                  ))}
                </div>
              ) : null}
              {tagFor === item.id ? (
                <form
                  className="mt-2 flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const next = tagDraft.trim().replace(/^#+/, '')
                    if (!next) return
                    void saveLabels(item, { tags: [...(item.tags ?? []), next] })
                    setTagDraft('')
                  }}
                >
                  <label className="sr-only" htmlFor={`tag-${item.id}`}>
                    新标签
                  </label>
                  <input
                    id={`tag-${item.id}`}
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    placeholder="输入标签后回车"
                    className="border border-foreground bg-transparent px-2 py-1 text-xs"
                  />
                  <Button type="submit" size="sm">
                    添加
                  </Button>
                  {(item.tags ?? []).map((name) => (
                    <Button
                      key={name}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void saveLabels(item, { tags: (item.tags ?? []).filter((tag) => tag !== name) })}
                    >
                      移除 #{name}
                    </Button>
                  ))}
                </form>
              ) : null}
              {shareFor === item.id && base ? <SharePanel base={base} itemId={item.id} now={now} onClose={() => setShareFor(null)} /> : null}
            </li>
          ))}
        </ul>
      </div>
      <aside className="border border-foreground bg-card">
        <div className="border-b border-foreground p-4">
          <h2 className="text-xs font-extrabold tracking-widest uppercase">配额</h2>
          <p className="mt-3 text-[22px] font-black tracking-tight">
            {formatBytes(roomUsed)}
            <span className="text-sm font-bold text-muted-foreground"> / {formatBytes(quotaBytes)}</span>
          </p>
          <div className="mt-3 h-1.5 bg-secondary">
            <div className="h-full bg-primary" style={{ width: `${ratio}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">单文件上限 {formatBytes(maxFileBytes)}</p>
        </div>
        <div className="p-4">
          <h2 className="text-xs font-extrabold tracking-widest uppercase">在线</h2>
          <p className="mt-3 text-sm" role="status">
            本机 · {connectionText[channel.status]}
            {channel.devices > 0 ? ` · ${channel.devices} 台设备` : ''}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">打开同一空间的设备会实时收到新条目。断线后会自动重连并补拉。Ctrl 或 ⌘ K 可搜索当前内容。</p>
        </div>
      </aside>
      {openIndex >= 0 ? (
        <ImageLightbox
          slides={slides}
          index={openIndex}
          onClose={() => setOpenId(null)}
          onIndex={(next) => {
            const slide = slides[next]
            if (slide) setOpenId(slide.key)
          }}
        />
      ) : null}
      <CommandPalette
        items={visible}
        onJump={(id) => {
          const row = document.getElementById(`clip-${id}`)
          row?.scrollIntoView({ block: 'center' })
          row?.focus()
        }}
      />
    </section>
  )
}
