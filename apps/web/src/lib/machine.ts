const returnKey = 'dropit-return'

export function normalizeUserCode(raw: string): string {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  if (compact.length <= 4) return compact
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}

export function readVerificationId(value: string | null): string | null {
  if (!value || !/^[A-Za-z0-9-]{1,64}$/.test(value)) return null
  return value
}

/** A pasted verification URL sets both fields. Plain typing only changes the code. */
export function parseDeviceEntry(value: string): { code: string; verificationId?: string | null } {
  const trimmed = value.trim()
  if (trimmed.includes('://') || trimmed.startsWith('/device?')) {
    try {
      const url = new URL(trimmed, 'http://dropit.local')
      return {
        code: normalizeUserCode(url.searchParams.get('user_code') ?? ''),
        verificationId: readVerificationId(url.searchParams.get('verification_id')),
      }
    } catch {
      // Treat an unparseable paste as a code.
    }
  }
  return { code: normalizeUserCode(value) }
}

export function scopeLabel(scope: 'read' | 'write'): string {
  return scope === 'read' ? '读取' : '写入'
}

export function formatStamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function lifetimeText(days: number | null): string {
  if (days === null) return '永不'
  return `${days} 天`
}

/** OAuth always returns to `/`, so the device link is restored from sessionStorage. */
export function isSafeReturn(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('://')) return false
  try {
    const url = new URL(path, 'http://dropit.local')
    if (url.origin !== 'http://dropit.local' || url.username || url.password) return false
    return url.pathname === '/device' || url.pathname === '/settings'
  } catch {
    return false
  }
}

export function rememberReturn(path: string) {
  if (isSafeReturn(path)) sessionStorage.setItem(returnKey, path)
  else sessionStorage.removeItem(returnKey)
}

export function takeReturn(): string | null {
  const value = sessionStorage.getItem(returnKey)
  sessionStorage.removeItem(returnKey)
  return value && isSafeReturn(value) ? value : null
}
