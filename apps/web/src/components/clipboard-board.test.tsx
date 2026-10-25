import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipboardBoard } from './clipboard-board.tsx'
import { ApiError, UploadCancelled, uploadFile } from '@/lib/api.ts'
import type { Item } from '@/lib/types.ts'

class FakeSocket {
  static instances: FakeSocket[] = []
  url: string
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readyState = 0

  constructor(url: string | URL) {
    this.url = String(url)
    FakeSocket.instances.push(this)
  }

  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }

  send() {}
}

type Held = {
  name: string
  progress: (ratio: number) => void
  signal: AbortSignal
  succeed: () => void
  fail: (error: unknown) => void
}

function makeItem(name: string): Item {
  return {
    id: `item-${name}`,
    spaceId: 's1',
    userId: 'u1',
    kind: 'file',
    text: null,
    filename: name,
    mime: 'text/plain',
    size: 4,
    hasThumbnail: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    expiresAt: Date.now() + 3_600_000,
    pinned: false,
    tags: [],
  }
}

function holdUpload() {
  const held: Held[] = []
  let active = 0
  let maxActive = 0
  const upload: typeof uploadFile = (_base, file, onProgress, signal) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    const abortSignal = signal ?? new AbortController().signal
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (run: () => void) => {
        if (settled) return
        settled = true
        active -= 1
        run()
      }
      abortSignal.addEventListener('abort', () => settle(() => reject(new UploadCancelled())), { once: true })
      held.push({
        name: file.name,
        progress: onProgress,
        signal: abortSignal,
        succeed: () => settle(() => resolve({ item: makeItem(file.name) })),
        fail: (error) => settle(() => reject(error)),
      })
    })
  }
  return {
    held,
    upload,
    get active() {
      return active
    },
    get maxActive() {
      return maxActive
    },
  }
}

function renderBoard(upload: typeof uploadFile, maxFileBytes = 500) {
  return render(
    <ClipboardBoard
      base="/api/spaces/s1"
      title="私人空间"
      quotaBytes={1000}
      usedBytes={0}
      maxFileBytes={maxFileBytes}
      maxTextBytes={1000}
      sender={() => '我'}
      canEdit={() => false}
      canRetract={() => false}
      canShare={() => false}
      upload={upload}
      chunkBytes={8 * 1024 * 1024}
    />,
  )
}

function choose(files: File[]) {
  const input = screen.getByLabelText('选择文件') as HTMLInputElement
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  fireEvent.change(input)
}

function namedFile(name: string, bytes = 4) {
  return new File([new Uint8Array(bytes)], name, { type: 'text/plain' })
}

function rowFor(name: string) {
  const bar = screen.getByRole('progressbar', { name })
  const row = bar.closest('li')
  if (!row) throw new Error(`missing row for ${name}`)
  return row
}

beforeEach(() => {
  FakeSocket.instances = []
  localStorage.removeItem('dropit-chunk-bytes')
  localStorage.removeItem('dropit-upload-sessions')
  vi.stubGlobal('WebSocket', FakeSocket)
  window.WebSocket = FakeSocket as unknown as typeof WebSocket
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('upload queue', () => {
  it('shows one row per file with progress, and a pasted screenshot joins the same queue', async () => {
    const gate = holdUpload()
    renderBoard(gate.upload)
    choose([namedFile('notes.txt', 8), namedFile('photo.png', 12)])
    expect(gate.maxActive).toBe(2)
    act(() => gate.held.find((entry) => entry.name === 'notes.txt')?.progress(0.42))
    const notes = rowFor('notes.txt')
    expect(notes.textContent).toContain('notes.txt')
    expect(notes.textContent).toContain('8 B')
    expect(notes.textContent).toContain('上传中')
    expect(notes.textContent).toContain('42%')
    expect(screen.getByRole('progressbar', { name: 'notes.txt' }).getAttribute('aria-valuenow')).toBe('42')
    expect(rowFor('photo.png').textContent).toContain('上传中')

    const shot = namedFile('shot.png', 6)
    const transfer = new DataTransfer()
    transfer.items.add(shot)
    await act(async () => {
      window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    })
    expect(rowFor('shot.png').textContent).toContain('上传中')
    expect(document.getElementById('clip-item-notes.txt')).toBeNull()
  })

  it('keeps at most three uploads active and queues the rest', async () => {
    const gate = holdUpload()
    renderBoard(gate.upload)
    choose(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((name) => namedFile(name)))
    expect(gate.maxActive).toBe(3)
    expect(gate.held.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(rowFor('d.txt').textContent).toContain('排队中')
    expect(rowFor('e.txt').textContent).toContain('排队中')
    await act(async () => {
      gate.held[0]?.succeed()
    })
    expect(gate.maxActive).toBe(3)
    expect(gate.held.map((entry) => entry.name)).toContain('d.txt')
    expect(gate.held.map((entry) => entry.name)).not.toContain('e.txt')
    expect(rowFor('e.txt').textContent).toContain('排队中')
  })

  it('removes a queued file immediately and cancels an in-flight upload without creating an item', async () => {
    const gate = holdUpload()
    renderBoard(gate.upload)
    choose(['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name) => namedFile(name)))
    const queued = screen.getByRole('button', { name: '取消 d.txt' })
    queued.focus()
    expect(document.activeElement).toBe(queued)
    fireEvent.click(queued)
    expect(screen.queryByRole('progressbar', { name: 'd.txt' })).toBeNull()
    expect(gate.held.map((entry) => entry.name)).not.toContain('d.txt')

    fireEvent.click(screen.getByRole('button', { name: '取消 a.txt' }))
    expect(gate.held[0]?.signal.aborted).toBe(true)
    expect(rowFor('a.txt').textContent).toContain('已取消')
    expect(document.getElementById('clip-item-a.txt')).toBeNull()
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'a.txt' })).toBeNull(), { timeout: 4000 })
    expect(document.getElementById('clip-item-a.txt')).toBeNull()
  })

  it('cancel-all drops queued rows and aborts the active ones', () => {
    const gate = holdUpload()
    renderBoard(gate.upload)
    choose(['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name) => namedFile(name)))
    fireEvent.click(screen.getByRole('button', { name: '全部取消' }))
    expect(screen.queryByRole('progressbar', { name: 'd.txt' })).toBeNull()
    expect(rowFor('a.txt').textContent).toContain('已取消')
    expect(gate.held.every((entry) => entry.signal.aborted)).toBe(true)
    expect(document.getElementById('clip-item-a.txt')).toBeNull()
  })

  it('retries 429 using Retry-After, then fails after three automatic retries', async () => {
    let calls = 0
    const upload: typeof uploadFile = () => {
      calls += 1
      return Promise.reject(new ApiError(429, 'UPLOAD_BUSY', 0))
    }
    renderBoard(upload)
    choose([namedFile('busy.txt')])
    await waitFor(() => expect(calls).toBe(4))
    expect(rowFor('busy.txt').textContent).toContain('失败')
    expect(rowFor('busy.txt').textContent).toContain('上传过于频繁')
    expect(document.getElementById('clip-item-busy.txt')).toBeNull()
  })

  it('retries a failed row manually, and one failure does not stop the other file', async () => {
    const gate = holdUpload()
    renderBoard(gate.upload)
    choose([namedFile('bad.txt'), namedFile('good.txt')])
    await act(async () => {
      gate.held.find((entry) => entry.name === 'bad.txt')?.fail(new ApiError(500, 'INTERNAL_ERROR', null))
      gate.held.find((entry) => entry.name === 'good.txt')?.succeed()
    })
    expect(rowFor('bad.txt').textContent).toContain('失败')
    expect(rowFor('bad.txt').textContent).toContain('服务暂时不可用')
    expect(rowFor('good.txt').textContent).toContain('完成')
    expect(document.getElementById('clip-item-good.txt')).not.toBeNull()
    expect(document.getElementById('clip-item-bad.txt')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试 bad.txt' }))
    const again = gate.held.filter((entry) => entry.name === 'bad.txt').at(-1)
    await act(async () => {
      again?.succeed()
    })
    expect(rowFor('bad.txt').textContent).toContain('完成')
    expect(document.getElementById('clip-item-bad.txt')).not.toBeNull()
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'good.txt' })).toBeNull(), { timeout: 4000 })
    expect(document.getElementById('clip-item-good.txt')).not.toBeNull()
  })

  it('rejects an oversized file before any request and warns before unload', () => {
    const gate = holdUpload()
    renderBoard(gate.upload, 500)
    choose([namedFile('huge.bin', 600)])
    expect(gate.held).toHaveLength(0)
    const row = rowFor('huge.bin')
    expect(row.textContent).toContain('失败')
    expect(row.textContent).toContain('超过大小上限（500 B）')
    expect(row.querySelector('.text-destructive')?.textContent).toContain('超过大小上限')

    choose([namedFile('pending.txt')])
    const leaving = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leaving)
    expect(leaving.defaultPrevented).toBe(true)
  })

  it('shows 处理中 after the bytes are sent, and speed with remaining time while uploading', () => {
    const gate = holdUpload()
    renderBoard(gate.upload, 8 * 1024 * 1024)
    choose([namedFile('movie.bin', 1024 * 1024)])
    act(() => gate.held[0]?.progress(1))
    const processing = rowFor('movie.bin')
    expect(processing.textContent).toContain('处理中…')
    expect(processing.getAttribute('data-upload-status')).toBe('processing')
    expect(screen.getByRole('progressbar', { name: 'movie.bin' }).getAttribute('aria-valuetext')).toBe('处理中')
    expect(screen.queryByRole('button', { name: '暂停 movie.bin' })).toBeNull()
    expect(screen.getByRole('button', { name: '取消 movie.bin' })).toBeTruthy()

    cleanup()
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const speed = holdUpload()
    renderBoard(speed.upload, 8 * 1024 * 1024)
    choose([namedFile('movie.bin', 1024 * 1024)])
    act(() => speed.held[0]?.progress(0))
    now = 2_000
    act(() => speed.held[0]?.progress(0.5))
    const row = rowFor('movie.bin')
    expect(row.textContent).toContain('上传中')
    expect(row.textContent).toContain('0.5 MB/s')
    expect(row.textContent).toContain('剩余 1 秒')
  })

  it('pauses an upload and continues it without losing the row', async () => {
    const gate = holdUpload()
    renderBoard(gate.upload)
    choose([namedFile('notes.txt')])
    fireEvent.click(screen.getByRole('button', { name: '暂停 notes.txt' }))
    fireEvent.click(screen.getByRole('button', { name: '继续 notes.txt' }))
    await act(async () => {})
    expect(rowFor('notes.txt').textContent).toContain('上传中')
    expect(gate.held).toHaveLength(2)
    expect(gate.held[1]?.signal.aborted).toBe(false)
    await act(async () => {
      gate.held[1]?.succeed()
    })
    expect(rowFor('notes.txt').textContent).toContain('完成')
    expect(document.getElementById('clip-item-notes.txt')).not.toBeNull()
  })
})
