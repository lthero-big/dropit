import { createHash } from 'node:crypto';
import { open as openFile, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { CliError } from './errors.js';
import type { Item } from './items.js';
import type { Target } from './client.js';
import { removeSession, upsertSession, type UploadRecord } from './sessions.js';
import { sampleProgress, type ProgressSample } from './push.js';

/** Files at or above this size use the session protocol. Smaller files stay one request. */
export const LARGE_FILE_BYTES = 256 * 1024;
/** Matches the server default of three in-flight chunks per upload. */
export const CHUNK_CONCURRENCY = 3;
export const CHUNK_RETRIES = 3;

const RETRYABLE = new Set([
  'CHUNK_BUSY', 'RATE_LIMITED', 'UPLOAD_BUSY', 'CHECKSUM_MISMATCH', 'UPLOAD_TIMEOUT',
  'UPLOAD_IN_PROGRESS', 'UNAVAILABLE', 'HTTP_408', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504',
]);

const DISCARD_ON_COMPLETE = new Set([
  'UPLOAD_INCOMPLETE', 'QUOTA_EXCEEDED', 'FILE_TOO_LARGE', 'INVALID_IMAGE', 'INVALID_FILENAME', 'EMPTY_FILE', 'INVALID_INPUT',
]);

export function chunkCount(size: number, chunkSize: number): number {
  if (chunkSize <= 0) throw new CliError('INVALID_INPUT', '分片大小无效');
  return Math.ceil(size / chunkSize);
}

export function chunkLength(size: number, chunkSize: number, index: number): number {
  const length = Math.min(chunkSize, size - index * chunkSize);
  if (length <= 0) throw new CliError('INVALID_CHUNK_INDEX', '分片序号无效');
  return length;
}

export function missingIndexes(count: number, received: readonly number[]): number[] {
  const have = new Set(received);
  const missing: number[] = [];
  for (let index = 0; index < count; index += 1) if (!have.has(index)) missing.push(index);
  return missing;
}

export function retryableChunkError(error: unknown): boolean {
  return error instanceof CliError && RETRYABLE.has(error.code);
}

export interface ChunkProgress {
  speed: number;
  eta: number | null;
  report: boolean;
}

export interface UploadSessionInfo {
  uploadId: string;
  chunkSize: number;
  expiresAt: number;
  received: number[];
  size?: number;
}

export interface ChunkClient {
  createUpload(target: Target, filename: string, size: number, mime: string): Promise<UploadSessionInfo>;
  getUpload(target: Target, uploadId: string): Promise<UploadSessionInfo & { size: number }>;
  putChunk(target: Target, uploadId: string, index: number, bytes: Buffer, sha256: string, signal: AbortSignal, onBytes: (sent: number) => void): Promise<void>;
  completeUpload(target: Target, uploadId: string): Promise<Item>;
  deleteUpload(target: Target, uploadId: string): Promise<void>;
  list(target: Target): Promise<Item[]>;
}

async function readSlice(file: string, start: number, length: number, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) throw new CliError('INTERRUPTED', '已取消上传', 130);
  const handle = await openFile(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    if (bytesRead !== length) throw new CliError('CHUNK_SIZE_MISMATCH', '本地文件在上传过程中变了');
    return buf;
  } finally {
    await handle.close();
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CliError('INTERRUPTED', '已取消上传', 130));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CliError('INTERRUPTED', '已取消上传', 130));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function mapLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>, signal: AbortSignal): Promise<void> {
  if (limit < 1) throw new CliError('USAGE', '并发数无效', 2);
  if (items.length === 0) return;
  let next = 0;
  let active = 0;
  let failure: unknown;
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (signal.aborted && !failure) failure = new CliError('INTERRUPTED', '已取消上传', 130);
      if (failure && active === 0) {
        reject(failure);
        return;
      }
      if (failure) return;
      while (active < limit && next < items.length && !signal.aborted) {
        const item = items[next]!;
        next += 1;
        active += 1;
        worker(item).then(() => {
          active -= 1;
          if (next >= items.length && active === 0) resolve();
          else pump();
        }, (error: unknown) => {
          failure = error;
          active -= 1;
          if (active === 0) reject(error);
        });
      }
      if (signal.aborted && active === 0) reject(failure ?? new CliError('INTERRUPTED', '已取消上传', 130));
      else if (!failure && next >= items.length && active === 0) resolve();
    };
    pump();
  });
}

async function forget(client: ChunkClient, target: Target, sessionFile: string, uploadId: string): Promise<void> {
  await client.deleteUpload(target, uploadId).catch((error: unknown) => {
    if (!(error instanceof CliError) || error.code !== 'NOT_FOUND') throw error;
  });
  await removeSession(sessionFile, uploadId);
}

function receivedBytes(size: number, chunkSize: number, received: readonly number[]): number {
  return received.reduce((total, index) => total + chunkLength(size, chunkSize, index), 0);
}

async function adopt(client: ChunkClient, target: Target, sessionFile: string, record: UploadRecord, size: number): Promise<{ record: UploadRecord; received: number[] } | undefined> {
  if (record.expiresAt <= Date.now()) {
    await forget(client, target, sessionFile, record.uploadId).catch(() => undefined);
    return undefined;
  }
  try {
    const remote = await client.getUpload(target, record.uploadId);
    if (remote.size !== size || remote.chunkSize !== record.chunkSize) {
      await forget(client, target, sessionFile, record.uploadId);
      return undefined;
    }
    return { record: { ...record, expiresAt: remote.expiresAt }, received: remote.received };
  } catch (error) {
    if (error instanceof CliError && error.code === 'NOT_FOUND') {
      await removeSession(sessionFile, record.uploadId);
      return undefined;
    }
    throw error;
  }
}

async function recoverItem(client: ChunkClient, target: Target, record: UploadRecord): Promise<Item | undefined> {
  const items = await client.list(target);
  const matches = items.filter(item => item.kind === 'file' && item.size === record.size && item.filename === record.filename && item.createdAt >= record.startedAt - 5_000);
  matches.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  return matches[0];
}

export async function uploadChunked(options: {
  client: ChunkClient;
  target: Target;
  file: string;
  mime: string;
  url: string;
  targetKey: string;
  sessionFile: string;
  signal: AbortSignal;
  findSession: () => Promise<UploadRecord | undefined>;
  onProgress: (sent: number, total: number, extra: ChunkProgress) => void;
}): Promise<Item> {
  if (options.signal.aborted) throw new CliError('INTERRUPTED', '已取消上传', 130);
  const info = await stat(options.file);
  if (!info.isFile()) throw new CliError('USAGE', `${options.file} 不是文件`, 2);
  if (info.size <= 0) throw new CliError('EMPTY_FILE', `${basename(options.file)} 是空文件`);
  const path = await realpath(options.file);
  const filename = basename(options.file);
  const started = Date.now();
  let record = await options.findSession();
  let received: number[] = [];
  if (record && (record.size !== info.size || record.mtimeMs !== Math.round(info.mtimeMs) || record.path !== path)) {
    await forget(options.client, options.target, options.sessionFile, record.uploadId).catch(() => undefined);
    record = undefined;
  }
  if (record) {
    const adopted = await adopt(options.client, options.target, options.sessionFile, record, info.size);
    if (adopted) {
      record = adopted.record;
      received = adopted.received;
    } else {
      const recovered = record ? await recoverItem(options.client, options.target, record).catch(() => undefined) : undefined;
      if (recovered) return recovered;
      record = undefined;
    }
  }
  if (!record) {
    const created = await options.client.createUpload(options.target, filename, info.size, options.mime);
    record = {
      url: options.url, targetKey: options.targetKey, path, size: info.size, mtimeMs: Math.round(info.mtimeMs),
      uploadId: created.uploadId, chunkSize: created.chunkSize, expiresAt: created.expiresAt, filename, startedAt: started,
    };
    await upsertSession(options.sessionFile, record);
    received = created.received;
  }
  const active = record;
  const total = info.size;
  const count = chunkCount(total, active.chunkSize);
  const missing = missingIndexes(count, received);
  let committed = receivedBytes(total, active.chunkSize, received);
  const inflight = new Map<number, number>();
  const report = (force: boolean) => {
    let sent = committed;
    for (const value of inflight.values()) sent += value;
    const sample: ProgressSample = sampleProgress(started, sent, total);
    options.onProgress(sent, total, { ...sample, report: force });
  };
  report(false);
  try {
    await mapLimit(missing, CHUNK_CONCURRENCY, async (index) => {
      const length = chunkLength(total, active.chunkSize, index);
      let retries = 0;
      while (true) {
        if (options.signal.aborted) throw new CliError('INTERRUPTED', '已取消上传', 130);
        inflight.set(index, 0);
        try {
          const bytes = await readSlice(path, index * active.chunkSize, length, options.signal);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          await options.client.putChunk(options.target, active.uploadId, index, bytes, sha256, options.signal, (sent) => {
            inflight.set(index, sent);
            report(false);
          });
          inflight.delete(index);
          committed += length;
          report(true);
          return;
        } catch (error) {
          inflight.delete(index);
          if (options.signal.aborted || (error instanceof CliError && error.code === 'INTERRUPTED')) {
            throw new CliError('INTERRUPTED', '已取消上传', 130);
          }
          if (!retryableChunkError(error) || retries >= CHUNK_RETRIES) throw error;
          retries += 1;
          const wait = error instanceof CliError && error.retryAfter != null ? error.retryAfter * 1000 : 200 * 2 ** (retries - 1);
          await delay(wait, options.signal);
        }
      }
    }, options.signal);
  } catch (error) {
    if (options.signal.aborted || (error instanceof CliError && error.code === 'INTERRUPTED')) {
      throw new CliError('INTERRUPTED', '已取消上传', 130);
    }
    throw error;
  }
  if (options.signal.aborted) throw new CliError('INTERRUPTED', '已取消上传', 130);
  let attempt = 0;
  while (true) {
    try {
      const item = await options.client.completeUpload(options.target, active.uploadId);
      await removeSession(options.sessionFile, active.uploadId);
      options.onProgress(total, total, { ...sampleProgress(started, total, total), report: true });
      return item;
    } catch (error) {
      if (error instanceof CliError && error.code === 'NOT_FOUND') {
        const recovered = await recoverItem(options.client, options.target, active);
        await removeSession(options.sessionFile, active.uploadId);
        if (recovered) return recovered;
      }
      if (error instanceof CliError && error.code === 'UPLOAD_IN_PROGRESS' && attempt < CHUNK_RETRIES) {
        attempt += 1;
        await delay(error.retryAfter != null ? error.retryAfter * 1000 : 200 * attempt, options.signal);
        continue;
      }
      if (error instanceof CliError && DISCARD_ON_COMPLETE.has(error.code)) {
        await removeSession(options.sessionFile, active.uploadId);
      }
      throw error;
    }
  }
}
