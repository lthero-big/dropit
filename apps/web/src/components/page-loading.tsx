import { useEffect, useState } from 'react'
import { Logo } from '@/components/logo.tsx'

/** Loads shorter than this never show the loader, so a fast refresh does not flash it (RHEA-190 m51). */
export const PAGE_LOADING_DELAY_MS = 300
/** How long the page that replaces the loader keeps the fade-in rule (the CSS fade itself is --dur-slow). */
export const PAGE_REVEAL_MS = 480

let revealTimer: number | undefined

/** Marks <html data-page-reveal> so the page that replaces the loader fades in (see .dd-page-loading in index.css). */
function markPageReveal() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.pageReveal = ''
  window.clearTimeout(revealTimer)
  revealTimer = window.setTimeout(() => {
    delete root.dataset.pageReveal
  }, PAGE_REVEAL_MS)
}

/**
 * RHEA-190 m51: the one full-page loading transition. A centered brand mark, a light spinner and the label.
 * It stays invisible for the first {@link PAGE_LOADING_DELAY_MS}, fades in after that, and the page that
 * replaces it fades in too. prefers-reduced-motion turns the spinner, the fades and the delay animation off.
 */
export function PageLoading({ label, delayMs = PAGE_LOADING_DELAY_MS }: { label: string; delayMs?: number }) {
  const [shown, setShown] = useState(delayMs <= 0)

  useEffect(() => {
    if (delayMs <= 0) return
    const id = window.setTimeout(() => setShown(true), delayMs)
    return () => window.clearTimeout(id)
  }, [delayMs])

  useEffect(() => () => markPageReveal(), [])

  return (
    <main className="dd-page-loading grid min-h-svh place-items-center px-6 py-16" data-page-loading={shown ? 'shown' : 'pending'} aria-busy="true">
      <div className="dd-page-loading-body flex flex-col items-center gap-5 text-center" role="status" aria-live="polite">
        <span aria-hidden="true">
          <Logo size="lg" word={false} />
        </span>
        <span className="dd-spinner" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </main>
  )
}
