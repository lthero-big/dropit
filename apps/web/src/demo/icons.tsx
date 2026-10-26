import { LaptopIcon, MonitorIcon, SmartphoneIcon, TabletIcon } from 'lucide-react'
import type { DeviceKind } from './data.ts'

export function DeviceGlyph({ kind, className }: { kind: DeviceKind; className?: string }) {
  const Icon = { mac: LaptopIcon, phone: SmartphoneIcon, pad: TabletIcon, pc: MonitorIcon }[kind]
  return <Icon className={className} aria-hidden />
}
