import { describe, expect, it } from 'vitest'
import { onlineDeviceCount, presenceDots } from './board-hooks.ts'
import type { Item, ItemDevice } from './types.ts'

// RHEA-190 m12: 「在线设备 · 4」 with only one online row. The pill used the raw socket
// count (tabs, CLI) while the list is deduped by device and also shows offline senders.
const win: ItemDevice = { id: 'win-chrome-1', name: 'Windows · Chrome', kind: 'pc' }
const phone: ItemDevice = { id: 'android-1', name: 'Android 手机 · Chrome', kind: 'phone' }
const sent = (device: ItemDevice, createdAt: number) => ({ id: `i-${createdAt}`, createdAt, device }) as unknown as Item

describe('presence count (RHEA-190 m12)', () => {
  it('counts unique online devices, not sockets, and never counts offline rows', () => {
    // three tabs of the same Windows Chrome = 3 sockets, one named peer; phone only sent earlier
    const dots = presenceDots(3, [win, win, win], [sent(phone, 2)], win.id)
    expect(dots.map((dot) => [dot.name, dot.online])).toEqual([[win.name, true], [phone.name, false]])
    expect(onlineDeviceCount(3, [win], dots)).toBe(1)
  })

  it('folds unnamed CLI / API connections into one 其他客户端 row that is counted', () => {
    const dots = presenceDots(4, [win], [sent(phone, 2)], win.id, 2)
    expect(dots.filter((dot) => dot.online).map((dot) => dot.name)).toEqual([win.name, '其他客户端（CLI / API，2 个连接）'])
    expect(onlineDeviceCount(4, [win], dots)).toBe(2)
  })

  it('falls back to the raw count for servers that do not name peers', () => {
    const dots = presenceDots(2, null, [], 'x')
    expect(onlineDeviceCount(2, null, dots)).toBe(2)
  })
})
