import { mediaKind } from '@/lib/media.ts'
import type { Item } from '@/lib/types.ts'

export type ClipKind = 'link' | 'color' | 'code' | 'text' | 'image' | 'video' | 'audio' | 'file'

const COLOR = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|oklch|oklab|lab|lch)\([^()\n]{1,60}\))$/i
const CODE_HINTS = [
  /^\s*(?:import|export|const|let|var|function|class|def|return|if|for|while|package|#include|using|SELECT|INSERT|UPDATE)\b/m,
  /[;{}]\s*$/m,
  /=>|::|\$\(|<\/?[a-z][\w-]*[\s>]/,
]

/** One trimmed http(s) URL and nothing else. */
export function parseLink(text: string): URL | null {
  const value = text.trim()
  if (!value || /\s/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export function parseColor(text: string): string | null {
  const value = text.trim()
  return COLOR.test(value) ? value : null
}

/** Fenced block, or several lines where most look like source code. Markdown prose stays text. */
export function looksLikeCode(text: string): boolean {
  const value = text.trim()
  if (/^```[\s\S]*```$/.test(value)) return true
  const lines = value.split('\n').filter((line) => line.trim())
  if (lines.length < 2) return false
  if (lines.some((line) => /^\s*(?:[-*+]|\d+\.)\s|^#{1,6}\s/.test(line))) return false
  const hits = CODE_HINTS.filter((pattern) => pattern.test(value)).length
  const indented = lines.filter((line) => /^(?: {2,}|\t)/.test(line)).length
  return hits >= 2 || (hits >= 1 && indented >= 1)
}

export function clipKind(item: Pick<Item, 'kind' | 'text' | 'mime' | 'filename' | 'hasThumbnail'>): ClipKind {
  if (item.kind === 'file') {
    if (item.hasThumbnail) return 'image'
    return mediaKind(item) ?? 'file'
  }
  const text = item.text ?? ''
  if (parseLink(text)) return 'link'
  if (parseColor(text)) return 'color'
  if (looksLikeCode(text)) return 'code'
  return 'text'
}

/** Strip a single surrounding ``` fence (and its language tag) for display/copy. */
export function codeSource(text: string): { lang: string; body: string } {
  const match = /^```([\w+-]*)\n?([\s\S]*?)\n?```$/.exec(text.trim())
  return match ? { lang: match[1] ?? '', body: match[2] ?? '' } : { lang: '', body: text }
}

/** Cards fade over the last AGING_WINDOW before expiry; 1 = fresh, floor keeps them legible. */
export const AGING_WINDOW = 20 * 60_000
export function lifeOpacity(remainingMs: number): number {
  if (remainingMs >= AGING_WINDOW) return 1
  const ratio = Math.max(0, remainingMs) / AGING_WINDOW
  return Math.round((0.5 + ratio * 0.5) * 100) / 100
}
