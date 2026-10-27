import { describe, expect, it } from 'vitest'
import { AGING_WINDOW, clipKind, codeSource, lifeOpacity, looksLikeCode, parseColor, parseLink } from '@/lib/clip-kind.ts'

const text = (value: string) => ({ kind: 'text' as const, text: value, mime: null, filename: null, hasThumbnail: false })
const file = (filename: string, mime: string | null, hasThumbnail = false) => ({ kind: 'file' as const, text: null, mime, filename, hasThumbnail })

describe('clipKind', () => {
  it('recognises a lone http(s) URL as a link, but not prose containing one', () => {
    expect(clipKind(text('  https://github.com/lthero-big/dropit/pull/35 '))).toBe('link')
    expect(parseLink('https://a.dev/x')?.hostname).toBe('a.dev')
    expect(clipKind(text('看这个 https://a.dev'))).toBe('text')
    expect(clipKind(text('javascript:alert(1)'))).toBe('text')
    expect(clipKind(text('ftp://a.dev/x'))).toBe('text')
  })

  it('recognises hex and functional colours', () => {
    expect(parseColor('#d0021b')).toBe('#d0021b')
    expect(clipKind(text('#fff'))).toBe('color')
    expect(clipKind(text('oklch(0.62 0.2 25)'))).toBe('color')
    expect(clipKind(text('#notacolor'))).toBe('text')
    expect(clipKind(text('#123 号会议室'))).toBe('text')
  })

  it('treats fenced or code-shaped snippets as code and markdown prose as text', () => {
    expect(clipKind(text('```ts\nconst a = 1\n```'))).toBe('code')
    expect(looksLikeCode('function add(a, b) {\n  return a + b\n}')).toBe(true)
    expect(looksLikeCode('import x from "y"\nexport const z = () => x;')).toBe(true)
    expect(clipKind(text('# 标题\n- 第一条 {x}\n- 第二条;'))).toBe('text')
    expect(clipKind(text('明天十点开会\n记得带电脑'))).toBe('text')
    expect(clipKind(text('a = 1'))).toBe('text')
  })

  it('maps files by thumbnail and media type', () => {
    expect(clipKind(file('shot.png', 'image/png', true))).toBe('image')
    expect(clipKind(file('clip.mp4', 'video/mp4'))).toBe('video')
    expect(clipKind(file('memo.mp3', null))).toBe('audio')
    expect(clipKind(file('report.pdf', 'application/pdf'))).toBe('file')
  })

  it('strips one surrounding fence for display', () => {
    expect(codeSource('```py\nprint(1)\n```')).toEqual({ lang: 'py', body: 'print(1)' })
    expect(codeSource('x = 1')).toEqual({ lang: '', body: 'x = 1' })
  })
})

describe('lifeOpacity', () => {
  it('stays opaque until the aging window, then fades to a legible floor', () => {
    expect(lifeOpacity(AGING_WINDOW * 3)).toBe(1)
    expect(lifeOpacity(AGING_WINDOW)).toBe(1)
    expect(lifeOpacity(AGING_WINDOW / 2)).toBe(0.75)
    expect(lifeOpacity(0)).toBe(0.5)
    expect(lifeOpacity(-1000)).toBe(0.5)
  })
})
