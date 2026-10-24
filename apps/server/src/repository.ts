import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError, type AccessToken, type DeviceAuthorization, type Flow, type Identity, type Invite, type Item, type Session, type ShareLink, type SharePublic, type Space, type User } from './domain.js';
import { migration1, migration2, migration3, migration4, migration5, migration6, migration7 } from './migrations.js';
import type { LimitAudit, LimitChange, LimitKey, LimitOverrides } from './limits.js';

type UserRow = User & { quotaBytes: number | null };
type DeviceRow = Omit<DeviceAuthorization, 'scopes'> & { scopes: string };
type TokenRow = Omit<AccessToken, 'scopes'> & { scopes: string };
type DevicePoll = { error: 'expired_token' | 'access_denied' | 'slow_down' | 'authorization_pending'; interval?: number } | { token: AccessToken };

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role, disabled: row.disabled, pending: row.pending, createdAt: row.createdAt };
}

function mapItem(row: Item): Item {
  const stored = row as Item & { tags: string | string[] | null; pinned: number | null };
  let tags: string[] = [];
  if (Array.isArray(stored.tags)) tags = stored.tags.filter((tag): tag is string => typeof tag === 'string');
  else if (typeof stored.tags === 'string' && stored.tags) {
    try {
      const parsed: unknown = JSON.parse(stored.tags);
      if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
    } catch { tags = []; }
  }
  return { ...row, pinned: stored.pinned ? 1 : 0, tags };
}

export interface Repository {
  limitOverrides(): LimitOverrides;
  saveLimitChanges(changes: LimitChange[], actor: { id: string; email: string }, now: number): void;
  limitAudit(limit: number, cursor?: number): LimitAudit[];
  saveFlow(flow: Flow): void;
  consumeFlow(stateHash: string, browserHash: string, provider: string, now: number): Flow | undefined;
  login(identity: Identity, inviteHash: string | null, admins: string[], sessionHash: string, expiresAt: number, now: number): User;
  session(sessionHash: string, now: number): Session | undefined;
  logout(sessionHash: string): void;
  createAccessToken(record: AccessToken, tokenHash: string): void;
  accessTokens(userId?: string): AccessToken[];
  tokenSession(tokenHash: string, now: number, touch?: boolean): Session | undefined;
  renameAccessToken(id: string, userId: string, name: string): void;
  revokeAccessToken(id: string, userId?: string): void;
  createDevice(record: DeviceAuthorization): void;
  deviceForUserCode(userCodeHash: string, verificationId: string | undefined, now: number): DeviceAuthorization | undefined;
  decideDevice(id: string, userId: string, approve: boolean, now: number): void;
  pollDevice(deviceCodeHash: string, now: number, tokenId: string, tokenHash: string): DevicePoll;
  users(): (User & { usedBytes: number; quotaBytes: number | null })[];
  provisionUser(input: { email: string; name: string; role: 'admin' | 'user'; quotaBytes: number | null; now: number }): User;
  updateUser(id: string, patch: { disabled?: boolean; role?: 'admin' | 'user'; name?: string; quotaBytes?: number | null }): void;
  revokeSessions(id: string): void;
  quotaOverride(userId: string): number | null;
  spaces(userId: string): Space[];
  space(id: string): Space | undefined;
  room(roomHash: string, now: number): Space | undefined;
  createRoom(space: Space): void;
  isMember(spaceId: string, userId: string): boolean;
  invite(tokenHash: string, now: number): Invite | undefined;
  createInvite(invite: Invite): void;
  invites(): Omit<Invite, 'tokenHash'>[];
  revokeInvite(id: string): void;
  usage(userId: string): number;
  items(spaceId: string, now: number): Item[];
  item(id: string, now: number): Item | undefined;
  addItem(item: Item, quota: number, maxItems: number): void;
  replaceText(id: string, text: string, size: number, quota: number, now: number): Item;
  deleteItem(id: string): Item | undefined;
  updateLabels(id: string, patch: { pinned?: 0 | 1; tags?: string[] }, now: number): Item;
  createShare(share: ShareLink): void;
  sharesForItem(itemId: string): SharePublic[];
  shareById(id: string): (SharePublic & { spaceId: string; userId: string | null }) | undefined;
  revokeShare(id: string, spaceId: string): void;
  openShare(tokenHash: string, now: number, ticketHash: string, ticketExpiresAt: number): { item: Item; linkExpiresAt: number | null; maxViews: number | null; views: number } | undefined;
  readShare(tokenHash: string, now: number, accessHash: string | null): Item | undefined;
  expire(now: number): Item[];
  garbage(): string[];
  forgetGarbage(key: string): void;
  fileKeys(): Set<string>;
  close(): void;
}

export class SqliteRepository implements Repository {
  private db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 7) throw new Error(`Unsupported schema version ${version}`);
    if (version < 7) this.db.transaction(() => {
      if (version < 1) this.db.exec(migration1);
      if (version < 2) this.db.exec(migration2);
      if (version < 3) this.db.exec(migration3);
      if (version < 4) this.db.exec(migration4);
      if (version < 5) this.db.exec(migration5);
      if (version < 6) this.db.exec(migration6);
      this.db.exec(migration7);
    })();
  }
  limitOverrides(): LimitOverrides {
    const rows = this.db.prepare('SELECT key,value FROM runtime_limits').all() as { key: LimitKey; value: number }[];
    return Object.fromEntries(rows.map(row => [row.key, row.value]));
  }
  saveLimitChanges(changes: LimitChange[], actor: { id: string; email: string }, now: number) {
    this.db.transaction(() => {
      for (const change of changes) {
        if (change.newOverride === null) this.db.prepare('DELETE FROM runtime_limits WHERE key=?').run(change.key);
        else this.db.prepare('INSERT INTO runtime_limits (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(change.key, change.newOverride);
        this.db.prepare(`INSERT INTO limit_audit (actorId,actorEmail,createdAt,key,oldValue,newValue,oldOverride,newOverride)
          VALUES (@actorId,@actorEmail,@createdAt,@key,@oldValue,@newValue,@oldOverride,@newOverride)`)
          .run({ ...change, actorId: actor.id, actorEmail: actor.email, createdAt: now });
      }
    })();
  }
  limitAudit(limit: number, cursor?: number) {
    return this.db.prepare('SELECT * FROM limit_audit WHERE id < ? ORDER BY id DESC LIMIT ?')
      .all(cursor ?? Number.MAX_SAFE_INTEGER, limit) as LimitAudit[];
  }
  saveFlow(flow: Flow) {
    this.db.prepare('INSERT INTO flows VALUES (@stateHash,@browserHash,@provider,@verifier,@inviteHash,@expiresAt)').run(flow);
  }
  consumeFlow(stateHash: string, browserHash: string, provider: string, now: number) {
    return this.db.transaction(() => {
      const flow = this.db.prepare('SELECT * FROM flows WHERE stateHash=? AND browserHash=? AND provider=? AND expiresAt>?')
        .get(stateHash, browserHash, provider, now) as Flow | undefined;
      if (flow) this.db.prepare('DELETE FROM flows WHERE stateHash=?').run(stateHash);
      return flow;
    })();
  }
  login(identity: Identity, inviteHash: string | null, admins: string[], sessionHash: string, expiresAt: number, now: number) {
    return this.db.transaction(() => {
      let row = this.db.prepare('SELECT u.* FROM users u JOIN identities i ON i.userId=u.id WHERE i.provider=? AND i.subject=?')
        .get(identity.provider, identity.subject) as UserRow | undefined;
      if (row?.disabled) throw new ApiError(403, 'USER_DISABLED');
      const invite = inviteHash ? this.invite(inviteHash, now) : undefined;
      if (!row) {
        const pending = this.db.prepare('SELECT * FROM users WHERE pending=1 AND lower(email)=lower(?)').get(identity.email) as UserRow | undefined;
        // A disabled pre-provisioned account must not be bypassed by creating a second user.
        if (pending?.disabled) throw new ApiError(403, 'USER_DISABLED');
        if (pending) {
          this.db.prepare('UPDATE users SET pending=0 WHERE id=?').run(pending.id);
          this.db.prepare('INSERT INTO identities (provider,subject,userId) VALUES (?,?,?)').run(identity.provider, identity.subject, pending.id);
          row = { ...pending, pending: 0 };
        }
      }
      if (!row) {
        // BEGIN IMMEDIATE holds the reserved lock across this count and the insert,
        // so two concurrent sign-ins cannot both observe an empty users table.
        const first = (this.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n === 0;
        // A missing or stale invite must not block the empty-database bootstrap.
        if (inviteHash && !invite && !first) throw new ApiError(403, 'INVITE_INVALID');
        const listed = admins.includes(identity.email.toLowerCase());
        if (!first && !listed && !invite) throw new ApiError(403, 'INVITATION_REQUIRED');
        const admin = first || listed;
        row = { id: randomUUID(), email: identity.email, name: identity.name, role: admin ? 'admin' : 'user', disabled: 0, pending: 0, createdAt: now, quotaBytes: null };
        this.db.prepare('INSERT INTO users (id,email,name,role,disabled,createdAt,pending,quotaBytes) VALUES (@id,@email,@name,@role,@disabled,@createdAt,@pending,@quotaBytes)').run(row);
        this.db.prepare('INSERT INTO identities (provider,subject,userId) VALUES (?,?,?)').run(identity.provider, identity.subject, row.id);
        const spaceId = randomUUID();
        this.db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES (?,?,?,NULL,NULL)').run(spaceId, 'Private space', row.id);
        this.db.prepare('INSERT INTO members (spaceId,userId) VALUES (?,?)').run(spaceId, row.id);
      } else if (inviteHash && !invite) throw new ApiError(403, 'INVITE_INVALID');
      if (invite) {
        // Membership already held: login is idempotent and does not spend another use.
        if (!this.isMember(invite.spaceId, row.id)) {
          const result = this.db.prepare('UPDATE invites SET uses=uses+1 WHERE id=? AND uses<maxUses AND revoked=0 AND expiresAt>?').run(invite.id, now);
          if (result.changes !== 1) throw new ApiError(403, 'INVITE_INVALID');
          this.db.prepare('INSERT INTO members (spaceId,userId) VALUES (?,?)').run(invite.spaceId, row.id);
        }
      }
      this.db.prepare('INSERT INTO sessions (sessionHash,userId,expiresAt) VALUES (?,?,?)').run(sessionHash, row.id, expiresAt);
      return toUser(row);
    }).immediate();
  }
  session(sessionHash: string, now: number): Session | undefined {
    const row = this.db.prepare('SELECT u.*, s.expiresAt FROM sessions s JOIN users u ON u.id=s.userId WHERE s.sessionHash=? AND s.expiresAt>? AND u.disabled=0')
      .get(sessionHash, now) as (UserRow & { expiresAt: number }) | undefined;
    if (!row) return undefined;
    return { user: toUser(row), expiresAt: row.expiresAt, sessionHash };
  }
  logout(sessionHash: string) { this.db.prepare('DELETE FROM sessions WHERE sessionHash=?').run(sessionHash); }
  createAccessToken(record: AccessToken, tokenHash: string) {
    this.db.prepare(`INSERT INTO access_tokens (id,tokenHash,userId,name,scopes,createdAt,lastUsedAt,expiresAt,revoked)
      VALUES (@id,@tokenHash,@userId,@name,@scopes,@createdAt,@lastUsedAt,@expiresAt,@revoked)`)
      .run({ ...record, scopes: JSON.stringify(record.scopes), tokenHash });
  }
  accessTokens(userId?: string) {
    const columns = 'id,userId,name,scopes,createdAt,lastUsedAt,expiresAt,revoked';
    const rows = userId === undefined ? this.db.prepare(`SELECT ${columns} FROM access_tokens ORDER BY createdAt DESC,id DESC`).all() :
      this.db.prepare(`SELECT ${columns} FROM access_tokens WHERE userId=? ORDER BY createdAt DESC,id DESC`).all(userId);
    return (rows as TokenRow[]).map(row => ({ ...row, scopes: JSON.parse(row.scopes) as AccessToken['scopes'] }));
  }
  tokenSession(tokenHash: string, now: number, touch = true): Session | undefined {
    const row = this.db.prepare(`SELECT u.*, t.id AS tokenId, t.scopes, t.expiresAt FROM access_tokens t
      JOIN users u ON u.id=t.userId WHERE t.tokenHash=? AND t.revoked=0 AND u.disabled=0 AND u.pending=0
      AND (t.expiresAt IS NULL OR t.expiresAt>?)`).get(tokenHash, now) as
      (UserRow & { tokenId: string; scopes: string; expiresAt: number | null }) | undefined;
    if (!row) return undefined;
    if (touch) this.db.prepare('UPDATE access_tokens SET lastUsedAt=? WHERE id=?').run(now, row.tokenId);
    return { user: toUser(row), sessionHash: '', expiresAt: row.expiresAt ?? Infinity,
      bearer: { id: row.tokenId, scopes: JSON.parse(row.scopes) as AccessToken['scopes'] } };
  }
  renameAccessToken(id: string, userId: string, name: string) {
    if (!this.db.prepare('UPDATE access_tokens SET name=? WHERE id=? AND userId=?').run(name, id, userId).changes) throw new ApiError(404, 'NOT_FOUND');
  }
  revokeAccessToken(id: string, userId?: string) {
    const result = userId === undefined ? this.db.prepare('UPDATE access_tokens SET revoked=1 WHERE id=?').run(id) :
      this.db.prepare('UPDATE access_tokens SET revoked=1 WHERE id=? AND userId=?').run(id, userId);
    if (!result.changes) throw new ApiError(404, 'NOT_FOUND');
  }
  createDevice(record: DeviceAuthorization) {
    this.db.prepare(`INSERT INTO device_authorizations
      (id,deviceCodeHash,userCodeHash,name,ipSummary,scopes,tokenLifetimeMs,expiresAt,interval,nextPollAt,attempts,status,userId)
      VALUES (@id,@deviceCodeHash,@userCodeHash,@name,@ipSummary,@scopes,@tokenLifetimeMs,@expiresAt,@interval,@nextPollAt,@attempts,@status,@userId)`)
      .run({ ...record, scopes: JSON.stringify(record.scopes) });
  }
  deviceForUserCode(userCodeHash: string, verificationId: string | undefined, now: number) {
    return this.db.transaction(() => {
      const row = verificationId ? this.db.prepare('SELECT * FROM device_authorizations WHERE id=?').get(verificationId) :
        this.db.prepare('SELECT * FROM device_authorizations WHERE userCodeHash=?').get(userCodeHash);
      const device = row as DeviceRow | undefined;
      if (!device || device.expiresAt <= now || device.status !== 'pending') return undefined;
      if (device.userCodeHash !== userCodeHash) {
        this.db.prepare(`UPDATE device_authorizations SET attempts=attempts+1,
          status=CASE WHEN attempts+1>=5 THEN 'denied' ELSE status END WHERE id=?`).run(device.id);
        return undefined;
      }
      return { ...device, scopes: JSON.parse(device.scopes) as DeviceAuthorization['scopes'] };
    }).immediate();
  }
  decideDevice(id: string, userId: string, approve: boolean, now: number) {
    if (!this.db.prepare(`UPDATE device_authorizations SET status=?,userId=? WHERE id=? AND status='pending' AND expiresAt>?`)
      .run(approve ? 'approved' : 'denied', userId, id, now).changes) throw new ApiError(404, 'NOT_FOUND');
  }
  pollDevice(deviceCodeHash: string, now: number, tokenId: string, tokenHash: string): DevicePoll {
    return this.db.transaction((): DevicePoll => {
      const device = this.db.prepare('SELECT * FROM device_authorizations WHERE deviceCodeHash=?').get(deviceCodeHash) as DeviceRow | undefined;
      if (!device || device.expiresAt <= now || device.status === 'consumed') return { error: 'expired_token' };
      if (device.status === 'denied') return { error: 'access_denied' };
      if (now < device.nextPollAt) {
        const interval = device.interval + 5;
        this.db.prepare('UPDATE device_authorizations SET interval=?,nextPollAt=? WHERE id=?').run(interval, now + interval * 1000, device.id);
        return { error: 'slow_down', interval };
      }
      this.db.prepare('UPDATE device_authorizations SET nextPollAt=? WHERE id=?').run(now + device.interval * 1000, device.id);
      if (device.status === 'pending') return { error: 'authorization_pending' };
      const user = this.db.prepare('SELECT disabled,pending FROM users WHERE id=?').get(device.userId) as Pick<User, 'disabled' | 'pending'> | undefined;
      if (!user || user.disabled || user.pending) {
        this.db.prepare("UPDATE device_authorizations SET status='denied' WHERE id=?").run(device.id);
        return { error: 'access_denied' };
      }
      const record: AccessToken = { id: tokenId, userId: device.userId!, name: device.name,
        scopes: JSON.parse(device.scopes) as AccessToken['scopes'], createdAt: now, lastUsedAt: null,
        expiresAt: device.tokenLifetimeMs === null ? null : now + device.tokenLifetimeMs, revoked: 0 };
      this.createAccessToken(record, tokenHash);
      this.db.prepare("UPDATE device_authorizations SET status='consumed' WHERE id=?").run(device.id);
      return { token: record };
    }).immediate();
  }
  users() {
    return this.db.prepare(`SELECT u.id,u.email,u.name,u.role,u.disabled,u.createdAt,u.pending,u.quotaBytes,
      coalesce((SELECT sum(storedBytes) FROM items WHERE userId=u.id),0) AS usedBytes
      FROM users u ORDER BY createdAt`).all() as (User & { usedBytes: number; quotaBytes: number | null })[];
  }
  provisionUser(input: { email: string; name: string; role: 'admin' | 'user'; quotaBytes: number | null; now: number }) {
    return this.db.transaction(() => {
      const taken = this.db.prepare('SELECT 1 FROM users WHERE lower(email)=lower(?)').get(input.email);
      if (taken) throw new ApiError(409, 'EMAIL_IN_USE');
      const row: UserRow = { id: randomUUID(), email: input.email, name: input.name, role: input.role, disabled: 0, pending: 1, createdAt: input.now, quotaBytes: input.quotaBytes };
      this.db.prepare('INSERT INTO users (id,email,name,role,disabled,createdAt,pending,quotaBytes) VALUES (@id,@email,@name,@role,@disabled,@createdAt,@pending,@quotaBytes)').run(row);
      const spaceId = randomUUID();
      this.db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES (?,?,?,NULL,NULL)').run(spaceId, 'Private space', row.id);
      this.db.prepare('INSERT INTO members (spaceId,userId) VALUES (?,?)').run(spaceId, row.id);
      return toUser(row);
    }).immediate();
  }
  updateUser(id: string, patch: { disabled?: boolean; role?: 'admin' | 'user'; name?: string; quotaBytes?: number | null }) {
    this.db.transaction(() => {
      const user = this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow | undefined;
      if (!user) throw new ApiError(404, 'NOT_FOUND');
      const nextDisabled = patch.disabled ?? Boolean(user.disabled);
      const nextRole = patch.role ?? user.role;
      const wasEnabledAdmin = user.role === 'admin' && user.disabled === 0;
      const staysEnabledAdmin = nextRole === 'admin' && !nextDisabled;
      if (wasEnabledAdmin && !staysEnabledAdmin) {
        const { n } = this.db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled=0").get() as { n: number };
        if (n <= 1) throw new ApiError(409, 'LAST_ADMIN');
      }
      this.db.prepare('UPDATE users SET disabled=?, role=?, name=?, quotaBytes=? WHERE id=?').run(
        Number(nextDisabled), nextRole, patch.name ?? user.name,
        patch.quotaBytes === undefined ? user.quotaBytes : patch.quotaBytes, id);
      if (nextDisabled && user.disabled === 0) {
        this.db.prepare('DELETE FROM sessions WHERE userId=?').run(id);
        this.db.prepare('UPDATE access_tokens SET revoked=1 WHERE userId=?').run(id);
        this.db.prepare("UPDATE device_authorizations SET status='denied' WHERE userId=? AND status='approved'").run(id);
      }
    }).immediate();
  }
  revokeSessions(id: string) {
    if (!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) throw new ApiError(404, 'NOT_FOUND');
    this.db.prepare('DELETE FROM sessions WHERE userId=?').run(id);
  }
  quotaOverride(userId: string) {
    const row = this.db.prepare('SELECT quotaBytes FROM users WHERE id=?').get(userId) as { quotaBytes: number | null } | undefined;
    return row?.quotaBytes ?? null;
  }
  spaces(userId: string) { return this.db.prepare('SELECT s.* FROM spaces s JOIN members m ON m.spaceId=s.id WHERE m.userId=?').all(userId) as Space[]; }
  space(id: string) { return this.db.prepare('SELECT * FROM spaces WHERE id=?').get(id) as Space | undefined; }
  room(roomHash: string, now: number) { return this.db.prepare('SELECT * FROM spaces WHERE roomHash=? AND expiresAt>?').get(roomHash, now) as Space | undefined; }
  createRoom(space: Space) { this.db.prepare('INSERT INTO spaces VALUES (@id,@name,@ownerId,@expiresAt,@roomHash)').run(space); }
  isMember(spaceId: string, userId: string) { return Boolean(this.db.prepare('SELECT 1 FROM members WHERE spaceId=? AND userId=?').get(spaceId, userId)); }
  invite(tokenHash: string, now: number) {
    return this.db.prepare('SELECT * FROM invites WHERE tokenHash=? AND revoked=0 AND uses<maxUses AND expiresAt>?').get(tokenHash, now) as Invite | undefined;
  }
  createInvite(invite: Invite) {
    this.db.prepare('INSERT INTO invites VALUES (@id,@tokenHash,@spaceId,@maxUses,@uses,@expiresAt,@revoked,@createdBy)').run(invite);
  }
  invites() { return this.db.prepare('SELECT id,spaceId,maxUses,uses,expiresAt,revoked,createdBy FROM invites ORDER BY expiresAt DESC').all() as Omit<Invite, 'tokenHash'>[]; }
  revokeInvite(id: string) {
    if (!this.db.prepare('UPDATE invites SET revoked=1 WHERE id=?').run(id).changes) throw new ApiError(404, 'NOT_FOUND');
  }
  usage(userId: string) { return (this.db.prepare('SELECT coalesce(sum(storedBytes),0) AS n FROM items WHERE userId=?').get(userId) as { n: number }).n; }
  items(spaceId: string, now: number) {
    return (this.db.prepare('SELECT * FROM items WHERE spaceId=? AND expiresAt>? ORDER BY pinned DESC, createdAt DESC, id DESC').all(spaceId, now) as Item[]).map(mapItem);
  }
  item(id: string, now: number) {
    const row = this.db.prepare('SELECT * FROM items WHERE id=? AND expiresAt>?').get(id, now) as Item | undefined;
    return row ? mapItem(row) : undefined;
  }
  addItem(item: Item, quota: number, maxItems: number) {
    this.db.transaction(() => {
      const space = this.space(item.spaceId);
      if (!space || (space.expiresAt !== null && space.expiresAt <= item.createdAt)) throw new ApiError(404, 'NOT_FOUND');
      // Revalidate membership/disabled status after streaming, immediately before committing.
      if (item.userId) {
        const user = this.db.prepare('SELECT disabled FROM users WHERE id=?').get(item.userId) as { disabled: number } | undefined;
        if (!user || user.disabled || !this.isMember(item.spaceId, item.userId)) throw new ApiError(403, 'FORBIDDEN');
      }
      const used = item.userId ? this.usage(item.userId) :
        (this.db.prepare('SELECT coalesce(sum(storedBytes),0) AS n FROM items WHERE spaceId=?').get(item.spaceId) as { n: number }).n;
      const count = (this.db.prepare('SELECT count(*) AS n FROM items WHERE spaceId=?').get(item.spaceId) as { n: number }).n;
      if (used + item.storedBytes > quota) throw new ApiError(413, 'QUOTA_EXCEEDED');
      if (count >= maxItems) throw new ApiError(413, 'ITEM_LIMIT');
      this.db.prepare(`INSERT INTO items (id,spaceId,userId,kind,text,filename,mime,size,storedBytes,fileKey,thumbnailKey,createdAt,expiresAt,updatedAt)
        VALUES (@id,@spaceId,@userId,@kind,@text,@filename,@mime,@size,@storedBytes,@fileKey,@thumbnailKey,@createdAt,@expiresAt,@updatedAt)`).run(item);
    }).immediate();
  }
  replaceText(id: string, text: string, size: number, quota: number, now: number) {
    return this.db.transaction(() => {
      const current = this.item(id, now);
      if (!current || current.kind !== 'text') throw new ApiError(404, 'NOT_FOUND');
      const space = this.space(current.spaceId);
      if (!space || (space.expiresAt !== null && space.expiresAt <= now)) throw new ApiError(404, 'NOT_FOUND');
      if (current.userId) {
        const user = this.db.prepare('SELECT disabled FROM users WHERE id=?').get(current.userId) as { disabled: number } | undefined;
        if (!user || user.disabled || !this.isMember(current.spaceId, current.userId)) throw new ApiError(403, 'FORBIDDEN');
      }
      const delta = size - current.storedBytes;
      if (delta > 0) {
        const used = current.userId ? this.usage(current.userId) :
          (this.db.prepare('SELECT coalesce(sum(storedBytes),0) AS n FROM items WHERE spaceId=?').get(current.spaceId) as { n: number }).n;
        if (used + delta > quota) throw new ApiError(413, 'QUOTA_EXCEEDED');
      }
      this.db.prepare('UPDATE items SET text=?, size=?, storedBytes=?, updatedAt=? WHERE id=?').run(text, size, size, now, id);
      return { ...current, text, size, storedBytes: size, updatedAt: now };
    }).immediate();
  }
  deleteItem(id: string) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM items WHERE id=?').get(id) as Item | undefined;
      const item = row ? mapItem(row) : undefined;
      if (item) {
        for (const key of [item.fileKey, item.thumbnailKey]) if (key) this.db.prepare('INSERT OR IGNORE INTO garbage VALUES (?)').run(key);
        this.db.prepare('DELETE FROM items WHERE id=?').run(id);
      }
      return item;
    })();
  }
  updateLabels(id: string, patch: { pinned?: 0 | 1; tags?: string[] }, now: number) {
    return this.db.transaction(() => {
      const current = this.item(id, now);
      if (!current) throw new ApiError(404, 'NOT_FOUND');
      const space = this.space(current.spaceId);
      if (!space || (space.expiresAt !== null && space.expiresAt <= now)) throw new ApiError(404, 'NOT_FOUND');
      if (current.userId) {
        const user = this.db.prepare('SELECT disabled FROM users WHERE id=?').get(current.userId) as { disabled: number } | undefined;
        if (!user || user.disabled || !this.isMember(current.spaceId, current.userId)) throw new ApiError(403, 'FORBIDDEN');
      }
      const pinned = patch.pinned ?? current.pinned;
      const tags = patch.tags ?? current.tags;
      this.db.prepare('UPDATE items SET pinned=?, tags=? WHERE id=?').run(pinned, JSON.stringify(tags), id);
      return { ...current, pinned, tags };
    }).immediate();
  }
  createShare(share: ShareLink) {
    this.db.prepare(`INSERT INTO shares (id,tokenHash,itemId,spaceId,createdBy,expiresAt,maxViews,views,revoked,createdAt,downloadTicketHash,downloadTicketExpiresAt)
      VALUES (@id,@tokenHash,@itemId,@spaceId,@createdBy,@expiresAt,@maxViews,@views,@revoked,@createdAt,@downloadTicketHash,@downloadTicketExpiresAt)`).run(share);
  }
  sharesForItem(itemId: string) {
    return this.db.prepare('SELECT id,itemId,expiresAt,maxViews,views,revoked,createdAt FROM shares WHERE itemId=? ORDER BY createdAt DESC,id DESC').all(itemId) as SharePublic[];
  }
  shareById(id: string) {
    return this.db.prepare(`SELECT s.id,s.itemId,s.spaceId,s.expiresAt,s.maxViews,s.views,s.revoked,s.createdAt,i.userId
      FROM shares s JOIN items i ON i.id=s.itemId WHERE s.id=?`).get(id) as (SharePublic & { spaceId: string; userId: string | null }) | undefined;
  }
  revokeShare(id: string, spaceId: string) {
    if (!this.db.prepare('UPDATE shares SET revoked=1 WHERE id=? AND spaceId=?').run(id, spaceId).changes) throw new ApiError(404, 'NOT_FOUND');
  }
  private activeShare(tokenHash: string, now: number) {
    const share = this.db.prepare('SELECT * FROM shares WHERE tokenHash=?').get(tokenHash) as ShareLink | undefined;
    if (!share || share.revoked || (share.expiresAt !== null && share.expiresAt <= now)) return undefined;
    const item = this.item(share.itemId, now);
    if (!item || item.spaceId !== share.spaceId) return undefined;
    const space = this.space(item.spaceId);
    if (!space || (space.expiresAt !== null && space.expiresAt <= now)) return undefined;
    return { share, item };
  }
  openShare(tokenHash: string, now: number, ticketHash: string, ticketExpiresAt: number) {
    return this.db.transaction(() => {
      const loaded = this.activeShare(tokenHash, now);
      if (!loaded) return undefined;
      const updated = this.db.prepare(`UPDATE shares SET views=views+1, downloadTicketHash=?, downloadTicketExpiresAt=?
        WHERE id=? AND revoked=0 AND (maxViews IS NULL OR views<maxViews)`).run(ticketHash, ticketExpiresAt, loaded.share.id);
      if (updated.changes !== 1) return undefined;
      return { item: loaded.item, linkExpiresAt: loaded.share.expiresAt, maxViews: loaded.share.maxViews, views: loaded.share.views + 1 };
    }).immediate();
  }
  readShare(tokenHash: string, now: number, accessHash: string | null) {
    return this.db.transaction(() => {
      const loaded = this.activeShare(tokenHash, now);
      if (!loaded) return undefined;
      const ticketOk = Boolean(accessHash && loaded.share.downloadTicketHash === accessHash && (loaded.share.downloadTicketExpiresAt ?? 0) > now);
      if (ticketOk) return loaded.item;
      const updated = this.db.prepare('UPDATE shares SET views=views+1 WHERE id=? AND revoked=0 AND (maxViews IS NULL OR views<maxViews)').run(loaded.share.id);
      if (updated.changes !== 1) return undefined;
      return loaded.item;
    }).immediate();
  }
  expire(now: number) {
    return this.db.transaction(() => {
      const items = (this.db.prepare('SELECT * FROM items WHERE expiresAt<=? OR spaceId IN (SELECT id FROM spaces WHERE expiresAt<=?)').all(now, now) as Item[]).map(mapItem);
      for (const item of items) this.deleteItem(item.id);
      this.db.prepare('DELETE FROM spaces WHERE expiresAt<=?').run(now);
      this.db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(now);
      this.db.prepare('DELETE FROM flows WHERE expiresAt<=?').run(now);
      this.db.prepare('DELETE FROM device_authorizations WHERE expiresAt<=?').run(now);
      this.db.prepare('DELETE FROM invites WHERE expiresAt<=? OR revoked=1').run(now);
      this.db.prepare('DELETE FROM shares WHERE revoked=1 OR (expiresAt IS NOT NULL AND expiresAt<=?)').run(now);
      return items;
    })();
  }
  garbage() { return (this.db.prepare('SELECT key FROM garbage').all() as { key: string }[]).map(r => r.key); }
  forgetGarbage(key: string) { this.db.prepare('DELETE FROM garbage WHERE key=?').run(key); }
  fileKeys() {
    return new Set((this.db.prepare('SELECT fileKey AS key FROM items WHERE fileKey IS NOT NULL UNION SELECT thumbnailKey AS key FROM items WHERE thumbnailKey IS NOT NULL').all() as { key: string }[]).map(r => r.key));
  }
  close() { this.db.close(); }
}
