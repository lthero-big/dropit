import { ApiError, errorText, isKeepSession, isUploadCancelled, KeepSession } from '@/lib/api.ts'
import { formatBytes } from '@/lib/format.ts'
import { etaMs, noteBytes, slidingBytesPerSecond, type SpeedSample } from '@/lib/upload-speed.ts'
import type { Item } from '@/lib/types.ts'

export const UPLOAD_CONCURRENCY = 3
export const UPLOAD_AUTO_RETRIES = 3
export const UPLOAD_DONE_MS = 2500

export type UploadPhase = 'queued' | 'uploading' | 'processing' | 'paused' | 'done' | 'failed' | 'cancelled'

export type UploadProgress = number | { ratio: number; phase?: 'processing' }

export type UploadRow = {
  id: string
  name: string
  size: number
  ratio: number
  status: UploadPhase
  error: string
  speedBps: number
  etaMs: number | null
  /** Drawn from localStorage after a refresh. The File is gone until the user picks it again. */
  restored?: boolean
  confirmMtime?: boolean
}

export type RestoredUpload = {
  uploadId: string
  name: string
  size: number
  ratio: number
  sessionKey: string
}

export type KeptSession = {
  key: string
  uploadId: string
}

type Uploader = (
  file: File,
  onProgress: (update: UploadProgress) => void,
  signal: AbortSignal,
) => Promise<{ item: Item }>

type Job = UploadRow & {
  file: File | null
  sessionKey: string | null
  uploadId: string | null
  held: File | null
  controller: AbortController | null
  timer: ReturnType<typeof setTimeout> | null
  samples: SpeedSample[]
  /** Bumps on each start so a late abort cannot pause a resumed attempt. */
  run: number
}

export type UploadQueue = {
  enqueue: (files: File[], maxFileBytes: number) => void
  cancel: (id: string) => void
  cancelAll: () => void
  retry: (id: string) => void
  pause: (id: string) => void
  resume: (id: string) => void
  restore: (input: RestoredUpload) => void
  dropRestored: () => void
  dropUpload: (uploadId: string) => void
  dropForeign: (uploadId: string) => void
  claimedIds: () => string[]
  needsFile: (id: string) => boolean
  sessionOf: (id: string) => (KeptSession & { name: string; size: number }) | null
  bindFile: (id: string, file: File, sessionKey?: string) => void
  holdFile: (id: string, file: File, error: string) => void
  armMtime: (id: string, file: File) => void
  confirmMtime: (id: string) => File | null
  takeHeld: (id: string) => File | null
  dispose: () => void
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function retryable(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 429 && (
    error.code === 'UPLOAD_BUSY' || error.code === 'RATE_LIMITED' || error.code === 'UPLOAD_SESSION_LIMIT'
  )
}

function readProgress(update: UploadProgress): { ratio: number; phase?: 'processing' } {
  if (typeof update === 'number') return { ratio: update }
  return { ratio: update.ratio, phase: update.phase }
}

export function createUploadQueue(options: {
  upload: Uploader
  onItem: (item: Item) => void
  onAuthLost: () => void
  onChange: (rows: UploadRow[]) => void
  onOversize: (name: string) => void
  onFailed: (message: string) => void
  discard?: (file: File) => void
  discardKept?: (session: KeptSession) => void
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
  doneMs?: number
}): UploadQueue {
  const jobs: Job[] = []
  const wait = options.sleep ?? sleep
  const now = options.now ?? Date.now
  const doneMs = options.doneMs ?? UPLOAD_DONE_MS
  let disposed = false
  let seq = 0
  let limit = Number.POSITIVE_INFINITY

  function markOversize(job: Job) {
    job.status = 'failed'
    job.ratio = 0
    job.speedBps = 0
    job.etaMs = null
    job.error = `超过大小上限（${formatBytes(limit)}）`
    options.onOversize(job.name)
  }

  function snapshot(): UploadRow[] {
    return jobs.map(({ id, name, size, ratio, status, error, speedBps, etaMs: remain, restored, confirmMtime }) => ({
      id, name, size, ratio, status, error, speedBps, etaMs: remain,
      restored: restored || undefined,
      confirmMtime: confirmMtime || undefined,
    }))
  }

  function forget(job: Job) {
    if (job.file) options.discard?.(job.file)
    else if (job.sessionKey && job.uploadId) options.discardKept?.({ key: job.sessionKey, uploadId: job.uploadId })
  }

  function find(id: string) {
    return jobs.find((entry) => entry.id === id)
  }

  function publish() {
    if (disposed) return
    options.onChange(snapshot())
  }

  function remove(job: Job) {
    const index = jobs.indexOf(job)
    if (index < 0) return
    if (job.timer) clearTimeout(job.timer)
    jobs.splice(index, 1)
    publish()
  }

  function armRemoval(job: Job) {
    if (job.timer) clearTimeout(job.timer)
    job.timer = setTimeout(() => {
      job.timer = null
      if (disposed) return
      if (job.status === 'done' || job.status === 'cancelled') remove(job)
    }, doneMs)
  }

  function applyProgress(job: Job, update: UploadProgress) {
    if (job.status !== 'uploading' && job.status !== 'processing') return
    const { ratio, phase } = readProgress(update)
    const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : job.ratio
    const bytes = Math.round(clamped * job.size)
    job.ratio = clamped
    job.samples = noteBytes(job.samples, bytes, now())
    job.speedBps = slidingBytesPerSecond(job.samples)
    job.etaMs = etaMs(Math.max(0, job.size - bytes), job.speedBps)
    if (phase === 'processing' || clamped >= 1) {
      job.status = 'processing'
      job.ratio = 1
      job.etaMs = null
    }
    publish()
  }

  async function uploadWithRetry(job: Job, signal: AbortSignal): Promise<{ item: Item }> {
    const file = job.file
    if (!file) throw new Error('missing file')
    let retries = 0
    while (true) {
      try {
        return await options.upload(file, (update) => applyProgress(job, update), signal)
      } catch (error) {
        if (signal.aborted || isUploadCancelled(error) || isKeepSession(error)) throw error
        if (!retryable(error) || retries >= UPLOAD_AUTO_RETRIES) throw error
        retries += 1
        const delay = error.retryAfter != null ? error.retryAfter * 1000 : 1000 * 2 ** (retries - 1)
        await wait(delay, signal)
      }
    }
  }

  function pump() {
    if (disposed) return
    while (jobs.filter((job) => job.status === 'uploading' || job.status === 'processing').length < UPLOAD_CONCURRENCY) {
      const job = jobs.find((entry) => entry.status === 'queued' && entry.file)
      if (!job) break
      job.status = 'uploading'
      job.ratio = 0
      job.error = ''
      job.samples = []
      job.speedBps = 0
      job.etaMs = null
      void start(job)
    }
    publish()
  }

  async function start(job: Job) {
    const controller = new AbortController()
    const run = ++job.run
    job.controller = controller
    publish()
    try {
      const result = await uploadWithRetry(job, controller.signal)
      if (disposed || run !== job.run || controller.signal.aborted || (job.status !== 'uploading' && job.status !== 'processing')) return
      job.status = 'done'
      job.ratio = 1
      job.speedBps = 0
      job.etaMs = null
      job.controller = null
      publish()
      options.onItem(result.item)
      armRemoval(job)
    } catch (error) {
      if (disposed || run !== job.run) return
      if (job.controller === controller) job.controller = null
      if (job.status === 'paused' || isKeepSession(error)) {
        job.status = 'paused'
        publish()
        return
      }
      if (job.status === 'cancelled' || controller.signal.aborted || isUploadCancelled(error)) {
        if (job.status === 'uploading' || job.status === 'processing') {
          job.status = 'cancelled'
          publish()
          armRemoval(job)
        }
        return
      }
      job.status = 'failed'
      job.speedBps = 0
      job.etaMs = null
      job.error = errorText(error)
      publish()
      options.onFailed(job.error)
      if (error instanceof ApiError && error.status === 401) options.onAuthLost()
    } finally {
      pump()
    }
  }

  function blank(file: File, name: string): Job {
    return {
      id: `up-${++seq}`,
      file,
      sessionKey: null,
      uploadId: null,
      held: null,
      name,
      size: file.size,
      ratio: 0,
      status: 'queued',
      error: '',
      speedBps: 0,
      etaMs: null,
      controller: null,
      timer: null,
      samples: [],
      run: 0,
    }
  }

  function detach(uploadId: string) {
    const job = jobs.find((entry) => entry.uploadId === uploadId)
    if (!job) return
    job.run += 1
    job.controller?.abort(new KeepSession())
    remove(job)
  }

  return {
    enqueue(files, maxFileBytes) {
      if (disposed) return
      limit = maxFileBytes
      for (const file of files) {
        const job = blank(file, file.name || '截图')
        if (file.size > limit) markOversize(job)
        jobs.push(job)
      }
      publish()
      pump()
    },
    cancel(id) {
      const job = find(id)
      if (!job) return
      if (job.status === 'queued') {
        forget(job)
        remove(job)
        return
      }
      if (job.status === 'paused') {
        forget(job)
        job.status = 'cancelled'
        publish()
        armRemoval(job)
        return
      }
      if (job.status !== 'uploading' && job.status !== 'processing') return
      job.status = 'cancelled'
      job.controller?.abort()
      publish()
      armRemoval(job)
    },
    cancelAll() {
      for (const job of [...jobs]) {
        if (job.status === 'queued' || job.status === 'paused' || job.status === 'uploading' || job.status === 'processing') {
          this.cancel(job.id)
        }
      }
    },
    retry(id) {
      const job = find(id)
      if (!job || job.status !== 'failed' || !job.file) return
      job.error = ''
      job.ratio = 0
      job.speedBps = 0
      job.etaMs = null
      job.samples = []
      if (job.file.size > limit) {
        markOversize(job)
        publish()
        return
      }
      job.status = 'queued'
      publish()
      pump()
    },
    pause(id) {
      const job = find(id)
      if (!job || job.status !== 'uploading') return
      job.status = 'paused'
      job.controller?.abort(new KeepSession())
      job.controller = null
      publish()
    },
    resume(id) {
      const job = find(id)
      if (!job || job.status !== 'paused' || !job.file) return
      job.status = 'queued'
      job.error = ''
      job.confirmMtime = false
      publish()
      pump()
    },
    restore(input) {
      if (disposed || jobs.some((entry) => entry.uploadId === input.uploadId)) return
      jobs.push({
        id: `up-${++seq}`,
        file: null,
        sessionKey: input.sessionKey,
        uploadId: input.uploadId,
        held: null,
        name: input.name || '截图',
        size: input.size,
        ratio: input.ratio,
        status: 'paused',
        error: '',
        restored: true,
        confirmMtime: false,
        speedBps: 0,
        etaMs: null,
        controller: null,
        timer: null,
        samples: [],
        run: 0,
      })
      publish()
    },
    dropRestored() {
      for (const job of [...jobs]) {
        if (job.restored && !job.file && job.status === 'paused') remove(job)
      }
    },
    dropUpload: detach,
    dropForeign(uploadId) {
      const job = jobs.find((entry) => entry.uploadId === uploadId)
      if (!job || job.status === 'uploading' || job.status === 'processing' || job.status === 'queued') return
      job.run += 1
      remove(job)
    },
    claimedIds() {
      return jobs.flatMap((job) => job.uploadId ? [job.uploadId] : [])
    },
    needsFile(id) {
      const job = find(id)
      return Boolean(job && job.status === 'paused' && !job.file)
    },
    sessionOf(id) {
      const job = find(id)
      if (!job?.sessionKey || !job.uploadId) return null
      return { key: job.sessionKey, uploadId: job.uploadId, name: job.name, size: job.size }
    },
    bindFile(id, file, sessionKey) {
      const job = find(id)
      if (!job || job.status === 'cancelled' || job.status === 'done') return
      job.file = file
      job.held = null
      job.confirmMtime = false
      job.error = ''
      job.name = file.name || job.name
      job.size = file.size
      if (sessionKey) job.sessionKey = sessionKey
      if (job.status === 'paused' || job.status === 'failed') {
        job.status = 'queued'
        publish()
        pump()
        return
      }
      publish()
    },
    holdFile(id, file, error) {
      const job = find(id)
      if (!job || job.status !== 'paused') return
      job.held = file
      job.confirmMtime = false
      job.error = error
      publish()
    },
    armMtime(id, file) {
      const job = find(id)
      if (!job || job.status !== 'paused') return
      job.held = file
      job.confirmMtime = true
      job.error = '修改时间不一致，仍要续传？'
      publish()
    },
    confirmMtime(id) {
      const job = find(id)
      if (!job?.held) return null
      const file = job.held
      job.held = null
      job.confirmMtime = false
      job.error = ''
      publish()
      return file
    },
    takeHeld(id) {
      const job = find(id)
      if (!job) return null
      const file = job.held
      job.held = null
      job.confirmMtime = false
      job.error = ''
      publish()
      return file
    },
    dispose() {
      disposed = true
      for (const job of jobs) {
        if (job.timer) clearTimeout(job.timer)
        job.controller?.abort(new KeepSession())
      }
    },
  }
}
