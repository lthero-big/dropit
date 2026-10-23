import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Config } from './config.js';
import { ApiError, cleanFilename, hash, publicItem, token, type Item, type Session, type Space } from './domain.js';
import type { FileStorage } from './files.js';
import type { Broadcaster } from './events.js';
import type { Repository } from './repository.js';

export class ClipboardService {
  private activeUploads = 0;
  private cleaning: Promise<void> | undefined;
  constructor(readonly config: Config, readonly repo: Repository, readonly files: FileStorage,
    readonly events: Broadcaster, readonly now: () => number = Date.now) {}

  requireSession(session: Session | undefined): Session {
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED');
    return session;
  }
  admin(session: Session | undefined) {
    const auth = this.requireSession(session);
    if (auth.user.role !== 'admin') throw new ApiError(403, 'FORBIDDEN');
    return auth;
  }
  space(id: string, session: Session | undefined) {
    const auth = this.requireSession(session);
    const space = this.repo.space(id);
    if (!space || space.roomHash || !this.repo.isMember(id, auth.user.id)) throw new ApiError(404, 'NOT_FOUND');
    return space;
  }
  room(roomToken: string) {
    const space = this.repo.room(hash(roomToken), this.now());
    if (!space) throw new ApiError(404, 'NOT_FOUND');
    return space;
  }
  createRoom() {
    const roomToken = token();
    const space: Space = { id: randomUUID(), name: 'Temporary room', ownerId: null,
      expiresAt: this.now() + this.config.roomRetentionMs, roomHash: hash(roomToken) };
    this.repo.createRoom(space);
    return { token: roomToken, expiresAt: space.expiresAt, url: `${this.config.origin}/rooms/${roomToken}` };
  }
  createInvite(session: Session | undefined, spaceId: string, maxUses: number, hours: number) {
    const auth = this.admin(session);
    this.space(spaceId, auth);
    const inviteToken = token();
    const invite = { id: randomUUID(), tokenHash: hash(inviteToken), spaceId, maxUses,
      uses: 0, expiresAt: this.now() + hours * 3600000, revoked: 0, createdBy: auth.user.id };
    this.repo.createInvite(invite);
    const { tokenHash: _hash, ...publicInvite } = invite;
    return { ...publicInvite, token: inviteToken, url: `${this.config.origin}/invite/${inviteToken}` };
  }
  snapshot(space: Space) {
    return { type: 'snapshot', items: this.repo.items(space.id, this.now()).map(publicItem), serverTime: this.now(), expiresAt: space.expiresAt };
  }
  private baseItem(space: Space, session: Session | undefined): Item {
    const now = this.now();
    return { id: randomUUID(), spaceId: space.id, userId: space.roomHash ? null : session!.user.id,
      kind: 'text', text: null, filename: null, mime: null, size: 0, storedBytes: 0,
      fileKey: null, thumbnailKey: null, createdAt: now, updatedAt: now,
      expiresAt: Math.min(now + this.config.retentionMs, space.expiresAt ?? Infinity) };
  }
  private commit(item: Item, room: boolean) {
    const quota = room ? this.config.roomQuotaBytes : (this.repo.quotaOverride(item.userId!) ?? this.config.userQuotaBytes);
    this.repo.addItem(item, quota, room ? Math.min(100, this.config.maxItems) : this.config.maxItems);
    this.events.publish(item.spaceId, { type: 'item.created', item: publicItem(item) });
    return publicItem(item);
  }
  text(space: Space, session: Session | undefined, text: string) {
    const size = Buffer.byteLength(text);
    if (!text.trim()) throw new ApiError(400, 'EMPTY_TEXT');
    if (size > this.config.maxTextBytes) throw new ApiError(413, 'TEXT_TOO_LARGE');
    return this.commit({ ...this.baseItem(space, session), text, size, storedBytes: size }, Boolean(space.roomHash));
  }
  editText(space: Space, session: Session | undefined, id: string, text: string) {
    const current = this.item(space, id);
    if (current.kind !== 'text') throw new ApiError(400, 'INVALID_INPUT');
    // Rooms: any capability holder. Spaces: the author only, so an owner cannot rewrite someone else.
    if (!space.roomHash && current.userId !== session?.user.id) throw new ApiError(403, 'FORBIDDEN');
    const size = Buffer.byteLength(text);
    if (!text.trim()) throw new ApiError(400, 'EMPTY_TEXT');
    if (size > this.config.maxTextBytes) throw new ApiError(413, 'TEXT_TOO_LARGE');
    const quota = space.roomHash ? this.config.roomQuotaBytes : (this.repo.quotaOverride(current.userId!) ?? this.config.userQuotaBytes);
    const updated = this.repo.replaceText(id, text, size, quota, this.now());
    const item = publicItem(updated);
    this.events.publish(space.id, { type: 'item.updated', item });
    return item;
  }
  async upload(space: Space, session: Session | undefined, body: ReadableStream<Uint8Array>, filename: string, mime: string) {
    if (this.activeUploads >= 4) throw new ApiError(429, 'UPLOAD_BUSY');
    ++this.activeUploads;
    let fileKey: string | undefined;
    let thumbnailKey: string | undefined;
    try {
      const limit = space.roomHash ? this.config.roomMaxFileBytes : this.config.maxFileBytes;
      const saved = await this.files.write(body, limit);
      fileKey = saved.key;
      let thumbnailSize = 0;
      if (['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(mime)) {
        let thumbnail: Buffer;
        try {
          const image = sharp(await this.files.bytes(fileKey), { limitInputPixels: 16 * 1024 ** 2, animated: false });
          const metadata = await image.metadata();
          if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'heif'].includes(metadata.format ?? '')) throw new Error('Not a raster');
          thumbnail = await image.rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
        } catch { throw new ApiError(415, 'INVALID_IMAGE'); }
        const savedThumb = await this.files.write(new Blob([new Uint8Array(thumbnail)]).stream(), 1024 ** 2);
        thumbnailKey = savedThumb.key;
        thumbnailSize = savedThumb.size;
      }
      const item = this.commit({ ...this.baseItem(space, session), kind: 'file', fileKey,
        thumbnailKey: thumbnailKey ?? null, filename: cleanFilename(filename), mime,
        size: saved.size, storedBytes: saved.size + thumbnailSize }, Boolean(space.roomHash));
      this.files.commit(fileKey);
      if (thumbnailKey) this.files.commit(thumbnailKey);
      return item;
    } catch (error) {
      for (const key of [fileKey, thumbnailKey]) if (key) await this.files.remove(key);
      throw error;
    } finally { --this.activeUploads; }
  }
  item(space: Space, id: string) {
    const item = this.repo.item(id, this.now());
    if (!item || item.spaceId !== space.id) throw new ApiError(404, 'NOT_FOUND');
    return item;
  }
  async retract(space: Space, id: string, session: Session | undefined) {
    const item = this.item(space, id);
    if (!space.roomHash && item.userId !== session?.user.id && space.ownerId !== session?.user.id) throw new ApiError(403, 'FORBIDDEN');
    this.repo.deleteItem(id);
    this.events.publish(space.id, { type: 'item.deleted', id });
    await this.flushGarbage();
  }
  async flushGarbage() {
    for (const key of this.repo.garbage()) {
      await this.files.remove(key);
      this.repo.forgetGarbage(key);
    }
  }
  cleanup() {
    if (this.cleaning) return this.cleaning;
    this.cleaning = (async () => {
      for (const item of this.repo.expire(this.now())) this.events.publish(item.spaceId, { type: 'item.deleted', id: item.id });
      this.events.revalidate();
      await this.flushGarbage();
      await this.files.sweep(this.repo.fileKeys(), this.now() - 3600000);
    })().finally(() => { this.cleaning = undefined; });
    return this.cleaning;
  }
}
