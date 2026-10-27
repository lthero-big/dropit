import { ExternalLinkIcon } from 'lucide-react'
import { clipKindLabel, codeSource, parseColor, parseLink, type ClipKind } from '@/lib/clip-kind.ts'

export function KindTag({ kind }: { kind: ClipKind }) {
  return (
    <span className="inline-flex h-5 items-center rounded-xs border border-line-2 bg-surface-2 px-1.5 text-[11px] font-medium text-fg-3" data-clip-kind={kind}>
      {clipKindLabel[kind]}
    </span>
  )
}

/** Sender badge: initial in a tinted dot plus the label the page provides (我 / 成员 / 访客). */
export function SourceBadge({ label }: { label: string }) {
  const tint = label === '我' ? 'bg-dev-mac' : label === '访客' ? 'bg-dev-pad' : 'bg-dev-phone'
  return (
    <span className="inline-flex h-5 items-center gap-1 text-xs font-medium text-fg-2" data-source-badge="">
      <span className={`grid size-4 place-items-center rounded-full text-[10px] font-semibold text-white ${tint}`} aria-hidden="true">
        {label.slice(0, 1)}
      </span>
      {label}
    </span>
  )
}

function hostHue(host: string): number {
  let hash = 0
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
}

export function LinkBody({ text }: { text: string }) {
  const url = parseLink(text)
  if (!url) return null
  const host = url.hostname.replace(/^www\./, '')
  const path = `${url.pathname === '/' ? '' : url.pathname}${url.search}`
  return (
    <a
      href={url.href}
      target="_blank"
      rel="noopener noreferrer"
      data-action=""
      className="group/link flex min-h-10 items-center gap-3 rounded-md border border-line-1 bg-surface-0 p-2 no-underline transition-colors duration-(--dur-fast) hover:border-line-3"
    >
      <span
        className="grid size-9 shrink-0 place-items-center rounded-sm text-sm font-semibold text-white uppercase"
        style={{ background: `oklch(0.58 0.11 ${hostHue(host)})` }}
        aria-hidden="true"
      >
        {host.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{host}</span>
        <span className="block truncate font-mono text-xs text-fg-3">{path || url.href}</span>
      </span>
      <ExternalLinkIcon className="size-4 shrink-0 text-fg-4 transition-colors group-hover/link:text-fg-2" aria-hidden="true" />
    </a>
  )
}

export function ColorBody({ text }: { text: string }) {
  const color = parseColor(text)
  if (!color) return null
  return (
    <div className="flex items-center gap-3">
      <span className="size-12 shrink-0 rounded-md border border-line-2 shadow-elev-1" style={{ background: color }} aria-hidden="true" />
      <span className="font-mono text-sm text-fg">{color}</span>
    </div>
  )
}

export function CodeBody({ text, collapsed }: { text: string; collapsed: boolean }) {
  const { lang, body } = codeSource(text)
  return (
    <div className="relative overflow-hidden rounded-md border border-line-1 bg-code">
      {lang ? <span className="absolute top-1.5 right-2 font-mono text-[10px] text-fg-4 uppercase">{lang}</span> : null}
      <pre className={`overflow-x-auto p-3 font-mono text-[12.5px] leading-5 text-fg-2 ${collapsed ? 'max-h-40' : ''}`}>
        <code>{body}</code>
      </pre>
    </div>
  )
}
