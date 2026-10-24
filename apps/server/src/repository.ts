import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError, type Flow, type Identity, type Invite, type Item, type Session, type Space, type User } from './domain.js';
import { migration1, migration2, migration3 } from './migrations.js';

type UserRow = User & { quotaBytes: number | null };

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role, disabled: row.disabled, pending: row.pending, createdAt: row.createdAt };
}

export interface Repository {
  saveFlow(flow: Flow): void;
  consumeFlow(stateHash: string, browserHash: string, provider: string, now: number): Flow | undefined;
  login(identity: Identity, inviteHash: string | null, admins: string[], sessionHash: string, expiresAt: number, now: number): User;
  session(sessionHash: string, now: number): Session | undefined;
  logout(sessionHash: string): void;
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
    if (version > 3) throw new Error(`Unsupported schema version ${version}`);
    if (version < 3) this.db.transaction(() => {
      if (version < 1) this.db.exec(migration1);
      if (version < 2) this.db.exec(migration2);
      this.db.exec(migration3);
    })();
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
      if (inviteHash && !invite) throw new ApiError(403, 'INVITE_INVALID');
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
      // Configured admin mailboxes may use GitHub or Google. The second verified
      // provider binds to the existing account instead of creating another user.
      // Other mailboxes stay unmerged across providers.
      if (!row && admins.includes(identity.email.toLowerCase())) {
        const matches = this.db.prepare('SELECT * FROM users WHERE lower(email)=lower(?) ORDER BY createdAt,id').all(identity.email) as UserRow[];
        const existing = matches.find(user => user.disabled === 0);
        if (matches.length > 0 && !existing) throw new ApiError(403, 'USER_DISABLED');
        if (existing) {
          this.db.prepare('UPDATE users SET pending=0 WHERE id=?').run(existing.id);
          this.db.prepare('INSERT INTO identities (provider,subject,userId) VALUES (?,?,?)').run(identity.provider, identity.subject, existing.id);
          row = { ...existing, pending: 0 };
        }
      }
      if (!row) {
        const first = (this.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n === 0;
        const admin = admins.includes(identity.email.toLowerCase()) || (first && admins.length === 0);
        if (!admin && !invite) throw new ApiError(403, 'INVITATION_REQUIRED');
        row = { id: randomUUID(), email: identity.email, name: identity.name, role: admin ? 'admin' : 'user', disabled: 0, pending: 0, createdAt: now, quotaBytes: null };
        this.db.prepare('INSERT INTO users (id,email,name,role,disabled,createdAt,pending,quotaBytes) VALUES (@id,@email,@name,@role,@disabled,@createdAt,@pending,@quotaBytes)').run(row);
        this.db.prepare('INSERT INTO identities (provider,subject,userId) VALUES (?,?,?)').run(identity.provider, identity.subject, row.id);
        const spaceId = randomUUID();
        this.db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES (?,?,?,NULL,NULL)').run(spaceId, 'Private space', row.id);
        this.db.prepare('INSERT INTO members (spaceId,userId) VALUES (?,?)').run(spaceId, row.id);
      }
      // The process environment is the source of truth: a listed mailbox is admin on each login.
      if (admins.includes(identity.email.toLowerCase()) && row.role !== 'admin') {
        this.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(row.id);
        row = { ...row, role: 'admin' };
      }
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
      if (nextDisabled && user.disabled === 0) this.db.prepare('DELETE FROM sessions WHERE userId=?').run(id);
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
      this.db.prepare(`INSERT INTO items (id,spaceId,userId,kind,text,filename,mime,size,storedBytes,fileKey,thumbnailKey,createdAt,expiresAt,updatedAt)
        VALUES (@id,@spaceId,@userId,@kind,@text,@filename,@mime,@size,@storedBytes,@fileKey,@thumbnailKey,@createdAt,@expiresAt,@updatedAt)`).run(item);
    }).immediate();
  }
  replaceText(id: string, text: string, size: number, quota: number, now: number) {
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM items WHERE id=? AND expiresAt>?').get(id, now) as Item | undefined;
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
