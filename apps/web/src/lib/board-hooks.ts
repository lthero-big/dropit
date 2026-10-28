/**
 * Board hooks and presence math shared by the real board and the RHEA-191 demo
 * (RHEA-190 step 5): phone-width docking, scroll-aware collapse, named presence dots.
 */
import { useEffect, useState } from 'react'
import type { Item, ItemDevice } from '@/lib/types.ts'

function useMedia(query: string): boolean {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  const [match, setMatch] = useState(() => supported && window.matchMedia(query).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [query])
  return match
}

/** Phone width: the composer docks to the bottom edge instead of sitting above the board. */
export function useDockedComposer() {
  return useMedia('(max-width: 640px)')
}

/**
 * Scroll-aware collapse for the docked composer: shrinks to a pill while the
 * reader scrolls down, comes back on scroll up, at the end of the page, or when
 * tapped. Never collapses while focused or holding a draft.
 */
export function useScrollCollapse(enabled: boolean, hold: boolean) {
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setCollapsed(false)
      return
    }
    let last = window.scrollY
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const y = window.scrollY
        const delta = y - last
        const atEnd = window.innerHeight + y >= document.documentElement.scrollHeight - 8
        if (y < 48 || atEnd) setCollapsed(false)
        else if (delta > 6) setCollapsed(true)
        else if (delta < -10) setCollapsed(false)
        if (Math.abs(delta) > 6) last = y
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
    }
  }, [enabled])
  return [collapsed && enabled && !hold, setCollapsed] as const
}

export type PresenceDot = { key: string; name: string; kind: ItemDevice['kind'] | null; online: boolean; self: boolean }

/**
 * Who is here. With named peers (servers from RHEA-190 step 5) every online
 * device gets its own tinted dot, plus recent senders shown hollow as offline;
 * older servers only report a count, so the dots are anonymous.
 * Connections that named no device (CLI / API) collapse into one "其他客户端" dot,
 * so the online count is unique devices, not sockets (RHEA-190 m12).
 */
export function presenceDots(count: number, peers: ItemDevice[] | null, items: Item[], selfId: string, others = 0): PresenceDot[] {
  if (!peers) {
    const n = Math.max(1, Math.min(count, 6))
    return Array.from({ length: n }, (_, index) => ({ key: `#${index}`, name: index === 0 ? '本设备' : `设备 ${index + 1}`, kind: null, online: index < count, self: index === 0 }))
  }
  const seen = new Set<string>()
  const dots: PresenceDot[] = []
  const online = [...peers].sort((a, b) => Number(b.id === selfId) - Number(a.id === selfId))
  for (const peer of online) {
    if (seen.has(peer.id)) continue
    seen.add(peer.id)
    dots.push({ key: peer.id, name: peer.name, kind: peer.kind, online: true, self: peer.id === selfId })
  }
  if (others > 0) {
    dots.push({ key: OTHERS_KEY, name: others > 1 ? `其他客户端（CLI / API，${others} 个连接）` : '其他客户端（CLI / API）', kind: null, online: true, self: false })
  }
  const recent = [...items].sort((a, b) => b.createdAt - a.createdAt)
  for (const item of recent) {
    if (dots.length >= 6) break
    const device = item.device
    if (!device || seen.has(device.id)) continue
    seen.add(device.id)
    dots.push({ key: device.id, name: device.name, kind: device.kind, online: false, self: device.id === selfId })
  }
  return dots.slice(0, Math.max(6, online.length + (others > 0 ? 1 : 0)))
}

export const OTHERS_KEY = '#others'

/**
 * The number shown as 在线设备: unique online devices (plus one for unnamed clients),
 * i.e. exactly the rows marked 在线 in the list. Falls back to the raw socket count
 * only for servers that do not name peers (RHEA-190 m12).
 */
export function onlineDeviceCount(count: number, peers: ItemDevice[] | null, dots: PresenceDot[]): number {
  return peers ? dots.filter((dot) => dot.online).length : count
}

/** Phones / tablets: a coarse primary pointer or no hover. They get swipe gestures, never pin-drag or drag-to-group. */
const TOUCH_QUERY = '(pointer: coarse), (hover: none)'

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_QUERY).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(TOUCH_QUERY)
    const onChange = () => setCoarse(query.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])
  return coarse
}
