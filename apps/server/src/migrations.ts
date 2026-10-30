// user_version is the migration ledger; DDL runs atomically on startup.
export const migration1 = `
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
CREATE TABLE identities (provider TEXT NOT NULL, subject TEXT NOT NULL, userId TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(provider,subject));
CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, ownerId TEXT REFERENCES users(id), expiresAt INTEGER, roomHash TEXT UNIQUE);
CREATE UNIQUE INDEX personal_space ON spaces(ownerId) WHERE ownerId IS NOT NULL;
CREATE TABLE members (spaceId TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(spaceId,userId));
CREATE TABLE invites (id TEXT PRIMARY KEY, tokenHash TEXT UNIQUE NOT NULL, spaceId TEXT NOT NULL REFERENCES spaces(id),
 maxUses INTEGER NOT NULL CHECK(maxUses>0), uses INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL,
 revoked INTEGER NOT NULL DEFAULT 0, createdBy TEXT NOT NULL REFERENCES users(id));
CREATE TABLE sessions (sessionHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), expiresAt INTEGER NOT NULL);
CREATE INDEX session_user ON sessions(userId);
CREATE TABLE flows (stateHash TEXT PRIMARY KEY, browserHash TEXT NOT NULL, provider TEXT NOT NULL, verifier TEXT NOT NULL, inviteHash TEXT, expiresAt INTEGER NOT NULL);
CREATE TABLE items (id TEXT PRIMARY KEY, spaceId TEXT NOT NULL REFERENCES spaces(id), userId TEXT REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('text','file')), text TEXT, filename TEXT, mime TEXT, size INTEGER NOT NULL,
 storedBytes INTEGER NOT NULL, fileKey TEXT, thumbnailKey TEXT, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
CREATE INDEX item_space ON items(spaceId,createdAt);
CREATE INDEX item_user ON items(userId);
CREATE INDEX item_expiry ON items(expiresAt);
CREATE TABLE garbage (key TEXT PRIMARY KEY);
PRAGMA user_version=1;
`;

// Pending accounts are claimed by the first verified OAuth identity with the same email.
// quotaBytes NULL means the installation default (USER_QUOTA_BYTES).
export const migration2 = `
ALTER TABLE users ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN quotaBytes INTEGER;
CREATE INDEX user_email ON users(email);
PRAGMA user_version=2;
`;

// updatedAt stays equal to createdAt until the text is edited in place.
export const migration3 = `
ALTER TABLE items ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0;
UPDATE items SET updatedAt = createdAt WHERE updatedAt = 0;
PRAGMA user_version=3;
`;

// Share links store only the token hash. expiresAt NULL means the link itself does not expire.
// maxViews NULL means unlimited. The download ticket authorizes file/thumbnail after a view is spent.
export const migration4 = `
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  tokenHash TEXT UNIQUE NOT NULL,
  itemId TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  spaceId TEXT NOT NULL,
  createdBy TEXT REFERENCES users(id),
  expiresAt INTEGER,
  maxViews INTEGER CHECK (maxViews IS NULL OR maxViews > 0),
  views INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  downloadTicketHash TEXT,
  downloadTicketExpiresAt INTEGER
);
CREATE INDEX share_item ON shares(itemId);
CREATE INDEX share_space ON shares(spaceId);
PRAGMA user_version=4;
`;

// pinned and tags are clip metadata. tags is a JSON array. Existing rows stay unpinned with no tags.
export const migration5 = `
ALTER TABLE items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
PRAGMA user_version=5;
`;

export const migration6 = `
CREATE TABLE access_tokens (
 id TEXT PRIMARY KEY, tokenHash TEXT UNIQUE NOT NULL,
 userId TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, scopes TEXT NOT NULL,
 createdAt INTEGER NOT NULL, lastUsedAt INTEGER, expiresAt INTEGER, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX access_token_user ON access_tokens(userId);
CREATE TABLE device_authorizations (
 id TEXT PRIMARY KEY, deviceCodeHash TEXT UNIQUE NOT NULL, userCodeHash TEXT UNIQUE NOT NULL,
 name TEXT NOT NULL, ipSummary TEXT NOT NULL, scopes TEXT NOT NULL, tokenLifetimeMs INTEGER,
 expiresAt INTEGER NOT NULL, interval INTEGER NOT NULL, nextPollAt INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','consumed')),
 userId TEXT REFERENCES users(id)
);
CREATE INDEX device_expiry ON device_authorizations(expiresAt);
PRAGMA user_version=6;
`;

// Both runtime overrides and their audit trail live alongside content in DATA_DIR.
export const migration7 = `
CREATE TABLE runtime_limits (key TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value > 0));
CREATE TABLE limit_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actorId TEXT NOT NULL REFERENCES users(id), actorEmail TEXT NOT NULL, createdAt INTEGER NOT NULL,
 key TEXT NOT NULL, oldValue INTEGER NOT NULL, newValue INTEGER NOT NULL,
 oldOverride INTEGER, newOverride INTEGER
);
PRAGMA user_version=7;
`;

// Unfinished uploads reserve both bytes and an item slot. Chunk keys use the same
// durable garbage queue as items, so deletion is retried after crashes/I/O errors.
export const migration8 = `
CREATE TABLE uploads (
 id TEXT PRIMARY KEY, spaceId TEXT NOT NULL REFERENCES spaces(id), userId TEXT REFERENCES users(id),
 principal TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size>0), chunkSize INTEGER NOT NULL CHECK(chunkSize>0),
 createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL
);
CREATE INDEX upload_user ON uploads(userId);
CREATE INDEX upload_space ON uploads(spaceId);
CREATE INDEX upload_principal ON uploads(principal);
CREATE INDEX upload_expiry ON uploads(expiresAt);
CREATE TABLE upload_chunks (
 uploadId TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
 "index" INTEGER NOT NULL CHECK("index">=0), key TEXT UNIQUE NOT NULL,
 size INTEGER NOT NULL CHECK(size>0), sha256 TEXT NOT NULL,
 PRIMARY KEY(uploadId,"index")
);
PRAGMA user_version=8;
`;

// Step 5 (RHEA-190): demo-style groups and device identity. Every column is
// nullable so existing rows stay "ungrouped / unknown device".
export const migration9 = `
CREATE TABLE item_groups (
 spaceId TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL, position INTEGER NOT NULL, createdAt INTEGER NOT NULL,
 PRIMARY KEY(spaceId,name)
);
ALTER TABLE items ADD COLUMN groupName TEXT;
ALTER TABLE items ADD COLUMN deviceId TEXT;
ALTER TABLE items ADD COLUMN deviceName TEXT;
ALTER TABLE items ADD COLUMN deviceKind TEXT;
CREATE INDEX item_group ON items(spaceId,groupName);
PRAGMA user_version=9;
`;

// Step 7 (RHEA-190): a browser keeps one temporary room at a time. deviceHash
// is sha256 of the browser's secret room key; only live rooms may hold it.
export const migration10 = `
ALTER TABLE spaces ADD COLUMN deviceHash TEXT;
CREATE UNIQUE INDEX room_device ON spaces(deviceHash) WHERE deviceHash IS NOT NULL;
PRAGMA user_version=10;
`;

// RHEA-190 r4: every browser login becomes a manageable device. Old rows get a
// random id and stay "unknown device" until the browser is seen again.
export const migration11 = `
ALTER TABLE sessions ADD COLUMN id TEXT;
ALTER TABLE sessions ADD COLUMN createdAt INTEGER;
ALTER TABLE sessions ADD COLUMN lastSeenAt INTEGER;
ALTER TABLE sessions ADD COLUMN userAgent TEXT;
ALTER TABLE sessions ADD COLUMN ipSummary TEXT;
ALTER TABLE sessions ADD COLUMN deviceId TEXT;
ALTER TABLE sessions ADD COLUMN deviceName TEXT;
ALTER TABLE sessions ADD COLUMN deviceKind TEXT;
UPDATE sessions SET id=lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX session_id ON sessions(id);
PRAGMA user_version=11;
`;

// RHEA-190 m11: OAuth apps configurable from 设置, and several providers bound to
// one account. clientSecret never leaves the server (the API only returns a
// masked hint). identities gain the provider email and link time for display;
// flows remember which signed-in user started a "bind" flow.
export const migration12 = `
CREATE TABLE oauth_apps (
 provider TEXT PRIMARY KEY, clientId TEXT NOT NULL, clientSecret TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, updatedAt INTEGER NOT NULL, updatedBy TEXT,
 checkedAt INTEGER, checkOk INTEGER, checkCode TEXT
);
ALTER TABLE identities ADD COLUMN email TEXT;
ALTER TABLE identities ADD COLUMN linkedAt INTEGER;
ALTER TABLE flows ADD COLUMN linkUserId TEXT;
CREATE INDEX identity_user ON identities(userId);
PRAGMA user_version=12;
`;

// RHEA-190 auth step 1: installation-wide text settings edited in 管理 (first: the
// site address, key appOrigin). Admin setting > environment variable.
export const migration13 = `
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL, updatedBy TEXT);
PRAGMA user_version=13;
`;

// RHEA-190 auth step 2: email + password sign-in next to OAuth. passwordHash is
// scrypt$N$r$p$salt$key (NULL = OAuth-only account). mustChangePassword is set by an
// admin reset or `dropit-admin reset-password` and cleared when the user picks a new one.
export const migration14 = `
ALTER TABLE users ADD COLUMN passwordHash TEXT;
ALTER TABLE users ADD COLUMN mustChangePassword INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN passwordUpdatedAt INTEGER;
PRAGMA user_version=14;
`;

// RHEA-190 auth step 3: short room codes (typed to enter a room, optionally with a PIN), per-user
// invite limits and personal invites. roomCode is case-sensitive and unique among rooms that still
// exist (expired rooms give theirs up on creation of a new one). pinHash is scrypt. joinSpace=0 marks
// a personal invite: it only lets someone register and never adds the invitee to the inviter's space.
export const migration15 = `
ALTER TABLE spaces ADD COLUMN roomCode TEXT;
ALTER TABLE spaces ADD COLUMN pinHash TEXT;
CREATE UNIQUE INDEX room_code ON spaces(roomCode) WHERE roomCode IS NOT NULL;
ALTER TABLE users ADD COLUMN inviteLimit INTEGER;
ALTER TABLE invites ADD COLUMN joinSpace INTEGER NOT NULL DEFAULT 1;
ALTER TABLE invites ADD COLUMN createdAt INTEGER;
PRAGMA user_version=15;
`;

// RHEA-190 auth step 4: the room code IS the room link (/r/<code>) and the old long room links are removed
// for good (01a18243). The spaces table is rebuilt without roomHash (the hash of the old 43-character link,
// and of the 6-character step-3 link); rooms get a fresh internal secret, roomKey, that only derives access
// tokens. migrateRoomCodes (repository) then gives rooms their 6-character codes and the repository sets
// user_version=16. Runs with foreign keys off (the repository turns them off around the migration).
export const migration16 = `
CREATE TABLE spaces_v16 (id TEXT PRIMARY KEY, name TEXT NOT NULL, ownerId TEXT REFERENCES users(id), expiresAt INTEGER,
 roomKey TEXT UNIQUE, deviceHash TEXT, roomCode TEXT, pinHash TEXT);
INSERT INTO spaces_v16 (id,name,ownerId,expiresAt,roomKey,deviceHash,roomCode,pinHash)
 SELECT id,name,ownerId,expiresAt,CASE WHEN roomHash IS NULL THEN NULL ELSE lower(hex(randomblob(32))) END,deviceHash,roomCode,pinHash FROM spaces;
DROP TABLE spaces;
ALTER TABLE spaces_v16 RENAME TO spaces;
CREATE UNIQUE INDEX personal_space ON spaces(ownerId) WHERE ownerId IS NOT NULL;
CREATE UNIQUE INDEX room_device ON spaces(deviceHash) WHERE deviceHash IS NOT NULL;
CREATE UNIQUE INDEX room_code ON spaces(roomCode) WHERE roomCode IS NOT NULL;
`;

// RHEA-190 m50: space invites are read-only by default, and admins see temporary rooms (metadata only).
// Additive only, safe on a live database: existing members stay editors (the default), existing invites
// keep role NULL (= editor, as before). Rooms get created/last-active/closed timestamps and who created them
// (a signed-in user, else NULL); rooms from before this migration have NULL there and the admin list derives
// their creation time from expiresAt - roomRetentionMs.
export const migration17 = `
ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'editor';
ALTER TABLE invites ADD COLUMN role TEXT;
ALTER TABLE spaces ADD COLUMN createdAt INTEGER;
ALTER TABLE spaces ADD COLUMN lastActiveAt INTEGER;
ALTER TABLE spaces ADD COLUMN closedAt INTEGER;
ALTER TABLE spaces ADD COLUMN createdBy TEXT;
PRAGMA user_version=17;
`;
