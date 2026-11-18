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

fn account(row: &Row<'_>) -> rusqlite::Result<Account> {
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

pub struct Space {
    pub id: String,
    pub name: String,
    pub expires_at: Option<i64>,
}

pub fn space(db: &Connection, id: &str, user_id: &str, write: bool) -> ApiResult<Space> {
    let (space, read_only) = db.query_row(
        "SELECT s.id,s.name,s.expiresAt, coalesce(s.ownerId<>m.userId,1) AND m.role='viewer'
         FROM spaces s JOIN members m ON m.spaceId=s.id WHERE s.id=? AND m.userId=? AND coalesce(s.roomKey,'')=''",
        params![id, user_id],
        |row| Ok((Space { id: row.get(0)?, name: row.get(1)?, expires_at: row.get(2)? }, row.get::<_, bool>(3)?)),
    ).optional()?.ok_or(ApiError::NOT_FOUND)?;
    if write && read_only {
        return Err(ApiError::new(403, "READ_ONLY"));
    }
    Ok(space)
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

#[derive(Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    id: String,
    space_id: String,
    user_id: Option<String>,
    kind: String,
    text: Option<String>,
    filename: Option<String>,
    mime: Option<String>,
    size: i64,
    created_at: i64,
    updated_at: i64,
    expires_at: i64,
    pinned: bool,
    tags: Vec<String>,
    has_thumbnail: bool,
    group: Option<String>,
    device: Option<Device>,
}

fn item(row: &Row<'_>) -> rusqlite::Result<Item> {
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

pub fn snapshot(db: &Connection, space: Space) -> ApiResult<Value> {
    let mut items = db.prepare("SELECT * FROM items WHERE spaceId=? AND expiresAt>? ORDER BY pinned DESC, createdAt DESC, id DESC")?;
    let items = items
        .query_map(params![space.id, now()], item)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut groups = db.prepare(
        "SELECT name FROM item_groups WHERE spaceId=? ORDER BY position, createdAt, name",
    )?;
    let groups = groups
        .query_map([space.id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(
        json!({ "type": "snapshot", "items": items, "groups": groups, "serverTime": now(), "expiresAt": space.expires_at }),
    )
}

pub struct TextInput {
    pub text: String,
    pub group: Option<String>,
    pub device: Option<Device>,
}

pub fn insert_text(
    db: &mut Connection,
    config: &Config,
    session_hash: &str,
    space_id: &str,
    input: TextInput,
) -> ApiResult<Item> {
    let time = now();
    // TS creates a named group before checking item capacity. Preserve the group if capacity rejects the item.
    if let Some(group) = &input.group {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let account = writable_account(&tx, session_hash)?;
        space(&tx, space_id, &account.user.id, true)?;
        ensure_group(&tx, space_id, group, time)?;
        tx.commit()?;
    }

    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let account = writable_account(&tx, session_hash)?;
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

fn writable_account(db: &Connection, session_hash: &str) -> ApiResult<Account> {
    let account = session(db, session_hash, None)?.ok_or(ApiError::UNAUTHENTICATED)?;
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
