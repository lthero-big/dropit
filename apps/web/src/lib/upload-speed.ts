export const SPEED_WINDOW_MS = 5_000

export type SpeedSample = { at: number; bytes: number }

export function noteBytes(samples: SpeedSample[], bytes: number, now: number, windowMs = SPEED_WINDOW_MS): SpeedSample[] {
  const next = samples.filter((sample) => now - sample.at <= windowMs && sample.at <= now)
  const last = next[next.length - 1]
  if (last && last.at === now) {
    next[next.length - 1] = { at: now, bytes: Math.max(last.bytes, bytes) }
    return next
  }
  next.push({ at: now, bytes })
  return next
}

/** Bytes per second across the samples still inside the window. */
export function slidingBytesPerSecond(samples: SpeedSample[]): number {
  if (samples.length < 2) return 0
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last) return 0
  const seconds = (last.at - first.at) / 1000
  if (seconds < 0.2) return 0
  return Math.max(0, (last.bytes - first.bytes) / seconds)
}

export function etaMs(remainingBytes: number, bytesPerSecond: number): number | null {
  if (remainingBytes <= 0) return 0
  if (bytesPerSecond <= 0) return null
  return (remainingBytes / bytesPerSecond) * 1000
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!(bytesPerSecond > 0)) return '—'
  const mb = bytesPerSecond / (1024 * 1024)
  if (mb >= 0.05) return `${mb.toFixed(1)} MB/s`
  const kb = bytesPerSecond / 1024
  if (kb >= 0.05) return `${kb.toFixed(1)} KB/s`
  return `${Math.max(1, Math.round(bytesPerSecond))} B/s`
}

export function formatEta(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '计算中'
  if (ms < 1000) return '剩余不到 1 秒'
  const total = Math.round(ms / 1000)
  if (total < 60) return `剩余 ${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `剩余 ${minutes} 分 ${seconds} 秒` : `剩余 ${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const remainMinutes = minutes % 60
  return remainMinutes ? `剩余 ${hours} 小时 ${remainMinutes} 分` : `剩余 ${hours} 小时`
}
