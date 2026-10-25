import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ApiError } from './domain.js';

export interface FileStorage {
  write(body: ReadableStream<Uint8Array>, limit: number, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ key: string; size: number; sha256: string }>;
  bytes(key: string): Promise<Buffer>;
  prefix(key: string, length: number): Promise<Buffer>;
  stream(key: string, start?: number, end?: number): ReadableStream<Uint8Array>;
  concatenate(keys: string[]): ReadableStream<Uint8Array>;
  remove(key: string): Promise<void>;
  commit(key: string): void;
  sweep(referenced: Set<string>, olderThan: number): Promise<void>;
}

export class DiskFileStorage implements FileStorage {
  private active = new Set<string>();
  constructor(private directory: string) {}
  private path(key: string) {
    if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('Invalid storage key');
    return join(this.directory, key);
  }
  async write(body: ReadableStream<Uint8Array>, limit: number, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = randomUUID();
    this.active.add(key);
    const reader = body.getReader();
    let handle;
    let size = 0;
    let timedOut = false;
    const digest = createHash('sha256');
    const cancel = () => { void reader.cancel().catch(() => {}); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const deadline = options.timeoutMs === undefined ? undefined :
      setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMs).unref();
    const checkCancelled = () => {
      if (timedOut) throw new ApiError(400, 'UPLOAD_TIMEOUT');
      if (options.signal?.aborted) throw new ApiError(404, 'NOT_FOUND');
    };
    try {
      checkCancelled();
      handle = await open(this.path(key), 'wx', 0o600);
      while (true) {
        const { value, done } = await reader.read();
        checkCancelled();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new ApiError(413, 'FILE_TOO_LARGE');
        digest.update(value);
        // FileHandle.write can perform a short write.
        let offset = 0;
        while (offset < value.byteLength) offset += (await handle.write(value, offset)).bytesWritten;
      }
      if (size === 0) throw new ApiError(400, 'EMPTY_FILE');
      await handle.sync();
      await handle.close();
      checkCancelled();
      return { key, size, sha256: digest.digest('hex') };
    } catch (error) {
      await reader.cancel().catch(() => {});
      await handle?.close().catch(() => {});
      try { await this.remove(key); } finally { this.active.delete(key); }
      throw error;
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }
  bytes(key: string) { return readFile(this.path(key)); }
  async prefix(key: string, length: number) {
    const handle = await open(this.path(key), 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
  stream(key: string, start = 0, end?: number) {
    return Readable.toWeb(createReadStream(this.path(key), { start, end })) as ReadableStream<Uint8Array>;
  }
  concatenate(keys: string[]) { return concatenate(this, keys); }
  async remove(key: string) {
    try { await unlink(this.path(key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.active.delete(key);
  }
  commit(key: string) { this.active.delete(key); }
  async sweep(referenced: Set<string>, olderThan: number) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const key of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}$/.test(key) || this.active.has(key) || referenced.has(key)) continue;
      try { if ((await stat(this.path(key))).mtimeMs < olderThan) await this.remove(key); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

/** Concatenate persisted chunks with stream backpressure, without buffering a file. */
function concatenate(files: FileStorage, keys: string[]) {
  async function* bytes() {
    for (const key of keys) {
      const reader = files.stream(key).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  return Readable.toWeb(Readable.from(bytes())) as ReadableStream<Uint8Array>;
}
