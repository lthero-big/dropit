import { ApiError, errorText, isUploadCancelled } from '@/lib/api.ts'
import { formatBytes } from '@/lib/format.ts'
import type { Item } from '@/lib/types.ts'

export const UPLOAD_CONCURRENCY = 3
export const UPLOAD_AUTO_RETRIES = 3
export const UPLOAD_DONE_MS = 2500

export type UploadPhase = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled'

export type UploadRow = {
  id: string
  name: string
  size: number
  ratio: number
  status: UploadPhase
  error: string
}

type Uploader = (
  file: File,
  onProgress: (ratio: number) => void,
  signal: AbortSignal,
) => Promise<{ item: Item }>

type Job = UploadRow & {
  file: File
  controller: AbortController | null
  timer: ReturnType<typeof setTimeout> | null
}

export type UploadQueue = {
  enqueue: (files: File[], maxFileBytes: number) => void
  cancel: (id: string) => void
  cancelAll: () => void
  retry: (id: string) => void
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
  return error instanceof ApiError && error.status === 429 && (error.code === 'UPLOAD_BUSY' || error.code === 'RATE_LIMITED')
}

export function createUploadQueue(options: {
  upload: Uploader
  onItem: (item: Item) => void
  onAuthLost: () => void
  onChange: (rows: UploadRow[]) => void
  onOversize: (name: string) => void
  onFailed: (message: string) => void
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  doneMs?: number
}): UploadQueue {
  const jobs: Job[] = []
  const wait = options.sleep ?? sleep
  const doneMs = options.doneMs ?? UPLOAD_DONE_MS
  let disposed = false
  let seq = 0
  let limit = Number.POSITIVE_INFINITY

  function markOversize(job: Job) {
    job.status = 'failed'
    job.ratio = 0
    job.error = `超过大小上限（${formatBytes(limit)}）`
    options.onOversize(job.name)
  }

  function snapshot(): UploadRow[] {
    return jobs.map(({ id, name, size, ratio, status, error }) => ({ id, name, size, ratio, status, error }))
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

  async function uploadWithRetry(job: Job, signal: AbortSignal): Promise<{ item: Item }> {
    let retries = 0
    while (true) {
      try {
        return await options.upload(job.file, (ratio) => {
          if (job.status !== 'uploading') return
          job.ratio = ratio
          publish()
        }, signal)
      } catch (error) {
        if (signal.aborted || isUploadCancelled(error)) throw error
        if (!retryable(error) || retries >= UPLOAD_AUTO_RETRIES) throw error
        retries += 1
        const delay = error.retryAfter != null ? error.retryAfter * 1000 : 1000 * 2 ** (retries - 1)
        await wait(delay, signal)
      }
    }
  }

  function pump() {
    if (disposed) return
    while (jobs.filter((job) => job.status === 'uploading').length < UPLOAD_CONCURRENCY) {
      const job = jobs.find((entry) => entry.status === 'queued')
      if (!job) break
      job.status = 'uploading'
      job.ratio = 0
      job.error = ''
      void start(job)
    }
    publish()
  }

  async function start(job: Job) {
    const controller = new AbortController()
    job.controller = controller
    publish()
    try {
      const result = await uploadWithRetry(job, controller.signal)
      if (disposed || controller.signal.aborted || job.status !== 'uploading') return
      job.status = 'done'
      job.ratio = 1
      job.controller = null
      publish()
      options.onItem(result.item)
      armRemoval(job)
    } catch (error) {
      job.controller = null
      if (disposed || job.status === 'cancelled' || controller.signal.aborted || isUploadCancelled(error)) {
        if (!disposed && job.status === 'uploading') {
          job.status = 'cancelled'
          publish()
          armRemoval(job)
        }
        return
      }
      job.status = 'failed'
      job.error = errorText(error)
      publish()
      options.onFailed(job.error)
      if (error instanceof ApiError && error.status === 401) options.onAuthLost()
    } finally {
      pump()
    }
  }

  return {
    enqueue(files, maxFileBytes) {
      if (disposed) return
      limit = maxFileBytes
      for (const file of files) {
        const name = file.name || '截图'
        const job: Job = {
          id: `up-${++seq}`,
          file,
          name,
          size: file.size,
          ratio: 0,
          status: 'queued',
          error: '',
          controller: null,
          timer: null,
        }
        if (file.size > limit) markOversize(job)
        jobs.push(job)
      }
      publish()
      pump()
    },
    cancel(id) {
      const job = jobs.find((entry) => entry.id === id)
      if (!job) return
      if (job.status === 'queued') {
        remove(job)
        return
      }
      if (job.status !== 'uploading') return
      job.status = 'cancelled'
      job.controller?.abort()
      publish()
      armRemoval(job)
    },
    cancelAll() {
      for (const job of [...jobs]) {
        if (job.status === 'queued') remove(job)
        else if (job.status === 'uploading') this.cancel(job.id)
      }
    },
    retry(id) {
      const job = jobs.find((entry) => entry.id === id)
      if (!job || job.status !== 'failed') return
      job.error = ''
      job.ratio = 0
      if (job.file.size > limit) {
        markOversize(job)
        publish()
        return
      }
      job.status = 'queued'
      publish()
      pump()
    },
    dispose() {
      disposed = true
      for (const job of jobs) {
        if (job.timer) clearTimeout(job.timer)
        job.controller?.abort()
      }
    },
  }
}
