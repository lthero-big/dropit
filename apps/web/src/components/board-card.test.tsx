import { describe, expect, it } from 'vitest'
import { itemVisual } from '@/components/board-card.tsx'
import { dayLabel } from '@/lib/day-label.ts'
import type { Item } from '@/lib/types.ts'

function item(patch: Partial<Item>): Item {
  return {
    id: 'a',
    spaceId: 's1',
    userId: 'u1',
    kind: 'text',
    text: 'hello',
    filename: null,
    mime: null,
    size: 5,
    hasThumbnail: false,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 10,
    pinned: false,
    tags: [],
    ...patch,
  }
}

describe('itemVisual', () => {
  it('maps text items onto the shared card kinds', () => {
    expect(itemVisual(item({ text: 'https://www.example.com/docs?q=1' }), '/b')).toMatchObject({ kind: 'link', site: 'example.com', title: 'example.com/docs?q=1', href: 'https://www.example.com/docs?q=1' })
    expect(itemVisual(item({ text: '#3366ff' }), '/b')).toMatchObject({ kind: 'color', value: '#3366ff' })
    expect(itemVisual(item({ text: '```ts\nconst a = 1\n```' }), '/b')).toMatchObject({ kind: 'code', lang: 'ts', code: 'const a = 1' })
    expect(itemVisual(item({ text: 'plain words' }), '/b')).toMatchObject({ kind: 'text', text: 'plain words' })
  })

  it('maps files onto image, media and plain file bodies with real URLs', () => {
    expect(itemVisual(item({ kind: 'file', text: null, filename: 'shot.png', mime: 'image/png', hasThumbnail: true, size: 2048 }), '/api/spaces/s1')).toMatchObject({ kind: 'image', name: 'shot.png', src: '/api/spaces/s1/items/a/thumbnail', meta: '2.0 KB' })
    expect(itemVisual(item({ kind: 'file', text: null, filename: 'song.mp3', mime: 'audio/mpeg' }), '/api/spaces/s1')).toMatchObject({ kind: 'file', media: 'audio', src: '/api/spaces/s1/items/a/media' })
    expect(itemVisual(item({ kind: 'file', text: null, filename: 'setup.exe', mime: 'application/octet-stream' }), '/api/spaces/s1')).toMatchObject({ kind: 'file', media: null, src: undefined })
  })
})

describe('dayLabel', () => {
  it('names today, yesterday, then the date', () => {
    const now = new Date(2026, 9, 27, 12).getTime()
    expect(dayLabel(now - 60_000, now)).toBe('今天')
    expect(dayLabel(new Date(2026, 9, 26, 9).getTime(), now)).toBe('昨天')
    expect(dayLabel(new Date(2026, 9, 20, 9).getTime(), now)).toBe('10 月 20 日')
  })
})
