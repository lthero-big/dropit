/**
 * Card bodies shared by the real clipboard board and the RHEA-191 demo
 * (RHEA-190 step 4). Both sides map their data onto `ClipVisual`; the demo's
 * fake `Clip` already has this shape, the board builds it from an `Item`.
 */
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { PlayIcon, ZoomInIcon } from 'lucide-react'
import { AudioPlayer, InlineVideo, useIsolatePointer, type ViewerMedia } from '@/components/clip-media.tsx'
import { fileType } from '@/lib/file-type.ts'

export type ClipVisual =
  | { id: string; kind: 'link'; url: string; title: string; site: string; /** real links open in a new tab */ href?: string }
  | { id: string; kind: 'code'; lang: string; code: string }
  | { id: string; kind: 'color'; value: string; name?: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'image'; name: string; src: string; w?: number; h?: number; tone?: string; meta?: string }
  | {
      id: string
      kind: 'file'
      name: string
      size: number
      /** playable audio / video source */
      src?: string
      poster?: string
      /** explicit media kind (the board knows the MIME type); otherwise guessed from the name */
      media?: 'audio' | 'video' | null
    }

export type VisualKind = ClipVisual['kind']

/** Overrides the board passes in: richer text/code bodies and its own image viewer. */
export type BodySlots = {
  /** replaces the big display paragraph (e.g. Markdown with 展开/收起) */
  text?: ReactNode
  /** replaces the code block (e.g. full listing when expanded) */
  code?: ReactNode
  /** custom image open handler + accessible name; defaults to the shared MediaViewer */
  openImage?: () => void
  imageLabel?: string
}

export type BodyProps = {
  clip: ClipVisual
  viewing: boolean
  onView: (media: ViewerMedia) => void
  slots?: BodySlots
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function hexChannels(color: string): [number, number, number] | null {
  let h = color.trim().replace(/^#/, '')
  if (!/^[0-9a-f]+$/i.test(h)) return null
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('')
  if (h.length !== 6 && h.length !== 8) return null
  const n = Number.parseInt(h.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `r g b` for a hex colour, '' for anything else (rgb(), hsl(), oklch() …). */
export function hexToRgb(hex: string): string {
  const ch = hexChannels(hex)
  return ch ? ch.join(' ') : ''
}

/** Black or white text, whichever reads better on the colour (non-hex colours get black). */
export function readableOn(hex: string): '#000' | '#fff' {
  const ch = hexChannels(hex)
  if (!ch) return '#000'
  const [r, g, b] = ch.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return l > 0.4 ? '#000' : '#fff'
}

/** audio / video files with a source play inline instead of showing a file icon */
export function mediaOfVisual(clip: ClipVisual): 'audio' | 'video' | null {
  if (clip.kind !== 'file' || !clip.src) return null
  if (clip.media !== undefined) return clip.media
  const t = fileType(clip.name).label
  return t === 'AUDIO' ? 'audio' : t === 'VIDEO' ? 'video' : null
}

export function visualLabel(clip: ClipVisual) {
  switch (clip.kind) {
    case 'link': return clip.title
    case 'code': return `${clip.lang} 代码`
    case 'color': return clip.value
    case 'text': return clip.text
    case 'image': return clip.name
    case 'file': return clip.name
  }
}

/** Compact countdown for the card footer: 42s · 12m 05s · 3h 20m · 2d 4h. */
export function shortLeft(ms: number) {
  if (ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const kindLabel: Record<VisualKind, string> = { link: '链接', code: '代码', color: '色值', text: '文本', image: '图片', file: '文件' }

export function VisualKindTag({ clip }: { clip: ClipVisual }) {
  return (
    <span className="dd-mono text-[10px] uppercase tracking-[0.08em] text-[var(--fg-3)]" data-clip-kind={clip.kind}>
      {kindLabel[clip.kind]}
      {clip.kind === 'code' && clip.lang ? ` · ${clip.lang}` : ''}
    </span>
  )
}

function siteHue(site: string) {
  let h = 0
  for (const ch of site) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

export function Favicon({ site, size = 28 }: { site: string; size?: number }) {
  const hue = siteHue(site)
  return (
    <span
      aria-hidden
      className="dd-mono grid shrink-0 place-items-center rounded-[var(--radius-sm)] text-[12px] font-semibold text-white"
      style={{ width: size, height: size, background: `oklch(0.55 0.11 ${hue})`, boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.08)' }}
    >
      {site.replace(/^www\./, '')[0]?.toUpperCase()}
    </span>
  )
}

const imageMedia = (clip: Extract<ClipVisual, { kind: 'image' }>): ViewerMedia => ({
  type: 'image',
  src: clip.src,
  name: clip.name,
  meta: clip.meta ?? (clip.w && clip.h ? `${clip.w}×${clip.h}` : undefined),
  layoutId: `img-${clip.id}`,
})

function imageMeta(clip: Extract<ClipVisual, { kind: 'image' }>) {
  return clip.meta ?? (clip.w && clip.h ? `${clip.w}×${clip.h}` : '')
}

function ZoomableThumb({ clip, viewing, onView, slots, className }: BodyProps & { clip: Extract<ClipVisual, { kind: 'image' }>; className: string }) {
  const ref = useIsolatePointer<HTMLButtonElement>()
  const label = slots?.imageLabel ?? `放大查看 ${clip.name}`
  return (
    <button
      ref={ref}
      type="button"
      data-action
      aria-label={label}
      title="放大查看"
      onClick={() => (slots?.openImage ? slots.openImage() : onView(imageMedia(clip)))}
      className="group/zoom relative cursor-zoom-in"
    >
      {viewing ? (
        <img src={clip.src} alt="" draggable={false} className={`${className} opacity-0`} />
      ) : (
        <motion.img layoutId={slots?.openImage ? undefined : `img-${clip.id}`} src={clip.src} alt="" draggable={false} className={className} />
      )}
      <span aria-hidden className="absolute inset-0 grid place-items-center rounded-[var(--radius-xs)] bg-black/30 text-white opacity-0 transition-opacity group-hover/zoom:opacity-100 group-focus-visible/zoom:opacity-100">
        <ZoomInIcon className="size-4" />
      </span>
    </button>
  )
}

export function CodeLines({ code, lines = 5 }: { code: string; lines?: number }) {
  const all = code.split('\n')
  const shown = Number.isFinite(lines) ? all.slice(0, lines) : all
  const pad = String(shown.length).length
  return (
    <pre className="dd-mono m-0 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--line-1)] bg-[var(--code-bg)] p-2.5 text-[11.5px] leading-[1.6] text-[var(--fg-2)]">
      {shown.map((line, i) => (
        <div key={i} className="flex gap-3">
          <span className="shrink-0 select-none text-right text-[var(--fg-4)]" style={{ width: `${Math.max(1, pad) * 0.62}em` }}>{i + 1}</span>
          <span className={Number.isFinite(lines) ? 'truncate' : 'whitespace-pre-wrap break-all'}>{line || ' '}</span>
        </div>
      ))}
    </pre>
  )
}

export function GridBody({ clip, viewing, onView, slots }: BodyProps) {
  switch (clip.kind) {
    case 'link':
      return (
        <div className="flex flex-col gap-3 p-3 pr-24">
          <VisualKindTag clip={clip} />
          <div className="flex items-start gap-2.5">
            <Favicon site={clip.site} />
            <div className="min-w-0">
              <p className="dd-display line-clamp-2 text-[14px] font-medium leading-snug break-words text-[var(--fg)]">{clip.href ? <LinkOut href={clip.href}>{clip.title}</LinkOut> : clip.title}</p>
              <p className="dd-mono mt-1 truncate text-[11px] text-[var(--fg-3)]">{clip.url.replace(/^https?:\/\//, '')}</p>
            </div>
          </div>
        </div>
      )
    case 'code':
      return (
        <div className="flex flex-col gap-2 p-3">
          <VisualKindTag clip={clip} />
          {slots?.code ?? <CodeLines code={clip.code} />}
        </div>
      )
    case 'color':
      return (
        <div className="p-1.5 pb-0">
          <div className="flex h-24 flex-col justify-between rounded-[calc(var(--radius-md)-3px)] p-2.5" style={{ background: clip.value, color: readableOn(clip.value) }}>
            <span className="dd-mono text-[10px] uppercase tracking-[0.08em] opacity-70">色值</span>
            <span className="dd-mono text-[18px] font-medium tracking-tight">{clip.value}</span>
          </div>
          <p className="dd-mono flex justify-between px-1.5 py-2 text-[11px] text-[var(--fg-3)]">
            <span>{hexToRgb(clip.value) ? `rgb(${hexToRgb(clip.value)})` : ''}</span>
            {clip.name ? <span>{clip.name}</span> : null}
          </p>
        </div>
      )
    case 'text':
      return (
        <div className="flex min-h-28 flex-col justify-between gap-3 p-3">
          <VisualKindTag clip={clip} />
          {slots?.text ?? <p className="dd-display text-[20px] font-medium leading-[1.35] tracking-[-0.01em] break-words text-[var(--fg)]">{clip.text}</p>}
        </div>
      )
    case 'image':
      return (
        <div className="p-1.5 pb-0">
          <div className="grid h-36 place-items-center overflow-hidden rounded-[calc(var(--radius-md)-3px)]" style={{ background: clip.tone ? `color-mix(in oklab, ${clip.tone} 70%, var(--surface-2))` : 'var(--surface-sunken)' }}>
            <ZoomableThumb clip={clip} viewing={viewing} onView={onView} slots={slots} className="block max-h-[122px] max-w-full rounded-[var(--radius-xs)] object-contain shadow-[0_8px_20px_-8px_rgb(0_0_0/0.45)]" />
          </div>
          <p className="flex justify-between gap-2 px-1.5 py-2 text-[11px] text-[var(--fg-3)]">
            <span className="truncate text-[var(--fg-2)]">{clip.name}</span>
            <span className="dd-mono shrink-0">{imageMeta(clip)}</span>
          </p>
        </div>
      )
    case 'file': {
      const t = fileType(clip.name)
      const Icon = t.icon
      const media = mediaOfVisual(clip)
      if (media === 'video' && clip.src) {
        const src = clip.src
        return (
          <div className="p-1.5 pb-0">
            <InlineVideo src={src} poster={clip.poster} name={clip.name} onExpand={() => onView({ type: 'video', src, poster: clip.poster, name: clip.name, meta: formatSize(clip.size) })} />
            <p className="flex justify-between gap-2 px-1.5 py-2 text-[11px] text-[var(--fg-3)]">
              <span className="truncate text-[var(--fg-2)]">{clip.name}</span>
              <span className="dd-mono shrink-0">{t.label} · {formatSize(clip.size)}</span>
            </p>
          </div>
        )
      }
      if (media === 'audio' && clip.src) {
        return (
          <div className="flex flex-col gap-2.5 p-3">
            <div className="flex items-center gap-2 pr-24">
              <Icon className="size-4 shrink-0" style={{ color: t.color }} />
              <p className="truncate text-[13.5px] font-medium text-[var(--fg)]">{clip.name}</p>
            </div>
            <AudioPlayer src={clip.src} name={clip.name} color={t.color} />
          </div>
        )
      }
      return (
        <div className="flex items-center gap-3 p-3 pr-24">
          <span className="relative grid size-11 shrink-0 place-items-center rounded-[var(--radius-sm)]" style={{ background: `color-mix(in oklab, ${t.color} 14%, var(--surface-1))`, color: t.color }}>
            <Icon className="size-5" />
            <span className="dd-mono absolute -bottom-1.5 rounded-[2px] px-1 text-[8.5px] font-semibold text-white" style={{ background: t.color }}>{t.ext.slice(0, 4)}</span>
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-medium text-[var(--fg)]">{clip.name}</p>
            <p className="dd-mono mt-0.5 text-[11px] text-[var(--fg-3)]">{t.label} · {formatSize(clip.size)}</p>
          </div>
        </div>
      )
    }
  }
}

/** Compact one-line rendering for the list / timeline layouts. */
export function RowBody({ clip, viewing, onView, slots }: BodyProps) {
  let lead
  let main
  switch (clip.kind) {
    case 'link':
      lead = <Favicon site={clip.site} size={24} />
      main = <><p className="truncate text-[13.5px] font-medium">{clip.href ? <LinkOut href={clip.href}>{clip.title}</LinkOut> : clip.title}</p><p className="dd-mono truncate text-[11px] text-[var(--fg-3)]">{clip.site}</p></>
      break
    case 'code':
      lead = <span className="dd-mono grid size-6 shrink-0 place-items-center rounded-[var(--radius-xs)] bg-[var(--code-bg)] text-[9px] text-[var(--fg-2)] ring-1 ring-[var(--line-1)]">{'</>'}</span>
      main = slots?.code ?? <p className="dd-mono truncate text-[12px] text-[var(--fg-2)]">{clip.code.split('\n')[0]}</p>
      break
    case 'color':
      lead = <span className="size-6 shrink-0 rounded-[var(--radius-xs)] ring-1 ring-black/10" style={{ background: clip.value }} />
      main = <p className="dd-mono text-[13px]">{clip.value} <span className="text-[var(--fg-3)]">{clip.name}</span></p>
      break
    case 'text':
      lead = <span className="dd-display grid size-6 shrink-0 place-items-center text-[15px] text-[var(--fg-3)]">“</span>
      main = slots?.text ?? <p className="dd-display truncate text-[15px] font-medium">{clip.text}</p>
      break
    case 'image':
      lead = <ZoomableThumb clip={clip} viewing={viewing} onView={onView} slots={slots} className="block size-6 rounded-[var(--radius-xs)] object-cover" />
      main = <p className="truncate text-[13px]">{clip.name} <span className="dd-mono text-[11px] text-[var(--fg-3)]">{imageMeta(clip)}</span></p>
      break
    case 'file': {
      const t = fileType(clip.name)
      const Icon = t.icon
      const media = mediaOfVisual(clip)
      if (media === 'audio' && clip.src) {
        lead = <span className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-xs)]" style={{ color: t.color, background: `color-mix(in oklab, ${t.color} 14%, transparent)` }}><Icon className="size-3.5" /></span>
        main = <div className="flex items-center gap-3"><p className="w-40 shrink-0 truncate text-[13px]">{clip.name}</p><div className="min-w-0 flex-1"><AudioPlayer compact src={clip.src} name={clip.name} color={t.color} /></div></div>
        break
      }
      if (media === 'video' && clip.src) {
        const src = clip.src
        lead = <PlayLead color={t.color} name={clip.name} onPlay={() => onView({ type: 'video', src, poster: clip.poster, name: clip.name, meta: formatSize(clip.size) })} />
      } else {
        lead = <span className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-xs)]" style={{ color: t.color, background: `color-mix(in oklab, ${t.color} 14%, transparent)` }}><Icon className="size-3.5" /></span>
      }
      main = <p className="truncate text-[13px]">{clip.name} <span className="dd-mono text-[11px] text-[var(--fg-3)]">{formatSize(clip.size)}</span></p>
      break
    }
  }
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 pr-24">
      {lead}
      <div className="min-w-0 flex-1">{main}</div>
    </div>
  )
}

function PlayLead({ color, name, onPlay }: { color: string; name: string; onPlay: () => void }) {
  const ref = useIsolatePointer<HTMLButtonElement>()
  return (
    <motion.button ref={ref} type="button" data-action aria-label={`播放 ${name}`} title="播放" onClick={onPlay} whileTap={{ scale: 0.9 }} className="grid size-6 shrink-0 place-items-center rounded-full text-white" style={{ background: color }}>
      <PlayIcon className="size-3 translate-x-px" fill="currentColor" />
    </motion.button>
  )
}

function LinkOut({ href, children }: { href: string; children: ReactNode }) {
  const ref = useIsolatePointer<HTMLAnchorElement>()
  return (
    <a ref={ref} href={href} target="_blank" rel="noopener noreferrer" data-action="" className="text-inherit underline-offset-2 hover:underline">
      {children}
    </a>
  )
}
