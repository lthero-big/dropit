// RHEA-190 step 5: demo-style groups, device identity and pin chips on the real board.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipboardBoard } from './clipboard-board.tsx'
import { detectDevice, deviceQuery, itemHeaders, localDevice, resetLocalDevice, setUploadGroup } from '@/lib/device.ts'
import type { Item } from '@/lib/types.ts'

class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readyState = 0
  url: string
  constructor(url: string | URL) {
    this.url = String(url)
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

type Call = { url: string; init?: RequestInit }
let calls: Call[] = []

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderBoard(respond: (url: string, init?: RequestInit) => Response = () => json({ error: { code: 'NOT_FOUND' } }, 404)) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return respond(url, init)
    }),
  )
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
  return FakeSocket.instances.at(-1)
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  localStorage.clear()
  resetLocalDevice()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setUploadGroup(null)
})

describe('device identity', () => {
  it('names common devices from the user agent', () => {
    expect(detectDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toEqual({ kind: 'mac', name: 'Mac · Chrome' })
    expect(detectDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toEqual({ kind: 'phone', name: 'iPhone · Safari' })
    expect(detectDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5)).toEqual({ kind: 'pad', name: 'iPad · Safari' })
    expect(detectDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36')).toEqual({ kind: 'phone', name: 'Android 手机 · Chrome' })
    expect(detectDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toEqual({ kind: 'pc', name: 'Windows · Edge' })
  })

  it('keeps one stable id per browser and sends it with new items and the live channel', () => {
    const first = localDevice()
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{6,64}$/)
    resetLocalDevice()
    expect(localDevice()).toEqual(first)
    const headers = itemHeaders()
    expect(headers['X-Dropit-Device']).toBe(first.id)
    expect(decodeURIComponent(headers['X-Dropit-Device-Name'] ?? '')).toBe(first.name)
    expect(headers['X-Dropit-Device-Kind']).toBe(first.kind)
    expect(headers['X-Dropit-Group']).toBeUndefined()
    setUploadGroup('工作')
    expect(itemHeaders()['X-Dropit-Group']).toBe(encodeURIComponent('工作'))
    expect(deviceQuery().get('device')).toBe(first.id)
    const socket = renderBoard()
    expect(socket?.url).toContain('/api/spaces/s1/ws?')
    expect(new URL(socket?.url ?? '').searchParams.get('device')).toBe(first.id)
  })
})

describe('groups on the board', () => {
  it('filters by group chips, sends into the target group and creates groups', async () => {
    const socket = renderBoard((url, init) => {
      if (url === '/api/spaces/s1/items/text' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { text: string; group?: string }
        return json({ item: item({ id: 'sent', text: body.text, group: body.group ?? null }) }, 201)
      }
      if (url === '/api/spaces/s1/groups' && init?.method === 'POST') return json({ groups: ['工作', '个人', '旅行'] }, 201)
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    socket?.emit({
      type: 'snapshot',
      items: [item({ id: 'w', text: 'work note', group: '工作' }), item({ id: 'p', text: 'home note', group: '个人' }), item({ id: 'n', text: 'loose note' })],
      groups: ['工作', '个人'],
      serverTime: Date.now(),
      expiresAt: null,
    })
    expect(await screen.findByText('work note')).toBeTruthy()
    const bar = screen.getByRole('toolbar', { name: '分组' })
    expect(within(bar).getByRole('button', { name: /全部/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(bar).getByRole('button', { name: /^工作/ }))
    expect(screen.getByText('work note')).toBeTruthy()
    expect(screen.queryByText('home note')).toBeNull()
    expect(screen.queryByText('loose note')).toBeNull()
    expect(screen.getByText('1 条')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '发送到分组' }))
    fireEvent.click(within(screen.getByRole('listbox', { name: '发送到分组' })).getByRole('option', { name: '工作' }))
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(screen.getByRole('button', { name: '发送到分组' }).getAttribute('data-group-target')).toBe('工作')
    fireEvent.change(screen.getByLabelText('要发送的文本'), { target: { value: 'for work' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/spaces/s1/items/text')).toBe(true))
    const post = calls.find((call) => call.url === '/api/spaces/s1/items/text')
    expect(post?.init?.body).toBe(JSON.stringify({ text: 'for work', group: '工作' }))
    const sent = new Headers(post?.init?.headers)
    expect(sent.get('X-Dropit-Device')).toBe(localDevice().id)
    expect(sent.get('X-Dropit-Device-Kind')).toBe(localDevice().kind)
    expect(sent.get('X-Dropit-Group')).toBeNull()

    fireEvent.click(within(bar).getByRole('button', { name: '新建分组' }))
    const input = screen.getByLabelText('分组名')
    fireEvent.change(input, { target: { value: '旅行' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(calls.some((call) => call.url === '/api/spaces/s1/groups' && call.init?.method === 'POST')).toBe(true))
    const create = calls.find((call) => call.url === '/api/spaces/s1/groups' && call.init?.method === 'POST')
    expect(create?.init?.body).toBe(JSON.stringify({ name: '旅行' }))
    expect(await within(screen.getByRole('toolbar', { name: '分组' })).findByRole('button', { name: /^旅行/ })).toBeTruthy()

    socket?.emit({ type: 'groups', groups: ['工作'] })
    await waitFor(() => expect(within(screen.getByRole('toolbar', { name: '分组' })).queryByRole('button', { name: /^个人/ })).toBeNull())
  })

  it('moves a clip with the card group badge and shows the 按分组 view', async () => {
    const socket = renderBoard((url, init) => {
      if (url === '/api/spaces/s1/items/n/labels' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { group?: string | null }
        return json({ item: item({ id: 'n', text: 'loose note', group: body.group ?? null }) })
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404)
    })
    socket?.emit({
      type: 'snapshot',
      items: [item({ id: 'w', text: 'work note', group: '工作' }), item({ id: 'n', text: 'loose note' })],
      groups: ['工作'],
      serverTime: Date.now(),
      expiresAt: null,
    })
    const loose = (await screen.findByText('loose note')).closest('li')
    if (!loose) throw new Error('missing clip')
    fireEvent.click(within(loose).getByRole('button', { name: '加入分组' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^工作/ }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/spaces/s1/items/n/labels')).toBe(true))
    expect(calls.find((call) => call.url === '/api/spaces/s1/items/n/labels')?.init?.body).toBe(JSON.stringify({ group: '工作' }))

    fireEvent.click(screen.getByRole('button', { name: '按分组' }))
    expect(localStorage.getItem('dropit-layout')).toBe('group')
    await waitFor(() => {
      const section = document.querySelector('[data-group-section="工作"]')
      if (!(section instanceof HTMLElement)) throw new Error('missing section')
      expect(within(section).getByText('loose note')).toBeTruthy()
      expect(within(section).getByText('work note')).toBeTruthy()
    })
  })
})

describe('named presence and pin chips', () => {
  it('shows a named dot per online device, device labels on cards, and pinned chips', async () => {
    const self = localDevice()
    const socket = renderBoard()
    socket?.emit({
      type: 'snapshot',
      items: [
        item({ id: 'm', text: 'from phone', device: { id: 'phone-123456', name: 'iPhone · Safari', kind: 'phone' } }),
        item({ id: 'o', text: 'from old pc', device: { id: 'pc-old-1234', name: '旧电脑', kind: 'pc' } }),
        item({ id: 'pin', text: 'pinned text', pinned: true }),
      ],
      serverTime: Date.now(),
      expiresAt: null,
    })
    expect(await screen.findByText('from phone')).toBeTruthy()
    socket?.emit({
      type: 'presence',
      devices: 2,
      peers: [
        { id: 'phone-123456', name: 'iPhone · Safari', kind: 'phone' },
        { id: self.id, name: self.name, kind: self.kind },
      ],
    })
    const status = await screen.findByRole('status', { name: '2 台设备在线' })
    const dots = [...status.querySelectorAll('[data-device-dot]')]
    // self first, then the other online peer, then the offline sender
    expect(dots.map((dot) => dot.getAttribute('title'))).toEqual([`${self.name}（本设备） · 在线`, 'iPhone · Safari · 在线', '旧电脑 · 离线'])
    const card = screen.getByText('from phone').closest('li')
    if (!card) throw new Error('missing card')
    expect(within(card).getByText('iPhone · Safari')).toBeTruthy()

    const bar = screen.getByRole('region', { name: '置顶栏' })
    expect(within(bar).getByText('pinned text')).toBeTruthy()
    expect(within(bar).queryByRole('listitem')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '按设备' }))
    expect(screen.getByRole('heading', { name: /iPhone · Safari/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /旧电脑.*离线/ })).toBeTruthy()
  })
})
