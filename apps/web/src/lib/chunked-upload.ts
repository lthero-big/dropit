import { ApiError, KeepSession, UploadCancelled, api } from '@/lib/api.ts'
import type { Item } from '@/lib/types.ts'

/** Matches the server default `UPLOAD_CHUNK_BYTES`. Learned values replace it. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024
export const MIN_CHUNK_BYTES = 64 * 1024
/** Per file. Matches `uploadChunksPerSession`. */
export const CHUNK_CONCURRENCY = 3
/** One browser is one account. Matches `uploadChunksPerUser`, under the global cap of 16. */
export const GLOBAL_CHUNK_CONCURRENCY = 6
export const CHUNK_RETRIES = 3

const SESSIONS_KEY = 'dropit-upload-sessions'
const CHUNK_KEY = 'dropit-chunk-bytes'

export type UploadProgress = number | { ratio: number; phase?: 'processing' }

export type UploadSession = {
  uploadId: string
  chunkSize: number
  expiresAt: number
  received: number[]
  size?: number
}

export type ChunkTransport = {
  create: (base: string, file: File, signal: AbortSignal) => Promise<UploadSession>
  get: (base: string, uploadId: string, signal: AbortSignal) => Promise<Omit<UploadSession, 'uploadId'> & { uploadId?: string }>
  put: (
    base: string,
    uploadId: string,
    index: number,
    body: Blob,
    onBytes: (loaded: number) => void,
    signal: AbortSignal,
  ) => Promise<void>
  complete: (base: string, uploadId: string, signal: AbortSignal) => Promise<{ item: Item }>
  cancel: (base: string, uploadId: string) => Promise<void>
}

export type ResumeRecord = {
  key: string
  base: string
  uploadId: string
  chunkSize: number
  expiresAt: number
  size: number
  name: string
}

export type ResumeStore = {
  get: (key: string) => ResumeRecord | null
  list: () => ResumeRecord[]
  put: (record: ResumeRecord) => void
  remove: (key: string) => void
}

type SingleUpload = (file: File, onProgress: (ratio: number) => void, signal: AbortSignal) => Promise<{ item: Item }>

export function resumeKey(base: string, file: File): string {
  return `${base}\u0000${file.name}\u0000${file.size}\u0000${file.lastModified}`
}

export function readChunkBytes(): number {
  try {
    const raw = localStorage.getItem(CHUNK_KEY)
    const value = raw ? Number(raw) : DEFAULT_CHUNK_BYTES
    if (Number.isSafeInteger(value) && value >= MIN_CHUNK_BYTES && value <= 24 * 1024 * 1024) return value
  } catch {
    // Private mode and disabled storage keep the documented default.
  }
  return DEFAULT_CHUNK_BYTES
}

export function rememberChunkBytes(value: number) {
  if (!Number.isSafeInteger(value) || value < MIN_CHUNK_BYTES || value > 24 * 1024 * 1024) return
  try {
    localStorage.setItem(CHUNK_KEY, String(value))
  } catch {
    // The in-flight session still uses the size the server returned.
  }
}

export function memoryStore(): ResumeStore {
  const records = new Map<string, ResumeRecord>()
  return {
    get: (key) => records.get(key) ?? null,
    list: () => [...records.values()],
    put: (record) => {
      records.set(record.key, record)
    },
    remove: (key) => {
      records.delete(key)
    },
  }
}

function isRecord(value: unknown): value is ResumeRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as ResumeRecord
  return typeof record.key === 'string' && typeof record.base === 'string' && typeof record.uploadId === 'string'
    && Number.isSafeInteger(record.chunkSize) && Number.isSafeInteger(record.expiresAt)
    && Number.isSafeInteger(record.size) && typeof record.name === 'string'
}

export function browserResumeStore(): ResumeStore {
  const read = (): ResumeRecord[] => {
    try {
      const parsed = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]') as unknown
      return Array.isArray(parsed) ? parsed.filter(isRecord) : []
    } catch {
      return []
    }
  }
  const write = (records: ResumeRecord[]) => {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(records.slice(-32)))
    } catch {
      // Resume is best-effort when storage is full.
    }
  }
  return {
    get: (key) => read().find((record) => record.key === key) ?? null,
    list: () => read(),
    put: (record) => {
      write([...read().filter((entry) => entry.key !== record.key), record])
    },
    remove: (key) => {
      write(read().filter((entry) => entry.key !== key))
    },
  }
}

export function resumeIdentity(key: string): { base: string; name: string; size: number; lastModified: number } | null {
  const parts = key.split('\u0000')
  if (parts.length < 4) return null
  const lastModified = Number(parts.at(-1))
  const size = Number(parts.at(-2))
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(lastModified)) return null
  return { base: parts[0] ?? '', name: parts.slice(1, -2).join('\u0000'), size, lastModified }
}

export type ResumeMatch =
  | { kind: 'match' }
  | { kind: 'mtime' }
  | { kind: 'mismatch'; fields: Array<'文件名' | '大小'> }

export function matchResumeFile(record: Pick<ResumeRecord, 'key' | 'name' | 'size'>, file: File): ResumeMatch {
  const fields: Array<'文件名' | '大小'> = []
  if ((file.name || '截图') !== (record.name || '截图')) fields.push('文件名')
  if (file.size !== record.size) fields.push('大小')
  if (fields.length > 0) return { kind: 'mismatch', fields }
  const identity = resumeIdentity(record.key)
  if (identity && file.lastModified !== identity.lastModified) return { kind: 'mtime' }
  return { kind: 'match' }
}

/** Point an existing server session at a re-picked file whose mtime differs. Does not open a new session. */
export function adoptResume(store: ResumeStore, record: ResumeRecord, file: File): ResumeRecord {
  const next = { ...record, key: resumeKey(record.base, file), name: file.name || record.name, size: file.size }
  if (next.key !== record.key) store.remove(record.key)
  store.put(next)
  return next
}

export function receivedRatio(size: number, chunkSize: number, received: number[]): number {
  if (size <= 0 || chunkSize <= 0) return 0
  const count = Math.ceil(size / chunkSize)
  let bytes = 0
  const seen = new Set<number>()
  for (const index of received) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= count || seen.has(index)) continue
    seen.add(index)
    bytes += Math.min(chunkSize, size - index * chunkSize)
  }
  return Math.min(1, bytes / size)
}

export class ChunkGate {
  private active = 0
  private waiters: Array<() => void> = []
  readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  get inFlight() {
    return this.active
  }

  async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw aborted(signal)
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', onAbort)
        this.active += 1
        resolve()
      }
      const onAbort = () => {
        const index = this.waiters.indexOf(start)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(aborted(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(start)
    })
  }

  release() {
    this.active = Math.max(0, this.active - 1)
    this.waiters.shift()?.()
  }
}

let shared: ChunkGate | null = null

export function sharedChunkGate(): ChunkGate {
  if (!shared) shared = new ChunkGate(GLOBAL_CHUNK_CONCURRENCY)
  return shared
}

function aborted(signal: AbortSignal): Error {
  if (signal.reason instanceof KeepSession) return signal.reason
  if (signal.reason instanceof UploadCancelled) return signal.reason
  if (signal.reason instanceof ApiError) return signal.reason
  return new UploadCancelled()
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted(signal))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(aborted(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function chunkRetryable(error: unknown): boolean {
  if (error instanceof UploadCancelled || error instanceof KeepSession) return false
  if (!(error instanceof ApiError)) return true
  if (error.status === 0 || error.status === 429 || error.status >= 500) return true
  return error.code === 'UPLOAD_TIMEOUT'
}

function chunkBlob(file: File, index: number, chunkSize: number): Blob {
  const start = index * chunkSize
  return file.slice(start, Math.min(file.size, start + chunkSize))
}

function xhrError(xhr: XMLHttpRequest): ApiError {
  let code = 'INTERNAL_ERROR'
  try {
    code = (JSON.parse(xhr.responseText) as { error?: { code?: string } }).error?.code ?? code
  } catch {
    // Non-JSON failures still retry or surface as a status.
  }
  const retry = xhr.getResponseHeader('Retry-After')
  return new ApiError(xhr.status, code, retry && /^\d+$/.test(retry) ? Number(retry) : null)
}

function putBytes(url: string, body: Blob, onBytes: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted(signal))
      return
    }
    const xhr = new XMLHttpRequest()
    let settled = false
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      run()
    }
    const onAbort = () => xhr.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    xhr.open('PUT', url)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onBytes(event.loaded)
    }
    xhr.onload = () => {
      finish(() => {
        if (xhr.status >= 200 && xhr.status < 300) resolve()
        else reject(xhrError(xhr))
      })
    }
    xhr.onerror = () => finish(() => reject(new ApiError(0, 'INTERNAL_ERROR', null)))
    xhr.onabort = () => finish(() => reject(aborted(signal)))
    xhr.send(body)
  })
}

export function browserTransport(): ChunkTransport {
  return {
    create: (base, file, signal) => api<UploadSession>(`${base}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name || 'clipboard',
        size: file.size,
        mime: (file.type || 'application/octet-stream').split(';')[0] || 'application/octet-stream',
      }),
      signal,
    }),
    get: (base, uploadId, signal) => api(`${base}/uploads/${uploadId}`, { signal }),
    put: (base, uploadId, index, body, onBytes, signal) => putBytes(`${base}/uploads/${uploadId}/chunks/${index}`, body, onBytes, signal),
    complete: (base, uploadId, signal) => api<{ item: Item }>(`${base}/uploads/${uploadId}/complete`, { method: 'POST', signal }),
    cancel: async (base, uploadId) => {
      await api(`${base}/uploads/${uploadId}`, { method: 'DELETE' })
    },
  }
}

export function discardUpload(base: string, file: File, store: ResumeStore = browserResumeStore(), transport: ChunkTransport = browserTransport()) {
  const record = store.get(resumeKey(base, file))
  if (!record || record.base !== base) return
  discardSession(base, record, store, transport)
}

export function discardSession(
  base: string,
  record: Pick<ResumeRecord, 'key' | 'uploadId' | 'base'>,
  store: ResumeStore = browserResumeStore(),
  transport: ChunkTransport = browserTransport(),
) {
  if (record.base !== base) return
  store.remove(record.key)
  void transport.cancel(base, record.uploadId).catch(() => {})
}

type ChunkOptions = {
  base: string
  file: File
  onProgress: (update: UploadProgress) => void
  signal: AbortSignal
  transport: ChunkTransport
  store: ResumeStore
  gate: ChunkGate
  chunkConcurrency?: number
  retries?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
}

async function openSession(options: ChunkOptions, key: string, state: { uploadId: string | null }) {
  const now = options.now?.() ?? Date.now()
  const existing = options.store.get(key)
  if (existing && (existing.base !== options.base || existing.size !== options.file.size || existing.expiresAt <= now)) {
    options.store.remove(key)
    void options.transport.cancel(existing.base, existing.uploadId).catch(() => {})
  } else if (existing) {
    try {
      const remote = await options.transport.get(options.base, existing.uploadId, options.signal)
      if (remote.expiresAt > now && (remote.size == null || remote.size === options.file.size) && remote.chunkSize > 0) {
        state.uploadId = existing.uploadId
        rememberChunkBytes(remote.chunkSize)
        return { uploadId: existing.uploadId, chunkSize: remote.chunkSize, expiresAt: remote.expiresAt, received: remote.received ?? [], size: remote.size }
      }
    } catch (error) {
      if (options.signal.aborted) throw aborted(options.signal)
      if (!(error instanceof ApiError) || error.status !== 404) throw error
    }
    options.store.remove(key)
  }
  const created = await options.transport.create(options.base, options.file, options.signal)
  state.uploadId = created.uploadId
  options.store.put({
    key,
    base: options.base,
    uploadId: created.uploadId,
    chunkSize: created.chunkSize,
    expiresAt: created.expiresAt,
    size: options.file.size,
    name: options.file.name,
  })
  rememberChunkBytes(created.chunkSize)
  if (options.signal.aborted) {
    if (!(options.signal.reason instanceof KeepSession)) {
      options.store.remove(key)
      void options.transport.cancel(options.base, created.uploadId).catch(() => {})
    }
    throw aborted(options.signal)
  }
  return created
}

async function putWithRetry(
  options: ChunkOptions,
  uploadId: string,
  index: number,
  chunkSize: number,
  signal: AbortSignal,
  onBytes: (loaded: number) => void,
) {
  const retries = options.retries ?? CHUNK_RETRIES
  const wait = options.sleep ?? sleep
  const blob = chunkBlob(options.file, index, chunkSize)
  let attempt = 0
  while (true) {
    if (signal.aborted) throw aborted(signal)
    await options.gate.acquire(signal)
    let held = true
    try {
      await options.transport.put(options.base, uploadId, index, blob, onBytes, signal)
      return
    } catch (error) {
      if (signal.aborted) throw aborted(signal)
      if (error instanceof ApiError && error.status === 404) {
        options.store.remove(resumeKey(options.base, options.file))
        throw error
      }
      if (!chunkRetryable(error) || attempt >= retries) throw error
      attempt += 1
      const delay = error instanceof ApiError && error.retryAfter != null ? error.retryAfter * 1000 : 1000 * 2 ** (attempt - 1)
      options.gate.release()
      held = false
      await wait(delay, signal)
    } finally {
      if (held) options.gate.release()
    }
  }
}

async function runPool(indices: number[], limit: number, parent: AbortSignal, run: (index: number, signal: AbortSignal) => Promise<void>) {
  if (indices.length === 0) return
  const child = new AbortController()
  const onAbort = () => child.abort(parent.reason)
  if (parent.aborted) child.abort(parent.reason)
  parent.addEventListener('abort', onAbort)
  let cursor = 0
  let failure: unknown = null
  const workers = Array.from({ length: Math.min(limit, indices.length) }, async () => {
    while (!failure && !child.signal.aborted) {
      const index = indices[cursor]
      cursor += 1
      if (index === undefined) return
      try {
        await run(index, child.signal)
      } catch (error) {
        if (!failure) failure = error
        if (!child.signal.aborted) child.abort(error)
      }
    }
  })
  try {
    await Promise.all(workers)
  } finally {
    parent.removeEventListener('abort', onAbort)
  }
  if (parent.aborted) throw aborted(parent)
  if (failure) throw failure
}

async function completeWithRetry(options: ChunkOptions, uploadId: string) {
  const retries = options.retries ?? CHUNK_RETRIES
  const wait = options.sleep ?? sleep
  let attempt = 0
  while (true) {
    try {
      return await options.transport.complete(options.base, uploadId, options.signal)
    } catch (error) {
      if (options.signal.aborted) throw aborted(options.signal)
      const retry = error instanceof ApiError && (error.status === 429 || error.code === 'UPLOAD_IN_PROGRESS')
      if (!retry || attempt >= retries) {
        if (error instanceof ApiError && error.status !== 429 && error.code !== 'UPLOAD_IN_PROGRESS' && error.status !== 0 && error.status < 500) {
          options.store.remove(resumeKey(options.base, options.file))
        }
        throw error
      }
      attempt += 1
      const delay = error.retryAfter != null ? error.retryAfter * 1000 : 1000 * 2 ** (attempt - 1)
      await wait(delay, options.signal)
    }
  }
}

export async function uploadChunked(options: ChunkOptions): Promise<{ item: Item }> {
  const key = resumeKey(options.base, options.file)
  const state = { uploadId: null as string | null, finished: false }
  const onAbort = () => {
    if (state.finished || !state.uploadId) return
    if (options.signal.reason instanceof KeepSession) return
    options.store.remove(key)
    void options.transport.cancel(options.base, state.uploadId).catch(() => {})
  }
  options.signal.addEventListener('abort', onAbort)
  try {
    if (options.signal.aborted) throw aborted(options.signal)
    const session = await openSession(options, key, state)
    const count = Math.ceil(options.file.size / session.chunkSize)
    const received = new Set(session.received.filter((index) => index >= 0 && index < count))
    const loaded = new Map<number, number>()
    const lengthOf = (index: number) => Math.min(session.chunkSize, options.file.size - index * session.chunkSize)
    for (const index of received) loaded.set(index, lengthOf(index))
    const report = () => {
      let bytes = 0
      for (const value of loaded.values()) bytes += value
      options.onProgress(options.file.size > 0 ? Math.min(1, bytes / options.file.size) : 1)
    }
    report()
    const missing: number[] = []
    for (let index = 0; index < count; index += 1) {
      if (!received.has(index)) missing.push(index)
    }
    await runPool(missing, options.chunkConcurrency ?? CHUNK_CONCURRENCY, options.signal, async (index, signal) => {
      await putWithRetry(options, session.uploadId, index, session.chunkSize, signal, (bytes) => {
        loaded.set(index, Math.min(lengthOf(index), Math.max(0, bytes)))
        report()
      })
      loaded.set(index, lengthOf(index))
      report()
    })
    options.onProgress({ ratio: 1, phase: 'processing' })
    const result = await completeWithRetry(options, session.uploadId)
    state.finished = true
    options.store.remove(key)
    return result
  } catch (error) {
    if (options.signal.aborted) throw aborted(options.signal)
    throw error
  } finally {
    options.signal.removeEventListener('abort', onAbort)
  }
}

export async function uploadMaybeChunked(options: {
  base: string
  file: File
  onProgress: (update: UploadProgress) => void
  signal: AbortSignal
  single: SingleUpload
  chunkBytes?: number
  transport?: ChunkTransport
  store?: ResumeStore
  gate?: ChunkGate
  chunkConcurrency?: number
  retries?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
}): Promise<{ item: Item }> {
  const store = options.store ?? browserResumeStore()
  const transport = options.transport ?? browserTransport()
  const threshold = options.chunkBytes ?? readChunkBytes()
  const key = resumeKey(options.base, options.file)
  const now = options.now?.() ?? Date.now()
  const existing = store.get(key)
  if (existing && existing.expiresAt <= now) {
    store.remove(key)
    void transport.cancel(options.base, existing.uploadId).catch(() => {})
  }
  const resumable = existing && existing.expiresAt > now && existing.base === options.base && existing.size === options.file.size
  if (options.file.size <= threshold && !resumable) {
    return options.single(options.file, (ratio) => options.onProgress(ratio), options.signal)
  }
  return uploadChunked({
    base: options.base,
    file: options.file,
    onProgress: options.onProgress,
    signal: options.signal,
    transport,
    store,
    gate: options.gate ?? sharedChunkGate(),
    chunkConcurrency: options.chunkConcurrency,
    retries: options.retries,
    sleep: options.sleep,
    now: options.now,
  })
}
