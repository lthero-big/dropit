import { useEffect, useState } from 'react'
import type { SpaceSummary } from './types.ts'

export function quotaTone(used: number, quota: number): 'ok' | 'warn' | 'over' {
  if (quota <= 0) return 'ok'
  if (used > quota) return 'over'
  if (used / quota >= 0.8) return 'warn'
  return 'ok'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function formatRemain(ms: number): string {
  if (ms <= 0) return '已过期'
  const total = Math.floor(ms / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${total % 60} 秒`
  return `${total} 秒`
}

export function formatWhen(createdAt: number, now: number): string {
  const delta = Math.max(0, now - createdAt)
  if (delta < 60_000) return '刚刚'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)} 小时前`
  return `${Math.floor(delta / 86400_000)} 天前`
}

export function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length
}

export function useClock(offset: number): number {
  const [now, setNow] = useState(() => Date.now() + offset)
  useEffect(() => {
    setNow(Date.now() + offset)
    const id = window.setInterval(() => setNow(Date.now() + offset), 1000)
    return () => window.clearInterval(id)
  }, [offset])
  return now
}

export function spaceLabel(space: SpaceSummary, meId: string, spaces: SpaceSummary[]): string {
  const own = space.ownerId === meId
  const base = own ? '私人空间' : space.name === 'Private space' ? (space.ownerName ? `${space.ownerName} 的空间` : '受邀空间') : space.name
  if (own) return base
  const same = spaces.filter((item) => item.ownerId !== meId && item.name === space.name && item.ownerName === space.ownerName)
  return same.length > 1 ? `${base} ${space.id.slice(0, 4)}` : base
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}
