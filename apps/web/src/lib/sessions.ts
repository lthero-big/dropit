import type { DeviceKind } from './device.ts'
import type { DeviceSession } from './types.ts'

/** Readable title: the board's device name if the browser reported one, else "macOS · Chrome 131". */
export function sessionTitle(session: DeviceSession): string {
  return session.device?.name || `${session.os} · ${session.browser}`
}

export function sessionKind(session: DeviceSession): DeviceKind {
  if (session.device) return session.device.kind
  if (/iPhone|Android 手机/.test(session.os)) return 'phone'
  if (/iPad|平板/.test(session.os)) return 'pad'
  if (session.os === 'macOS') return 'mac'
  return 'pc'
}
