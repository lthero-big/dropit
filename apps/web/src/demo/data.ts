// Fake data for the RHEA-191 UI demo. Nothing here talks to the server.
import voiceMemo from './media/voice-memo.mp3'
import screenRec from './media/screen-rec.mp4'
import screenRecPoster from './media/screen-rec-poster.jpg'
import { formatSize, hexToRgb, readableOn } from '@/components/clip-visual.tsx'

export { formatSize, hexToRgb, readableOn }

export type DeviceKind = 'mac' | 'phone' | 'pad' | 'pc'
export type Device = { id: string; name: string; kind: DeviceKind; online: boolean }

export type ClipKind = 'link' | 'code' | 'color' | 'text' | 'image' | 'file'

type Base = {
  id: string
  deviceId: string
  createdAt: number
  expiresAt: number
  pinned?: boolean
  /** user-defined group (分组); undefined = 未分组 */
  group?: string
  /** set when the item arrived live so it flies in from its device dot */
  arrived?: boolean
  /** set when the item was pasted/dropped into the composer */
  landed?: boolean
}

export type Clip =
  | (Base & { kind: 'link'; url: string; title: string; site: string })
  | (Base & { kind: 'code'; lang: string; code: string })
  | (Base & { kind: 'color'; value: string; name?: string })
  | (Base & { kind: 'text'; text: string })
  | (Base & { kind: 'image'; name: string; w: number; h: number; tone: string; src: string })
  | (Base & { kind: 'file'; name: string; size: number; /** playable audio / video source */ src?: string; poster?: string })

export const devices: Device[] = [
  { id: 'mbp', name: 'MacBook Pro', kind: 'mac', online: true },
  { id: 'iphone', name: 'iPhone 17', kind: 'phone', online: true },
  { id: 'ipad', name: 'iPad mini', kind: 'pad', online: false },
  { id: 'desk', name: '书房台式机', kind: 'pc', online: true },
]

export const deviceById = (id: string) => devices.find((d) => d.id === id) ?? devices[0]

const MIN = 60_000
const HOUR = 60 * MIN

/** Inline SVG "screenshots" so the demo needs no network images. */
export function fakeShot(tone: string, label: string, variant = 0): string {
  const bars = [0, 1, 2, 3]
    .map((i) => `<rect x="24" y="${70 + i * 26}" width="${180 - ((i + variant) % 3) * 40}" height="10" rx="5" fill="white" fill-opacity="${0.55 - i * 0.08}"/>`)
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tone}"/><stop offset="1" stop-color="${tone}" stop-opacity="0.72"/></linearGradient></defs>
<rect width="320" height="200" fill="url(#g)"/>
<rect x="12" y="12" width="296" height="22" rx="6" fill="white" fill-opacity="0.18"/>
<circle cx="26" cy="23" r="4" fill="white" fill-opacity="0.7"/><circle cx="40" cy="23" r="4" fill="white" fill-opacity="0.5"/><circle cx="54" cy="23" r="4" fill="white" fill-opacity="0.35"/>
${bars}
<rect x="220" y="66" width="76" height="108" rx="8" fill="white" fill-opacity="0.22"/>
<text x="24" y="186" font-family="sans-serif" font-size="11" fill="white" fill-opacity="0.85">${label}</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Groups the board starts with, same as the earlier dropit demo (工作 / 个人). */
export const seedGroups = ['工作', '个人']

export function seedClips(now: number): Clip[] {
  const at = (ago: number, ttl: number) => ({ createdAt: now - ago, expiresAt: now - ago + ttl })
  return [
    {
      id: 'c1', kind: 'link', deviceId: 'iphone', ...at(2 * MIN, 24 * HOUR),
      url: 'https://landing-ideas.pages.dev/playlist/', title: 'Playlist — 一页歌单式的落地页灵感', site: 'landing-ideas.pages.dev', group: '个人',
    },
    {
      id: 'c2', kind: 'code', deviceId: 'mbp', ...at(6 * MIN, 2 * HOUR), lang: 'tsx', pinned: true, group: '工作',
      code: "const clip = await drop(text, {\n  ttl: '2h',\n  to: 'all-devices',\n})",
    },
    { id: 'c3', kind: 'color', deviceId: 'desk', ...at(11 * MIN, 6 * HOUR), value: '#D0021B', name: 'dropit red' },
    { id: 'c4', kind: 'text', deviceId: 'iphone', ...at(15 * MIN, 30 * MIN + 50_000), text: '取件码 7342，丰巢 3 号柜', group: '个人' },
    {
      id: 'c5', kind: 'image', deviceId: 'iphone', ...at(26 * MIN, 12 * HOUR),
      name: 'IMG_2041.PNG', w: 1179, h: 2556, tone: '#4f6d7a', src: fakeShot('#4f6d7a', 'IMG_2041.PNG', 1), group: '个人',
    },
    { id: 'c6', kind: 'file', deviceId: 'mbp', ...at(48 * MIN, 24 * HOUR), name: '季度复盘-v3.pdf', size: 2_840_000, group: '工作' },
    { id: 'c7', kind: 'color', deviceId: 'mbp', ...at(55 * MIN, 59 * MIN + 30_000), value: '#3F7F74', name: 'phone teal' },
    {
      id: 'c8', kind: 'link', deviceId: 'desk', ...at(3 * HOUR, 24 * HOUR),
      url: 'https://github.com/lthero-big/dropit/pulls', title: 'Pull requests · lthero-big/dropit', site: 'github.com', pinned: true, group: '工作',
    },
    { id: 'c9', kind: 'file', deviceId: 'desk', ...at(5 * HOUR, 24 * HOUR), name: 'dropit-backup.tar.zst', size: 184_500_000 },
    { id: 'c10', kind: 'text', deviceId: 'mbp', ...at(26 * HOUR, 72 * HOUR), text: '周五前把暗色模式的边框对比度再降一档', group: '工作' },
    {
      id: 'c11', kind: 'code', deviceId: 'desk', ...at(27 * HOUR, 72 * HOUR), lang: 'bash',
      code: 'pnpm --filter @dropit/web dev\nopen http://localhost:5173/demo/ui', group: '工作',
    },
    { id: 'c12', kind: 'file', deviceId: 'iphone', ...at(28 * HOUR, 28 * HOUR + 75_000), name: '语音备忘录 0412.m4a', size: 3_120_000, src: voiceMemo, group: '个人' },
    {
      id: 'c13', kind: 'file', deviceId: 'iphone', ...at(40 * MIN, 24 * HOUR),
      name: '屏幕录制 10-26.mp4', size: 18_600_000, src: screenRec, poster: screenRecPoster, group: '工作',
    },
  ]
}

let seq = 100
const incoming: Array<(now: number) => Clip> = [
  (now) => ({ id: `n${seq++}`, kind: 'text', deviceId: 'iphone', createdAt: now, expiresAt: now + 2 * HOUR, text: '晚上 8 点，老地方见', group: '个人' }),
  (now) => ({ id: `n${seq++}`, kind: 'link', deviceId: 'desk', createdAt: now, expiresAt: now + 24 * HOUR, url: 'https://motion.dev/docs/react-layout-animations', title: 'Layout animations · Motion', site: 'motion.dev', group: '工作' }),
  (now) => ({ id: `n${seq++}`, kind: 'color', deviceId: 'mbp', createdAt: now, expiresAt: now + 6 * HOUR, value: '#A86B2D', name: 'pad amber' }),
  (now) => ({ id: `n${seq++}`, kind: 'code', deviceId: 'mbp', createdAt: now, expiresAt: now + 2 * HOUR, lang: 'json', code: '{\n  "ttl": "15m",\n  "burn": true\n}', group: '工作' }),
  (now) => ({ id: `n${seq++}`, kind: 'file', deviceId: 'desk', createdAt: now, expiresAt: now + 24 * HOUR, name: 'design-tokens.fig', size: 12_400_000, group: '工作' }),
]
let turn = 0
export function nextIncoming(now: number): Clip {
  const make = incoming[turn % incoming.length]
  turn += 1
  return { ...make(now), arrived: true }
}

export function pastedShot(now: number, src?: string): Clip {
  const tones = ['#5b5f97', '#7a4f6d', '#2f6f6a', '#8a5a2b']
  const tone = tones[seq % tones.length]
  return {
    id: `p${seq++}`, kind: 'image', deviceId: 'mbp', createdAt: now, expiresAt: now + 12 * HOUR,
    name: `截图 ${new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}.png`,
    w: 2880, h: 1800, tone, src: src ?? fakeShot(tone, 'Screenshot', seq), landed: true,
  }
}

export function droppedFile(now: number, name: string, size: number, src?: string): Clip {
  return { id: `f${seq++}`, kind: 'file', deviceId: 'mbp', createdAt: now, expiresAt: now + 24 * HOUR, name, size, src, landed: true }
}

export function textClip(now: number, text: string): Clip {
  const trimmed = text.trim()
  if (/^https?:\/\/\S+$/.test(trimmed)) {
    const host = new URL(trimmed).host
    return { id: `t${seq++}`, kind: 'link', deviceId: 'mbp', createdAt: now, expiresAt: now + 24 * HOUR, url: trimmed, title: host, site: host, landed: true }
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return { id: `t${seq++}`, kind: 'color', deviceId: 'mbp', createdAt: now, expiresAt: now + 6 * HOUR, value: trimmed.toUpperCase(), landed: true }
  }
  if (trimmed.includes('\n') || /[{};=]|=>/.test(trimmed)) {
    return { id: `t${seq++}`, kind: 'code', deviceId: 'mbp', createdAt: now, expiresAt: now + 2 * HOUR, lang: 'txt', code: trimmed, landed: true }
  }
  return { id: `t${seq++}`, kind: 'text', deviceId: 'mbp', createdAt: now, expiresAt: now + 2 * HOUR, text: trimmed, landed: true }
}

export function clipCopyText(c: Clip): string {
  switch (c.kind) {
    case 'link': return c.url
    case 'code': return c.code
    case 'color': return c.value
    case 'text': return c.text
    case 'image': return c.name
    case 'file': return c.name
  }
}


export function formatLeft(ms: number): string {
  if (ms <= 0) return '已过期'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${String(sec).padStart(2, '0')} 秒`
  return `${sec} 秒`
}

export function formatAgo(ms: number): string {
  const m = Math.floor(ms / MIN)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

export { dayLabel } from '@/lib/day-label.ts'

/** WCAG relative luminance, used to pick text on color swatches. */

