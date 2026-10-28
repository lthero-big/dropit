import { useState } from 'react'
import type { GroupFilter } from '@/components/board-groups.tsx'
import type { Item } from '@/lib/types.ts'

/** Search text + group chip filter, and the pinned / loose / per-group lists derived from them. */
export function useBoardFilter(visible: Item[]) {
  const [query, setQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState<GroupFilter>(null)
  const needle = query.trim().toLowerCase()
  const shown = visible.filter((item) => {
    if (!needle) return true
    // tags are no longer shown or edited, so they don't match searches either (the data stays on the server)
    const haystack = `${item.text ?? ''}\n${item.filename ?? ''}`
    return haystack.toLowerCase().includes(needle)
  })
  const pinnedShown = shown.filter((item) => item.pinned)
  const looseAll = shown.filter((item) => !item.pinned)
  const looseShown = groupFilter === null ? looseAll : looseAll.filter((item) => (item.group ?? '') === groupFilter)
  const groupCounts = new Map<string, number>()
  for (const item of looseAll) groupCounts.set(item.group ?? '', (groupCounts.get(item.group ?? '') ?? 0) + 1)
  return { query, setQuery, groupFilter, setGroupFilter, shown, pinnedShown, looseAll, looseShown, groupCounts }
}
