import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ClipboardBoard } from './clipboard-board.tsx'
import { ApiError, UploadCancelled, uploadFile } from '@/lib/api.ts'
import { memoryStore, resumeKey, type ChunkTransport, type ResumeRecord, type ResumeStore } from '@/lib/chunked-upload.ts'
import { CLAIMS_KEY } from '@/lib/upload-claims.ts'
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
  localStorage.removeItem(CLAIMS_KEY)
  sessionStorage.clear()
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
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'd.txt' })).toBeNull())
    expect(gate.held.map((entry) => entry.name)).not.toContain('d.txt')

    fireEvent.click(screen.getByRole('button', { name: '取消 a.txt' }))
    expect(gate.held[0]?.signal.aborted).toBe(true)
    expect(rowFor('a.txt').textContent).toContain('已取消')
    expect(document.getElementById('clip-item-a.txt')).toBeNull()
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'a.txt' })).toBeNull(), { timeout: 4000 })
    expect(document.getElementById('clip-item-a.txt')).toBeNull()
  })

  it('cancel-all drops queued rows and aborts the active ones', async () => {
    const gate = holdUpload()
    renderBoard(gate.upload)
    choose(['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name) => namedFile(name)))
    fireEvent.click(screen.getByRole('button', { name: '全部取消' }))
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'd.txt' })).toBeNull())
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
    // a finished upload hands its placeholder over to the real card
    expect(document.getElementById('clip-item-good.txt')).not.toBeNull()
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'good.txt' })).toBeNull())
    expect(document.getElementById('clip-item-bad.txt')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试 bad.txt' }))
    const again = gate.held.filter((entry) => entry.name === 'bad.txt').at(-1)
    await act(async () => {
      again?.succeed()
    })
    expect(document.getElementById('clip-item-bad.txt')).not.toBeNull()
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'bad.txt' })).toBeNull())
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
    expect(document.getElementById('clip-item-notes.txt')).not.toBeNull()
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'notes.txt' })).toBeNull())
  })
})

const BASE = '/api/spaces/s1'

function stampedFile(name: string, bytes: number, lastModified: number) {
  return new File([new Uint8Array(bytes)], name, { type: 'text/plain', lastModified })
}

function savedSession(target: File, patch: Partial<ResumeRecord> = {}): ResumeRecord {
  return {
    key: resumeKey(BASE, target),
    base: BASE,
    uploadId: 'up-1',
    chunkSize: 4,
    expiresAt: Date.now() + 60_000,
    size: target.size,
    name: target.name,
    ...patch,
  }
}

function fakeTransport(options: { status?: number; received?: number[] } = {}) {
  const calls = { create: 0, cancel: [] as string[], get: 0 }
  const transport: ChunkTransport = {
    create: async () => {
      calls.create += 1
      return { uploadId: 'new-id', chunkSize: 4, expiresAt: Date.now() + 60_000, received: [] }
    },
    get: async () => {
      calls.get += 1
      if (options.status === 404) throw new ApiError(404, 'NOT_FOUND', null)
      return { uploadId: 'up-1', chunkSize: 4, expiresAt: Date.now() + 60_000, received: options.received ?? [0] }
    },
    put: async () => {},
    complete: async (_base, uploadId) => ({ item: makeItem(uploadId === 'up-1' ? 'notes.txt' : 'other.txt') }),
    cancel: async (_base, id) => {
      calls.cancel.push(id)
    },
  }
  return { transport, calls }
}

function renderResume(store: ResumeStore, transport: ChunkTransport, upload = holdUpload().upload) {
  return render(
    <ClipboardBoard
      base={BASE}
      title="私人空间"
      quotaBytes={1000}
      usedBytes={0}
      maxFileBytes={8 * 1024 * 1024}
      maxTextBytes={1000}
      sender={() => '我'}
      canEdit={() => false}
      canRetract={() => false}
      canShare={() => false}
      upload={upload}
      chunkBytes={8 * 1024 * 1024}
      resumeStore={store}
      transport={transport}
    />,
  )
}

function pickResume(file: File) {
  const input = screen.getByLabelText('选择要续传的文件') as HTMLInputElement
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  fireEvent.change(input)
}

describe('restored upload queue', () => {
  const original = stampedFile('notes.txt', 8, 1_700_000_000_000)

  it('redraws a paused row with progress and remaining bytes after refresh', async () => {
    const store = memoryStore()
    store.put(savedSession(original))
    const { transport } = fakeTransport()
    renderResume(store, transport)
    const row = await screen.findByRole('progressbar', { name: 'notes.txt' })
    expect(row.closest('li')?.textContent).toContain('已暂停')
    expect(row.closest('li')?.textContent).toContain('50%')
    expect(row.closest('li')?.textContent).toContain('剩余 4 B')
    expect(screen.getByRole('button', { name: '继续 notes.txt' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消 notes.txt' })).toBeTruthy()
  })

  it('continues only after the same file is picked again', async () => {
    const store = memoryStore()
    store.put(savedSession(original))
    const { transport, calls } = fakeTransport()
    renderResume(store, transport)
    fireEvent.click(await screen.findByRole('button', { name: '继续 notes.txt' }))
    expect(screen.queryByText('上传中')).toBeNull()
    pickResume(original)
    await waitFor(() => expect(document.querySelector('[data-clip-id]')).not.toBeNull())
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'notes.txt' })).toBeNull())
    expect(calls.create).toBe(0)
  })

  it('names a mismatched field and deletes the old session only when the user abandons it', async () => {
    const store = memoryStore()
    store.put(savedSession(original))
    const { transport, calls } = fakeTransport()
    const gate = holdUpload()
    renderResume(store, transport, gate.upload)
    fireEvent.click(await screen.findByRole('button', { name: '继续 notes.txt' }))
    pickResume(stampedFile('other.txt', 8, original.lastModified))
    expect(rowFor('notes.txt').textContent).toContain('文件名不一致')
    expect(calls.cancel).toEqual([])
    expect(calls.create).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '放弃并重新上传 notes.txt' }))
    await waitFor(() => expect(gate.held.some((entry) => entry.name === 'other.txt')).toBe(true))
    expect(calls.cancel).toEqual(['up-1'])
    expect(store.list()).toEqual([])
  })

  it('confirms a lastModified mismatch and resumes the same upload id', async () => {
    const store = memoryStore()
    store.put(savedSession(original))
    const { transport, calls } = fakeTransport()
    renderResume(store, transport)
    fireEvent.click(await screen.findByRole('button', { name: '继续 notes.txt' }))
    pickResume(stampedFile('notes.txt', 8, original.lastModified + 5))
    expect(rowFor('notes.txt').textContent).toContain('修改时间不一致，仍要续传？')
    fireEvent.click(screen.getByRole('button', { name: '仍要续传 notes.txt' }))
    await waitFor(() => expect(document.querySelector('[data-clip-id]')).not.toBeNull())
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'notes.txt' })).toBeNull())
    expect(calls.create).toBe(0)
  })

  it('clears an expired local session and a missing server session', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '1')
    const expired = memoryStore()
    expired.put(savedSession(original, { expiresAt: Date.now() - 1_000 }))
    const expiredTransport = fakeTransport()
    renderResume(expired, expiredTransport.transport)
    await waitFor(() => expect(error).toHaveBeenCalledWith('会话已过期，请重新上传'))
    expect(screen.queryByRole('button', { name: '继续 notes.txt' })).toBeNull()
    expect(expired.list()).toEqual([])
    cleanup()

    error.mockClear()
    const missing = memoryStore()
    missing.put(savedSession(original))
    const missingTransport = fakeTransport({ status: 404 })
    renderResume(missing, missingTransport.transport)
    await waitFor(() => expect(error).toHaveBeenCalledWith('会话已过期，请重新上传'))
    expect(screen.queryByRole('button', { name: '继续 notes.txt' })).toBeNull()
    expect(missing.list()).toEqual([])
    expect(missingTransport.calls.cancel).toEqual(['up-1'])
  })

  it('does not restore a session another live tab already claimed', async () => {
    sessionStorage.setItem('dropit-tab', 'tab-a')
    localStorage.setItem(CLAIMS_KEY, JSON.stringify({ 'up-1': { tabId: 'tab-b', until: Date.now() + 60_000 } }))
    const store = memoryStore()
    store.put(savedSession(original))
    const { transport, calls } = fakeTransport()
    renderResume(store, transport)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: '继续 notes.txt' })).toBeNull()
    expect(calls.cancel).toEqual([])
    expect(store.list()).toHaveLength(1)
  })

  it('drops the row when another tab takes the lock, without deleting the server session', async () => {
    sessionStorage.setItem('dropit-tab', 'tab-a')
    const store = memoryStore()
    store.put(savedSession(original))
    const { transport, calls } = fakeTransport()
    renderResume(store, transport)
    expect(await screen.findByRole('button', { name: '继续 notes.txt' })).toBeTruthy()
    localStorage.setItem(CLAIMS_KEY, JSON.stringify({ 'up-1': { tabId: 'tab-b', until: Date.now() + 60_000 } }))
    window.dispatchEvent(new StorageEvent('storage', { key: CLAIMS_KEY }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '继续 notes.txt' })).toBeNull())
    expect(calls.cancel).toEqual([])
    expect(store.list()).toHaveLength(1)
  })
})

describe('upload placeholder cards (RHEA-190 step 6)', () => {
  const native = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  afterEach(() => {
    URL.createObjectURL = native.create
    URL.revokeObjectURL = native.revoke
  })

  it('drops a translucent card into the board the moment a file is picked, with its own progress line', async () => {
    const gate = holdUpload()
    renderBoard(gate.upload)
    choose([namedFile('notes.txt')])
    const card = rowFor('notes.txt')
    expect(card.hasAttribute('data-upload-card')).toBe(true)
    expect(card.closest('.clip-board')).not.toBeNull()
    expect(card.querySelector('.dd-card-body')?.className).toContain('opacity-55')
    const bar = screen.getByRole('progressbar', { name: 'notes.txt' })
    expect(bar.getAttribute('aria-valuenow')).toBe('0')
    expect(bar.className).toContain('h-[2px]')
    await act(async () => {
      gate.held[0]?.progress(0.5)
    })
    expect(screen.getByRole('progressbar', { name: 'notes.txt' }).getAttribute('aria-valuenow')).toBe('50')
    expect(rowFor('notes.txt').textContent).toContain('50%')
    // each card carries its own progress: a second pick gets a second bar
    choose([namedFile('more.txt')])
    expect(screen.getAllByRole('progressbar')).toHaveLength(2)
  })

  it('previews a picked image from a local object URL and frees it once the upload has landed', async () => {
    const created: string[] = []
    const revoked: string[] = []
    URL.createObjectURL = (file: Blob) => {
      const url = `blob:local/${(file as File).name}`
      created.push(url)
      return url
    }
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url)
    }
    const gate = holdUpload()
    renderBoard(gate.upload)
    choose([new File([new Uint8Array(4)], 'photo.png', { type: 'image/png' })])
    const img = rowFor('photo.png').querySelector('[data-upload-preview="image"]')
    expect(img?.getAttribute('src')).toBe('blob:local/photo.png')
    await act(async () => {
      gate.held[0]?.succeed()
    })
    expect(document.getElementById('clip-item-photo.png')).not.toBeNull()
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'photo.png' })).toBeNull())
    await waitFor(() => expect(revoked).toContain('blob:local/photo.png'), { timeout: 4000 })
    expect(created).toEqual(['blob:local/photo.png'])
  })

  it('keeps a failed upload on the board with 重试 and 移除', async () => {
    const gate = holdUpload()
    renderBoard(gate.upload)
    choose([namedFile('bad.txt')])
    await act(async () => {
      gate.held[0]?.fail(new ApiError(500, 'INTERNAL_ERROR', null))
    })
    const card = rowFor('bad.txt')
    expect(card.getAttribute('data-upload-status')).toBe('failed')
    expect(card.textContent).toContain('服务暂时不可用')
    expect(screen.getByRole('button', { name: '重试 bad.txt' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除 bad.txt' }))
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'bad.txt' })).toBeNull())
    expect(document.getElementById('clip-item-bad.txt')).toBeNull()
  })
})
