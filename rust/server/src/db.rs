use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, TransactionBehavior, params};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{
    ApiError, ApiResult,
    config::{Config, StartupResult},
    now,
};

#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
    available: Arc<Semaphore>,
}

impl Database {
    pub fn open(config: &mut Config) -> StartupResult<Self> {
        let connection = Connection::open_with_flags(
            config.data.join("dropit.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != 19 {
            return Err(format!("Expected a TS schema-19 fixture, found schema {version}").into());
        }
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        config.apply_settings(&connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            available: Arc::new(Semaphore::new(1)),
        })
    }

    pub async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> ApiResult<T> + Send + 'static,
    ) -> ApiResult<T> {
        let permit = self
            .available
            .clone()
            .acquire_owned()
            .await
            .map_err(ApiError::internal)?;
        let connection = self.connection.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut db = connection.lock().map_err(ApiError::internal)?;
            operation(&mut db)
        })
        .await
        .map_err(ApiError::internal)?
    }
}

pub fn user_count(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("SELECT count(*) FROM users", [], |row| row.get(0))
}

pub fn setting(db: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    db.query_row("SELECT value FROM app_settings WHERE key=?", [key], |row| {
        row.get(0)
    })
    .optional()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub role: String,
    pub disabled: i64,
    pub pending: i64,
    pub created_at: i64,
}

pub struct Account {
    pub user: User,
    pub password_hash: Option<String>,
    pub must_change_password: bool,
    pub quota: Option<i64>,
}

pub(crate) fn account(row: &Row<'_>) -> rusqlite::Result<Account> {
    Ok(Account {
        user: User {
            id: row.get("id")?,
            email: row.get("email")?,
            name: row.get("name")?,
            role: row.get("role")?,
            disabled: row.get("disabled")?,
            pending: row.get("pending")?,
            created_at: row.get("createdAt")?,
        },
        password_hash: row.get("passwordHash")?,
        must_change_password: row.get::<_, i64>("mustChangePassword")? != 0,
        quota: row.get("quotaBytes")?,
    })
}

pub fn password_account(db: &Connection, email: &str) -> ApiResult<Option<Account>> {
    Ok(db.query_row("SELECT * FROM users WHERE lower(email)=lower(?) ORDER BY passwordHash IS NULL, createdAt LIMIT 1",
        [email], account).optional()?)
}

pub fn session(db: &Connection, hash: &str, ip: Option<&str>) -> ApiResult<Option<Account>> {
    let time = now();
    let account = db.query_row(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.userId WHERE s.sessionHash=? AND s.expiresAt>? AND u.disabled=0",
        params![hash, time], account,
    ).optional()?;
    if account.is_some()
        && let Some(ip) = ip
    {
        db.execute(
            "UPDATE sessions SET lastSeenAt=?, ipSummary=? WHERE sessionHash=? AND
            (lastSeenAt IS NULL OR lastSeenAt<? OR ipSummary IS NOT ?)",
            params![time, ip, hash, time - 60000, ip],
        )?;
    }
    Ok(account)
}

/// Re-check the credential inside a write transaction. Middleware has already
/// authenticated the request, but revocation or account disablement can race
/// with the commit, so writes must not trust the earlier snapshot.
pub fn principal_account(
    db: &Connection,
    session_hash: Option<&str>,
    bearer_id: Option<&str>,
    time: i64,
) -> ApiResult<Option<Account>> {
    if let Some(session_hash) = session_hash {
        return session(db, session_hash, None);
    }
    let Some(bearer_id) = bearer_id else {
        return Ok(None);
    };
    Ok(db
        .query_row(
            "SELECT u.* FROM access_tokens t JOIN users u ON u.id=t.userId
             WHERE t.id=? AND t.revoked=0 AND u.disabled=0 AND u.pending=0
             AND (t.expiresAt IS NULL OR t.expiresAt>?)",
            params![bearer_id, time],
            account,
        )
        .optional()?)
}

pub fn principal_member(
    db: &Connection,
    session_hash: Option<&str>,
    bearer_id: Option<&str>,
    space_id: &str,
    user_id: &str,
) -> ApiResult<bool> {
    let Some(account) = principal_account(db, session_hash, bearer_id, now())? else {
        return Ok(false);
    };
    if account.user.id != user_id {
        return Ok(false);
    }
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM spaces s JOIN members m ON m.spaceId=s.id
         WHERE s.id=? AND m.userId=? AND coalesce(s.roomKey,'')='')",
        params![space_id, user_id],
        |row| row.get(0),
    )?)
}

pub fn accept_invite(db: &Connection, hash: &str, user_id: &str, time: i64) -> ApiResult<()> {
    let (id, space, join, role): (String, String, bool, String) = db.query_row(
        "SELECT i.id,i.spaceId,i.joinSpace,coalesce(i.role,'editor') FROM invites i LEFT JOIN users u ON u.id=i.createdBy
         WHERE i.tokenHash=? AND i.revoked=0 AND i.uses<i.maxUses AND i.expiresAt>? AND (i.joinSpace=1 OR u.role='admin')",
        params![hash, time], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional()?.ok_or(ApiError::new(403, "INVITE_INVALID"))?;
    if join
        && !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM members WHERE spaceId=? AND userId=?)",
            params![space, user_id],
            |row| row.get::<_, bool>(0),
        )?
    {
        db.execute("UPDATE invites SET uses=uses+1 WHERE id=?", [id])?;
        db.execute(
            "INSERT INTO members (spaceId,userId,role) VALUES (?,?,?)",
            params![space, user_id, role],
        )?;
    }
    Ok(())
}

pub fn usage(db: &Connection, user_id: &str, time: i64) -> ApiResult<(i64, i64)> {
    Ok(db.query_row(
        "SELECT (SELECT coalesce(sum(storedBytes),0) FROM items WHERE userId=?1),
        (SELECT coalesce(sum(size),0) FROM uploads WHERE userId=?1 AND expiresAt>?2)",
        params![user_id, time],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?)
}

pub fn spaces(db: &Connection, user_id: &str) -> ApiResult<Vec<Value>> {
    let mut stmt = db.prepare("SELECT s.id,s.name,s.ownerId,s.expiresAt,
        CASE WHEN s.ownerId=m.userId THEN 'owner' ELSE m.role END AS role,o.name AS ownerName
        FROM spaces s JOIN members m ON m.spaceId=s.id LEFT JOIN users o ON o.id=s.ownerId WHERE m.userId=?")?;
    let rows = stmt.query_map([user_id], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?,
            "ownerId": row.get::<_, Option<String>>(2)?, "expiresAt": row.get::<_, Option<i64>>(3)?,
            "role": row.get::<_, String>(4)?, "ownerName": row.get::<_, Option<String>>(5)?,
        }))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[allow(dead_code)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub expires_at: Option<i64>,
    pub owner_id: Option<String>,
    pub room_key: Option<String>,
    pub device_hash: Option<String>,
    pub room_code: Option<String>,
    pub pin_hash: Option<String>,
    pub created_at: Option<i64>,
    pub last_active_at: Option<i64>,
    pub closed_at: Option<i64>,
    pub created_by: Option<String>,
}

pub fn space(db: &Connection, id: &str, user_id: &str, write: bool) -> ApiResult<Space> {
    let (space, read_only) = db.query_row(
        "SELECT s.id,s.name,s.expiresAt,s.ownerId,s.roomKey,s.deviceHash,s.roomCode,s.pinHash,
         s.createdAt,s.lastActiveAt,s.closedAt,s.createdBy,
         coalesce(s.ownerId<>m.userId,1) AND m.role='viewer'
         FROM spaces s JOIN members m ON m.spaceId=s.id WHERE s.id=? AND m.userId=? AND coalesce(s.roomKey,'')=''",
        params![id, user_id],
        |row| Ok((Space {
            id: row.get(0)?, name: row.get(1)?, expires_at: row.get(2)?, owner_id: row.get(3)?,
            room_key: row.get(4)?, device_hash: row.get(5)?, room_code: row.get(6)?, pin_hash: row.get(7)?,
            created_at: row.get(8)?, last_active_at: row.get(9)?, closed_at: row.get(10)?, created_by: row.get(11)?,
        }, row.get::<_, bool>(12)?)),
    ).optional()?.ok_or(ApiError::NOT_FOUND)?;
    if write && read_only {
        return Err(ApiError::new(403, "READ_ONLY"));
    }
    Ok(space)
}

/// Load a live temporary room after its URL capability has been checked by
/// the rooms module. No member row exists for an anonymous room.
pub fn room(db: &Connection, id: &str, time: i64) -> ApiResult<Space> {
    db.query_row(
        "SELECT id,name,expiresAt,ownerId,roomKey,deviceHash,roomCode,pinHash,createdAt,lastActiveAt,closedAt,createdBy
         FROM spaces WHERE id=? AND roomKey IS NOT NULL AND closedAt IS NULL AND expiresAt>?",
        params![id, time],
        |row| Ok(Space {
            id: row.get(0)?, name: row.get(1)?, expires_at: row.get(2)?, owner_id: row.get(3)?,
            room_key: row.get(4)?, device_hash: row.get(5)?, room_code: row.get(6)?, pin_hash: row.get(7)?,
            created_at: row.get(8)?, last_active_at: row.get(9)?, closed_at: row.get(10)?, created_by: row.get(11)?,
        }),
    ).optional()?.ok_or(ApiError::NOT_FOUND)
}

pub fn room_by_code(db: &Connection, code: &str, time: i64) -> ApiResult<Option<Space>> {
    db.query_row(
        "SELECT id,name,expiresAt,ownerId,roomKey,deviceHash,roomCode,pinHash,createdAt,lastActiveAt,closedAt,createdBy
         FROM spaces WHERE roomCode=? AND roomKey IS NOT NULL AND closedAt IS NULL AND expiresAt>?",
        params![code, time],
        |row| Ok(Space {
            id: row.get(0)?, name: row.get(1)?, expires_at: row.get(2)?, owner_id: row.get(3)?,
            room_key: row.get(4)?, device_hash: row.get(5)?, room_code: row.get(6)?, pin_hash: row.get(7)?,
            created_at: row.get(8)?, last_active_at: row.get(9)?, closed_at: row.get(10)?, created_by: row.get(11)?,
        }),
    ).optional().map_err(Into::into)
}

pub fn device_room(db: &Connection, device_hash: &str, time: i64) -> ApiResult<Option<Space>> {
    db.query_row(
        "SELECT id,name,expiresAt,ownerId,roomKey,deviceHash,roomCode,pinHash,createdAt,lastActiveAt,closedAt,createdBy
         FROM spaces WHERE deviceHash=? AND roomKey IS NOT NULL AND closedAt IS NULL AND expiresAt>?",
        params![device_hash, time],
        |row| Ok(Space {
            id: row.get(0)?, name: row.get(1)?, expires_at: row.get(2)?, owner_id: row.get(3)?,
            room_key: row.get(4)?, device_hash: row.get(5)?, room_code: row.get(6)?, pin_hash: row.get(7)?,
            created_at: row.get(8)?, last_active_at: row.get(9)?, closed_at: row.get(10)?, created_by: row.get(11)?,
        }),
    ).optional().map_err(Into::into)
}

/// A private-space file that the caller may read. Keys stay off the JSON item.
pub struct StoredFile {
    pub filename: Option<String>,
    pub size: i64,
    pub file_key: Option<String>,
    pub thumbnail_key: Option<String>,
}

pub fn readable_file(
    db: &Connection,
    space_id: &str,
    user_id: &str,
    item_id: &str,
) -> ApiResult<StoredFile> {
    let time = now();
    space(db, space_id, user_id, false)?;
    let file = db
        .query_row(
            "SELECT filename, size, fileKey, thumbnailKey FROM items
             WHERE id=? AND spaceId=? AND expiresAt>?",
            params![item_id, space_id, time],
            |row| {
                Ok(StoredFile {
                    filename: row.get(0)?,
                    size: row.get(1)?,
                    file_key: row.get(2)?,
                    thumbnail_key: row.get(3)?,
                })
            },
        )
        .optional()?
        .ok_or(ApiError::NOT_FOUND)?;
    Ok(file)
}

#[derive(Clone, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub space_id: String,
    pub user_id: Option<String>,
    pub kind: String,
    pub text: Option<String>,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub expires_at: i64,
    pub pinned: bool,
    pub tags: Vec<String>,
    pub has_thumbnail: bool,
    pub group: Option<String>,
    pub device: Option<Device>,
}

pub fn item(row: &Row<'_>) -> rusqlite::Result<Item> {
    let tags = row.get::<_, String>("tags")?;
    let tags = match serde_json::from_str::<Value>(&tags) {
        Ok(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    let device = match row.get::<_, Option<String>>("deviceId")? {
        Some(id) if !id.is_empty() => Some(Device {
            id,
            name: row
                .get::<_, Option<String>>("deviceName")?
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "未命名设备".into()),
            kind: row
                .get::<_, Option<String>>("deviceKind")?
                .unwrap_or_else(|| "pc".into()),
        }),
        _ => None,
    };
    Ok(Item {
        id: row.get("id")?,
        space_id: row.get("spaceId")?,
        user_id: row.get("userId")?,
        kind: row.get("kind")?,
        text: row.get("text")?,
        filename: row.get("filename")?,
        mime: row.get("mime")?,
        size: row.get("size")?,
        created_at: row.get("createdAt")?,
        updated_at: row.get("updatedAt")?,
        expires_at: row.get("expiresAt")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        tags,
        group: row.get("groupName")?,
        has_thumbnail: row
            .get::<_, Option<String>>("thumbnailKey")?
            .is_some_and(|v| !v.is_empty()),
        device,
    })
}

pub fn item_by_id(db: &Connection, item_id: &str, time: i64) -> ApiResult<Option<Item>> {
    Ok(db
        .query_row(
            "SELECT * FROM items WHERE id=? AND expiresAt>?",
            params![item_id, time],
            item,
        )
        .optional()?)
}

pub fn snapshot(db: &Connection, space: Space) -> ApiResult<Value> {
    let mut items = db.prepare("SELECT * FROM items WHERE spaceId=? AND expiresAt>? ORDER BY pinned DESC, createdAt DESC, id DESC")?;
    let items = items
        .query_map(params![space.id, now()], item)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let groups = groups(db, &space.id)?;
    Ok(
        json!({ "type": "snapshot", "items": items, "groups": groups, "serverTime": now(), "expiresAt": space.expires_at }),
    )
}

pub fn groups(db: &Connection, space: &str) -> ApiResult<Vec<String>> {
    let mut stmt = db.prepare(
        "SELECT name FROM item_groups WHERE spaceId=? ORDER BY position, createdAt, name",
    )?;
    Ok(stmt
        .query_map([space], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub struct TextInput {
    pub text: String,
    pub group: Option<String>,
    pub device: Option<Device>,
}

pub fn insert_text(
    db: &mut Connection,
    config: &Config,
    session_hash: Option<&str>,
    bearer_id: Option<&str>,
    space_id: &str,
    input: TextInput,
) -> ApiResult<Item> {
    let time = now();
    // TS creates a named group before checking item capacity. Preserve the group if capacity rejects the item.
    if let Some(group) = &input.group {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let account = writable_account(&tx, session_hash, bearer_id)?;
        space(&tx, space_id, &account.user.id, true)?;
        ensure_group(&tx, space_id, group, time)?;
        tx.commit()?;
    }

    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let account = writable_account(&tx, session_hash, bearer_id)?;
    let space = space(&tx, space_id, &account.user.id, true)?;
    if space.expires_at.is_some_and(|expiry| expiry <= time) {
        return Err(ApiError::NOT_FOUND);
    }
    let (used, reserved) = usage(&tx, &account.user.id, time)?;
    let size = input.text.len() as i64;
    if used + reserved + size > account.quota.unwrap_or(config.quota) {
        return Err(ApiError::new(413, "QUOTA_EXCEEDED"));
    }
    let count: i64 = tx.query_row(
        "SELECT (SELECT count(*) FROM items WHERE spaceId=?1)
        + (SELECT count(*) FROM uploads WHERE spaceId=?1 AND expiresAt>?2)",
        params![space_id, time],
        |row| row.get(0),
    )?;
    if count >= config.max_items {
        return Err(ApiError::new(413, "ITEM_LIMIT"));
    }

    let id = Uuid::new_v4().to_string();
    let expires_at = space
        .expires_at
        .unwrap_or(i64::MAX)
        .min(time + config.retention);
    let device = input.device.as_ref();
    tx.execute("INSERT INTO items (id,spaceId,userId,kind,text,size,storedBytes,createdAt,expiresAt,updatedAt,groupName,deviceId,deviceName,deviceKind)
        VALUES (?1,?2,?3,'text',?4,?5,?5,?6,?7,?6,?8,?9,?10,?11)",
        params![id, space_id, account.user.id, input.text, size, time, expires_at, input.group,
            device.map(|d| &d.id), device.map(|d| &d.name), device.map(|d| &d.kind)])?;
    let inserted = tx.query_row("SELECT * FROM items WHERE id=?", [id], item)?;
    tx.commit()?;
    Ok(inserted)
}

pub fn insert_room_text(
    db: &mut Connection,
    config: &Config,
    space_id: &str,
    input: TextInput,
) -> ApiResult<Item> {
    let time = now();
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let space = room(&tx, space_id, time)?;
    if let Some(group) = &input.group {
        ensure_group(&tx, space_id, group, time)?;
    }
    let (used, reserved): (i64, i64) = tx.query_row(
        "SELECT coalesce(sum(storedBytes),0),coalesce((SELECT sum(size) FROM uploads WHERE spaceId=? AND expiresAt>?),0) FROM items WHERE spaceId=?",
        params![space_id, time, space_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let size = input.text.len() as i64;
    if used + reserved + size > config.room_quota {
        return Err(ApiError::new(413, "QUOTA_EXCEEDED"));
    }
    let count: i64 = tx.query_row(
        "SELECT count(*) + (SELECT count(*) FROM uploads WHERE spaceId=? AND expiresAt>?) FROM items WHERE spaceId=?",
        params![space_id, time, space_id], |row| row.get(0),
    )?;
    if count >= config.max_items.min(100) {
        return Err(ApiError::new(413, "ITEM_LIMIT"));
    }
    let id = Uuid::new_v4().to_string();
    let expires_at = space
        .expires_at
        .unwrap_or(i64::MAX)
        .min(time + config.retention);
    let device = input.device.as_ref();
    tx.execute(
        "INSERT INTO items (id,spaceId,userId,kind,text,size,storedBytes,createdAt,expiresAt,updatedAt,groupName,deviceId,deviceName,deviceKind)
         VALUES (?1,?2,NULL,'text',?3,?4,?4,?5,?6,?5,?7,?8,?9,?10)",
        params![id, space_id, input.text, size, time, expires_at, input.group,
            device.map(|d| &d.id), device.map(|d| &d.name), device.map(|d| &d.kind)],
    )?;
    let inserted = tx.query_row("SELECT * FROM items WHERE id=?", [id], item)?;
    tx.commit()?;
    Ok(inserted)
}

pub struct FileInput {
    pub filename: String,
    pub mime: String,
    pub size: i64,
    pub stored_bytes: i64,
    pub file_key: String,
    pub thumbnail_key: Option<String>,
    pub group: Option<String>,
    pub device: Option<Device>,
}

pub fn insert_room_file(
    db: &mut Connection,
    config: &Config,
    space_id: &str,
    input: FileInput,
) -> ApiResult<Item> {
    let time = now();
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let space = room(&tx, space_id, time)?;
    if let Some(group) = &input.group {
        ensure_group(&tx, space_id, group, time)?;
    }
    let (used, reserved): (i64, i64) = tx.query_row(
        "SELECT coalesce(sum(storedBytes),0),coalesce((SELECT sum(size) FROM uploads WHERE spaceId=? AND expiresAt>?),0) FROM items WHERE spaceId=?",
        params![space_id, time, space_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if used + reserved + input.stored_bytes > config.room_quota {
        return Err(ApiError::new(413, "QUOTA_EXCEEDED"));
    }
    let count: i64 = tx.query_row(
        "SELECT count(*) + (SELECT count(*) FROM uploads WHERE spaceId=? AND expiresAt>?) FROM items WHERE spaceId=?",
        params![space_id, time, space_id], |row| row.get(0),
    )?;
    if count >= config.max_items.min(100) {
        return Err(ApiError::new(413, "ITEM_LIMIT"));
    }
    let id = Uuid::new_v4().to_string();
    let expires_at = space
        .expires_at
        .unwrap_or(i64::MAX)
        .min(time + config.retention);
    let device = input.device.as_ref();
    tx.execute(
        "INSERT INTO items (id,spaceId,userId,kind,filename,mime,size,storedBytes,fileKey,thumbnailKey,createdAt,expiresAt,updatedAt,groupName,deviceId,deviceName,deviceKind)
         VALUES (?1,?2,NULL,'file',?3,?4,?5,?6,?7,?8,?9,?10,?9,?11,?12,?13,?14)",
        params![id, space_id, input.filename, input.mime, input.size, input.stored_bytes,
            input.file_key, input.thumbnail_key, time, expires_at, input.group,
            device.map(|d| &d.id), device.map(|d| &d.name), device.map(|d| &d.kind)],
    )?;
    let inserted = tx.query_row("SELECT * FROM items WHERE id=?", [id], item)?;
    tx.commit()?;
    Ok(inserted)
}

pub fn delete_room_item(
    db: &mut Connection,
    space_id: &str,
    item_id: &str,
) -> ApiResult<Vec<String>> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    room(&tx, space_id, now())?;
    let (file_key, thumbnail_key): (Option<String>, Option<String>) = tx
        .query_row(
            "SELECT fileKey,thumbnailKey FROM items WHERE id=? AND spaceId=? AND expiresAt>?",
            params![item_id, space_id, now()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or(ApiError::NOT_FOUND)?;
    let mut keys = Vec::new();
    for key in [file_key, thumbnail_key]
        .into_iter()
        .flatten()
        .filter(|key| !key.is_empty())
    {
        tx.execute("INSERT OR IGNORE INTO garbage (key) VALUES (?)", [&key])?;
        keys.push(key);
    }
    tx.execute("DELETE FROM items WHERE id=?", [item_id])?;
    tx.commit()?;
    Ok(keys)
}

pub fn insert_file(
    db: &mut Connection,
    config: &Config,
    session_hash: &str,
    space_id: &str,
    input: FileInput,
) -> ApiResult<Item> {
    let time = now();
    // Named groups are created before the capacity check, matching insert_text.
    if let Some(group) = &input.group {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let account = writable_account(&tx, Some(session_hash), None)?;
        space(&tx, space_id, &account.user.id, true)?;
        ensure_group(&tx, space_id, group, time)?;
        tx.commit()?;
    }

    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let account = writable_account(&tx, Some(session_hash), None)?;
    let space = space(&tx, space_id, &account.user.id, true)?;
    if space.expires_at.is_some_and(|expiry| expiry <= time) {
        return Err(ApiError::NOT_FOUND);
    }
    let (used, reserved) = usage(&tx, &account.user.id, time)?;
    let quota = account.quota.unwrap_or(config.quota);
    if used
        .saturating_add(reserved)
        .saturating_add(input.stored_bytes)
        > quota
    {
        return Err(ApiError::new(413, "QUOTA_EXCEEDED"));
    }
    let count: i64 = tx.query_row(
        "SELECT (SELECT count(*) FROM items WHERE spaceId=?1)
        + (SELECT count(*) FROM uploads WHERE spaceId=?1 AND expiresAt>?2)",
        params![space_id, time],
        |row| row.get(0),
    )?;
    if count >= config.max_items {
        return Err(ApiError::new(413, "ITEM_LIMIT"));
    }
    let id = Uuid::new_v4().to_string();
    let expires_at = space
        .expires_at
        .unwrap_or(i64::MAX)
        .min(time + config.retention);
    let device = input.device.as_ref();
    tx.execute(
        "INSERT INTO items (id,spaceId,userId,kind,filename,mime,size,storedBytes,fileKey,thumbnailKey,createdAt,expiresAt,updatedAt,groupName,deviceId,deviceName,deviceKind)
         VALUES (?1,?2,?3,'file',?4,?5,?6,?7,?8,?9,?10,?11,?10,?12,?13,?14,?15)",
        params![
            id,
            space_id,
            account.user.id,
            input.filename,
            input.mime,
            input.size,
            input.stored_bytes,
            input.file_key,
            input.thumbnail_key,
            time,
            expires_at,
            input.group,
            device.map(|device| &device.id),
            device.map(|device| &device.name),
            device.map(|device| &device.kind),
        ],
    )?;
    let inserted = tx.query_row("SELECT * FROM items WHERE id=?", [id], item)?;
    tx.commit()?;
    Ok(inserted)
}

pub fn delete_item(
    db: &mut Connection,
    session_hash: &str,
    space_id: &str,
    item_id: &str,
) -> ApiResult<Vec<String>> {
    let time = now();
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let account = writable_account(&tx, Some(session_hash), None)?;
    let space = space(&tx, space_id, &account.user.id, true)?;
    let (author, file_key, thumbnail_key): (Option<String>, Option<String>, Option<String>) = tx
        .query_row(
            "SELECT userId, fileKey, thumbnailKey FROM items WHERE id=? AND spaceId=? AND expiresAt>?",
            params![item_id, space_id, time],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or(ApiError::NOT_FOUND)?;
    if author.as_deref() != Some(account.user.id.as_str())
        && space.owner_id.as_deref() != Some(account.user.id.as_str())
    {
        return Err(ApiError::new(403, "FORBIDDEN"));
    }
    let mut keys = Vec::new();
    for key in [file_key, thumbnail_key].into_iter().flatten() {
        if key.is_empty() {
            continue;
        }
        tx.execute("INSERT OR IGNORE INTO garbage (key) VALUES (?)", [&key])?;
        keys.push(key);
    }
    tx.execute("DELETE FROM items WHERE id=?", [item_id])?;
    tx.commit()?;
    Ok(keys)
}

pub fn forget_garbage(db: &Connection, key: &str) -> ApiResult<()> {
    db.execute("DELETE FROM garbage WHERE key=?", [key])?;
    Ok(())
}

pub fn garbage_keys(db: &Connection) -> ApiResult<Vec<String>> {
    let mut stmt = db.prepare("SELECT key FROM garbage")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn referenced_file_keys(db: &Connection) -> ApiResult<Vec<String>> {
    let mut stmt = db.prepare(
        "SELECT fileKey AS key FROM items WHERE fileKey IS NOT NULL
         UNION SELECT thumbnailKey AS key FROM items WHERE thumbnailKey IS NOT NULL
         UNION SELECT key FROM upload_chunks",
    )?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub struct UploadSession {
    pub id: String,
    pub space_id: String,
    pub user_id: Option<String>,
    pub filename: String,
    pub mime: String,
    pub size: i64,
    pub chunk_size: i64,
    pub expires_at: i64,
}

pub struct UploadChunk {
    pub index: i64,
    pub key: String,
    pub size: i64,
    #[allow(dead_code)]
    pub sha256: String,
}

pub struct NewUpload {
    pub id: String,
    pub space_id: String,
    pub user_id: String,
    pub principal: String,
    pub filename: String,
    pub mime: String,
    pub size: i64,
    pub chunk_size: i64,
    pub created_at: i64,
    pub expires_at: i64,
    pub quota: i64,
    pub max_items: i64,
    pub sessions_per_user: i64,
    pub sessions_global: i64,
}

/// Reserve a session after the HTTP layer has already authenticated the caller.
///
/// Membership, quota, item slots, and live session caps are rechecked inside
/// the immediate transaction. The user id comes from that authenticated session.
pub fn create_upload_for_user(db: &mut Connection, upload: &mut NewUpload) -> ApiResult<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let space = check_writer(
        &tx,
        &upload.space_id,
        Some(&upload.user_id),
        upload.created_at,
    )?;
    // Activity does not extend the session. A space that expires sooner wins.
    upload.expires_at = upload.expires_at.min(space.expires_at.unwrap_or(i64::MAX));
    check_capacity(
        &tx,
        &upload.space_id,
        Some(&upload.user_id),
        upload.size,
        upload.quota,
        upload.max_items,
        upload.created_at,
    )?;
    let (total, own): (i64, i64) = tx.query_row(
        "SELECT count(*), coalesce(sum(principal=?1),0) FROM uploads WHERE expiresAt>?2",
        params![upload.principal, upload.created_at],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if total >= upload.sessions_global || own >= upload.sessions_per_user {
        return Err(ApiError::new(429, "UPLOAD_SESSION_LIMIT"));
    }
    tx.execute(
        "INSERT INTO uploads (id,spaceId,userId,principal,filename,mime,size,chunkSize,createdAt,expiresAt)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            upload.id,
            upload.space_id,
            upload.user_id,
            upload.principal,
            upload.filename,
            upload.mime,
            upload.size,
            upload.chunk_size,
            upload.created_at,
            upload.expires_at,
        ],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn upload_session(db: &Connection, id: &str, time: i64) -> ApiResult<Option<UploadSession>> {
    Ok(db
        .query_row(
            "SELECT id,spaceId,userId,filename,mime,size,chunkSize,expiresAt FROM uploads WHERE id=? AND expiresAt>?",
            params![id, time],
            |row| {
                Ok(UploadSession {
                    id: row.get(0)?,
                    space_id: row.get(1)?,
                    user_id: row.get(2)?,
                    filename: row.get(3)?,
                    mime: row.get(4)?,
                    size: row.get(5)?,
                    chunk_size: row.get(6)?,
                    expires_at: row.get(7)?,
                })
            },
        )
        .optional()?)
}

pub fn upload_chunks(db: &Connection, id: &str) -> ApiResult<Vec<UploadChunk>> {
    let mut stmt = db.prepare(
        "SELECT \"index\", key, size, sha256 FROM upload_chunks WHERE uploadId=? ORDER BY \"index\"",
    )?;
    let rows = stmt.query_map([id], |row| {
        Ok(UploadChunk {
            index: row.get(0)?,
            key: row.get(1)?,
            size: row.get(2)?,
            sha256: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// `true` means the new key was committed. `false` means an identical retry.
pub fn save_chunk(
    db: &mut Connection,
    upload_id: &str,
    index: i64,
    key: &str,
    size: i64,
    sha256: &str,
    time: i64,
) -> ApiResult<bool> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let upload = upload_session(&tx, upload_id, time)?.ok_or(ApiError::NOT_FOUND)?;
    let _ = check_writer(&tx, &upload.space_id, upload.user_id.as_deref(), time)?;
    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT size, sha256 FROM upload_chunks WHERE uploadId=? AND \"index\"=?",
            params![upload_id, index],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((existing_size, existing_sha)) = existing {
        if existing_size != size || existing_sha != sha256 {
            return Err(ApiError::new(409, "CHUNK_CONFLICT"));
        }
        // The first copy stays. The retry key is discarded immediately.
        tx.execute("INSERT OR IGNORE INTO garbage (key) VALUES (?)", [key])?;
        tx.commit()?;
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO upload_chunks (uploadId,\"index\",key,size,sha256) VALUES (?1,?2,?3,?4,?5)",
        params![upload_id, index, key, size, sha256],
    )?;
    tx.commit()?;
    Ok(true)
}

pub fn delete_upload(db: &mut Connection, id: &str) -> ApiResult<Vec<String>> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut stmt = tx.prepare("SELECT key FROM upload_chunks WHERE uploadId=?")?;
    let keys = stmt
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    drop(stmt);
    for key in &keys {
        tx.execute("INSERT OR IGNORE INTO garbage (key) VALUES (?)", [key])?;
    }
    tx.execute("DELETE FROM uploads WHERE id=?", [id])?;
    tx.commit()?;
    Ok(keys)
}

/// Drop expired sessions, sessions in expired spaces, and disabled users' sessions.
pub fn expire_uploads(db: &mut Connection, time: i64) -> ApiResult<Vec<String>> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut stmt = tx.prepare(
        "SELECT id FROM uploads WHERE expiresAt<=?1
         OR spaceId IN (SELECT id FROM spaces WHERE expiresAt<=?1)
         OR userId IN (SELECT id FROM users WHERE disabled=1)
         OR principal IN (SELECT 'user:' || id FROM users WHERE disabled=1)",
    )?;
    let ids = stmt
        .query_map([time], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    drop(stmt);
    for id in &ids {
        let mut keys = tx.prepare("SELECT key FROM upload_chunks WHERE uploadId=?")?;
        let chunk_keys = keys
            .query_map([id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        drop(keys);
        for key in chunk_keys {
            tx.execute("INSERT OR IGNORE INTO garbage (key) VALUES (?)", [key])?;
        }
        tx.execute("DELETE FROM uploads WHERE id=?", [id])?;
    }
    tx.commit()?;
    Ok(ids)
}

/// Release the reservation and insert the item in one immediate transaction.
pub fn complete_upload(
    db: &mut Connection,
    config: &Config,
    session_hash: &str,
    space_id: &str,
    upload_id: &str,
    input: FileInput,
) -> ApiResult<Item> {
    let time = now();
    if let Some(group) = &input.group {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let account = writable_account(&tx, Some(session_hash), None)?;
        space(&tx, space_id, &account.user.id, true)?;
        ensure_group(&tx, space_id, group, time)?;
        tx.commit()?;
    }

    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let account = writable_account(&tx, Some(session_hash), None)?;
    let space = space(&tx, space_id, &account.user.id, true)?;
    if space.expires_at.is_some_and(|expiry| expiry <= time) {
        return Err(ApiError::NOT_FOUND);
    }
    let upload = upload_session(&tx, upload_id, time)?.ok_or(ApiError::NOT_FOUND)?;
    if upload.space_id != space_id || upload.user_id.as_deref() != Some(account.user.id.as_str()) {
        return Err(ApiError::NOT_FOUND);
    }
    let mut stmt = tx.prepare("SELECT key FROM upload_chunks WHERE uploadId=?")?;
    let keys = stmt
        .query_map([upload_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    drop(stmt);
    for key in keys {
        tx.execute("INSERT OR IGNORE INTO garbage (key) VALUES (?)", [key])?;
    }
    tx.execute("DELETE FROM uploads WHERE id=?", [upload_id])?;

    let (used, reserved) = usage(&tx, &account.user.id, time)?;
    let quota = account.quota.unwrap_or(config.quota);
    if used
        .saturating_add(reserved)
        .saturating_add(input.stored_bytes)
        > quota
    {
        return Err(ApiError::new(413, "QUOTA_EXCEEDED"));
    }
    let count: i64 = tx.query_row(
        "SELECT (SELECT count(*) FROM items WHERE spaceId=?1)
        + (SELECT count(*) FROM uploads WHERE spaceId=?1 AND expiresAt>?2)",
        params![space_id, time],
        |row| row.get(0),
    )?;
    if count >= config.max_items {
        return Err(ApiError::new(413, "ITEM_LIMIT"));
    }
    let id = Uuid::new_v4().to_string();
    let expires_at = space
        .expires_at
        .unwrap_or(i64::MAX)
        .min(time + config.retention);
    let device = input.device.as_ref();
    tx.execute(
        "INSERT INTO items (id,spaceId,userId,kind,filename,mime,size,storedBytes,fileKey,thumbnailKey,createdAt,expiresAt,updatedAt,groupName,deviceId,deviceName,deviceKind)
         VALUES (?1,?2,?3,'file',?4,?5,?6,?7,?8,?9,?10,?11,?10,?12,?13,?14,?15)",
        params![
            id,
            space_id,
            account.user.id,
            input.filename,
            input.mime,
            input.size,
            input.stored_bytes,
            input.file_key,
            input.thumbnail_key,
            time,
            expires_at,
            input.group,
            device.map(|device| &device.id),
            device.map(|device| &device.name),
            device.map(|device| &device.kind),
        ],
    )?;
    let inserted = tx.query_row("SELECT * FROM items WHERE id=?", [id], item)?;
    tx.commit()?;
    Ok(inserted)
}

fn check_writer(
    db: &Connection,
    space_id: &str,
    user_id: Option<&str>,
    time: i64,
) -> ApiResult<Space> {
    let space = db
        .query_row(
            "SELECT id,name,expiresAt,ownerId FROM spaces WHERE id=?",
            [space_id],
            |row| {
                Ok(Space {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    expires_at: row.get(2)?,
                    owner_id: row.get(3)?,
                    room_key: None,
                    device_hash: None,
                    room_code: None,
                    pin_hash: None,
                    created_at: None,
                    last_active_at: None,
                    closed_at: None,
                    created_by: None,
                })
            },
        )
        .optional()?;
    let Some(space) = space else {
        return Err(ApiError::NOT_FOUND);
    };
    if space.expires_at.is_some_and(|expiry| expiry <= time) {
        return Err(ApiError::NOT_FOUND);
    }
    let Some(user_id) = user_id else {
        return Ok(space);
    };
    let disabled: Option<i64> = db
        .query_row("SELECT disabled FROM users WHERE id=?", [user_id], |row| {
            row.get(0)
        })
        .optional()?;
    if disabled.is_none_or(|value| value != 0) {
        return Err(ApiError::new(403, "FORBIDDEN"));
    }
    let role: Option<String> = db
        .query_row(
            "SELECT role FROM members WHERE spaceId=? AND userId=?",
            params![space_id, user_id],
            |row| row.get(0),
        )
        .optional()?;
    match role.as_deref() {
        Some("viewer") => Err(ApiError::new(403, "READ_ONLY")),
        Some(_) => Ok(space),
        None => Err(ApiError::new(403, "FORBIDDEN")),
    }
}

fn check_capacity(
    db: &Connection,
    space_id: &str,
    user_id: Option<&str>,
    bytes: i64,
    quota: i64,
    max_items: i64,
    time: i64,
) -> ApiResult<()> {
    let used = if let Some(user_id) = user_id {
        let (stored, reserved) = usage(db, user_id, time)?;
        stored.saturating_add(reserved)
    } else {
        let stored: i64 = db.query_row(
            "SELECT coalesce(sum(storedBytes),0) FROM items WHERE spaceId=?",
            [space_id],
            |row| row.get(0),
        )?;
        let reserved: i64 = db.query_row(
            "SELECT coalesce(sum(size),0) FROM uploads WHERE spaceId=? AND expiresAt>?",
            params![space_id, time],
            |row| row.get(0),
        )?;
        stored.saturating_add(reserved)
    };
    if used.saturating_add(bytes) > quota {
        return Err(ApiError::new(413, "QUOTA_EXCEEDED"));
    }
    let count: i64 = db.query_row(
        "SELECT (SELECT count(*) FROM items WHERE spaceId=?1)
        + (SELECT count(*) FROM uploads WHERE spaceId=?1 AND expiresAt>?2)",
        params![space_id, time],
        |row| row.get(0),
    )?;
    if count >= max_items {
        return Err(ApiError::new(413, "ITEM_LIMIT"));
    }
    Ok(())
}

pub struct PreviewSource {
    pub item_id: String,
    pub file_key: String,
    pub expires_at: i64,
}

pub fn preview_source(
    db: &Connection,
    space_id: &str,
    user_id: &str,
    item_id: &str,
) -> ApiResult<PreviewSource> {
    let time = now();
    space(db, space_id, user_id, false)?;
    let (file_key, thumbnail_key, expires_at): (Option<String>, Option<String>, i64) = db
        .query_row(
            "SELECT fileKey, thumbnailKey, expiresAt FROM items WHERE id=? AND spaceId=? AND expiresAt>?",
            params![item_id, space_id, time],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or(ApiError::NOT_FOUND)?;
    let file_key = file_key
        .filter(|key| !key.is_empty())
        .ok_or(ApiError::NOT_FOUND)?;
    if thumbnail_key.as_deref().is_none_or(|key| key.is_empty()) {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(PreviewSource {
        item_id: item_id.to_owned(),
        file_key,
        expires_at,
    })
}

pub fn item_live(db: &Connection, item_id: &str) -> ApiResult<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM items WHERE id=? AND expiresAt>?)",
        params![item_id, now()],
        |row| row.get(0),
    )?)
}

fn writable_account(
    db: &Connection,
    session_hash: Option<&str>,
    bearer_id: Option<&str>,
) -> ApiResult<Account> {
    let account =
        principal_account(db, session_hash, bearer_id, now())?.ok_or(ApiError::UNAUTHENTICATED)?;
    if account.must_change_password {
        return Err(ApiError::new(403, "PASSWORD_CHANGE_REQUIRED"));
    }
    Ok(account)
}

fn ensure_group(db: &Connection, space: &str, group: &str, time: i64) -> ApiResult<()> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM item_groups WHERE spaceId=? AND name=?)",
        params![space, group],
        |row| row.get(0),
    )?;
    if !exists {
        let (count, top): (i64, i64) = db.query_row(
            "SELECT count(*),coalesce(max(position),-1) FROM item_groups WHERE spaceId=?",
            [space],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if count >= 24 {
            return Err(ApiError::new(409, "GROUP_LIMIT"));
        }
        db.execute(
            "INSERT INTO item_groups (spaceId,name,position,createdAt) VALUES (?,?,?,?)",
            params![space, group, top + 1, time],
        )?;
    }
    Ok(())
}
