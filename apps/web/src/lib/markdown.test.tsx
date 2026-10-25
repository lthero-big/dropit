import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown.tsx'

afterEach(() => {
  cleanup()
})

function expectAutolink(link: HTMLElement, href: string) {
  expect(link.getAttribute('href')).toBe(href)
  expect(link.textContent).toBe(href)
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow')
  expect(link.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(link.tabIndex).toBe(0)
  expect(link.className).toContain('text-primary')
  expect(link.className).toContain('underline')
  expect(link.className).toContain('[overflow-wrap:anywhere]')
  expect(link.className).not.toMatch(/#[0-9a-f]{3,8}/i)
}

function plainText(container: HTMLElement = document.body) {
  const node = container.querySelector('p')
  if (!node) throw new Error('missing plain text')
  return node
}

describe('plain-text autolinks', () => {
  it('links http and https without changing the copied text', () => {
    const source = 'see https://example.com/a and HTTP://Example.ORG/B'
    render(<MarkdownText text={source} />)
    const [first, second] = screen.getAllByRole('link')
    expectAutolink(first, 'https://example.com/a')
    expectAutolink(second, 'HTTP://Example.ORG/B')
    expect(plainText().textContent).toBe(source)
    expect(plainText().className).toContain('whitespace-pre-wrap')
    expect(plainText().className).toContain('[overflow-wrap:anywhere]')
    first.focus()
    expect(document.activeElement).toBe(first)
  })

  it('keeps trailing punctuation and balanced parentheses outside the trap', () => {
    const cases: Array<[string, string[]]> = [
      ['go https://example.com.', ['https://example.com']],
      ['go https://example.com, next', ['https://example.com']],
      ['(https://example.com)', ['https://example.com']],
      ['[https://example.com]', ['https://example.com']],
      ['wow https://example.com!', ['https://example.com']],
      ['ask https://example.com?', ['https://example.com']],
      ['end https://example.com;', ['https://example.com']],
      ["see 'https://example.com'", ['https://example.com']],
      ['https://example.com).', ['https://example.com']],
      ['https://example.com/a_(b).', ['https://example.com/a_(b)']],
      ['https://example.com/a_(b))', ['https://example.com/a_(b)']],
      ['https://en.wikipedia.org/wiki/Rust_(programming_language)', ['https://en.wikipedia.org/wiki/Rust_(programming_language)']],
      ['https://example.com/index.html', ['https://example.com/index.html']],
      ['https://example.com/a?b=1&c=2#frag', ['https://example.com/a?b=1&c=2#frag']],
      ['https://example.com?q=1', ['https://example.com?q=1']],
      ['https://example.com:8080/x', ['https://example.com:8080/x']],
      ['http://127.0.0.1:8080/health', ['http://127.0.0.1:8080/health']],
      ['http://[::1]:8080/a', ['http://[::1]:8080/a']],
      ['http://[::1]', ['http://[::1]']],
      ['看https://example.com/path这个', ['https://example.com/path']],
      ['https://example.com。下一句', ['https://example.com']],
      ['https://example.com，还有', ['https://example.com']],
      ['哇https://example.com！', ['https://example.com']],
      ['https://example.com/a,b', ['https://example.com/a,b']],
    ]
    for (const [source, hrefs] of cases) {
      const view = render(<MarkdownText text={source} />)
      const found = screen.queryAllByRole('link')
      expect(found.map((link) => link.getAttribute('href')), source).toEqual(hrefs)
      for (const link of found) expectAutolink(link, link.textContent ?? '')
      expect(plainText().textContent, source).toBe(source)
      view.unmount()
    }
  })

  it('keeps several links, newlines, and a long url inside the line', () => {
    const long = `https://example.com/${'a'.repeat(1800)}`
    const source = `one https://one.example/x\ntwo ${long}。`
    render(<MarkdownText text={source} />)
    const [first, second] = screen.getAllByRole('link')
    expectAutolink(first, 'https://one.example/x')
    expectAutolink(second, long)
    expect(plainText().textContent).toBe(source)
    expect(plainText().className).toContain('[overflow-wrap:anywhere]')
  })

  it('does not link incomplete urls or non-http schemes and their disguises', () => {
    const plain = [
      'http://',
      'https://',
      'http://.',
      'http://...',
      'http:/example.com',
      'https:example.com',
      'www.example.com',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java script:alert(1)',
      'javascript :alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'javascript\t:alert(1)',
      ' javascript:alert(1)',
      '&#106;avascript:alert(1)',
      '&#x6A;avascript:alert(1)',
      '%6Aavascript:alert(1)',
      'javascript&#58;alert(1)',
      'javascript&colon;alert(1)',
      'vbscript:msgbox(1)',
      'VBSCRIPT:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'DATA:text/html,hi',
      'file:///etc/passwd',
      'FILE:///C:/Windows/win.ini',
      'https://user:pass@evil.com/phish',
      'https://paypal.com@evil.com/',
      'https://example.com%2e%2e@evil.com',
      'http://0x7f000001',
      'http://2130706433/',
      'http://%31',
    ]
    for (const source of plain) {
      const view = render(<MarkdownText text={source} />)
      expect(screen.queryByRole('link'), source).toBeNull()
      expect(plainText().textContent, source).toBe(source)
      expect(document.querySelector('script'), source).toBeNull()
      expect(document.querySelector('img'), source).toBeNull()
      expect(view.container.innerHTML, source).not.toContain('href="javascript:')
      expect(view.container.innerHTML, source).not.toContain('href="data:')
      expect(view.container.innerHTML, source).not.toContain('href="vbscript:')
      expect(view.container.innerHTML, source).not.toContain('href="file:')
      view.unmount()
    }
  })

  it('shows html and script payloads as text', () => {
    const source = '<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:alert(1)">https://good.example</a>'
    const view = render(<MarkdownText text={source} />)
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect(view.container.querySelectorAll('a')).toHaveLength(1)
    expectAutolink(screen.getByRole('link'), 'https://good.example')
    expect(plainText().textContent).toBe(source)
    expect(view.container.innerHTML).not.toContain('<script')
    expect(view.container.innerHTML).not.toContain('<img')
    expect(view.container.innerHTML).not.toContain('dangerouslySetInnerHTML')
  })
})

describe('markdown autolinks', () => {
  const source = [
    '## 见 https://example.com/head.',
    '',
    '裸链 https://example.com/bare.',
    '',
    '[手册](https://example.com/run)',
    '',
    '[坏](javascript:alert(1))',
    '',
    '`https://example.com/code`',
    '',
    '```',
    'https://example.com/fence',
    '```',
    '',
    '**粗体 https://example.com/bold**',
    '',
    '> 引用 https://example.com/quote',
    '',
    '- 列表 https://example.com/item',
  ].join('\n')

  it('links bare urls in rendered markdown and keeps labeled links', () => {
    render(<MarkdownText text={source} />)
    expect(plainText().textContent).toBe(source)
    expectAutolink(screen.getByRole('link', { name: 'https://example.com/fence' }), 'https://example.com/fence')
    fireEvent.click(screen.getByRole('button', { name: '渲染' }))
    expect(screen.getByRole('heading', { name: /见 https:\/\/example\.com\/head/ })).toBeTruthy()
    expectAutolink(screen.getByRole('link', { name: 'https://example.com/head' }), 'https://example.com/head')
    expectAutolink(screen.getByRole('link', { name: 'https://example.com/bare' }), 'https://example.com/bare')
    expectAutolink(screen.getByRole('link', { name: 'https://example.com/bold' }), 'https://example.com/bold')
    expectAutolink(screen.getByRole('link', { name: 'https://example.com/quote' }), 'https://example.com/quote')
    expectAutolink(screen.getByRole('link', { name: 'https://example.com/item' }), 'https://example.com/item')
    const manual = screen.getByRole('link', { name: '手册' })
    expect(manual.getAttribute('href')).toBe('https://example.com/run')
    expect(manual.textContent).toBe('手册')
    expect(manual.getAttribute('target')).toBe('_blank')
    expect(manual.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(manual.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(screen.queryByRole('link', { name: '坏' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'https://example.com/code' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'https://example.com/fence' })).toBeNull()
    expect(document.querySelector('code')?.textContent).toContain('https://example.com/code')
    expect(document.querySelector('pre')?.textContent).toContain('https://example.com/fence')
    expect(document.querySelector('script')).toBeNull()
    expect(document.body.textContent).toContain('javascript:alert(1)')
  })
})
