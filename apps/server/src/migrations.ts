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
