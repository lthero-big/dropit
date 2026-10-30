import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router'
import { PAGE_LOADING_DELAY_MS, PAGE_REVEAL_MS, PageLoading } from './components/page-loading.tsx'
import { SharePage } from './pages/share-page.tsx'

const here = dirname(fileURLToPath(import.meta.url))

// RHEA-190 m51: one shared full-page loading transition, and a centered single-item share page.

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.pageReveal
})

function loader() {
  return document.querySelector('[data-page-loading]') as HTMLElement | null
}

describe('PageLoading', () => {
  it('stays hidden for short loads, then shows the brand mark, a spinner and the label', () => {
    vi.useFakeTimers()
    render(<PageLoading label="正在连接…" />)
    expect(loader()?.dataset.pageLoading).toBe('pending')
    expect(loader()?.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toContain('正在连接…')
    // the brand mark is decoration: screen readers only hear the label
    expect(loader()?.querySelector('[data-logo]')?.parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(loader()?.querySelector('[data-logo]')).toBeTruthy()
    expect(loader()?.querySelector('.dd-spinner')).toBeTruthy()
    act(() => vi.advanceTimersByTime(PAGE_LOADING_DELAY_MS - 1))
    expect(loader()?.dataset.pageLoading).toBe('pending')
    act(() => vi.advanceTimersByTime(1))
    expect(loader()?.dataset.pageLoading).toBe('shown')
  })

  it('never shows when the load finishes inside the delay, and fades in what replaces it', () => {
    vi.useFakeTimers()
    const view = render(<PageLoading label="正在连接…" />)
    act(() => vi.advanceTimersByTime(PAGE_LOADING_DELAY_MS / 2))
    expect(loader()?.dataset.pageLoading).toBe('pending')
    view.rerender(<main>页面</main>)
    expect(loader()).toBeNull()
    expect(document.documentElement.dataset.pageReveal).toBe('')
    act(() => vi.advanceTimersByTime(PAGE_REVEAL_MS))
    expect(document.documentElement.dataset.pageReveal).toBeUndefined()
  })

  it('can show at once with delayMs 0', () => {
    render(<PageLoading label="正在读取…" delayMs={0} />)
    expect(loader()?.dataset.pageLoading).toBe('shown')
  })

  it('turns the spinner and the fades off under prefers-reduced-motion', () => {
    const css = readFileSync(resolve(here, 'index.css'), 'utf8')
    const block = css.slice(css.indexOf('RHEA-190 m51'))
    const reduced = block.slice(block.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.dd-spinner')
    expect(reduced).toContain('animation: none !important')
    expect(reduced).toContain('transition: none !important')
  })

  it('replaces the bare loading text on every full-page loading state', () => {
    for (const page of ['home-page', 'device-page', 'admin-page', 'settings-page', 'share-page', 'invite-page', 'change-password-page']) {
      const source = readFileSync(resolve(here, 'pages', `${page}.tsx`), 'utf8')
      expect(source, page).toContain('<PageLoading label=')
      expect(source, page).not.toMatch(/<main className="px-6 py-16 text-sm text-muted-foreground">/)
    }
  })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderShare(answer: () => Response) {
  const fetchMock = vi.fn(async () => answer())
  vi.stubGlobal('fetch', fetchMock)
  render(
    <MemoryRouter initialEntries={['/s/tok']}>
      <Routes>
        <Route path="/s/:token" element={<SharePage />} />
      </Routes>
    </MemoryRouter>,
  )
  return fetchMock
}

const file = {
  item: { kind: 'file', text: null, filename: 'report.pdf', mime: 'application/pdf', size: 2048, hasThumbnail: false, createdAt: 1, expiresAt: 9 },
  linkExpiresAt: null,
  views: 2,
  maxViews: 5,
  access: 'ticket',
}

describe('share page', () => {
  it('shows the shared loading transition while the link opens', () => {
    renderShare(() => json(file))
    expect(loader()).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('正在打开链接…')
  })

  it('centers one file item: title, name, size and the download button', async () => {
    renderShare(() => json(file))
    const heading = await screen.findByRole('heading', { name: '分享的内容' })
    const section = heading.closest('section') as HTMLElement
    expect(section.dataset.shareState).toBe('ready')
    for (const name of ['flex', 'flex-1', 'flex-col', 'items-center', 'justify-center', 'text-center', 'mx-auto', 'w-full']) expect(section.classList.contains(name), name).toBe(true)
    expect(section.closest('main')?.classList.contains('min-h-svh')).toBe(true)
    const item = section.querySelector('[data-share-item="file"]') as HTMLElement
    expect(item.classList.contains('items-center')).toBe(true)
    expect(item.querySelector('[data-share-icon]')).toBeTruthy()
    expect(item.textContent).toContain('report.pdf')
    expect(item.textContent).toContain('2.0 KB')
    const download = screen.getByRole('link', { name: '下载' })
    expect(item.contains(download)).toBe(true)
    expect(download.getAttribute('href')).toBe('/api/s/tok/file?access=ticket')
    expect(section.textContent).toContain('已查看 2 / 5 次')
    expect(document.querySelectorAll('[data-share-item]')).toHaveLength(1)
  })

  it('centers the invalid / expired state the same way', async () => {
    renderShare(() => json({ error: { code: 'NOT_FOUND' } }, 404))
    const heading = await screen.findByRole('heading', { name: '链接无效' })
    const section = heading.closest('section') as HTMLElement
    expect(section.dataset.shareState).toBe('invalid')
    for (const name of ['items-center', 'justify-center', 'text-center']) expect(section.classList.contains(name), name).toBe(true)
    expect(section.textContent).toContain('已过期')
    expect(screen.getByRole('link', { name: '打开 dropit' }).getAttribute('href')).toBe('/')
  })

  it('tells a server or network failure apart from a dead link and can retry', async () => {
    let fail = true
    const fetchMock = renderShare(() => (fail ? json({ error: { code: 'INTERNAL' } }, 500) : json(file)))
    expect(await screen.findByRole('heading', { name: '暂时打不开' })).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('heading', { name: '分享的内容' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
