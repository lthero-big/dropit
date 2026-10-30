import { useEffect, useId, type ReactNode } from 'react'

/**
 * RHEA-190 m50: a small modal dialog (bottom sheet on phones). Escape or a click on the backdrop closes it.
 */
export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-end bg-foreground/40 p-0 sm:place-items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`max-h-svh w-full ${wide ? 'max-w-2xl' : 'max-w-md'} overflow-y-auto rounded-t-lg border border-line-2 bg-surface-1 p-5 shadow-elev-3 sm:rounded-lg`}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-xl font-semibold text-fg">
            {title}
          </h2>
          <button type="button" className="min-h-10 min-w-10 text-sm text-muted-foreground hover:text-fg" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  )
}
