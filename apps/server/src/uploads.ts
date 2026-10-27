import { randomUUID } from 'node:crypto';
import { ApiError, cleanFilename, type ItemMeta, type Session, type Space, type UploadSession } from './domain.js';
import type { ClipboardService } from './service.js';

interface Work { controller: AbortController; done: Promise<void> }
function work() {
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  return { controller: new AbortController(), done, finish };
}

export class UploadService {
  private chunks = new Map<string, Set<Work>>();
  private users = new Map<string, number>();
  private active = 0;
  private completing = new Map<string, Work>();
  constructor(private service: ClipboardService) {}

  private principal(space: Space, session: Session | undefined) {
    // Anonymous room holders share a bucket. Signed-in holders also share their
    // account bucket across rooms/spaces; room capability remains the authority.
    return session ? `user:${session.user.id}` : `room:${space.id}`;
  }
  private quota(space: Space, session: Session | undefined) {
    const { repo, config } = this.service;
    return space.roomHash ? config.roomQuotaBytes : repo.quotaOverride(session!.user.id) ?? config.userQuotaBytes;
  }
  create(space: Space, session: Session | undefined, filename: string, size: number, mime: string) {
    const { config, repo, now } = this.service;
    if (size > (space.roomHash ? config.roomMaxFileBytes : config.maxFileBytes)) throw new ApiError(413, 'FILE_TOO_LARGE');
    const createdAt = now();
    const upload: UploadSession = {
      id: randomUUID(), spaceId: space.id, userId: space.roomHash ? null : session!.user.id,
      principal: this.principal(space, session), filename: cleanFilename(filename), mime, size,
      chunkSize: config.uploadChunkBytes, createdAt,
      expiresAt: Math.min(createdAt + 86400000, space.expiresAt ?? Infinity),
    };
    repo.createUpload(upload, this.quota(space, session), space.roomHash ? Math.min(100, config.maxItems) : config.maxItems,
      config.uploadSessionsPerUser, config.uploadSessionsGlobal);
    return { uploadId: upload.id, chunkSize: upload.chunkSize, expiresAt: upload.expiresAt, received: [] };
  }
  private authorized(space: Space, session: Session | undefined, id: string) {
    const upload = this.service.repo.upload(id, this.service.now());
    if (!upload || upload.spaceId !== space.id || (!space.roomHash && upload.userId !== session?.user.id)) throw new ApiError(404, 'NOT_FOUND');
    return upload;
  }
  get(space: Space, session: Session | undefined, id: string) {
    const upload = this.authorized(space, session, id);
    return { size: upload.size, chunkSize: upload.chunkSize, expiresAt: upload.expiresAt,
      received: this.service.repo.chunks(id).map(chunk => chunk.index) };
  }
  async put(space: Space, session: Session | undefined, id: string, rawIndex: string, body: ReadableStream<Uint8Array> | null, sha256?: string) {
    const upload = this.authorized(space, session, id);
    const index = Number(rawIndex);
    if (!/^(0|[1-9]\d*)$/.test(rawIndex) || !Number.isSafeInteger(index) || index >= Math.ceil(upload.size / upload.chunkSize)) throw new ApiError(400, 'INVALID_CHUNK_INDEX');
    if (sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(sha256)) throw new ApiError(400, 'INVALID_CHECKSUM');
    if (!body) throw new ApiError(400, 'EMPTY_FILE');
    if (this.completing.has(id)) throw new ApiError(409, 'UPLOAD_IN_PROGRESS');
    const { config, files, repo, now } = this.service;
    const principal = this.principal(space, session);
    const pending = this.chunks.get(id) ?? new Set<Work>();
    const own = this.users.get(principal) ?? 0;
    if (pending.size >= config.uploadChunksPerSession || own >= config.uploadChunksPerUser || this.active >= config.uploadChunksGlobal) throw new ApiError(429, 'CHUNK_BUSY');
    const writing = work();
    pending.add(writing); this.chunks.set(id, pending);
    this.users.set(principal, own + 1); ++this.active;
    let key: string | undefined;
    try {
      const expected = Math.min(upload.chunkSize, upload.size - index * upload.chunkSize);
      const saved = await files.write(body, expected, { timeoutMs: config.uploadChunkTimeoutMs, signal: writing.controller.signal });
      key = saved.key;
      if (saved.size !== expected) throw new ApiError(400, 'CHUNK_SIZE_MISMATCH');
      if (sha256 && saved.sha256 !== sha256.toLowerCase()) throw new ApiError(400, 'CHECKSUM_MISMATCH');
      this.authorized(space, session, id);
      if (repo.saveChunk({ uploadId: id, index, key, size: saved.size, sha256: saved.sha256 }, now())) {
        files.commit(key);
        key = undefined;
      }
    } finally {
      try { if (key) await files.remove(key); }
      finally {
        pending.delete(writing); if (!pending.size) this.chunks.delete(id);
        const remaining = (this.users.get(principal) ?? 1) - 1;
        if (remaining) this.users.set(principal, remaining); else this.users.delete(principal);
        --this.active; writing.finish();
      }
    }
  }
  async complete(space: Space, session: Session | undefined, id: string, meta: ItemMeta = {}) {
    const upload = this.authorized(space, session, id);
    if (this.completing.has(id) || this.chunks.has(id)) throw new ApiError(409, 'UPLOAD_IN_PROGRESS');
    const completing = work();
    this.completing.set(id, completing);
    const { repo, files } = this.service;
    let body: ReadableStream<Uint8Array> | undefined;
    try {
      const chunks = repo.chunks(id);
      const count = Math.ceil(upload.size / upload.chunkSize);
      if (chunks.length !== count || chunks.some((chunk, index) => chunk.index !== index)) throw new ApiError(400, 'UPLOAD_INCOMPLETE');
      if (chunks.reduce((total, chunk) => total + chunk.size, 0) !== upload.size ||
          chunks.some((chunk, index) => chunk.size !== Math.min(upload.chunkSize, upload.size - index * upload.chunkSize))) throw new ApiError(400, 'UPLOAD_INCOMPLETE');
      body = files.concatenate(chunks.map(chunk => chunk.key));
      return await this.service.upload(space, session, body, upload.filename, upload.mime,
        upload.size, id, completing.controller.signal, meta);
    } finally {
      await body?.cancel().catch(() => {});
      try { repo.deleteUpload(id); }
      finally { this.completing.delete(id); completing.finish(); }
      // The durable queue is retried by maintenance on I/O failure. A successful
      // item commit must not turn into a failed response because of garbage I/O.
      await this.service.flushGarbage().catch(() => console.error('Upload cleanup failed; will retry'));
    }
  }
  private async abort(ids: string[]) {
    const pending: Promise<void>[] = [];
    for (const id of ids) {
      const tasks = [...this.chunks.get(id) ?? []];
      const completing = this.completing.get(id);
      if (completing) tasks.push(completing);
      for (const task of tasks) {
        task.controller.abort(); pending.push(task.done);
      }
    }
    await Promise.all(pending);
  }
  async cancel(space: Space, session: Session | undefined, id: string) {
    this.authorized(space, session, id);
    this.service.repo.deleteUpload(id);
    await this.abort([id]);
    await this.service.flushGarbage();
  }
  async cancelUser(userId: string) {
    await this.abort(this.service.repo.deleteUserUploads(userId));
    await this.service.flushGarbage();
  }
  async expire() { await this.abort(this.service.repo.expireUploads(this.service.now())); }
}
