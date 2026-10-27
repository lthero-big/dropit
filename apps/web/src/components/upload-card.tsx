/**
 * RHEA-190 step 6: an upload shows up on the board as a card the moment the
 * file is picked, like the demo. The card stays translucent with a slim
 * progress line along its bottom edge; when the upload finishes it hands over
 * to the real clip card (which fades up to full opacity in the same spot).
 * Failed uploads stay on the board with 重试 / 移除.
 */
import type { CSSProperties, ReactNode, Ref } from 'react'
import { motion } from 'motion/react'
import { AlertCircleIcon, PauseIcon, PlayIcon, RotateCcwIcon, Trash2Icon, XIcon } from 'lucide-react'
import { formatBytes } from '@/lib/format.ts'
import { fileType } from '@/lib/file-type.ts'
import { dur, easeIn, easeOut, springSettle } from '@/lib/motion.ts'
import { formatEta, formatSpeed } from '@/lib/upload-speed.ts'
import type { UploadRow } from '@/lib/upload-queue.ts'
import { uploadPreviewKind, uploadStatusLabel } from '@/lib/upload-preview.ts'

export type UploadCardActions = {
  onCancel: () => void
  onPause: () => void
  onContinue: () => void
  onRetry: () => void
  onRemove: () => void
  onAcceptMtime: () => void
  onAbandon: () => void
}

const touchTarget: CSSProperties = { minWidth: 40, minHeight: 40 }
const iconButton =
  'grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--fg-3)] transition-colors duration-(--dur-fast) hover:bg-[var(--surface-2)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const textButton =
  'inline-flex min-h-10 shrink-0 items-center rounded-[var(--radius-sm)] px-2 text-[11px] font-medium text-[var(--fg-2)] transition-colors duration-(--dur-fast) hover:bg-[var(--surface-2)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

function statusLine(row: UploadRow) {
  const pct = Math.round(row.ratio * 100)
  return (
    <>
      {formatBytes(row.size)} ·{' '}
      <span className={row.status === 'processing' ? 'font-medium text-[var(--fg)]' : row.status === 'failed' ? 'font-medium text-destructive' : undefined}>{uploadStatusLabel[row.status]}</span>
      {row.status === 'uploading' || row.status === 'done' || row.status === 'paused' ? ` · ${pct}%` : ''}
      {row.status === 'paused' ? ` · 剩余 ${formatBytes(Math.max(0, row.size - Math.round(row.ratio * row.size)))}` : ''}
      {row.status === 'uploading' && row.speedBps > 0 ? ` · ${formatSpeed(row.speedBps)} · ${formatEta(row.etaMs)}` : ''}
    </>
  )
}

function Actions({ row, actions }: { row: UploadRow; actions: UploadCardActions }) {
  const active = row.status === 'queued' || row.status === 'uploading' || row.status === 'processing' || row.status === 'paused'
  return (
    <div className="-my-2 ml-auto flex shrink-0 items-center">
      {row.status === 'paused' && row.confirmMtime ? (
        <button type="button" className={textButton} style={touchTarget} aria-label={`仍要续传 ${row.name}`} onClick={actions.onAcceptMtime}>
          仍要续传
        </button>
      ) : null}
      {row.status === 'paused' && row.restored && row.error && !row.confirmMtime ? (
        <button type="button" className={textButton} style={touchTarget} aria-label={`放弃并重新上传 ${row.name}`} onClick={actions.onAbandon}>
          放弃并重新上传
        </button>
      ) : null}
      {row.status === 'uploading' ? (
        <button type="button" className={iconButton} style={touchTarget} aria-label={`暂停 ${row.name}`} title="暂停" onClick={actions.onPause}>
          <PauseIcon className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {row.status === 'paused' ? (
        <button type="button" className={iconButton} style={touchTarget} aria-label={`继续 ${row.name}`} title="继续" onClick={actions.onContinue}>
          <PlayIcon className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {row.status === 'failed' ? (
        <>
          <button type="button" className={`${textButton} text-[var(--fg)]`} style={touchTarget} aria-label={`重试 ${row.name}`} onClick={actions.onRetry}>
            <RotateCcwIcon className="mr-1 size-3.5" aria-hidden="true" />
            重试
          </button>
          <button type="button" className={iconButton} style={touchTarget} aria-label={`移除 ${row.name}`} title="移除" onClick={actions.onRemove}>
            <Trash2Icon className="size-3.5" aria-hidden="true" />
          </button>
        </>
      ) : null}
      {active ? (
        <button type="button" className={iconButton} style={touchTarget} aria-label={`取消 ${row.name}`} title="取消" onClick={actions.onCancel}>
          <XIcon className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

/** The slim line along the card's bottom edge (`role=progressbar`, named after the file). */
function ProgressLine({ row, reduced }: { row: UploadRow; reduced: boolean }) {
  const pct = Math.round(row.ratio * 100)
  const failed = row.status === 'failed'
  const tone = failed ? 'var(--destructive, #d0453a)' : row.status === 'paused' || row.status === 'cancelled' ? 'var(--fg-4)' : 'var(--brand)'
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden rounded-b-[var(--radius-md)] bg-[color-mix(in_oklab,var(--line-2)_60%,transparent)]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={row.status === 'processing' ? '处理中' : undefined}
      aria-label={row.name}
      data-upload-progress=""
    >
      <motion.div
        className="h-full origin-left"
        style={{ background: tone }}
        initial={false}
        animate={{ scaleX: failed ? 1 : row.status === 'queued' ? 0 : Math.max(0.02, row.ratio) }}
        transition={reduced ? { duration: 0 } : { duration: dur.base, ease: easeOut }}
      />
      {row.status === 'processing' && !reduced ? (
        <motion.div
          aria-hidden
          className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/70 to-transparent"
          initial={{ x: '-100%' }}
          animate={{ x: '300%' }}
          transition={{ duration: 1.1, repeat: Infinity, ease: 'linear' }}
        />
      ) : null}
    </div>
  )
}

function GridPreview({ row, preview }: { row: UploadRow; preview: string | null }) {
  const kind = uploadPreviewKind(row)
  const t = fileType(row.name)
  const Icon = t.icon
  if (kind === 'image' && preview) {
    return (
      <div className="p-1.5 pb-0">
        <div className="grid h-36 place-items-center overflow-hidden rounded-[calc(var(--radius-md)-3px)] bg-[var(--surface-sunken)]">
          <img src={preview} alt="" draggable={false} data-upload-preview="image" className="block max-h-[122px] max-w-full rounded-[var(--radius-xs)] object-contain shadow-[0_8px_20px_-8px_rgb(0_0_0/0.45)]" />
        </div>
        <p className="flex justify-between gap-2 px-1.5 pt-2 text-[11px] text-[var(--fg-3)]">
          <span className="truncate text-[var(--fg-2)]">{row.name}</span>
        </p>
      </div>
    )
  }
  if (kind === 'video' && preview) {
    return (
      <div className="p-1.5 pb-0">
        <div className="relative h-36 overflow-hidden rounded-[calc(var(--radius-md)-3px)] bg-black">
          <video src={preview} muted playsInline preload="metadata" data-upload-preview="video" className="size-full object-contain" />
        </div>
        <p className="flex justify-between gap-2 px-1.5 pt-2 text-[11px] text-[var(--fg-3)]">
          <span className="truncate text-[var(--fg-2)]">{row.name}</span>
          <span className="dd-mono shrink-0">{t.label}</span>
        </p>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-3 p-3" data-upload-preview="file">
      <span className="relative grid size-11 shrink-0 place-items-center rounded-[var(--radius-sm)]" style={{ background: `color-mix(in oklab, ${t.color} 14%, var(--surface-1))`, color: t.color }}>
        <Icon className="size-5" />
        <span className="dd-mono absolute -bottom-1.5 rounded-[2px] px-1 text-[8.5px] font-semibold text-white" style={{ background: t.color }}>{t.ext.slice(0, 4)}</span>
      </span>
      <div className="min-w-0">
        <p className="truncate text-[13.5px] font-medium text-[var(--fg)]">{row.name}</p>
        <p className="dd-mono mt-0.5 text-[11px] text-[var(--fg-3)]">{t.label}</p>
      </div>
    </div>
  )
}

function RowLead({ row, preview }: { row: UploadRow; preview: string | null }) {
  const t = fileType(row.name)
  const Icon = t.icon
  if (uploadPreviewKind(row) === 'image' && preview) {
    return <img src={preview} alt="" draggable={false} data-upload-preview="image" className="block size-6 shrink-0 rounded-[var(--radius-xs)] object-cover" />
  }
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-xs)]" data-upload-preview="file" style={{ color: t.color, background: `color-mix(in oklab, ${t.color} 14%, transparent)` }}>
      <Icon className="size-3.5" />
    </span>
  )
}

export function UploadCard({
  row,
  preview,
  variant,
  reduced,
  actions,
  ref,
}: {
  ref?: Ref<HTMLLIElement>
  row: UploadRow
  /** object URL of the picked file (images / videos only) */
  preview: string | null
  variant: 'grid' | 'row'
  reduced: boolean
  actions: UploadCardActions
}) {
  const failed = row.status === 'failed'
  const error: ReactNode = (failed || row.status === 'paused') && row.error ? (
    <p className="flex items-start gap-1 px-3 pb-2 text-[11px] break-words text-destructive">
      <AlertCircleIcon className="mt-px size-3 shrink-0" aria-hidden="true" />
      <span>{row.error}</span>
    </p>
  ) : null
  return (
    <motion.li
      ref={ref}
      layout={reduced ? false : 'position'}
      data-upload-card=""
      data-upload-id={row.id}
      data-upload-status={row.status}
      className={`relative list-none ${variant === 'grid' ? 'h-full' : ''}`}
      initial={reduced ? false : { opacity: 0, scale: 0.94, y: -8 }}
      animate={{ opacity: 1, scale: 1, y: 0, transition: springSettle }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, transition: { duration: dur.fast, ease: easeIn } }}
    >
      <div
        className={`dd-card flex flex-col overflow-hidden ${variant === 'grid' ? 'h-full' : ''} ${failed ? '!border-[color-mix(in_oklab,var(--destructive,#d0453a)_55%,var(--line-2))]' : ''}`}
        data-uploading={failed ? undefined : ''}
        aria-busy={row.status === 'uploading' || row.status === 'processing' || row.status === 'queued' ? true : undefined}
      >
        <div className={`dd-card-body flex-1 transition-opacity duration-(--dur-base) ${failed ? 'opacity-80' : 'opacity-55'}`}>
          {variant === 'grid' ? (
            <GridPreview row={row} preview={preview} />
          ) : (
            <div className="flex items-center gap-3 px-3 py-2.5">
              <RowLead row={row} preview={preview} />
              <p className="min-w-0 flex-1 truncate text-[13px]">{row.name}</p>
            </div>
          )}
        </div>
        {error}
        <footer className={`relative flex min-h-[33px] items-center gap-2 border-t border-[var(--line-1)] py-2 pr-1 pl-3 text-[11px] text-[var(--fg-3)] ${failed ? '' : 'opacity-90'}`}>
          <span className="min-w-0 truncate tabular-nums" data-upload-line="">
            {statusLine(row)}
          </span>
          <Actions row={row} actions={actions} />
        </footer>
        <ProgressLine row={row} reduced={reduced} />
      </div>
    </motion.li>
  )
}
