import { formatBytes } from './format.ts'
import { LIMIT_KEYS, type AdminLimits, type LimitKey } from './types.ts'

// MB/GB match the rest of the UI: 1024-based quantities, labeled MB/GB.
const MIB = 1024 ** 2
const GIB = 1024 ** 3
const HOUR = 3_600_000
const DAY = 86_400_000

export type LimitUnit = 'MB' | 'GB' | 'hour' | 'day' | 'second' | 'minute' | 'count'

const FACTOR: Record<Exclude<LimitUnit, 'count'>, number> = {
  MB: MIB,
  GB: GIB,
  hour: HOUR,
  day: DAY,
  second: 1000,
  minute: 60_000,
}

export const UNIT_LABEL: Record<LimitUnit, string> = {
  MB: 'MB',
  GB: 'GB',
  hour: '小时',
  day: '天',
  second: '秒',
  minute: '分钟',
  count: '',
}

const BYTE_KEYS = new Set<LimitKey>(['maxFileBytes', 'maxTextBytes', 'userQuotaBytes', 'roomQuotaBytes', 'roomMaxFileBytes'])
const LONG_TIME_KEYS = new Set<LimitKey>(['retentionMs', 'roomRetentionMs', 'sessionMs'])

export interface LimitSpec {
  key: LimitKey
  label: string
  group: '容量' | '时间' | '限流'
  hint?: string
}

export const LIMIT_SPECS: LimitSpec[] = [
  { key: 'maxFileBytes', label: '单文件上限', group: '容量' },
  { key: 'maxTextBytes', label: '文本上限', group: '容量' },
  { key: 'userQuotaBytes', label: '默认用户配额', group: '容量' },
  { key: 'roomQuotaBytes', label: '房间配额', group: '容量' },
  { key: 'roomMaxFileBytes', label: '房间单文件', group: '容量' },
  { key: 'maxItems', label: '每空间条目上限', group: '容量' },
  { key: 'retentionMs', label: '内容保留', group: '时间', hint: '只影响新条目。' },
  { key: 'roomRetentionMs', label: '房间保留', group: '时间', hint: '只影响新房间，且不超过 24 小时。' },
  { key: 'sessionMs', label: '会话时长', group: '时间', hint: '只影响新的登录会话。' },
  { key: 'rateWindowMs', label: '限流窗口', group: '时间', hint: '最长 1 小时，用秒、分钟或小时输入。' },
  { key: 'rateGeneral', label: '通用限流', group: '限流' },
  { key: 'rateAuth', label: '登录限流', group: '限流' },
  { key: 'rateInvite', label: '邀请限流', group: '限流' },
  { key: 'rateUpload', label: '上传限流', group: '限流' },
  { key: 'rateRoom', label: '房间写入限流', group: '限流' },
]

export function unitsFor(key: LimitKey): LimitUnit[] {
  if (BYTE_KEYS.has(key)) return ['MB', 'GB']
  if (key === 'rateWindowMs') return ['second', 'minute', 'hour']
  if (LONG_TIME_KEYS.has(key)) return ['hour', 'day']
  return ['count']
}

export function defaultUnit(key: LimitKey, value: number): LimitUnit {
  if (BYTE_KEYS.has(key)) return value >= GIB && value % GIB === 0 ? 'GB' : 'MB'
  if (key === 'rateWindowMs') {
    if (value >= HOUR && value % HOUR === 0) return 'hour'
    if (value >= 60_000 && value % 60_000 === 0) return 'minute'
    return 'second'
  }
  if (LONG_TIME_KEYS.has(key)) return value >= DAY && value % DAY === 0 ? 'day' : 'hour'
  return 'count'
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, '')
}

export function toInput(value: number, unit: LimitUnit): string {
  if (unit === 'count') return String(value)
  const amount = value / FACTOR[unit]
  if (Number.isInteger(amount)) return String(amount)
  for (let digits = 0; digits <= 12; digits += 1) {
    const text = trimFixed(amount, digits)
    if (text && Math.round(Number(text) * FACTOR[unit]) === value) return text
  }
  return trimFixed(amount, 12)
}

export function toCanonical(raw: string, unit: LimitUnit): number | null {
  const text = raw.trim()
  if (unit === 'count') {
    if (!/^\d+$/.test(text)) return null
    const count = Number(text)
    return Number.isSafeInteger(count) && count >= 1 ? count : null
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const amount = Number(text)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const rounded = Math.round(amount * FACTOR[unit])
  return Number.isSafeInteger(rounded) && rounded >= 1 ? rounded : null
}

export function formatDuration(ms: number): string {
  if (ms >= DAY && ms % DAY === 0) return `${ms / DAY} 天`
  if (ms >= HOUR && ms % HOUR === 0) return `${ms / HOUR} 小时`
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} 分钟`
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} 秒`
  return `${ms} 毫秒`
}

export function formatLimit(key: string, value: number): string {
  if (BYTE_KEYS.has(key as LimitKey)) return formatBytes(value)
  if (LONG_TIME_KEYS.has(key as LimitKey) || key === 'rateWindowMs') return formatDuration(value)
  if (key === 'maxItems') return `${value} 条`
  return `${value} 次`
}

export function labelFor(key: string): string {
  return LIMIT_SPECS.find((spec) => spec.key === key)?.label ?? key
}

export function formatStamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function currentValues(limits: AdminLimits): Record<LimitKey, number> {
  return Object.fromEntries(LIMIT_KEYS.map((key) => [key, limits[key].value])) as Record<LimitKey, number>
}

function crossMessage(key: LimitKey, values: Record<LimitKey, number>): string | null {
  if ((key === 'roomMaxFileBytes' || key === 'maxFileBytes') && values.roomMaxFileBytes >= values.maxFileBytes) {
    return '房间单文件必须小于单文件上限'
  }
  if ((key === 'roomQuotaBytes' || key === 'userQuotaBytes') && values.roomQuotaBytes >= values.userQuotaBytes) {
    return '房间配额必须小于默认用户配额'
  }
  if ((key === 'roomRetentionMs' || key === 'retentionMs') && values.roomRetentionMs > values.retentionMs) {
    return '房间保留不能长于内容保留'
  }
  if ((key === 'rateAuth' || key === 'rateGeneral') && values.rateAuth >= values.rateGeneral) {
    return '登录限流必须小于通用限流'
  }
  if ((key === 'rateInvite' || key === 'rateGeneral') && values.rateInvite >= values.rateGeneral) {
    return '邀请限流必须小于通用限流'
  }
  if ((key === 'rateUpload' || key === 'rateGeneral') && values.rateUpload >= values.rateGeneral) {
    return '上传限流必须小于通用限流'
  }
  if ((key === 'rateRoom' || key === 'rateUpload') && values.rateRoom >= values.rateUpload) {
    return '房间写入限流必须小于上传限流'
  }
  return null
}

export function localLimitError(key: LimitKey, canonical: number, limits: AdminLimits): string | null {
  const field = limits[key]
  if (canonical < field.min || canonical > field.max) {
    return `需在 ${formatLimit(key, field.min)} 到 ${formatLimit(key, field.max)} 之间`
  }
  const values = currentValues(limits)
  values[key] = canonical
  return crossMessage(key, values)
}
