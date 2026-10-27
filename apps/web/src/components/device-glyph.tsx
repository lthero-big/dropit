import { LaptopIcon, MonitorIcon, SmartphoneIcon, TabletIcon, TerminalIcon } from 'lucide-react'
import type { DeviceKind } from '@/lib/device.ts'

export function DeviceGlyph({ kind, className }: { kind: DeviceKind; className?: string }) {
  const Icon = { mac: LaptopIcon, phone: SmartphoneIcon, pad: TabletIcon, pc: MonitorIcon, cli: TerminalIcon }[kind] ?? MonitorIcon
  return <Icon className={className} aria-hidden />
}
