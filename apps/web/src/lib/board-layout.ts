import type { Item } from '@/lib/types.ts'
import { dayLabel } from '@/lib/day-label.ts'

/** Minimum tap size for board buttons. */
export const touchTarget = { minWidth: 40, minHeight: 40 }

export const layoutKey = 'dropit-layout'
export type BoardLayout = 'grid' | 'list' | 'group' | 'timeline' | 'device'
export const LAYOUTS: BoardLayout[] = ['grid', 'list', 'group', 'timeline', 'device']

export function readLayout(): BoardLayout {
  try {
    const saved = localStorage.getItem(layoutKey)
    return LAYOUTS.includes(saved as BoardLayout) ? (saved as BoardLayout) : 'grid'
  } catch {
    return 'grid'
  }
}

/** Day sections for the timeline layout, newest day first (items keep board order). */
export function timeline(items: Item[], now: number): Array<[string, Item[]]> {
  const days = new Map<string, Item[]>()
  for (const item of items) {
    const key = dayLabel(item.createdAt, now)
    const list = days.get(key)
    if (list) list.push(item)
    else days.set(key, [item])
  }
  return [...days.entries()]
}

/** 按设备 sections, most recent sender first; clips without a device fall under their sender label. */
export function byDevice(items: Item[], sender: (item: Item) => string): Array<{ key: string; name: string; kind: NonNullable<Item['device']>['kind'] | null; list: Item[] }> {
  const map = new Map<string, { key: string; name: string; kind: NonNullable<Item['device']>['kind'] | null; list: Item[] }>()
  for (const item of items) {
    const key = item.device?.id ?? `sender:${sender(item)}`
    const entry = map.get(key)
    if (entry) entry.list.push(item)
    else map.set(key, { key, name: item.device?.name ?? `${sender(item)} · 未识别设备`, kind: item.device?.kind ?? null, list: [item] })
  }
  return [...map.values()]
}
