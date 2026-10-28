import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError, randomRoomCode, type AccessToken, type BrowserSession, type DeviceAuthorization, type Flow, type Identity, type Invite, type LinkedIdentity, type OAuthApp, type Item, type ItemDevice, type Session, type SessionMeta, type ShareLink, type SharePublic, type Space, type UploadSession, type UploadChunk, type User } from './domain.js';
import { migration1, migration2, migration3, migration4, migration5, migration6, migration7, migration8, migration9, migration10, migration11, migration12, migration13, migration14, migration15, migration16 } from './migrations.js';
import type { RegistrationPolicy } from './password.js';
import type { LimitAudit, LimitChange, LimitKey, LimitOverrides } from './limits.js';

type UserRow = User & { quotaBytes: number | null; passwordHash?: string | null; mustChangePassword?: number };
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
  const { groupName, deviceId, deviceName, deviceKind, ...rest } = stored as typeof stored & {
    groupName?: string | null; deviceId?: string | null; deviceName?: string | null; deviceKind?: string | null;
  };
  const device: ItemDevice | null = deviceId
    ? { id: deviceId, name: deviceName || '未命名设备', kind: (deviceKind ?? 'pc') as ItemDevice['kind'] }
    : (rest.device ?? null);
  return { ...rest, pinned: stored.pinned ? 1 : 0, tags, group: groupName ?? rest.group ?? null, device };
}

export interface AppSetting { key: string; value: string; updatedAt: number; updatedBy: string | null }

export interface Repository {
  limitOverrides(): LimitOverrides;
  setting(key: string): AppSetting | undefined;
  /** value null deletes the setting (falls back to the environment). */
  saveSetting(key: string, value: string | null, now: number, actor: string): void;
  saveLimitChanges(changes: LimitChange[], actor: { id: string; email: string }, now: number): void;
  limitAudit(limit: number, cursor?: number): LimitAudit[];
  saveFlow(flow: Flow): void;
  consumeFlow(stateHash: string, browserHash: string, provider: string, now: number): Flow | undefined;
  oauthApps(): OAuthApp[];
  /** clientSecret null keeps the stored secret. */
  saveOAuthApp(input: { provider: string; clientId: string; clientSecret: string | null; enabled: boolean; now: number; actor: string }): void;
  deleteOAuthApp(provider: string): void;
  recordOAuthCheck(provider: string, ok: boolean, code: string, now: number): void;
  identities(userId: string): LinkedIdentity[];
  /** Binds a provider identity to a signed-in account. Returns false when it was already bound to it. */
  linkIdentity(userId: string, identity: Identity, now: number): boolean;
  unlinkIdentity(userId: string, provider: string): void;
  login(identity: Identity, inviteHash: string | null, admins: string[], sessionHash: string, expiresAt: number, now: number, meta?: SessionMeta, policy?: RegistrationPolicy): User;
  /** RHEA-190 auth step 2 — password accounts. */
  userCount(): number;
  /** Account (and its password hash) for a password sign-in; prefers the row that has a password. */
  passwordAccount(email: string): (User & { passwordHash: string | null; mustChangePassword: number }) | undefined;
  /** Password state of one account. */
  passwordState(userId: string): { passwordHash: string | null; mustChangePassword: number } | undefined;
  /** Sets (or clears with null) the password; mustChange forces a change at next sign-in. */
  setPassword(userId: string, passwordHash: string | null, mustChange: boolean, now: number): void;
  /**
   * Creates an active account with a password and its private space. firstAdmin: only while the
   * users table is empty (setup / ADMIN_PASSWORD); otherwise the registration policy and invite apply.
   */
  createPasswordUser(input: { email: string; name: string; passwordHash: string; now: number; firstAdmin?: boolean;
    inviteHash?: string | null; policy?: RegistrationPolicy }): User;
  /** A browser session for an already-verified user (password sign-in / setup). */
  createSession(userId: string, sessionHash: string, expiresAt: number, now: number, meta?: SessionMeta): void;
  /** Spends an invite for an existing account (password sign-in from an invite link). Idempotent for members. */
  acceptInvite(inviteHash: string, userId: string, now: number): void;
  /** A pre-created account becomes active on its first password sign-in. */
  activate(userId: string): void;
  session(sessionHash: string, now: number): Session | undefined;
  logout(sessionHash: string): void;
  /** Throttled "last active" bump for a browser session. */
  touchSession(sessionHash: string, now: number, ipSummary: string): void;
  /** Remember which device (localStorage identity) a browser session belongs to. */
  tagSession(sessionHash: string, device: ItemDevice): void;
  browserSessions(userId: string, now: number): BrowserSession[];
  /** Deletes one browser session; userId scopes it to its owner (omit for admins). Returns its hash. */
  revokeSession(id: string, userId?: string): string;
  revokeOtherSessions(userId: string, keepHash: string): number;
  createAccessToken(record: AccessToken, tokenHash: string): void;
  accessTokens(userId?: string): AccessToken[];
  tokenSession(tokenHash: string, now: number, touch?: boolean): Session | undefined;
  renameAccessToken(id: string, userId: string, name: string): void;
  revokeAccessToken(id: string, userId?: string): void;
  createDevice(record: DeviceAuthorization): void;
  deviceForUserCode(userCodeHash: string, verificationId: string | undefined, now: number): DeviceAuthorization | undefined;
  decideDevice(id: string, userId: string, approve: boolean, now: number): void;
  pollDevice(deviceCodeHash: string, now: number, tokenId: string, tokenHash: string): DevicePoll;
  users(): (User & { usedBytes: number; quotaBytes: number | null; inviteLimit: number | null; hasPassword: number; mustChangePassword: number; providers: string | null })[];
  provisionUser(input: { email: string; name: string; role: 'admin' | 'user'; quotaBytes: number | null; now: number }): User;
  updateUser(id: string, patch: { disabled?: boolean; role?: 'admin' | 'user'; name?: string; quotaBytes?: number | null; inviteLimit?: number | null }): void;
  revokeSessions(id: string): void;
  quotaOverride(userId: string): number | null;
  spaces(userId: string): Space[];
  space(id: string): Space | undefined;
  room(roomHash: string, now: number): Space | undefined;
  roomById(id: string, now: number): Space | undefined;
  /** Throws TOKEN_COLLISION (retry with another token) or CODE_TAKEN. A room's own code and pin are on the Space. */
  createRoom(space: Space, deviceHash: string | null, now: number): void;
  roomByCode(code: string, now: number): Space | undefined;
  /** Replaces the code and pin of a live room. Throws CODE_TAKEN when another live room holds the code. */
  setRoomCode(spaceId: string, code: string, pinHash: string | null, now: number): void;
  /** the live temporary room bound to this browser, if any */
  deviceRoom(deviceHash: string, now: number): Space | undefined;
  isMember(spaceId: string, userId: string): boolean;
  invite(tokenHash: string, now: number): Invite | undefined;
  createInvite(invite: Invite): void;
  invites(): (Omit<Invite, 'tokenHash'> & { createdByEmail: string | null })[];
  revokeInvite(id: string): void;
  /** Personal invites (joinSpace=0) a user created that still exist, newest first. */
  personalInvites(userId: string): Omit<Invite, 'tokenHash'>[];
  /** Invites a user has spent from their limit: used ones plus those still open. */
  inviteUsage(userId: string, now: number): number;
  inviteUsageByUser(now: number): Map<string, number>;
  /** Atomic: counts the user's usage, refuses beyond limit (INVITE_LIMIT_REACHED), then inserts. limit null = unlimited. */
  createPersonalInvite(invite: Invite, limit: number | null, now: number): void;
  revokePersonalInvite(id: string, userId: string): void;
  inviteLimit(userId: string): number | null;
  personalSpaceId(userId: string): string | undefined;
  usage(userId: string): number;
  items(spaceId: string, now: number): Item[];
  item(id: string, now: number): Item | undefined;
  reservedBytes(userId: string, now: number): number;
  createUpload(upload: UploadSession, quota: number, maxItems: number, perUser: number, global: number): void;
  upload(id: string, now: number): UploadSession | undefined;
  chunks(id: string): UploadChunk[];
  saveChunk(chunk: UploadChunk, now: number): boolean;
  deleteUpload(id: string): void;
  deleteUserUploads(userId: string): string[];
  expireUploads(now: number): string[];
  addItem(item: Item, quota: number, maxItems: number, uploadId?: string): void;
  replaceText(id: string, text: string, size: number, quota: number, now: number): Item;
  deleteItem(id: string): Item | undefined;
  updateLabels(id: string, patch: { pinned?: 0 | 1; tags?: string[]; group?: string | null }, now: number): Item;
  groups(spaceId: string): string[];
  ensureGroup(spaceId: string, name: string, now: number, max: number): boolean;
  createGroup(spaceId: string, name: string, now: number, max: number): void;
  renameGroup(spaceId: string, from: string, to: string, now: number): Item[];
  deleteGroup(spaceId: string, name: string, now: number): Item[];
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
    if (version > 16) throw new Error(`Unsupported schema version ${version}`);
    if (version < 16) this.db.transaction(() => {
      if (version < 1) this.db.exec(migration1);
      if (version < 2) this.db.exec(migration2);
      if (version < 3) this.db.exec(migration3);
      if (version < 4) this.db.exec(migration4);
      if (version < 5) this.db.exec(migration5);
      if (version < 6) this.db.exec(migration6);
      if (version < 7) this.db.exec(migration7);
      if (version < 8) this.db.exec(migration8);
      if (version < 9) this.db.exec(migration9);
      if (version < 10) this.db.exec(migration10);
      if (version < 11) this.db.exec(migration11);
      if (version < 12) this.db.exec(migration12);
      if (version < 13) this.db.exec(migration13);
      if (version < 14) this.db.exec(migration14);
      if (version < 15) this.db.exec(migration15);
      migrateRoomCodes(this.db);
      this.db.exec(migration16);
    })();
  }
  setting(key: string) {
    return this.db.prepare('SELECT key,value,updatedAt,updatedBy FROM app_settings WHERE key=?').get(key) as AppSetting | undefined;
  }
  saveSetting(key: string, value: string | null, now: number, actor: string) {
    if (value === null) this.db.prepare('DELETE FROM app_settings WHERE key=?').run(key);
    else this.db.prepare(`INSERT INTO app_settings (key,value,updatedAt,updatedBy) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy`).run(key, value, now, actor);
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
    this.db.prepare('INSERT INTO flows (stateHash,browserHash,provider,verifier,inviteHash,expiresAt,linkUserId) VALUES (@stateHash,@browserHash,@provider,@verifier,@inviteHash,@expiresAt,@linkUserId)')
      .run({ linkUserId: null, ...flow });
  }
  oauthApps() {
    return this.db.prepare('SELECT * FROM oauth_apps ORDER BY provider').all() as OAuthApp[];
  }
  saveOAuthApp(input: { provider: string; clientId: string; clientSecret: string | null; enabled: boolean; now: number; actor: string }) {
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM oauth_apps WHERE provider=?').get(input.provider) as OAuthApp | undefined;
      const secret = input.clientSecret ?? existing?.clientSecret;
      if (!secret) throw new ApiError(400, 'OAUTH_SECRET_REQUIRED');
      // Any credential change invalidates the previous verification result.
      const changed = !existing || existing.clientId !== input.clientId || existing.clientSecret !== secret;
      this.db.prepare(`INSERT INTO oauth_apps (provider,clientId,clientSecret,enabled,updatedAt,updatedBy,checkedAt,checkOk,checkCode)
        VALUES (@provider,@clientId,@secret,@enabled,@now,@actor,NULL,NULL,NULL)
        ON CONFLICT(provider) DO UPDATE SET clientId=excluded.clientId, clientSecret=excluded.clientSecret, enabled=excluded.enabled,
          updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy,
          checkedAt=CASE WHEN @changed THEN NULL ELSE checkedAt END, checkOk=CASE WHEN @changed THEN NULL ELSE checkOk END,
          checkCode=CASE WHEN @changed THEN NULL ELSE checkCode END`)
        .run({ provider: input.provider, clientId: input.clientId, secret, enabled: input.enabled ? 1 : 0, now: input.now, actor: input.actor, changed: changed ? 1 : 0 });
    }).immediate();
  }
  deleteOAuthApp(provider: string) {
    this.db.prepare('DELETE FROM oauth_apps WHERE provider=?').run(provider);
  }
  recordOAuthCheck(provider: string, ok: boolean, code: string, now: number) {
    this.db.prepare('UPDATE oauth_apps SET checkedAt=?, checkOk=?, checkCode=? WHERE provider=?').run(now, ok ? 1 : 0, code, provider);
  }
  identities(userId: string) {
    return this.db.prepare('SELECT provider,email,linkedAt FROM identities WHERE userId=? ORDER BY linkedAt IS NULL, linkedAt, provider')
      .all(userId) as LinkedIdentity[];
  }
  linkIdentity(userId: string, identity: Identity, now: number) {
    return this.db.transaction(() => {
      const owner = this.db.prepare('SELECT userId FROM identities WHERE provider=? AND subject=?').get(identity.provider, identity.subject) as { userId: string } | undefined;
      if (owner?.userId === userId) {
        this.db.prepare('UPDATE identities SET email=? WHERE provider=? AND subject=?').run(identity.email, identity.provider, identity.subject);
        return false;
      }
      // Never move an identity away from another account: that would be a silent takeover.
      if (owner) throw new ApiError(409, 'IDENTITY_IN_USE');
      const user = this.db.prepare('SELECT disabled FROM users WHERE id=?').get(userId) as { disabled: number } | undefined;
      if (!user) throw new ApiError(401, 'UNAUTHENTICATED');
      if (user.disabled) throw new ApiError(403, 'USER_DISABLED');
      // One account per provider keeps unbinding unambiguous.
      if (this.db.prepare('SELECT 1 FROM identities WHERE userId=? AND provider=?').get(userId, identity.provider)) throw new ApiError(409, 'PROVIDER_ALREADY_LINKED');
      this.db.prepare('INSERT INTO identities (provider,subject,userId,email,linkedAt) VALUES (?,?,?,?,?)')
        .run(identity.provider, identity.subject, userId, identity.email, now);
      return true;
    }).immediate();
  }
  unlinkIdentity(userId: string, provider: string) {
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT provider FROM identities WHERE userId=?').all(userId) as { provider: string }[];
      if (!rows.some(row => row.provider === provider)) throw new ApiError(404, 'NOT_FOUND');
      // The last login method cannot be removed, or the account could never sign in again.
      const password = this.db.prepare('SELECT passwordHash FROM users WHERE id=?').get(userId) as { passwordHash: string | null } | undefined;
      if (rows.length <= 1 && !password?.passwordHash) throw new ApiError(409, 'LAST_IDENTITY');
      this.db.prepare('DELETE FROM identities WHERE userId=? AND provider=?').run(userId, provider);
    }).immediate();
  }
  consumeFlow(stateHash: string, browserHash: string, provider: string, now: number) {
    return this.db.transaction(() => {
      const flow = this.db.prepare('SELECT * FROM flows WHERE stateHash=? AND browserHash=? AND provider=? AND expiresAt>?')
        .get(stateHash, browserHash, provider, now) as Flow | undefined;
      if (flow) this.db.prepare('DELETE FROM flows WHERE stateHash=?').run(stateHash);
      return flow;
    })();
  }
  login(identity: Identity, inviteHash: string | null, admins: string[], sessionHash: string, expiresAt: number, now: number, meta: SessionMeta = {}, policy: RegistrationPolicy = 'invite') {
    return this.db.transaction(() => {
      let row = this.db.prepare('SELECT u.* FROM users u JOIN identities i ON i.userId=u.id WHERE i.provider=? AND i.subject=?')
        .get(identity.provider, identity.subject) as UserRow | undefined;
      let created = false;
      if (row?.disabled) throw new ApiError(403, 'USER_DISABLED');
      if (row) this.db.prepare('UPDATE identities SET email=? WHERE provider=? AND subject=?').run(identity.email, identity.provider, identity.subject);
      const invite = inviteHash ? this.invite(inviteHash, now) : undefined;
      if (!row) {
        const pending = this.db.prepare('SELECT * FROM users WHERE pending=1 AND lower(email)=lower(?)').get(identity.email) as UserRow | undefined;
        // A disabled pre-provisioned account must not be bypassed by creating a second user.
        if (pending?.disabled) throw new ApiError(403, 'USER_DISABLED');
        if (pending) {
          this.db.prepare('UPDATE users SET pending=0 WHERE id=?').run(pending.id);
          this.db.prepare('INSERT INTO identities (provider,subject,userId,email,linkedAt) VALUES (?,?,?,?,?)').run(identity.provider, identity.subject, pending.id, identity.email, now);
          row = { ...pending, pending: 0 };
        }
      }
      if (!row) {
        // RHEA-190 m11: an unknown identity whose verified email already belongs to an
        // account is NOT merged silently and NOT turned into a duplicate account. The
        // owner signs in the usual way and binds the new provider in 设置 → 登录方式.
        const existing = this.db.prepare(`SELECT u.disabled FROM users u WHERE u.pending=0 AND (lower(u.email)=lower(?)
          OR EXISTS (SELECT 1 FROM identities i WHERE i.userId=u.id AND lower(i.email)=lower(?))) LIMIT 1`)
          .get(identity.email, identity.email) as { disabled: number } | undefined;
        if (existing?.disabled) throw new ApiError(403, 'USER_DISABLED');
        if (existing) throw new ApiError(409, 'ACCOUNT_EXISTS');
      }
      if (!row) {
        // BEGIN IMMEDIATE holds the reserved lock across this count and the insert,
        // so two concurrent sign-ins cannot both observe an empty users table.
        const first = (this.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n === 0;
        // A missing or stale invite must not block the empty-database bootstrap.
        if (inviteHash && !invite && !first) throw new ApiError(403, 'INVITE_INVALID');
        const listed = admins.includes(identity.email.toLowerCase());
        // RHEA-190 auth step 2: 管理 → 注册 decides who may create an account. ADMIN_EMAILS and
        // the empty-database bootstrap are operator decisions and bypass it.
        if (!first && !listed && policy === 'closed') throw new ApiError(403, 'REGISTRATION_CLOSED');
        if (!first && !listed && !invite && policy !== 'open') throw new ApiError(403, 'INVITATION_REQUIRED');
        const admin = first || listed;
        row = { id: randomUUID(), email: identity.email, name: identity.name, role: admin ? 'admin' : 'user', disabled: 0, pending: 0, createdAt: now, quotaBytes: null };
        this.db.prepare('INSERT INTO users (id,email,name,role,disabled,createdAt,pending,quotaBytes) VALUES (@id,@email,@name,@role,@disabled,@createdAt,@pending,@quotaBytes)').run(row);
        this.db.prepare('INSERT INTO identities (provider,subject,userId,email,linkedAt) VALUES (?,?,?,?,?)').run(identity.provider, identity.subject, row.id, identity.email, now);
        const spaceId = randomUUID();
        this.db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES (?,?,?,NULL,NULL)').run(spaceId, 'Private space', row.id);
        this.db.prepare('INSERT INTO members (spaceId,userId) VALUES (?,?)').run(spaceId, row.id);
        created = true;
      } else if (inviteHash && !invite) throw new ApiError(403, 'INVITE_INVALID');
      if (invite) this.spendInvite(invite, row.id, now, created);
      this.createSession(row.id, sessionHash, expiresAt, now, meta);
      return toUser(row);
    }).immediate();
  }
  private spendInvite(invite: Invite, userId: string, now: number, created = false) {
    // A personal invite only opens registration: it never adds anyone to the inviter's space and an existing account never spends it.
    if (invite.joinSpace === 0) {
      if (!created) return;
      const spent = this.db.prepare('UPDATE invites SET uses=uses+1 WHERE id=? AND uses<maxUses AND revoked=0 AND expiresAt>?').run(invite.id, now);
      if (spent.changes !== 1) throw new ApiError(403, 'INVITE_INVALID');
      return;
    }
    // Membership already held: login is idempotent and does not spend another use.
    if (this.isMember(invite.spaceId, userId)) return;
    const result = this.db.prepare('UPDATE invites SET uses=uses+1 WHERE id=? AND uses<maxUses AND revoked=0 AND expiresAt>?').run(invite.id, now);
    if (result.changes !== 1) throw new ApiError(403, 'INVITE_INVALID');
    this.db.prepare('INSERT INTO members (spaceId,userId) VALUES (?,?)').run(invite.spaceId, userId);
  }
  acceptInvite(inviteHash: string, userId: string, now: number) {
    this.db.transaction(() => {
      const invite = this.invite(inviteHash, now);
      if (!invite) throw new ApiError(403, 'INVITE_INVALID');
      this.spendInvite(invite, userId, now);
    }).immediate();
  }
  createSession(userId: string, sessionHash: string, expiresAt: number, now: number, meta: SessionMeta = {}) {
    this.db.prepare('INSERT INTO sessions (sessionHash,userId,expiresAt,id,createdAt,lastSeenAt,userAgent,ipSummary) VALUES (?,?,?,?,?,?,?,?)')
      .run(sessionHash, userId, expiresAt, randomUUID(), now, now, meta.userAgent?.slice(0, 400) ?? null, meta.ipSummary ?? null);
  }
  userCount() {
    return (this.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
  }
  passwordAccount(email: string) {
    return this.db.prepare(`SELECT * FROM users WHERE lower(email)=lower(?) ORDER BY passwordHash IS NULL, createdAt LIMIT 1`)
      .get(email) as (User & { passwordHash: string | null; mustChangePassword: number }) | undefined;
  }
  passwordState(userId: string) {
    return this.db.prepare('SELECT passwordHash, mustChangePassword FROM users WHERE id=?').get(userId) as { passwordHash: string | null; mustChangePassword: number } | undefined;
  }
  setPassword(userId: string, passwordHash: string | null, mustChange: boolean, now: number) {
    if (!this.db.prepare('UPDATE users SET passwordHash=?, mustChangePassword=?, passwordUpdatedAt=? WHERE id=?')
      .run(passwordHash, mustChange ? 1 : 0, now, userId).changes) throw new ApiError(404, 'NOT_FOUND');
  }
  activate(userId: string) {
    this.db.prepare('UPDATE users SET pending=0 WHERE id=?').run(userId);
  }
  createPasswordUser(input: { email: string; name: string; passwordHash: string; now: number; firstAdmin?: boolean;
    inviteHash?: string | null; policy?: RegistrationPolicy }) {
    return this.db.transaction(() => {
      const first = this.userCount() === 0;
      if (input.firstAdmin && !first) throw new ApiError(409, 'SETUP_DONE');
      // Never attach a password to an existing (or admin pre-created) account by email alone:
      // nobody has proven they own that address. Pre-created users get a temporary password from an admin.
      if (this.db.prepare('SELECT 1 FROM users WHERE lower(email)=lower(?)').get(input.email) ||
          this.db.prepare('SELECT 1 FROM identities WHERE lower(email)=lower(?)').get(input.email)) throw new ApiError(409, 'EMAIL_IN_USE');
      const invite = input.inviteHash ? this.invite(input.inviteHash, input.now) : undefined;
      if (!input.firstAdmin) {
        if (input.inviteHash && !invite) throw new ApiError(403, 'INVITE_INVALID');
        const policy = input.policy ?? 'invite';
        if (policy === 'closed') throw new ApiError(403, 'REGISTRATION_CLOSED');
        if (policy === 'invite' && !invite) throw new ApiError(403, 'INVITATION_REQUIRED');
      }
      // ADMIN_EMAILS is NOT honoured here: a self-chosen password does not prove the address.
      const admin = Boolean(input.firstAdmin);
      const row: UserRow = { id: randomUUID(), email: input.email, name: input.name, role: admin ? 'admin' : 'user', disabled: 0, pending: 0,
        createdAt: input.now, quotaBytes: null };
      this.db.prepare(`INSERT INTO users (id,email,name,role,disabled,createdAt,pending,quotaBytes,passwordHash,mustChangePassword,passwordUpdatedAt)
        VALUES (@id,@email,@name,@role,@disabled,@createdAt,@pending,@quotaBytes,@passwordHash,0,@createdAt)`).run({ ...row, passwordHash: input.passwordHash });
      const spaceId = randomUUID();
      this.db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES (?,?,?,NULL,NULL)').run(spaceId, 'Private space', row.id);
      this.db.prepare('INSERT INTO members (spaceId,userId) VALUES (?,?)').run(spaceId, row.id);
      if (invite) this.spendInvite(invite, row.id, input.now, true);
      return toUser(row);
    }).immediate();
  }
  session(sessionHash: string, now: number): Session | undefined {
    const row = this.db.prepare('SELECT u.*, s.expiresAt, s.id AS sessionId FROM sessions s JOIN users u ON u.id=s.userId WHERE s.sessionHash=? AND s.expiresAt>? AND u.disabled=0')
      .get(sessionHash, now) as (UserRow & { expiresAt: number; sessionId: string | null }) | undefined;
    if (!row) return undefined;
    return { user: toUser(row), expiresAt: row.expiresAt, sessionHash, ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      ...(row.mustChangePassword ? { mustChangePassword: true } : {}) };
  }
  logout(sessionHash: string) { this.db.prepare('DELETE FROM sessions WHERE sessionHash=?').run(sessionHash); }
  touchSession(sessionHash: string, now: number, ipSummary: string) {
    this.db.prepare('UPDATE sessions SET lastSeenAt=?, ipSummary=? WHERE sessionHash=? AND (lastSeenAt IS NULL OR lastSeenAt<? OR ipSummary IS NOT ?)')
      .run(now, ipSummary, sessionHash, now - 60000, ipSummary);
  }
  tagSession(sessionHash: string, device: ItemDevice) {
    this.db.prepare('UPDATE sessions SET deviceId=?, deviceName=?, deviceKind=? WHERE sessionHash=? AND (deviceId IS NOT ? OR deviceName IS NOT ? OR deviceKind IS NOT ?)')
      .run(device.id, device.name, device.kind, sessionHash, device.id, device.name, device.kind);
  }
  browserSessions(userId: string, now: number): BrowserSession[] {
    const rows = this.db.prepare(`SELECT id,userId,createdAt,lastSeenAt,expiresAt,userAgent,ipSummary,deviceId,deviceName,deviceKind
      FROM sessions WHERE userId=? AND expiresAt>? ORDER BY coalesce(lastSeenAt,createdAt,0) DESC, id`).all(userId, now) as
      (Omit<BrowserSession, 'device'> & { deviceId: string | null; deviceName: string | null; deviceKind: string | null })[];
    return rows.map(({ deviceId, deviceName, deviceKind, ...row }) => ({ ...row,
      device: deviceId ? { id: deviceId, name: deviceName || '未命名设备', kind: (deviceKind ?? 'pc') as ItemDevice['kind'] } : null }));
  }
  revokeSession(id: string, userId?: string) {
    const row = (userId === undefined ? this.db.prepare('SELECT sessionHash FROM sessions WHERE id=?').get(id)
      : this.db.prepare('SELECT sessionHash FROM sessions WHERE id=? AND userId=?').get(id, userId)) as { sessionHash: string } | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND');
    this.db.prepare('DELETE FROM sessions WHERE sessionHash=?').run(row.sessionHash);
    return row.sessionHash;
  }
  revokeOtherSessions(userId: string, keepHash: string) {
    return this.db.prepare('DELETE FROM sessions WHERE userId=? AND sessionHash<>?').run(userId, keepHash).changes;
  }
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
    return this.db.prepare(`SELECT u.id,u.email,u.name,u.role,u.disabled,u.createdAt,u.pending,u.quotaBytes,u.inviteLimit,
      coalesce((SELECT sum(storedBytes) FROM items WHERE userId=u.id),0) AS usedBytes,
      (u.passwordHash IS NOT NULL) AS hasPassword, u.mustChangePassword,
      (SELECT group_concat(provider) FROM identities WHERE userId=u.id) AS providers
      FROM users u ORDER BY createdAt`).all() as (User & { usedBytes: number; quotaBytes: number | null; inviteLimit: number | null; hasPassword: number; mustChangePassword: number; providers: string | null })[];
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
  updateUser(id: string, patch: { disabled?: boolean; role?: 'admin' | 'user'; name?: string; quotaBytes?: number | null; inviteLimit?: number | null }) {
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
      this.db.prepare('UPDATE users SET disabled=?, role=?, name=?, quotaBytes=?, inviteLimit=? WHERE id=?').run(
        Number(nextDisabled), nextRole, patch.name ?? user.name,
        patch.quotaBytes === undefined ? user.quotaBytes : patch.quotaBytes,
        patch.inviteLimit === undefined ? (user as UserRow & { inviteLimit?: number | null }).inviteLimit ?? null : patch.inviteLimit, id);
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
  roomById(id: string, now: number) { return this.db.prepare('SELECT * FROM spaces WHERE id=? AND roomHash IS NOT NULL AND expiresAt>?').get(id, now) as Space | undefined; }
  room(roomHash: string, now: number) { return this.db.prepare('SELECT * FROM spaces WHERE roomHash=? AND expiresAt>?').get(roomHash, now) as Space | undefined; }
  createRoom(space: Space, deviceHash: string | null, now: number) {
    this.db.transaction(() => {
      // an expired room that cleanup has not removed yet gives up its browser binding and its code
      if (deviceHash) this.db.prepare('UPDATE spaces SET deviceHash=NULL WHERE deviceHash=?').run(deviceHash);
      if (this.db.prepare('SELECT 1 FROM spaces WHERE roomHash=?').get(space.roomHash)) throw new ApiError(409, 'TOKEN_COLLISION');
      if (space.roomCode) this.releaseExpiredCode(space.roomCode, now);
      if (space.roomCode && this.db.prepare('SELECT 1 FROM spaces WHERE roomCode=?').get(space.roomCode)) throw new ApiError(409, 'CODE_TAKEN');
      this.db.prepare('INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash,deviceHash,roomCode,pinHash) VALUES (?,?,?,?,?,?,?,?)')
        .run(space.id, space.name, space.ownerId, space.expiresAt, space.roomHash, deviceHash, space.roomCode ?? null, space.pinHash ?? null);
    }).immediate();
  }
  private releaseExpiredCode(code: string, now: number) {
    this.db.prepare('UPDATE spaces SET roomCode=NULL, pinHash=NULL WHERE roomCode=? AND expiresAt<=?').run(code, now);
  }
  roomByCode(code: string, now: number) { return this.db.prepare('SELECT * FROM spaces WHERE roomCode=? AND expiresAt>?').get(code, now) as Space | undefined; }
  setRoomCode(spaceId: string, code: string, pinHash: string | null, now: number) {
    this.db.transaction(() => {
      this.releaseExpiredCode(code, now);
      const holder = this.db.prepare('SELECT id FROM spaces WHERE roomCode=?').get(code) as { id: string } | undefined;
      if (holder && holder.id !== spaceId) throw new ApiError(409, 'CODE_TAKEN');
      if (!this.db.prepare('UPDATE spaces SET roomCode=?, pinHash=? WHERE id=? AND roomHash IS NOT NULL AND expiresAt>?').run(code, pinHash, spaceId, now).changes) throw new ApiError(404, 'NOT_FOUND');
    }).immediate();
  }
  deviceRoom(deviceHash: string, now: number) {
    return this.db.prepare('SELECT * FROM spaces WHERE deviceHash=? AND roomHash IS NOT NULL AND expiresAt>?').get(deviceHash, now) as Space | undefined;
  }
  isMember(spaceId: string, userId: string) { return Boolean(this.db.prepare('SELECT 1 FROM members WHERE spaceId=? AND userId=?').get(spaceId, userId)); }
  invite(tokenHash: string, now: number) {
    return this.db.prepare('SELECT * FROM invites WHERE tokenHash=? AND revoked=0 AND uses<maxUses AND expiresAt>?').get(tokenHash, now) as Invite | undefined;
  }
  createInvite(invite: Invite) {
    this.db.prepare(`INSERT INTO invites (id,tokenHash,spaceId,maxUses,uses,expiresAt,revoked,createdBy,joinSpace,createdAt)
      VALUES (@id,@tokenHash,@spaceId,@maxUses,@uses,@expiresAt,@revoked,@createdBy,@joinSpace,@createdAt)`)
      .run({ ...invite, joinSpace: invite.joinSpace ?? 1, createdAt: invite.createdAt ?? null });
  }
  invites() {
    return this.db.prepare(`SELECT i.id,i.spaceId,i.maxUses,i.uses,i.expiresAt,i.revoked,i.createdBy,i.joinSpace,i.createdAt,u.email AS createdByEmail
      FROM invites i LEFT JOIN users u ON u.id=i.createdBy ORDER BY i.expiresAt DESC`).all() as (Omit<Invite, 'tokenHash'> & { createdByEmail: string | null })[];
  }
  personalInvites(userId: string) {
    return this.db.prepare(`SELECT id,spaceId,maxUses,uses,expiresAt,revoked,createdBy,joinSpace,createdAt FROM invites
      WHERE createdBy=? AND joinSpace=0 AND NOT (revoked=1 AND uses=0) ORDER BY coalesce(createdAt,0) DESC, expiresAt DESC`).all(userId) as Omit<Invite, 'tokenHash'>[];
  }
  // A personal invite counts against the user's limit once it was used, or while it can still be used.
  // Revoking or letting an unused one expire gives the slot back.
  inviteUsage(userId: string, now: number) {
    return (this.db.prepare(`SELECT count(*) AS n FROM invites WHERE createdBy=? AND joinSpace=0 AND (uses>0 OR (revoked=0 AND expiresAt>?))`).get(userId, now) as { n: number }).n;
  }
  inviteUsageByUser(now: number) {
    const rows = this.db.prepare(`SELECT createdBy, count(*) AS n FROM invites WHERE joinSpace=0 AND (uses>0 OR (revoked=0 AND expiresAt>?)) GROUP BY createdBy`).all(now) as { createdBy: string; n: number }[];
    return new Map(rows.map(row => [row.createdBy, row.n]));
  }
  createPersonalInvite(invite: Invite, limit: number | null, now: number) {
    this.db.transaction(() => {
      if (limit !== null && this.inviteUsage(invite.createdBy, now) >= limit) throw new ApiError(403, 'INVITE_LIMIT_REACHED');
      this.createInvite({ ...invite, joinSpace: 0 });
    }).immediate();
  }
  revokePersonalInvite(id: string, userId: string) {
    const row = this.db.prepare('SELECT uses,revoked FROM invites WHERE id=? AND createdBy=? AND joinSpace=0').get(id, userId) as { uses: number; revoked: number } | undefined;
    if (!row || row.revoked) throw new ApiError(404, 'NOT_FOUND');
    if (row.uses > 0) throw new ApiError(409, 'INVITE_USED');
    this.db.prepare('UPDATE invites SET revoked=1 WHERE id=?').run(id);
  }
  inviteLimit(userId: string) {
    const row = this.db.prepare('SELECT inviteLimit FROM users WHERE id=?').get(userId) as { inviteLimit: number | null } | undefined;
    return row?.inviteLimit ?? null;
  }
  personalSpaceId(userId: string) {
    return (this.db.prepare('SELECT id FROM spaces WHERE ownerId=?').get(userId) as { id: string } | undefined)?.id;
  }
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
  reservedBytes(userId: string, now: number) {
    return (this.db.prepare('SELECT coalesce(sum(size),0) AS n FROM uploads WHERE userId=? AND expiresAt>?').get(userId, now) as { n: number }).n;
  }
  private roomReserved(spaceId: string, now: number) {
    return (this.db.prepare('SELECT coalesce(sum(size),0) AS n FROM uploads WHERE spaceId=? AND expiresAt>?').get(spaceId, now) as { n: number }).n;
  }
  private checkWriter(spaceId: string, userId: string | null, now: number) {
    const space = this.space(spaceId);
    if (!space || (space.expiresAt !== null && space.expiresAt <= now)) throw new ApiError(404, 'NOT_FOUND');
    if (userId) {
      const user = this.db.prepare('SELECT disabled FROM users WHERE id=?').get(userId) as { disabled: number } | undefined;
      if (!user || user.disabled || !this.isMember(spaceId, userId)) throw new ApiError(403, 'FORBIDDEN');
    }
  }
  private checkCapacity(spaceId: string, userId: string | null, bytes: number, quota: number, maxItems: number, now: number) {
    const used = userId ? this.usage(userId) + this.reservedBytes(userId, now) :
      (this.db.prepare('SELECT coalesce(sum(storedBytes),0) AS n FROM items WHERE spaceId=?').get(spaceId) as { n: number }).n + this.roomReserved(spaceId, now);
    const count = (this.db.prepare(`SELECT (SELECT count(*) FROM items WHERE spaceId=?) +
      (SELECT count(*) FROM uploads WHERE spaceId=? AND expiresAt>?) AS n`).get(spaceId, spaceId, now) as { n: number }).n;
    if (used + bytes > quota) throw new ApiError(413, 'QUOTA_EXCEEDED');
    if (count >= maxItems) throw new ApiError(413, 'ITEM_LIMIT');
  }
  createUpload(upload: UploadSession, quota: number, maxItems: number, perUser: number, global: number) {
    this.db.transaction(() => {
      this.checkWriter(upload.spaceId, upload.userId, upload.createdAt);
      this.checkCapacity(upload.spaceId, upload.userId, upload.size, quota, maxItems, upload.createdAt);
      const counts = this.db.prepare(`SELECT count(*) AS total, coalesce(sum(principal=?),0) AS own
        FROM uploads WHERE expiresAt>?`).get(upload.principal, upload.createdAt) as { total: number; own: number };
      if (counts.total >= global || counts.own >= perUser) throw new ApiError(429, 'UPLOAD_SESSION_LIMIT');
      this.db.prepare(`INSERT INTO uploads (id,spaceId,userId,principal,filename,mime,size,chunkSize,createdAt,expiresAt)
        VALUES (@id,@spaceId,@userId,@principal,@filename,@mime,@size,@chunkSize,@createdAt,@expiresAt)`).run(upload);
    }).immediate();
  }
  upload(id: string, now: number) {
    return this.db.prepare('SELECT * FROM uploads WHERE id=? AND expiresAt>?').get(id, now) as UploadSession | undefined;
  }
  chunks(id: string) {
    return this.db.prepare('SELECT * FROM upload_chunks WHERE uploadId=? ORDER BY "index"').all(id) as UploadChunk[];
  }
  saveChunk(chunk: UploadChunk, now: number) {
    return this.db.transaction(() => {
      const upload = this.upload(chunk.uploadId, now);
      if (!upload) throw new ApiError(404, 'NOT_FOUND');
      this.checkWriter(upload.spaceId, upload.userId, now);
      const existing = this.db.prepare('SELECT * FROM upload_chunks WHERE uploadId=? AND "index"=?').get(chunk.uploadId, chunk.index) as UploadChunk | undefined;
      if (existing) {
        if (existing.size !== chunk.size || existing.sha256 !== chunk.sha256) throw new ApiError(409, 'CHUNK_CONFLICT');
        return false;
      }
      this.db.prepare('INSERT INTO upload_chunks (uploadId,"index",key,size,sha256) VALUES (@uploadId,@index,@key,@size,@sha256)').run(chunk);
      return true;
    }).immediate();
  }
  deleteUpload(id: string) {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO garbage SELECT key FROM upload_chunks WHERE uploadId=?').run(id);
      this.db.prepare('DELETE FROM uploads WHERE id=?').run(id);
    }).immediate();
  }
  deleteUserUploads(userId: string) {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM uploads WHERE userId=? OR principal=?").all(userId, `user:${userId}`) as { id: string }[];
      for (const row of rows) this.deleteUpload(row.id);
      return rows.map(row => row.id);
    }).immediate();
  }
  expireUploads(now: number) {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM uploads WHERE expiresAt<=?
        OR spaceId IN (SELECT id FROM spaces WHERE expiresAt<=?)
        OR userId IN (SELECT id FROM users WHERE disabled=1)
        OR principal IN (SELECT 'user:' || id FROM users WHERE disabled=1)`).all(now, now) as { id: string }[];
      for (const row of rows) this.deleteUpload(row.id);
      return rows.map(row => row.id);
    }).immediate();
  }
  addItem(item: Item, quota: number, maxItems: number, uploadId?: string) {
    this.db.transaction(() => {
      this.checkWriter(item.spaceId, item.userId, item.createdAt);
      if (uploadId) {
        const upload = this.upload(uploadId, item.createdAt);
        if (!upload || upload.spaceId !== item.spaceId || upload.userId !== item.userId) throw new ApiError(404, 'NOT_FOUND');
        // Release this reservation in the same transaction that inserts the final
        // item. All other uploads' reservations still count, including thumbnails.
        this.deleteUpload(uploadId);
      }
      this.checkCapacity(item.spaceId, item.userId, item.storedBytes, quota, maxItems, item.createdAt);
      const { group, device, tags: _tags, pinned: _pinned, ...columns } = item;
      this.db.prepare(`INSERT INTO items (id,spaceId,userId,kind,text,filename,mime,size,storedBytes,fileKey,thumbnailKey,createdAt,expiresAt,updatedAt,groupName,deviceId,deviceName,deviceKind)
        VALUES (@id,@spaceId,@userId,@kind,@text,@filename,@mime,@size,@storedBytes,@fileKey,@thumbnailKey,@createdAt,@expiresAt,@updatedAt,@groupName,@deviceId,@deviceName,@deviceKind)`)
        .run({ ...columns, groupName: group ?? null, deviceId: device?.id ?? null, deviceName: device?.name ?? null, deviceKind: device?.kind ?? null });
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
        const used = current.userId ? this.usage(current.userId) + this.reservedBytes(current.userId, now) :
          (this.db.prepare('SELECT coalesce(sum(storedBytes),0) AS n FROM items WHERE spaceId=?').get(current.spaceId) as { n: number }).n + this.roomReserved(current.spaceId, now);
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
  updateLabels(id: string, patch: { pinned?: 0 | 1; tags?: string[]; group?: string | null }, now: number) {
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
      const group = patch.group === undefined ? (current.group ?? null) : patch.group;
      if (group !== null && !this.db.prepare('SELECT 1 FROM item_groups WHERE spaceId=? AND name=?').get(current.spaceId, group)) throw new ApiError(404, 'GROUP_NOT_FOUND');
      this.db.prepare('UPDATE items SET pinned=?, tags=?, groupName=? WHERE id=?').run(pinned, JSON.stringify(tags), group, id);
      return { ...current, pinned, tags, group };
    }).immediate();
  }
  groups(spaceId: string) {
    return (this.db.prepare('SELECT name FROM item_groups WHERE spaceId=? ORDER BY position, createdAt, name').all(spaceId) as { name: string }[])
      .map(row => row.name);
  }
  private insertGroup(spaceId: string, name: string, now: number, max: number) {
    const count = (this.db.prepare('SELECT count(*) AS n, coalesce(max(position),-1) AS top FROM item_groups WHERE spaceId=?').get(spaceId) as { n: number; top: number });
    if (count.n >= max) throw new ApiError(409, 'GROUP_LIMIT');
    this.db.prepare('INSERT INTO item_groups (spaceId,name,position,createdAt) VALUES (?,?,?,?)').run(spaceId, name, count.top + 1, now);
  }
  ensureGroup(spaceId: string, name: string, now: number, max: number) {
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM item_groups WHERE spaceId=? AND name=?').get(spaceId, name)) return false;
      this.insertGroup(spaceId, name, now, max);
      return true;
    }).immediate();
  }
  createGroup(spaceId: string, name: string, now: number, max: number) {
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM item_groups WHERE spaceId=? AND name=?').get(spaceId, name)) throw new ApiError(409, 'GROUP_EXISTS');
      this.insertGroup(spaceId, name, now, max);
    }).immediate();
  }
  private groupItems(spaceId: string, name: string, now: number) {
    return (this.db.prepare('SELECT * FROM items WHERE spaceId=? AND groupName=? AND expiresAt>?').all(spaceId, name, now) as Item[]).map(mapItem);
  }
  renameGroup(spaceId: string, from: string, to: string, now: number) {
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM item_groups WHERE spaceId=? AND name=?').get(spaceId, from)) throw new ApiError(404, 'GROUP_NOT_FOUND');
      if (from === to) return [];
      if (this.db.prepare('SELECT 1 FROM item_groups WHERE spaceId=? AND name=?').get(spaceId, to)) throw new ApiError(409, 'GROUP_EXISTS');
      this.db.prepare('UPDATE item_groups SET name=? WHERE spaceId=? AND name=?').run(to, spaceId, from);
      this.db.prepare('UPDATE items SET groupName=? WHERE spaceId=? AND groupName=?').run(to, spaceId, from);
      return this.groupItems(spaceId, to, now);
    }).immediate();
  }
  deleteGroup(spaceId: string, name: string, now: number) {
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM item_groups WHERE spaceId=? AND name=?').get(spaceId, name)) throw new ApiError(404, 'GROUP_NOT_FOUND');
      const affected = this.groupItems(spaceId, name, now);
      this.db.prepare('UPDATE items SET groupName=NULL WHERE spaceId=? AND groupName=?').run(spaceId, name);
      this.db.prepare('DELETE FROM item_groups WHERE spaceId=? AND name=?').run(spaceId, name);
      return affected.map(item => ({ ...item, group: null }));
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
      this.expireUploads(now);
      const items = (this.db.prepare('SELECT * FROM items WHERE expiresAt<=? OR spaceId IN (SELECT id FROM spaces WHERE expiresAt<=?)').all(now, now) as Item[]).map(mapItem);
      for (const item of items) this.deleteItem(item.id);
      this.db.prepare('DELETE FROM spaces WHERE expiresAt<=?').run(now);
      this.db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(now);
      this.db.prepare('DELETE FROM flows WHERE expiresAt<=?').run(now);
      this.db.prepare('DELETE FROM device_authorizations WHERE expiresAt<=?').run(now);
      // spent invites stay: they count against their creator's invite limit and are the usage history
      this.db.prepare('DELETE FROM invites WHERE uses=0 AND (expiresAt<=? OR revoked=1)').run(now);
      this.db.prepare('DELETE FROM shares WHERE revoked=1 OR (expiresAt IS NOT NULL AND expiresAt<=?)').run(now);
      return items;
    })();
  }
  garbage() { return (this.db.prepare('SELECT key FROM garbage').all() as { key: string }[]).map(r => r.key); }
  forgetGarbage(key: string) { this.db.prepare('DELETE FROM garbage WHERE key=?').run(key); }
  fileKeys() {
    return new Set((this.db.prepare('SELECT fileKey AS key FROM items WHERE fileKey IS NOT NULL UNION SELECT thumbnailKey AS key FROM items WHERE thumbnailKey IS NOT NULL UNION SELECT key FROM upload_chunks').all() as { key: string }[]).map(r => r.key));
  }
  close() { this.db.close(); }
}

/**
 * RHEA-190 auth step 4 (migration 16): every room without a code gets a unique random one, so that old
 * rooms open at /r/<code> too. Their old links keep working and are redirected to the code by the clients.
 */
export function migrateRoomCodes(db: Database.Database, random: () => string = randomRoomCode) {
  const rooms = db.prepare('SELECT id FROM spaces WHERE roomHash IS NOT NULL AND roomCode IS NULL').all() as { id: string }[];
  const taken = db.prepare('SELECT 1 FROM spaces WHERE roomCode=?');
  const assign = db.prepare('UPDATE spaces SET roomCode=? WHERE id=?');
  for (const room of rooms) {
    for (let attempt = 0; ; attempt++) {
      if (attempt >= 100) throw new Error('could not assign a unique room code');
      const code = random();
      if (taken.get(code)) continue;
      assign.run(code, room.id);
      break;
    }
  }
  return rooms.length;
}
