//! SQLite schema upgrades shared by the Rust server.
//!
//! The TypeScript server is the schema authority.  Keep these statements in
//! the same order and with the same defaults as `apps/server/src/migrations.ts`.
//! Every upgrade runs before the connection is handed to the request handlers.

use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};

use crate::config::StartupResult;

pub const CURRENT_SCHEMA: i64 = 19;

pub fn open(path: &Path) -> StartupResult<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        }
    }
    let mut db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > CURRENT_SCHEMA {
        return Err(format!("Unsupported schema version {version}").into());
    }

    // Migration 16 rebuilds `spaces`, so preserve the same pre-migration
    // snapshot guarantee as the TS repository for all pre-17 databases.
    if version > 0 && version < 17 && path.exists() {
        let backup = backup_path(path, version);
        let escaped = backup.to_string_lossy().replace('\'', "''");
        db.execute_batch(&format!("VACUUM INTO '{escaped}';"))?;
        eprintln!(
            "dropit: backed up the database (schema {version}) to {} before migrating",
            backup.display()
        );
    }

    if version < 16 {
        db.pragma_update(None, "foreign_keys", "OFF")?;
        let tx = db.transaction()?;
        apply_pre_16(&tx, version)?;
        tx.commit()?;
        db.pragma_update(None, "foreign_keys", "ON")?;
    }
    if version < 17 {
        let tx = db.transaction()?;
        tx.execute_batch(MIGRATION_17)?;
        tx.commit()?;
    }
    if version < 18 {
        let tx = db.transaction()?;
        tx.execute_batch(MIGRATION_18)?;
        tx.commit()?;
    }
    if version < 19 {
        let tx = db.transaction()?;
        tx.execute_batch(MIGRATION_19)?;
        tx.commit()?;
    }

    let final_version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if final_version != CURRENT_SCHEMA {
        return Err(format!("Migration stopped at schema {final_version}").into());
    }
    Ok(db)
}

fn backup_path(path: &Path, version: i64) -> std::path::PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let suffix = format!("{}-{}", now.as_secs(), now.subsec_nanos());
    std::path::PathBuf::from(format!("{}.pre-v{version}-{suffix}.bak", path.display()))
}

fn apply_pre_16(tx: &Transaction<'_>, version: i64) -> StartupResult<()> {
    if version < 1 {
        tx.execute_batch(MIGRATION_1)?;
    }
    if version < 2 {
        tx.execute_batch(MIGRATION_2)?;
    }
    if version < 3 {
        tx.execute_batch(MIGRATION_3)?;
    }
    if version < 4 {
        tx.execute_batch(MIGRATION_4)?;
    }
    if version < 5 {
        tx.execute_batch(MIGRATION_5)?;
    }
    if version < 6 {
        tx.execute_batch(MIGRATION_6)?;
    }
    if version < 7 {
        tx.execute_batch(MIGRATION_7)?;
    }
    if version < 8 {
        tx.execute_batch(MIGRATION_8)?;
    }
    if version < 9 {
        tx.execute_batch(MIGRATION_9)?;
    }
    if version < 10 {
        tx.execute_batch(MIGRATION_10)?;
    }
    if version < 11 {
        tx.execute_batch(MIGRATION_11)?;
    }
    if version < 12 {
        tx.execute_batch(MIGRATION_12)?;
    }
    if version < 13 {
        tx.execute_batch(MIGRATION_13)?;
    }
    if version < 14 {
        tx.execute_batch(MIGRATION_14)?;
    }
    if version < 15 {
        tx.execute_batch(MIGRATION_15)?;
    }
    if version < 16 {
        tx.execute_batch(MIGRATION_16)?;
        migrate_room_codes(tx)?;
        let mut check = tx.prepare("PRAGMA foreign_key_check")?;
        if check.query([])?.next()?.is_some() {
            return Err("migration 16 broke a foreign key".into());
        }
        tx.execute_batch("PRAGMA user_version=16;")?;
    }
    Ok(())
}

fn migrate_room_codes(tx: &Transaction<'_>) -> StartupResult<()> {
    let mut rows = tx.prepare("SELECT id,roomCode FROM spaces WHERE roomKey IS NOT NULL")?;
    let rooms = rows
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(rows);

    for (id, code) in rooms {
        if code.as_deref().is_some_and(is_step_three_random_code) {
            // A five-character code made only from the random alphabet was the
            // old generated form.  It receives a fresh six-character code.
            assign_room_code(tx, &id)?;
        } else if code.is_none() {
            assign_room_code(tx, &id)?;
        }
    }
    Ok(())
}

const ROOM_CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";

fn is_step_three_random_code(value: &str) -> bool {
    value.len() == 5 && value.bytes().all(|byte| ROOM_CODE_ALPHABET.contains(&byte))
}

fn assign_room_code(tx: &Transaction<'_>, id: &str) -> StartupResult<()> {
    for _ in 0..100 {
        let code = random_room_code()?;
        let taken: Option<String> = tx
            .query_row("SELECT id FROM spaces WHERE roomCode=?", [&code], |row| {
                row.get(0)
            })
            .optional()?;
        if taken.is_none() {
            tx.execute("UPDATE spaces SET roomCode=? WHERE id=?", params![code, id])?;
            return Ok(());
        }
    }
    Err("could not assign a unique room code".into())
}

fn random_room_code() -> StartupResult<String> {
    let mut output = String::with_capacity(6);
    let cutoff = u8::MAX - (u8::MAX % ROOM_CODE_ALPHABET.len() as u8);
    while output.len() < 6 {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes)?;
        for byte in bytes {
            if byte >= cutoff {
                continue;
            }
            output.push(ROOM_CODE_ALPHABET[(byte as usize) % ROOM_CODE_ALPHABET.len()] as char);
            if output.len() == 6 {
                break;
            }
        }
    }
    Ok(output)
}

const MIGRATION_1: &str = r#"
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
"#;

const MIGRATION_2: &str = r#"
ALTER TABLE users ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN quotaBytes INTEGER;
CREATE INDEX user_email ON users(email);
PRAGMA user_version=2;
"#;

const MIGRATION_3: &str = r#"
ALTER TABLE items ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0;
UPDATE items SET updatedAt = createdAt WHERE updatedAt = 0;
PRAGMA user_version=3;
"#;

const MIGRATION_4: &str = r#"
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
"#;

const MIGRATION_5: &str = r#"
ALTER TABLE items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
PRAGMA user_version=5;
"#;

const MIGRATION_6: &str = r#"
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
"#;

const MIGRATION_7: &str = r#"
CREATE TABLE runtime_limits (key TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value > 0));
CREATE TABLE limit_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actorId TEXT NOT NULL REFERENCES users(id), actorEmail TEXT NOT NULL, createdAt INTEGER NOT NULL,
 key TEXT NOT NULL, oldValue INTEGER NOT NULL, newValue INTEGER NOT NULL,
 oldOverride INTEGER, newOverride INTEGER
);
PRAGMA user_version=7;
"#;

const MIGRATION_8: &str = r#"
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
"#;

const MIGRATION_9: &str = r#"
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
"#;

const MIGRATION_10: &str = r#"
ALTER TABLE spaces ADD COLUMN deviceHash TEXT;
CREATE UNIQUE INDEX room_device ON spaces(deviceHash) WHERE deviceHash IS NOT NULL;
PRAGMA user_version=10;
"#;

const MIGRATION_11: &str = r#"
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
"#;

const MIGRATION_12: &str = r#"
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
"#;

const MIGRATION_13: &str = r#"
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL, updatedBy TEXT);
PRAGMA user_version=13;
"#;

const MIGRATION_14: &str = r#"
ALTER TABLE users ADD COLUMN passwordHash TEXT;
ALTER TABLE users ADD COLUMN mustChangePassword INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN passwordUpdatedAt INTEGER;
PRAGMA user_version=14;
"#;

const MIGRATION_15: &str = r#"
ALTER TABLE spaces ADD COLUMN roomCode TEXT;
ALTER TABLE spaces ADD COLUMN pinHash TEXT;
CREATE UNIQUE INDEX room_code ON spaces(roomCode) WHERE roomCode IS NOT NULL;
ALTER TABLE users ADD COLUMN inviteLimit INTEGER;
ALTER TABLE invites ADD COLUMN joinSpace INTEGER NOT NULL DEFAULT 1;
ALTER TABLE invites ADD COLUMN createdAt INTEGER;
PRAGMA user_version=15;
"#;

const MIGRATION_16: &str = r#"
CREATE TABLE spaces_v16 (id TEXT PRIMARY KEY, name TEXT NOT NULL, ownerId TEXT REFERENCES users(id), expiresAt INTEGER,
 roomKey TEXT UNIQUE, deviceHash TEXT, roomCode TEXT, pinHash TEXT);
INSERT INTO spaces_v16 (id,name,ownerId,expiresAt,roomKey,deviceHash,roomCode,pinHash)
 SELECT id,name,ownerId,expiresAt,CASE WHEN roomHash IS NULL THEN NULL ELSE lower(hex(randomblob(32))) END,deviceHash,roomCode,pinHash FROM spaces;
DROP TABLE spaces;
ALTER TABLE spaces_v16 RENAME TO spaces;
CREATE UNIQUE INDEX personal_space ON spaces(ownerId) WHERE ownerId IS NOT NULL;
CREATE UNIQUE INDEX room_device ON spaces(deviceHash) WHERE deviceHash IS NOT NULL;
CREATE UNIQUE INDEX room_code ON spaces(roomCode) WHERE roomCode IS NOT NULL;
"#;

const MIGRATION_17: &str = r#"
ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'editor';
ALTER TABLE invites ADD COLUMN role TEXT;
ALTER TABLE spaces ADD COLUMN createdAt INTEGER;
ALTER TABLE spaces ADD COLUMN lastActiveAt INTEGER;
ALTER TABLE spaces ADD COLUMN closedAt INTEGER;
ALTER TABLE spaces ADD COLUMN createdBy TEXT;
PRAGMA user_version=17;
"#;

const MIGRATION_18: &str = r#"
ALTER TABLE shares RENAME TO shares_v17;
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  tokenHash TEXT UNIQUE NOT NULL,
  itemId TEXT NOT NULL,
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
INSERT INTO shares (id,tokenHash,itemId,spaceId,createdBy,expiresAt,maxViews,views,revoked,createdAt,downloadTicketHash,downloadTicketExpiresAt)
  SELECT id,tokenHash,itemId,spaceId,createdBy,expiresAt,maxViews,views,revoked,createdAt,downloadTicketHash,downloadTicketExpiresAt FROM shares_v17;
DROP TABLE shares_v17;
CREATE INDEX share_item ON shares(itemId);
CREATE INDEX share_space ON shares(spaceId);
CREATE INDEX share_creator ON shares(createdBy,createdAt DESC,id DESC);
PRAGMA user_version=18;
"#;

const MIGRATION_19: &str = r#"
ALTER TABLE shares ADD COLUMN copyToken TEXT;
PRAGMA user_version=19;
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(label: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "dropit-{label}-{}-{stamp}.sqlite",
            std::process::id()
        ))
    }

    #[test]
    fn creates_the_current_schema_from_an_empty_database() {
        let path = temp_path("empty-migration");
        let db = open(&path).unwrap();
        let version: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA);
        assert!(db.prepare("SELECT copyToken FROM shares").is_ok());
        drop(db);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn upgrades_schema_15_with_a_backup_and_room_code() {
        let path = temp_path("history-migration");
        let db = Connection::open(&path).unwrap();
        for migration in [
            MIGRATION_1,
            MIGRATION_2,
            MIGRATION_3,
            MIGRATION_4,
            MIGRATION_5,
            MIGRATION_6,
            MIGRATION_7,
            MIGRATION_8,
            MIGRATION_9,
            MIGRATION_10,
            MIGRATION_11,
            MIGRATION_12,
            MIGRATION_13,
            MIGRATION_14,
            MIGRATION_15,
        ] {
            db.execute_batch(migration).unwrap();
        }
        db.execute(
            "INSERT INTO spaces (id,name,ownerId,expiresAt,roomHash) VALUES ('room','old room',NULL,NULL,'legacy')",
            [],
        )
        .unwrap();
        drop(db);

        let db = open(&path).unwrap();
        let (room_key, room_code): (Option<String>, Option<String>) = db
            .query_row(
                "SELECT roomKey,roomCode FROM spaces WHERE id='room'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(room_key.is_some());
        assert_eq!(room_code.as_deref().map(str::len), Some(6));
        let version: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA);
        drop(db);

        let backup = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|candidate| {
                let prefix = format!(
                    "{}.pre-v15-",
                    path.file_name().and_then(|value| value.to_str()).unwrap()
                );
                candidate
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.starts_with(&prefix))
            });
        assert!(
            backup.is_some(),
            "historical database backup was not created"
        );
        let _ = fs::remove_file(path);
        if let Some(backup) = backup {
            let _ = fs::remove_file(backup);
        }
    }
}
