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
