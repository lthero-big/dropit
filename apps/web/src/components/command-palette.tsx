import { useEffect, useState } from 'react'
import type { Item } from '@/lib/types.ts'

function summary(item: Item) {
  const text = item.kind === 'text' ? (item.text ?? '') : (item.filename ?? '文件')
  return text.replace(/\s+/g, ' ').trim().slice(0, 80) || '空内容'
}

export function CommandPalette({ items, onJump }: { items: Item[]; onJump: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((current) => !current)
        setQuery('')
      } else if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!open) return null
  const needle = query.trim().toLowerCase()
  const matches = items
    .filter((item) => {
      const haystack = `${item.text ?? ''}\n${item.filename ?? ''}\n${(item.tags ?? []).join('\n')}`.toLowerCase()
      return !needle || haystack.includes(needle)
    })
    .slice(0, 8)

  return (
    <div className="fixed inset-0 z-40 grid place-items-start bg-foreground/40 px-4 pt-[15vh]" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-label="命令面板"
        className="w-full max-w-xl rounded-md border border-line-2 bg-background p-3"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <label className="sr-only" htmlFor="palette">
          搜索内容
        </label>
        <input
          id="palette"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索文本、文件名或标签"
          className="w-full border border-line-2 bg-transparent px-3 py-2 text-sm outline-none"
        />
        <ul className="mt-2">
          <li>
            <button
              type="button"
              className="block w-full px-2 py-2 text-left text-sm hover:bg-secondary"
              onClick={() => {
                setOpen(false)
                document.getElementById('draft')?.focus()
              }}
            >
              聚焦输入框
            </button>
          </li>
          {matches.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="block w-full truncate px-2 py-2 text-left text-sm hover:bg-secondary"
                onClick={() => {
                  setOpen(false)
                  onJump(item.id)
                }}
              >
                {summary(item)}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
