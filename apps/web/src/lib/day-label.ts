/** Timeline section title: 今天 / 昨天 / M 月 D 日 (shared by the board and the demo). */
export function dayLabel(ts: number, now: number): string {
  const d = new Date(ts)
  const today = new Date(now)
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (ts >= startToday) return '今天'
  if (ts >= startToday - 86_400_000) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}
