import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, KeepSession, errorText } from '@/lib/api.ts'
import {
  ChunkGate,
  browserResumeStore,
  browserTransport,
  discardUpload,
  memoryStore,
  rememberChunkBytes,
  resumeKey,
  uploadChunked,
  uploadMaybeChunked,
  type ChunkTransport,
  type ResumeRecord,
} from '@/lib/chunked-upload.ts'
import { createUploadQueue, type UploadRow } from '@/lib/upload-queue.ts'
import { etaMs, formatEta, formatSpeed, noteBytes, slidingBytesPerSecond } from '@/lib/upload-speed.ts'
import type { Item } from '@/lib/types.ts'

const base = '/api/spaces/s1'
const room = '/api/rooms/tok'
const future = 2_000_000_000_000

function file(name: string, bytes: number, lastModified = 1_700_000_000_000) {
  return new File([new Uint8Array(bytes)], name, { type: 'text/plain', lastModified })
}

function item(name: string): Item {
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
    createdAt: 1,
    updatedAt: 1,
    expiresAt: future,
    pinned: false,
    tags: [],
  }
}

function record(target: File, patch: Partial<ResumeRecord> = {}): ResumeRecord {
  return {
    key: resumeKey(base, target),
    base,
    uploadId: 'old',
    chunkSize: 4,
    expiresAt: future,
    size: target.size,
    name: target.name,
    ...patch,
  }
}

type PutCall = { index: number; size: number; signal: AbortSignal }

function transport(partial: Partial<ChunkTransport> = {}): ChunkTransport & { puts: PutCall[]; cancelled: string[]; created: number } {
  const puts: PutCall[] = []
  const cancelled: string[] = []
  const created = { n: 0 }
  return {
    puts,
    cancelled,
    get created() {
      return created.n
    },
    create: async (_base, next) => {
      created.n += 1
      return { uploadId: `up-${created.n}`, chunkSize: 4, expiresAt: future, received: [], size: next.size }
    },
    get: async () => ({ chunkSize: 4, expiresAt: future, received: [], size: 0 }),
    put: async (_base, _id, index, body, _onBytes, signal) => {
      puts.push({ index, size: body.size, signal })
    },
    complete: async () => ({ item: item('done') }),
    cancel: async (_base, uploadId) => {
      cancelled.push(uploadId)
    },
    ...partial,
  }
}

function untilAbort(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }, { once: true })
  })
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('upload speed', () => {
  it('averages bytes inside a five second window and formats speed and eta', () => {
    let samples = noteBytes([], 0, 1_000)
    expect(slidingBytesPerSecond(samples)).toBe(0)
    samples = noteBytes(samples, 512 * 1024, 1_000)
    samples = noteBytes(samples, 1024 * 1024, 2_000)
    expect(samples.find((sample) => sample.at === 1_000)?.bytes).toBe(512 * 1024)
    expect(slidingBytesPerSecond(samples)).toBe(512 * 1024)
    expect(formatSpeed(1024 * 1024)).toBe('1.0 MB/s')
    expect(formatSpeed(40 * 1024)).toBe('40.0 KB/s')
    expect(formatSpeed(12)).toBe('12 B/s')
    expect(formatSpeed(0)).toBe('—')
    expect(etaMs(1024 * 1024, 1024 * 1024)).toBe(1000)
    expect(formatEta(1000)).toBe('剩余 1 秒')
    expect(formatEta(800)).toBe('剩余不到 1 秒')
    expect(formatEta(90_000)).toBe('剩余 1 分 30 秒')
    expect(formatEta(null)).toBe('计算中')
    samples = noteBytes(samples, 2 * 1024 * 1024, 7_000)
    expect(samples.map((sample) => sample.at)).toEqual([2_000, 7_000])
  })
})

describe('chunked upload', () => {
  it('uploads a large file in parallel chunks and keeps a small file on the single request', async () => {
    const client = transport()
    const store = memoryStore()
    const large = file('large.bin', 10)
    const phases: string[] = []
    let completeAt = -1
    client.complete = async () => {
      completeAt = phases.length
      return { item: item('large.bin') }
    }
    const result = await uploadMaybeChunked({
      base,
      file: large,
      onProgress: (update) => phases.push(typeof update === 'number' ? 'bytes' : update.phase ?? 'ratio'),
      signal: new AbortController().signal,
      single: async () => ({ item: item('nope') }),
      chunkBytes: 4,
      transport: client,
      store,
      gate: new ChunkGate(6),
      chunkConcurrency: 3,
    })
    expect(result.item.filename).toBe('large.bin')
    expect(client.created).toBe(1)
    expect(client.puts.map((call) => call.index).sort()).toEqual([0, 1, 2])
    expect(client.puts.map((call) => call.size).sort()).toEqual([2, 4, 4])
    expect(phases.at(-1)).toBe('processing')
    expect(phases[completeAt - 1]).toBe('processing')
    expect(completeAt).toBe(phases.length)
    expect(store.get(resumeKey(base, large))).toBeNull()
    expect(localStorage.getItem('dropit-chunk-bytes')).toBeNull()
    rememberChunkBytes(64 * 1024)
    expect(localStorage.getItem('dropit-chunk-bytes')).toBe(String(64 * 1024))
    rememberChunkBytes(4)
    expect(localStorage.getItem('dropit-chunk-bytes')).toBe(String(64 * 1024))

    const single = vi.fn(async () => ({ item: item('small.txt') }))
    const small = transport()
    await uploadMaybeChunked({
      base,
      file: file('small.txt', 4),
      onProgress: () => {},
      signal: new AbortController().signal,
      single,
      chunkBytes: 8,
      transport: small,
      store: memoryStore(),
      gate: new ChunkGate(6),
    })
    expect(single).toHaveBeenCalledOnce()
    expect(small.created).toBe(0)
  })

  it('caps parallel chunks per file and across files', async () => {
    let inFlight = 0
    let max = 0
    const hanging = (): ChunkTransport['put'] => async (_base, _id, _index, _body, _onBytes, signal) => {
      inFlight += 1
      max = Math.max(max, inFlight)
      await untilAbort(signal)
      inFlight -= 1
    }
    const gate = new ChunkGate(4)
    const stopOne = new AbortController()
    const started = uploadChunked({
      base,
      file: file('one.bin', 24),
      onProgress: () => {},
      signal: stopOne.signal,
      transport: transport({ put: hanging() }),
      store: memoryStore(),
      gate,
      chunkConcurrency: 3,
    })
    await flush()
    expect(max).toBe(3)
    expect(gate.inFlight).toBe(3)

    const stopTwo = new AbortController()
    const second = uploadChunked({
      base,
      file: file('two.bin', 24),
      onProgress: () => {},
      signal: stopTwo.signal,
      transport: transport({ put: hanging() }),
      store: memoryStore(),
      gate,
      chunkConcurrency: 3,
    })
    await flush()
    expect(max).toBe(4)
    expect(gate.inFlight).toBe(4)
    stopOne.abort()
    stopTwo.abort()
    await expect(started).rejects.toBeTruthy()
    await expect(second).rejects.toBeTruthy()
    expect(gate.inFlight).toBe(0)
  })

  it('resumes missing chunks and restarts when the session is missing or expired', async () => {
    const target = file('resume.bin', 12)
    const store = memoryStore()
    store.put(record(target))
    const client = transport({
      get: async () => ({ chunkSize: 4, expiresAt: future, received: [0, 2], size: target.size }),
    })
    await uploadChunked({
      base,
      file: target,
      onProgress: () => {},
      signal: new AbortController().signal,
      transport: client,
      store,
      gate: new ChunkGate(6),
    })
    expect(client.created).toBe(0)
    expect(client.puts.map((call) => call.index)).toEqual([1])

    const expired = memoryStore()
    expired.put(record(target, { uploadId: 'gone', expiresAt: 10 }))
    const restarted = transport()
    await uploadChunked({
      base,
      file: target,
      onProgress: () => {},
      signal: new AbortController().signal,
      transport: restarted,
      store: expired,
      gate: new ChunkGate(6),
      now: () => 20,
    })
    expect(restarted.cancelled).toEqual(['gone'])
    expect(restarted.created).toBe(1)
    expect(restarted.puts).toHaveLength(3)

    const missing = memoryStore()
    missing.put(record(target, { uploadId: '404' }))
    const again = transport({
      get: async () => {
        throw new ApiError(404, 'NOT_FOUND', null)
      },
    })
    await uploadChunked({
      base,
      file: target,
      onProgress: () => {},
      signal: new AbortController().signal,
      transport: again,
      store: missing,
      gate: new ChunkGate(6),
      now: () => 20,
    })
    expect(again.cancelled).toEqual([])
    expect(again.created).toBe(1)

    const flaky = memoryStore()
    flaky.put(record(target))
    const network = transport({
      get: async () => {
        throw new ApiError(0, 'INTERNAL_ERROR', null)
      },
    })
    await expect(uploadChunked({
      base,
      file: target,
      onProgress: () => {},
      signal: new AbortController().signal,
      transport: network,
      store: flaky,
      gate: new ChunkGate(6),
      now: () => 20,
    })).rejects.toMatchObject({ status: 0 })
    expect(network.created).toBe(0)
    expect(flaky.get(resumeKey(base, target))?.uploadId).toBe('old')
  })

  it('retries a chunk with exponential backoff or Retry-After, then stops', async () => {
    const delays: number[] = []
    let calls = 0
    const client = transport({
      put: async () => {
        calls += 1
        if (calls < 3) throw new ApiError(429, 'CHUNK_BUSY', 2)
      },
    })
    await uploadChunked({
      base,
      file: file('retry.bin', 4),
      onProgress: () => {},
      signal: new AbortController().signal,
      transport: client,
      store: memoryStore(),
      gate: new ChunkGate(6),
      retries: 3,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    expect(calls).toBe(3)
    expect(delays).toEqual([2000, 2000])

    const backoff: number[] = []
    let attempts = 0
    const failing = transport({
      put: async () => {
        attempts += 1
        throw new ApiError(0, 'INTERNAL_ERROR', null)
      },
    })
    await expect(uploadChunked({
      base,
      file: file('drop.bin', 4),
      onProgress: () => {},
      signal: new AbortController().signal,
      transport: failing,
      store: memoryStore(),
      gate: new ChunkGate(6),
      retries: 3,
      sleep: async (ms) => {
        backoff.push(ms)
      },
    })).rejects.toMatchObject({ status: 0 })
    expect(attempts).toBe(4)
    expect(backoff).toEqual([1000, 2000, 4000])

    const seen: number[] = []
    await expect(uploadChunked({
      base,
      file: file('clash.bin', 8),
      onProgress: () => {},
      signal: new AbortController().signal,
      transport: transport({
        put: async (_base, _id, index, _body, _onBytes, signal) => {
          seen.push(index)
          if (index === 0) throw new ApiError(409, 'CHUNK_CONFLICT', null)
          await untilAbort(signal)
        },
      }),
      store: memoryStore(),
      gate: new ChunkGate(6),
      chunkConcurrency: 2,
      sleep: async () => {
        throw new Error('conflict must not back off')
      },
    })).rejects.toMatchObject({ code: 'CHUNK_CONFLICT' })
    expect(seen.filter((index) => index === 0)).toEqual([0])
  })

  it('deletes the session on cancel and keeps it on pause', async () => {
    const client = transport({
      put: async (_base, _id, _index, _body, _onBytes, signal) => {
        await untilAbort(signal)
      },
    })
    const store = memoryStore()
    const target = file('cancel.bin', 8)
    const controller = new AbortController()
    const pending = uploadChunked({
      base,
      file: target,
      onProgress: () => {},
      signal: controller.signal,
      transport: client,
      store,
      gate: new ChunkGate(6),
    })
    await flush()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'UploadCancelled' })
    expect(client.cancelled).toEqual(['up-1'])
    expect(store.get(resumeKey(base, target))).toBeNull()

    const paused = transport({
      put: async (_base, _id, _index, _body, _onBytes, signal) => {
        await untilAbort(signal)
      },
    })
    const kept = memoryStore()
    const pauseFile = file('pause.bin', 8)
    const pause = new AbortController()
    const held = uploadChunked({
      base,
      file: pauseFile,
      onProgress: () => {},
      signal: pause.signal,
      transport: paused,
      store: kept,
      gate: new ChunkGate(6),
    })
    await flush()
    pause.abort(new KeepSession())
    await expect(held).rejects.toBeInstanceOf(KeepSession)
    expect(paused.cancelled).toEqual([])
    expect(kept.get(resumeKey(base, pauseFile))?.uploadId).toBe('up-1')
  })

  it('retries complete while the server is still assembling, and drops a discarded session', async () => {
    const delays: number[] = []
    let calls = 0
    const store = memoryStore()
    const target = file('done.bin', 4)
    await uploadChunked({
      base,
      file: target,
      onProgress: () => {},
      signal: new AbortController().signal,
      transport: transport({
        complete: async () => {
          calls += 1
          if (calls === 1) throw new ApiError(409, 'UPLOAD_IN_PROGRESS', null)
          return { item: item('done.bin') }
        },
      }),
      store,
      gate: new ChunkGate(6),
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    expect(calls).toBe(2)
    expect(delays).toEqual([1000])
    expect(store.get(resumeKey(base, target))).toBeNull()

    const broken = memoryStore()
    await expect(uploadChunked({
      base,
      file: target,
      onProgress: () => {},
      signal: new AbortController().signal,
      transport: transport({
        complete: async () => {
          throw new ApiError(400, 'UPLOAD_INCOMPLETE', null)
        },
      }),
      store: broken,
      gate: new ChunkGate(6),
      sleep: async () => {
        throw new Error('terminal complete must not retry')
      },
    })).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' })
    expect(broken.get(resumeKey(base, target))).toBeNull()
  })

  it('names chunk errors and sends cookie requests with no bearer token', async () => {
    expect(errorText(new ApiError(429, 'CHUNK_BUSY', null))).toBe('分片上传繁忙')
    expect(errorText(new ApiError(429, 'UPLOAD_SESSION_LIMIT', 3))).toBe('未完成的上传太多，3 秒后再试')
    expect(errorText(new ApiError(409, 'CHUNK_CONFLICT', null))).toBe('分片冲突，请重试')
    expect(errorText(new ApiError(409, 'UPLOAD_IN_PROGRESS', null))).toBe('上传仍在处理')
    expect(errorText(new ApiError(400, 'CHUNK_SIZE_MISMATCH', null))).toBe('分片大小不符')
    expect(errorText(new ApiError(400, 'CHECKSUM_MISMATCH', null))).toBe('分片校验失败')

    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      calls.push({ url, init })
      const method = init.method ?? 'GET'
      if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(new Response(JSON.stringify({
        uploadId: 'srv',
        chunkSize: 8,
        expiresAt: future,
        received: [],
        item: item('room.txt'),
      }), { status: method === 'GET' ? 200 : 201 }))
    })
    class FakeXHR {
      static last: FakeXHR | null = null
      withCredentials = false
      method = ''
      url = ''
      status = 204
      responseText = ''
      upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number }) => void) | null }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      headers: Record<string, string> = {}
      open(method: string, url: string) {
        this.method = method
        this.url = url
        FakeXHR.last = this
      }
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value
      }
      getResponseHeader() {
        return null
      }
      send() {
        this.onload?.()
      }
      abort() {
        this.onabort?.()
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    const http = browserTransport()
    const roomFile = file('room.txt', 4)
    const created = await http.create(room, roomFile, new AbortController().signal)
    expect(created.uploadId).toBe('srv')
    expect(calls[0]?.url).toBe(`${room}/uploads`)
    expect(calls[0]?.init.credentials).toBe('same-origin')
    expect(calls[0]?.init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ filename: 'room.txt', size: 4, mime: 'text/plain' })
    await http.put(room, 'srv', 0, new Blob(['abcd']), () => {}, new AbortController().signal)
    expect(FakeXHR.last?.method).toBe('PUT')
    expect(FakeXHR.last?.url).toBe(`${room}/uploads/srv/chunks/0`)
    expect(FakeXHR.last?.withCredentials).toBe(true)
    expect(FakeXHR.last?.headers).toEqual({ 'Content-Type': 'application/octet-stream' })
    await http.complete(base, 'srv', new AbortController().signal)
    expect(calls.at(-1)?.url).toBe(`${base}/uploads/srv/complete`)
    await http.cancel(base, 'srv')
    expect(calls.at(-1)).toMatchObject({ url: `${base}/uploads/srv`, init: { method: 'DELETE', credentials: 'same-origin' } })
  })

  it('pauses without deleting, then resumes only the missing chunks', async () => {
    const saved: number[] = []
    const client = transport({
      get: async () => ({ chunkSize: 4, expiresAt: future, received: [...saved], size: 12 }),
      put: async (_base, _id, index, _body, _onBytes, signal) => {
        if (index === 0 && saved.length === 0) {
          saved.push(0)
          return
        }
        await untilAbort(signal)
      },
    })
    const store = memoryStore()
    const rows: UploadRow[] = []
    const target = file('queue.bin', 12)
    const queue = createUploadQueue({
      upload: (next, onProgress, signal) => uploadMaybeChunked({
        base,
        file: next,
        onProgress,
        signal,
        single: async () => {
          throw new Error('large file must use chunks')
        },
        chunkBytes: 4,
        transport: client,
        store,
        gate: new ChunkGate(6),
        chunkConcurrency: 2,
      }),
      discard: (next) => discardUpload(base, next, store, client),
      onItem: () => {},
      onAuthLost: () => {},
      onChange: (next) => {
        rows.splice(0, rows.length, ...next)
      },
      onOversize: () => {},
      onFailed: () => {},
    })
    queue.enqueue([target], 1000)
    await flush()
    expect(saved).toEqual([0])
    expect(rows[0]?.status).toBe('uploading')
    queue.pause(rows[0]!.id)
    await flush()
    expect(rows[0]?.status).toBe('paused')
    expect(client.cancelled).toEqual([])
    expect(store.get(resumeKey(base, target))?.uploadId).toBe('up-1')

    client.put = async (_base, _id, index) => {
      saved.push(index)
    }
    queue.resume(rows[0]!.id)
    await flush()
    expect(client.created).toBe(1)
    expect(saved.sort()).toEqual([0, 1, 2])
    expect(rows[0]?.status).toBe('done')
    queue.dispose()
  })

  it('retries UPLOAD_SESSION_LIMIT on the file and remembers a browser resume record', async () => {
    let calls = 0
    const rows: UploadRow[] = []
    const queue = createUploadQueue({
      upload: async () => {
        calls += 1
        if (calls < 3) throw new ApiError(429, 'UPLOAD_SESSION_LIMIT', 0)
        return { item: item('busy.txt') }
      },
      onItem: () => {},
      onAuthLost: () => {},
      onChange: (next) => {
        rows.splice(0, rows.length, ...next)
      },
      onOversize: () => {},
      onFailed: () => {},
      sleep: async () => {},
    })
    queue.enqueue([file('busy.txt', 4)], 100)
    await vi.waitFor(() => expect(rows[0]?.status).toBe('done'))
    expect(calls).toBe(3)

    const target = file('local.bin', 9)
    const store = browserResumeStore()
    store.put(record(target, { uploadId: 'local' }))
    expect(browserResumeStore().get(resumeKey(base, target))?.uploadId).toBe('local')
    discardUpload(base, target, store, transport())
    expect(browserResumeStore().get(resumeKey(base, target))).toBeNull()
  })
})
