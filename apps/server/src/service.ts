import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Config } from './config.js';
import { ApiError, MAX_GROUPS, cleanFilename, cleanGroupName, hash, publicItem, publicShareItem, token, type Item, type ItemMeta, type Session, type SharePublic, type Space } from './domain.js';
import type { FileStorage } from './files.js';
import type { Broadcaster } from './events.js';
import type { Repository } from './repository.js';
import { sniffRaster } from './media.js';
import { UploadService } from './uploads.js';

export class ClipboardService {
  readonly uploads = new UploadService(this);
  private activeUploads = 0;
  private activePreviews = 0;
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
  private canManage(space: Space, authorId: string | null, session: Session | undefined) {
    if (space.roomHash) return;
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED');
    if (authorId !== session.user.id && space.ownerId !== session.user.id) throw new ApiError(403, 'FORBIDDEN');
  }
  private shareExpires(expiresIn: string) {
    const window = expiresIn === '1h' ? 3600000 : expiresIn === '1d' ? 86400000 : expiresIn === '7d' ? 604800000 : expiresIn === 'never' ? null : undefined;
    if (window === undefined) throw new ApiError(400, 'INVALID_INPUT');
    return window === null ? null : this.now() + window;
  }
  createShare(space: Space, session: Session | undefined, itemId: string, expiresIn: string, maxViews: number | null): SharePublic & { token: string; url: string } {
    const item = this.item(space, itemId);
    this.canManage(space, item.userId, session);
    if (maxViews !== null && (!Number.isSafeInteger(maxViews) || maxViews < 1 || maxViews > 100)) throw new ApiError(400, 'INVALID_INPUT');
    const raw = token();
    const share = {
      id: randomUUID(), tokenHash: hash(raw), itemId: item.id, spaceId: space.id, createdBy: session?.user.id ?? null,
      expiresAt: this.shareExpires(expiresIn), maxViews, views: 0, revoked: 0, createdAt: this.now(),
      downloadTicketHash: null, downloadTicketExpiresAt: null,
    };
    this.repo.createShare(share);
    return {
      id: share.id, itemId: share.itemId, expiresAt: share.expiresAt, maxViews: share.maxViews,
      views: share.views, revoked: share.revoked, createdAt: share.createdAt,
      token: raw, url: `${this.config.origin}/s/${raw}`,
    };
  }
  listShares(space: Space, session: Session | undefined, itemId: string) {
    const item = this.item(space, itemId);
    this.canManage(space, item.userId, session);
    return this.repo.sharesForItem(item.id);
  }
  revokeShare(space: Space, session: Session | undefined, shareId: string) {
    const share = this.repo.shareById(shareId);
    if (!share || share.spaceId !== space.id) throw new ApiError(404, 'NOT_FOUND');
    this.canManage(space, share.userId, session);
    this.repo.revokeShare(shareId, space.id);
  }
  private shareToken(raw: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new ApiError(404, 'NOT_FOUND');
    return hash(raw);
  }
  openPublicShare(raw: string) {
    const access = token();
    const opened = this.repo.openShare(this.shareToken(raw), this.now(), hash(access), this.now() + 600000);
    if (!opened) throw new ApiError(404, 'NOT_FOUND');
    return {
      item: publicShareItem(opened.item), linkExpiresAt: opened.linkExpiresAt,
      views: opened.views, maxViews: opened.maxViews, access,
    };
  }
  readPublicShare(raw: string, access: string | undefined) {
    const accessHash = access && access.length <= 128 ? hash(access) : null;
    const item = this.repo.readShare(this.shareToken(raw), this.now(), accessHash);
    if (!item) throw new ApiError(404, 'NOT_FOUND');
    return item;
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
    return { type: 'snapshot', items: this.repo.items(space.id, this.now()).map(publicItem), groups: this.repo.groups(space.id),
      serverTime: this.now(), expiresAt: space.expiresAt };
  }
  groups(space: Space) { return this.repo.groups(space.id); }
  private publishGroups(space: Space) {
    const groups = this.repo.groups(space.id);
    this.events.publish(space.id, { type: 'groups', groups });
    return groups;
  }
  /** Validates an optional group and makes sure it exists (creating it if needed). */
  private resolveGroup(space: Space, value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    const name = cleanGroupName(value);
    if (this.repo.ensureGroup(space.id, name, this.now(), MAX_GROUPS)) this.publishGroups(space);
    return name;
  }
  createGroup(space: Space, name: unknown) {
    this.repo.createGroup(space.id, cleanGroupName(name), this.now(), MAX_GROUPS);
    return this.publishGroups(space);
  }
  renameGroup(space: Space, from: string, to: unknown) {
    const updated = this.repo.renameGroup(space.id, from, cleanGroupName(to), this.now());
    const groups = this.publishGroups(space);
    for (const item of updated) this.events.publish(space.id, { type: 'item.updated', item: publicItem(item) });
    return groups;
  }
  deleteGroup(space: Space, name: string) {
    const updated = this.repo.deleteGroup(space.id, name, this.now());
    const groups = this.publishGroups(space);
    for (const item of updated) this.events.publish(space.id, { type: 'item.updated', item: publicItem(item) });
    return groups;
  }
  private baseItem(space: Space, session: Session | undefined, meta: ItemMeta = {}): Item {
    const now = this.now();
    return { group: this.resolveGroup(space, meta.group), device: meta.device ?? null, id: randomUUID(), spaceId: space.id, userId: space.roomHash ? null : session!.user.id,
      kind: 'text', text: null, filename: null, mime: null, size: 0, storedBytes: 0,
      fileKey: null, thumbnailKey: null, createdAt: now, updatedAt: now, pinned: 0, tags: [],
      expiresAt: Math.min(now + this.config.retentionMs, space.expiresAt ?? Infinity) };
  }
  private commit(item: Item, room: boolean, uploadId?: string) {
    const quota = room ? this.config.roomQuotaBytes : (this.repo.quotaOverride(item.userId!) ?? this.config.userQuotaBytes);
    this.repo.addItem(item, quota, room ? Math.min(100, this.config.maxItems) : this.config.maxItems, uploadId);
    this.events.publish(item.spaceId, { type: 'item.created', item: publicItem(item) });
    return publicItem(item);
  }
  text(space: Space, session: Session | undefined, text: string, meta: ItemMeta = {}) {
    const size = Buffer.byteLength(text);
    if (!text.trim()) throw new ApiError(400, 'EMPTY_TEXT');
    if (size > this.config.maxTextBytes) throw new ApiError(413, 'TEXT_TOO_LARGE');
    return this.commit({ ...this.baseItem(space, session, meta), text, size, storedBytes: size }, Boolean(space.roomHash));
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
  private normalizeTags(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 8) throw new ApiError(400, 'INVALID_INPUT');
    const tags: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') throw new ApiError(400, 'INVALID_INPUT');
      const tag = entry.trim().replace(/^#+/, '').trim();
      if ([...tag].length < 1 || [...tag].length > 24 || /\s/.test(tag) || tag.includes(',') || [...tag].some(char => {
        const code = char.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })) throw new ApiError(400, 'INVALID_INPUT');
      if (!tags.includes(tag)) tags.push(tag);
    }
    return tags;
  }
  label(space: Space, session: Session | undefined, id: string, patch: { pinned?: boolean; tags?: unknown; group?: unknown }) {
    const current = this.item(space, id);
    this.canManage(space, current.userId, session);
    if (patch.pinned === undefined && patch.tags === undefined && patch.group === undefined) throw new ApiError(400, 'INVALID_INPUT');
    const tags = patch.tags === undefined ? undefined : this.normalizeTags(patch.tags);
    const group = patch.group === undefined ? undefined : this.resolveGroup(space, patch.group);
    const updated = this.repo.updateLabels(id, {
      pinned: patch.pinned === undefined ? undefined : (patch.pinned ? 1 : 0),
      tags, group,
    }, this.now());
    const item = publicItem(updated);
    this.events.publish(space.id, { type: 'item.updated', item });
    return item;
  }
  private async raster(fileKey: string, edge: number) {
    try {
      const image = sharp(await this.files.bytes(fileKey), { limitInputPixels: 16 * 1024 ** 2, animated: false });
      const metadata = await image.metadata();
      if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'heif'].includes(metadata.format ?? '')) throw new Error('Not a raster');
      return await image.rotate().resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    } catch { throw new ApiError(415, 'INVALID_IMAGE'); }
  }
  async preview(item: Item) {
    // Only files that passed raster validation at upload can be previewed.
    if (!item.fileKey || !item.thumbnailKey) throw new ApiError(404, 'NOT_FOUND');
    if (this.activePreviews >= 2) throw new ApiError(429, 'PREVIEW_BUSY');
    ++this.activePreviews;
    try {
      // Generate on demand: no stored derivative, quota charge or cleanup key.
      const result = await this.raster(item.fileKey, 2048);
      if (!this.repo.item(item.id, this.now())) throw new ApiError(404, 'NOT_FOUND');
      return result;
    } finally { --this.activePreviews; }
  }
  async upload(space: Space, session: Session | undefined, body: ReadableStream<Uint8Array>, filename: string, mime: string, expectedSize?: number, uploadId?: string, signal?: AbortSignal, meta: ItemMeta = {}) {
    if (this.activeUploads >= 4) throw new ApiError(429, 'UPLOAD_BUSY');
    ++this.activeUploads;
    let fileKey: string | undefined;
    let thumbnailKey: string | undefined;
    try {
      const limit = space.roomHash ? this.config.roomMaxFileBytes : this.config.maxFileBytes;
      const saved = await this.files.write(body, limit, { signal });
      fileKey = saved.key;
      if (expectedSize != null && saved.size !== expectedSize) throw new ApiError(400, 'UPLOAD_INCOMPLETE');
      const prefix = uploadId ? await this.files.prefix(fileKey, 4096) : undefined;
      const rasterMime = prefix && sniffRaster(prefix);
      // The session protocol rejects SVG, including SVG disguised as a raster.
      // Legacy uploads retain download-only SVG/HTML compatibility.
      if (prefix && (mime === 'image/svg+xml' || /<svg[\s/>]/i.test(prefix.toString('utf8')))) throw new ApiError(415, 'INVALID_IMAGE');
      let thumbnailSize = 0;
      if (rasterMime || ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(mime)) {
        const thumbnail = await this.raster(fileKey, 320);
        const savedThumb = await this.files.write(new Blob([new Uint8Array(thumbnail)]).stream(), 1024 ** 2, { signal });
        thumbnailKey = savedThumb.key;
        thumbnailSize = savedThumb.size;
      }
      const item = this.commit({ ...this.baseItem(space, session, meta), kind: 'file', fileKey,
        thumbnailKey: thumbnailKey ?? null, filename: cleanFilename(filename), mime,
        size: saved.size, storedBytes: saved.size + thumbnailSize }, Boolean(space.roomHash), uploadId);
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
      await this.uploads.expire();
      for (const item of this.repo.expire(this.now())) this.events.publish(item.spaceId, { type: 'item.deleted', id: item.id });
      this.events.revalidate();
      await this.flushGarbage();
      await this.files.sweep(this.repo.fileKeys(), this.now() - 3600000);
    })().finally(() => { this.cleaning = undefined; });
    return this.cleaning;
  }
}
