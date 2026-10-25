import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipboardBoard } from './clipboard-board.tsx'
import { Shell } from './shell.tsx'
import { ThemeProvider } from './theme-provider.tsx'
import { SessionProvider } from '@/lib/session.tsx'
import type { Item, Me } from '@/lib/types.ts'

class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readyState = 0
  constructor(_url: string | URL) {
    FakeSocket.instances.push(this)
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  send() {}
  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const me: Me = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Lthero', role: 'admin', disabled: 0, pending: 0, createdAt: 1 },
  usedBytes: 900,
  quotaBytes: 1000,
  maxFileBytes: 100,
  maxTextBytes: 1000,
  retentionMs: 1000,
}

function item(patch: Partial<Item> = {}): Item {
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
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000,
    pinned: false,
    tags: [],
    ...patch,
  }
}

function renderShell() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/me') return Response.json(me)
      return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
    }),
  )
  return render(
    <ThemeProvider>
      <SessionProvider>
        <MemoryRouter>
          <Shell>
            <p>内容</p>
          </Shell>
        </MemoryRouter>
      </SessionProvider>
    </ThemeProvider>,
  )
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

beforeEach(() => {
  localStorage.clear()
})

describe('account menu', () => {
  it('keeps one avatar trigger and moves quota, settings, admin, and logout into the menu', async () => {
    renderShell()
    expect(await screen.findByRole('button', { name: '账户菜单' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Lthero' })).toBeNull()
    expect(screen.queryByRole('link', { name: '设置' })).toBeNull()
    expect(screen.queryByRole('link', { name: '管理' })).toBeNull()
    const account = screen.getByRole('button', { name: '账户菜单' })
    fireEvent.pointerDown(account, { button: 0, pointerType: 'mouse' })
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '配额' }).getAttribute('data-quota-tone')).toBe('warn')
    expect(screen.getByRole('menuitem', { name: '设置' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '管理' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '退出' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '设置' })).toBeNull())
  })

  it('opens a bottom drawer on a phone width and closes on Escape', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 767px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: '账户菜单' }))
    expect(await screen.findByRole('dialog', { name: '账户' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '退出' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '账户' })).toBeNull())
  })

  it('toggles theme from the header icon', async () => {
    renderShell()
    const toggle = await screen.findByRole('button', { name: '切换主题' })
    fireEvent.click(toggle)
    expect(document.documentElement.classList.contains('light') || document.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('clipboard layout', () => {
  it('uses a grid, drops the old table header, and stores the list choice', async () => {
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    render(
      <ClipboardBoard
        base="/api/spaces/s1"
        title="私人空间"
        quotaBytes={1000}
        usedBytes={20}
        maxFileBytes={100}
        maxTextBytes={1000}
        sender={() => '我'}
        canEdit={() => true}
        canRetract={() => true}
        canShare={() => true}
      />,
    )
    expect(screen.queryByText('类型')).toBeNull()
    expect(screen.queryByText('内容')).toBeNull()
    expect(screen.queryByRole('heading', { name: '配额' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '在线' })).toBeNull()
    FakeSocket.instances.at(-1)?.emit({
      type: 'snapshot',
      items: [
        item({ id: 'note', text: 'one\ntwo\nthree\nfour\nfive\nsix\nseven' }),
        item({ id: 'file', kind: 'file', text: null, filename: 'setup.exe', mime: 'application/octet-stream', size: 64 }),
        item({ id: 'pic', kind: 'file', text: null, filename: 'shot.png', mime: 'image/png', hasThumbnail: true, size: 80 }),
      ],
      serverTime: Date.now(),
      expiresAt: null,
    })
    expect(await screen.findByText('setup.exe')).toBeTruthy()
    expect(screen.getByRole('list').getAttribute('data-layout')).toBe('grid')
    expect(screen.getByRole('status', { name: '0 台设备在线' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '展开' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '列表' }))
    expect(localStorage.getItem('dropit-layout')).toBe('list')
    expect(screen.getByRole('list').getAttribute('data-layout')).toBe('list')
    FakeSocket.instances.at(-1)?.emit({ type: 'presence', devices: 3 })
    expect(await screen.findByRole('status', { name: '3 台设备在线' })).toBeTruthy()
  })
})
