/**
 * RHEA-190 lt2: full-screen reader for a long text card. The board keeps a short collapsed
 * preview (grid rows no longer stretch to the tallest card); clicking the card or 展开 opens
 * the whole text here: centered, scrolls on its own, the board behind is dimmed and blurred
 * like the photo viewer. A click on the backdrop or Esc closes it and focus goes back.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { XIcon } from 'lucide-react'
import { MarkdownText } from '@/lib/markdown.tsx'
import { dur, easeIn, easeOut, springSettle } from '@/lib/motion.ts'

export function TextReader({
  text,
  open,
  anchor,
  reduced,
  meta,
  onClose,
}: {
  text: string
  open: boolean
  anchor: RefObject<HTMLElement | null>
  reduced: boolean
  /** small caption next to the title, e.g. sender · time */
  meta?: string
  onClose: () => void
}) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setHost((anchor.current?.closest('.dd, .dd-board') as HTMLElement | null) ?? document.body)
  }, [anchor])
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])
  useEffect(() => {
    if (!open) return
    const html = document.documentElement
    const before = html.style.overflow
    html.style.overflow = 'hidden'
    return () => {
      html.style.overflow = before
      const previous = opener.current
      opener.current = null
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])
  if (!host) return null
  return createPortal(<AnimatePresence>{open ? <Reader key="reader" text={text} meta={meta} reduced={reduced} onClose={onClose} /> : null}</AnimatePresence>, host)
}

function Reader({ text, meta, reduced, onClose }: { text: string; meta?: string; reduced: boolean; onClose: () => void }) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const lines = text.split('\n').length
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-text-reader=""
      className="fixed inset-0 z-[100] flex items-center justify-center p-0 sm:p-6 lg:p-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: reduced ? 0 : dur.base, ease: easeOut } }}
      exit={{ opacity: 0, transition: { duration: reduced ? 0 : dur.fast, ease: easeIn } }}
    >
      <div data-text-reader-backdrop="" className="absolute inset-0 bg-[color-mix(in_oklab,var(--bg)_45%,black)]/70 backdrop-blur-md" onClick={onClose} aria-hidden />
      <motion.article
        className="relative z-10 flex h-full max-h-full w-full flex-col overflow-hidden border-[var(--line-2)] bg-[var(--surface-1)] shadow-[var(--elev-3)] sm:h-auto sm:max-h-[min(88vh,1100px)] sm:max-w-[min(820px,100%)] sm:rounded-[var(--radius-lg)] sm:border"
        initial={reduced ? false : { opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: reduced ? { duration: 0 } : springSettle }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98, transition: { duration: dur.fast, ease: easeIn } }}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--line-1)] py-2 pr-2 pl-5 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <h2 id={titleId} className="text-[14px] font-semibold text-[var(--fg)]">
            全文
          </h2>
          <span className="dd-mono truncate text-[11px] text-[var(--fg-3)]">
            {meta ? `${meta} · ` : ''}
            {lines} 行 · {text.length} 字
          </span>
          <button
            type="button"
            ref={closeRef}
            aria-label="关闭（Esc）"
            title="关闭（Esc）"
            className="ml-auto grid size-10 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--fg-2)] outline-none hover:bg-[var(--surface-2)] hover:text-[var(--fg)] focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onClose}
          >
            <XIcon className="size-4" />
          </button>
        </header>
        <div data-text-reader-scroll="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-[var(--fg)] sm:px-8 sm:py-6">
          <MarkdownText text={text} defaultRendered />
        </div>
      </motion.article>
    </motion.div>
  )
}
