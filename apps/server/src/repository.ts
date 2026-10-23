import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError, type Flow, type Identity, type Invite, type Item, type Session, type Space, type User } from './domain.js';
import { migration1 } from './migrations.js';

export interface Repository {
  saveFlow(flow: Flow): void;
  consumeFlow(stateHash: string, browserHash: string, provider: string, now: number): Flow | undefined;
  login(identity: Identity, inviteHash: string | null, admins: string[], sessionHash: string, expiresAt: number, now: number): User;
  session(sessionHash: string, now: number): Session | undefined;
  logout(sessionHash: string): void;
  users(): (User & { usedBytes: number })[];
  disableUser(id: string, disabled: boolean): void;
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
  deleteItem(id: string): Item | undefined;
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
    if (version === 0) this.db.transaction(() => this.db.exec(migration1))();
    else if (version !== 1) throw new Error(`Unsupported schema version ${version}`);
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
      let user = this.db.prepare('SELECT u.* FROM users u JOIN identities i ON i.userId=u.id WHERE i.provider=? AND i.subject=?')
        .get(identity.provider, identity.subject) as User | undefined;
      if (user?.disabled) throw new ApiError(403, 'USER_DISABLED');
      const invite = inviteHash ? this.invite(inviteHash, now) : undefined;
      if (inviteHash && !invite) throw new ApiError(403, 'INVITE_INVALID');
      if (!user) {
        const first = (this.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n === 0;
        const admin = admins.includes(identity.email.toLowerCase()) || (first && admins.length === 0);
        if (!admin && !invite) throw new ApiError(403, 'INVITATION_REQUIRED');
        user = { id: randomUUID(), email: identity.email, name: identity.name, role: admin ? 'admin' : 'user', disabled: 0, createdAt: now };
        this.db.prepare('INSERT INTO users VALUES (@id,@email,@name,@role,@disabled,@createdAt)').run(user);
        this.db.prepare('INSERT INTO identities VALUES (?,?,?)').run(identity.provider, identity.subject, user.id);
        const spaceId = randomUUID();
        this.db.prepare('INSERT INTO spaces VALUES (?,?,?,NULL,NULL)').run(spaceId, 'Private space', user.id);
        this.db.prepare('INSERT INTO members VALUES (?,?)').run(spaceId, user.id);
      }
      if (invite) {
        // Membership already held: login is idempotent and does not spend another use.
        if (!this.isMember(invite.spaceId, user.id)) {
          const result = this.db.prepare('UPDATE invites SET uses=uses+1 WHERE id=? AND uses<maxUses AND revoked=0 AND expiresAt>?').run(invite.id, now);
          if (result.changes !== 1) throw new ApiError(403, 'INVITE_INVALID');
          this.db.prepare('INSERT INTO members VALUES (?,?)').run(invite.spaceId, user.id);
        }
      }
      this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sessionHash, user.id, expiresAt);
      return user;
    }).immediate();
  }
  session(sessionHash: string, now: number): Session | undefined {
    const row = this.db.prepare('SELECT u.*, s.expiresAt FROM sessions s JOIN users u ON u.id=s.userId WHERE s.sessionHash=? AND s.expiresAt>? AND u.disabled=0')
      .get(sessionHash, now) as (User & { expiresAt: number }) | undefined;
    if (!row) return undefined;
    const { expiresAt, ...user } = row;
    return { user, expiresAt, sessionHash };
  }
  logout(sessionHash: string) { this.db.prepare('DELETE FROM sessions WHERE sessionHash=?').run(sessionHash); }
  users() {
    return this.db.prepare('SELECT u.*, coalesce((SELECT sum(storedBytes) FROM items WHERE userId=u.id),0) AS usedBytes FROM users u ORDER BY createdAt').all() as (User & { usedBytes: number })[];
  }
  disableUser(id: string, disabled: boolean) {
    this.db.transaction(() => {
      const user = this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as User | undefined;
      if (!user) throw new ApiError(404, 'NOT_FOUND');
      if (disabled && !user.disabled && user.role === 'admin') {
        const { n } = this.db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled=0").get() as { n: number };
        if (n <= 1) throw new ApiError(409, 'LAST_ADMIN');
      }
      this.db.prepare('UPDATE users SET disabled=? WHERE id=?').run(Number(disabled), id);
      if (disabled) this.db.prepare('DELETE FROM sessions WHERE userId=?').run(id);
    }).immediate();
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
  items(spaceId: string, now: number) { return this.db.prepare('SELECT * FROM items WHERE spaceId=? AND expiresAt>? ORDER BY createdAt DESC,id DESC').all(spaceId, now) as Item[]; }
  item(id: string, now: number) { return this.db.prepare('SELECT * FROM items WHERE id=? AND expiresAt>?').get(id, now) as Item | undefined; }
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
      this.db.prepare('INSERT INTO items VALUES (@id,@spaceId,@userId,@kind,@text,@filename,@mime,@size,@storedBytes,@fileKey,@thumbnailKey,@createdAt,@expiresAt)').run(item);
    }).immediate();
  }
  deleteItem(id: string) {
    return this.db.transaction(() => {
      const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(id) as Item | undefined;
      if (item) {
        for (const key of [item.fileKey, item.thumbnailKey]) if (key) this.db.prepare('INSERT OR IGNORE INTO garbage VALUES (?)').run(key);
        this.db.prepare('DELETE FROM items WHERE id=?').run(id);
      }
      return item;
    })();
  }
  expire(now: number) {
    return this.db.transaction(() => {
      const items = this.db.prepare('SELECT * FROM items WHERE expiresAt<=? OR spaceId IN (SELECT id FROM spaces WHERE expiresAt<=?)').all(now, now) as Item[];
      for (const item of items) this.deleteItem(item.id);
      this.db.prepare('DELETE FROM spaces WHERE expiresAt<=?').run(now);
      this.db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(now);
      this.db.prepare('DELETE FROM flows WHERE expiresAt<=?').run(now);
      this.db.prepare('DELETE FROM invites WHERE expiresAt<=? OR revoked=1').run(now);
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
