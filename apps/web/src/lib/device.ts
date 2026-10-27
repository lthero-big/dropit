// RHEA-190 step 5: device identity, like the demo's named devices. Each browser
// keeps a random id plus a readable name ("Mac · Chrome") in localStorage and
// sends it with new items and on the live channel, so the board can label who
// sent what and show named presence dots. Nothing here is secret.
export type DeviceKind = 'mac' | 'phone' | 'pad' | 'pc' | 'cli'
export type DeviceInfo = { id: string; name: string; kind: DeviceKind }

const KEY = 'dropit-device'
const KINDS: DeviceKind[] = ['mac', 'phone', 'pad', 'pc', 'cli']

function browserName(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge'
  if (/(OPR|Opera)\//.test(ua)) return 'Opera'
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox'
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return ''
}

/** Best-effort kind + readable name from the user agent. */
export function detectDevice(ua: string, touchPoints = 0): { kind: DeviceKind; name: string } {
  const browser = browserName(ua)
  const withBrowser = (os: string) => (browser ? `${os} · ${browser}` : os)
  if (/iPhone|iPod/.test(ua)) return { kind: 'phone', name: withBrowser('iPhone') }
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return { kind: 'pad', name: withBrowser('iPad') }
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? { kind: 'phone', name: withBrowser('Android 手机') } : { kind: 'pad', name: withBrowser('Android 平板') }
  if (/Macintosh|Mac OS X/.test(ua)) return { kind: 'mac', name: withBrowser('Mac') }
  if (/Windows/.test(ua)) return { kind: 'pc', name: withBrowser('Windows') }
  if (/CrOS/.test(ua)) return { kind: 'pc', name: withBrowser('Chromebook') }
  if (/Linux/.test(ua)) return { kind: 'pc', name: withBrowser('Linux') }
  return { kind: 'pc', name: browser || '浏览器' }
}

function randomId(): string {
  try {
    return `web-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  } catch {
    return `web-${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`
  }
}

export function cleanDeviceName(value: string): string {
  return [...value.replace(/\s+/g, ' ').trim()].slice(0, 40).join('')
}

let cached: DeviceInfo | null = null

function read(): DeviceInfo | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<DeviceInfo> | null
    if (parsed && typeof parsed.id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(parsed.id) && typeof parsed.name === 'string' && KINDS.includes(parsed.kind as DeviceKind)) {
      return { id: parsed.id, name: cleanDeviceName(parsed.name) || '浏览器', kind: parsed.kind as DeviceKind }
    }
  } catch {
    // fall through to a fresh identity
  }
  return null
}

function save(device: DeviceInfo) {
  try {
    localStorage.setItem(KEY, JSON.stringify(device))
  } catch {
    // private mode: identity lives for this tab only
  }
}

/** This browser's device identity (created on first use). */
export function localDevice(): DeviceInfo {
  if (cached) return cached
  const stored = read()
  if (stored) return (cached = stored)
  const nav = typeof navigator === 'undefined' ? null : navigator
  const detected = detectDevice(nav?.userAgent ?? '', nav?.maxTouchPoints ?? 0)
  cached = { id: randomId(), ...detected }
  save(cached)
  return cached
}

/** test hook */
export function resetLocalDevice() {
  cached = null
}

let uploadGroup: string | null = null
/** The composer's target group; file uploads pick it up as a header. */
export function setUploadGroup(group: string | null) {
  uploadGroup = group || null
}

/** Headers for requests that create an item (text, file, chunked complete). */
export function itemHeaders(): Record<string, string> {
  const device = localDevice()
  const headers: Record<string, string> = {
    'X-Dropit-Device': device.id,
    'X-Dropit-Device-Name': encodeURIComponent(device.name),
    'X-Dropit-Device-Kind': device.kind,
  }
  if (uploadGroup) headers['X-Dropit-Group'] = encodeURIComponent(uploadGroup)
  return headers
}

/** Query string for the live channel so presence can name this device. */
export function deviceQuery(): URLSearchParams {
  const device = localDevice()
  return new URLSearchParams({ device: device.id, name: device.name, kind: device.kind })
}

/** id of the Shell header slot the board fills with its presence pill */
export const PRESENCE_SLOT = 'dropit-presence-slot'

/** Paper device tint; the CLI borrows the desktop tint. */
export const deviceColor = (kind: DeviceKind) => `var(--dev-${kind === 'cli' ? 'pc' : kind})`
