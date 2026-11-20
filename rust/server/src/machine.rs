//! PATs, device authorization, and the one-time WebView session handoff.
//!
//! The wire formats in this module intentionally mirror the TypeScript
//! machine-auth implementation. Raw credentials are only returned to the
//! caller that created them; SQLite stores SHA-256 digests.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    ApiError, ApiResult,
    db::{self, Account},
    password,
};

pub const USER_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

#[derive(Clone, Debug)]
pub struct Bearer {
    pub id: String,
    pub scopes: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct AccessToken {
    pub id: String,
    pub user_id: String,
    pub name: crate::js::JsString,
    pub scopes: Vec<String>,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub revoked: i64,
}

#[derive(Clone, Debug)]
pub struct DeviceAuthorization {
    pub id: String,
    pub device_code_hash: String,
    pub user_code_hash: String,
    pub name: crate::js::JsString,
    pub ip_summary: String,
    pub scopes: Vec<String>,
    pub token_lifetime_ms: Option<i64>,
    pub expires_at: i64,
    pub interval: i64,
    pub next_poll_at: i64,
    pub attempts: i64,
    pub status: String,
    pub user_id: Option<String>,
}

pub struct TokenOptions {
    pub name: crate::js::JsString,
    pub scopes: Vec<String>,
    pub lifetime_ms: Option<i64>,
}

pub enum PollResult {
    Error(Value),
    Token(AccessToken),
}

pub fn raw_token() -> ApiResult<String> {
    password::session_token()
}

pub fn token_options(body: &crate::js::Object, allow_web: bool) -> ApiResult<TokenOptions> {
    let name = person_name(body.get("name"))?;
    let scopes = match body.get("scopes") {
        None => vec!["read".to_owned(), "write".to_owned()],
        Some(crate::js::Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or(ApiError::INVALID_INPUT)
            })
            .collect::<ApiResult<Vec<_>>>()?,
        _ => return Err(ApiError::INVALID_INPUT),
    };
    let allowed: &[&str] = if allow_web {
        &["read", "write", "web"]
    } else {
        &["read", "write"]
    };
    if scopes.is_empty()
        || scopes.len() > allowed.len()
        || scopes
            .iter()
            .any(|scope| !allowed.contains(&scope.as_str()))
        || scopes.iter().collect::<HashSet<_>>().len() != scopes.len()
        || (scopes.iter().any(|scope| scope == "web")
            && !(scopes.iter().any(|scope| scope == "read")
                && scopes.iter().any(|scope| scope == "write")))
    {
        return Err(ApiError::INVALID_INPUT);
    }
    let lifetime_ms = match body.get("expiresInDays") {
        Some(crate::js::Value::Null) => None,
        None => Some(90 * 86_400_000),
        Some(value) => {
            let days = value
                .as_i64()
                .filter(|days| (1..=3650).contains(days))
                .ok_or(ApiError::INVALID_INPUT)?;
            Some(days * 86_400_000)
        }
    };
    Ok(TokenOptions {
        name,
        scopes,
        lifetime_ms,
    })
}

pub(crate) fn person_name(value: Option<&crate::js::Value>) -> ApiResult<crate::js::JsString> {
    value
        .and_then(crate::js::Value::as_js_str)
        .ok_or(ApiError::INVALID_INPUT)?
        .clean_name()
}

pub fn user_code() -> ApiResult<String> {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).map_err(ApiError::internal)?;
    let chars: String = bytes
        .iter()
        .map(|byte| USER_CODE_ALPHABET[usize::from(*byte) % USER_CODE_ALPHABET.len()] as char)
        .collect();
    Ok(format!("{}-{}", &chars[..4], &chars[4..]))
}

pub fn user_code_hash(value: &str) -> String {
    password::hash(
        &value
            .to_uppercase()
            .replace(['-', ' ', '\t', '\n', '\r'], ""),
    )
}

pub fn ip_summary(ip: &str) -> String {
    match ip.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            let [a, b, c, _] = ip.octets();
            format!("{a}.{b}.{c}.0/24")
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            let prefix = ip
                .to_string()
                .split(':')
                .filter(|part| !part.is_empty())
                .take(2)
                .collect::<Vec<_>>()
                .join(":");
            format!("IPv6 {prefix}:…")
        }
        Err(_) => "unknown".into(),
    }
}

pub fn access_token_value(record: &AccessToken) -> Value {
    json!({
        "id": record.id,
        "userId": record.user_id,
        "name": record.name.decoded(),
        "scopes": record.scopes,
        "createdAt": record.created_at,
        "lastUsedAt": record.last_used_at,
        "expiresAt": record.expires_at,
        "revoked": record.revoked,
    })
}

fn parse_scopes(raw: &str) -> ApiResult<Vec<String>> {
    serde_json::from_str(raw).map_err(|_| ApiError::internal("invalid token scopes"))
}

fn access_token_from_row(row: &Row<'_>) -> rusqlite::Result<AccessToken> {
    Ok(AccessToken {
        id: row.get("id")?,
        user_id: row.get("userId")?,
        name: row.get("name")?,
        scopes: serde_json::from_str(&row.get::<_, String>("scopes")?).unwrap_or_default(),
        created_at: row.get("createdAt")?,
        last_used_at: row.get("lastUsedAt")?,
        expires_at: row.get("expiresAt")?,
        revoked: row.get("revoked")?,
    })
}

pub fn list_tokens(db: &Connection, user_id: Option<&str>) -> ApiResult<Vec<Value>> {
    let mut statement = if user_id.is_some() {
        db.prepare("SELECT id,userId,name,scopes,createdAt,lastUsedAt,expiresAt,revoked FROM access_tokens WHERE userId=? ORDER BY createdAt DESC,id DESC")?
    } else {
        db.prepare("SELECT id,userId,name,scopes,createdAt,lastUsedAt,expiresAt,revoked FROM access_tokens ORDER BY createdAt DESC,id DESC")?
    };
    let rows = if let Some(user_id) = user_id {
        statement
            .query_map([user_id], access_token_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        statement
            .query_map([], access_token_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows.iter().map(access_token_value).collect())
}

pub fn create_token(db: &Connection, record: &AccessToken, raw: &str) -> ApiResult<()> {
    db.execute(
        "INSERT INTO access_tokens (id,tokenHash,userId,name,scopes,createdAt,lastUsedAt,expiresAt,revoked) VALUES (?,?,?,?,?,?,?,?,?)",
        params![record.id, password::hash(raw), record.user_id, record.name, serde_json::to_string(&record.scopes).map_err(ApiError::internal)?, record.created_at, record.last_used_at, record.expires_at, record.revoked],
    )?;
    Ok(())
}

pub fn token_session(
    db: &Connection,
    token_hash: &str,
    time: i64,
    touch: bool,
) -> ApiResult<Option<(Account, Bearer)>> {
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT t.id,t.scopes FROM access_tokens t JOIN users u ON u.id=t.userId WHERE t.tokenHash=? AND t.revoked=0 AND u.disabled=0 AND u.pending=0 AND (t.expiresAt IS NULL OR t.expiresAt>?)",
            params![token_hash, time],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((id, raw_scopes)) = row else {
        return Ok(None);
    };
    let user_id: String = db.query_row(
        "SELECT userId FROM access_tokens WHERE id=?",
        [&id],
        |row| row.get(0),
    )?;
    let account = db.query_row("SELECT * FROM users WHERE id=?", [&user_id], db::account)?;
    if touch {
        db.execute(
            "UPDATE access_tokens SET lastUsedAt=? WHERE id=?",
            params![time, id],
        )?;
    }
    Ok(Some((
        account,
        Bearer {
            id,
            scopes: parse_scopes(&raw_scopes)?,
        },
    )))
}

pub fn token_live(
    db: &Connection,
    token_id: &str,
    user_id: &str,
    time: i64,
    required_scope: &str,
) -> ApiResult<bool> {
    let scopes: Option<String> = db
        .query_row(
            "SELECT t.scopes FROM access_tokens t JOIN users u ON u.id=t.userId WHERE t.id=? AND t.userId=? AND t.revoked=0 AND u.disabled=0 AND u.pending=0 AND (t.expiresAt IS NULL OR t.expiresAt>?)",
            params![token_id, user_id, time],
            |row| row.get(0),
        )
        .optional()?;
    let Some(scopes) = scopes else {
        return Ok(false);
    };
    Ok(parse_scopes(&scopes)?
        .iter()
        .any(|scope| scope == required_scope))
}

pub fn rename_token(
    db: &Connection,
    id: &str,
    user_id: &str,
    name: &crate::js::JsString,
) -> ApiResult<()> {
    if db.execute(
        "UPDATE access_tokens SET name=? WHERE id=? AND userId=?",
        params![name, id, user_id],
    )? == 0
    {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(())
}

pub fn revoke_token(db: &Connection, id: &str, user_id: Option<&str>) -> ApiResult<()> {
    let changed = if let Some(user_id) = user_id {
        db.execute(
            "UPDATE access_tokens SET revoked=1 WHERE id=? AND userId=?",
            params![id, user_id],
        )?
    } else {
        db.execute("UPDATE access_tokens SET revoked=1 WHERE id=?", [id])?
    };
    (changed > 0).then_some(()).ok_or(ApiError::NOT_FOUND)
}

pub fn delete_token(db: &Connection, id: &str, user_id: &str, time: i64) -> ApiResult<()> {
    let row: Option<(i64, Option<i64>)> = db
        .query_row(
            "SELECT revoked,expiresAt FROM access_tokens WHERE id=? AND userId=?",
            params![id, user_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((revoked, expires_at)) = row else {
        return Err(ApiError::NOT_FOUND);
    };
    if revoked == 0 && expires_at.is_none_or(|expires_at| expires_at > time) {
        return Err(ApiError::new(409, "TOKEN_ACTIVE"));
    }
    db.execute("DELETE FROM access_tokens WHERE id=?", [id])?;
    Ok(())
}

fn device_from_row(row: &Row<'_>) -> rusqlite::Result<DeviceAuthorization> {
    Ok(DeviceAuthorization {
        id: row.get("id")?,
        device_code_hash: row.get("deviceCodeHash")?,
        user_code_hash: row.get("userCodeHash")?,
        name: row.get("name")?,
        ip_summary: row.get("ipSummary")?,
        scopes: serde_json::from_str(&row.get::<_, String>("scopes")?).unwrap_or_default(),
        token_lifetime_ms: row.get("tokenLifetimeMs")?,
        expires_at: row.get("expiresAt")?,
        interval: row.get("interval")?,
        next_poll_at: row.get("nextPollAt")?,
        attempts: row.get("attempts")?,
        status: row.get("status")?,
        user_id: row.get("userId")?,
    })
}

pub fn create_device(db: &Connection, device: &DeviceAuthorization) -> ApiResult<()> {
    db.execute(
        "INSERT INTO device_authorizations (id,deviceCodeHash,userCodeHash,name,ipSummary,scopes,tokenLifetimeMs,expiresAt,interval,nextPollAt,attempts,status,userId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![device.id, device.device_code_hash, device.user_code_hash, device.name, device.ip_summary, serde_json::to_string(&device.scopes).map_err(ApiError::internal)?, device.token_lifetime_ms, device.expires_at, device.interval, device.next_poll_at, device.attempts, device.status, device.user_id],
    )?;
    Ok(())
}

pub fn device_for_user_code(
    db: &mut Connection,
    code_hash: &str,
    verification_id: Option<&str>,
    time: i64,
) -> ApiResult<Option<DeviceAuthorization>> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let device = if let Some(id) = verification_id {
        tx.query_row(
            "SELECT * FROM device_authorizations WHERE id=?",
            [id],
            device_from_row,
        )
        .optional()?
    } else {
        tx.query_row(
            "SELECT * FROM device_authorizations WHERE userCodeHash=?",
            [code_hash],
            device_from_row,
        )
        .optional()?
    };
    let Some(device) = device else {
        tx.commit()?;
        return Ok(None);
    };
    if device.expires_at <= time || device.status != "pending" {
        tx.commit()?;
        return Ok(None);
    }
    if device.user_code_hash != code_hash {
        tx.execute("UPDATE device_authorizations SET attempts=attempts+1,status=CASE WHEN attempts+1>=5 THEN 'denied' ELSE status END WHERE id=?", [&device.id])?;
        tx.commit()?;
        return Ok(None);
    }
    tx.commit()?;
    Ok(Some(device))
}

pub fn decide_device(
    db: &Connection,
    id: &str,
    user_id: &str,
    approve: bool,
    time: i64,
) -> ApiResult<()> {
    let status = if approve { "approved" } else { "denied" };
    if db.execute("UPDATE device_authorizations SET status=?,userId=? WHERE id=? AND status='pending' AND expiresAt>?", params![status, user_id, id, time])? == 0 {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(())
}

pub fn poll_device(
    db: &mut Connection,
    device_code_hash: &str,
    time: i64,
    token_id: &str,
    raw_token: &str,
) -> ApiResult<PollResult> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let device = tx
        .query_row(
            "SELECT * FROM device_authorizations WHERE deviceCodeHash=?",
            [device_code_hash],
            device_from_row,
        )
        .optional()?;
    let Some(device) = device else {
        tx.commit()?;
        return Ok(PollResult::Error(json!({"error":"expired_token"})));
    };
    if device.expires_at <= time || device.status == "consumed" {
        tx.commit()?;
        return Ok(PollResult::Error(json!({"error":"expired_token"})));
    }
    if device.status == "denied" {
        tx.commit()?;
        return Ok(PollResult::Error(json!({"error":"access_denied"})));
    }
    if time < device.next_poll_at {
        let interval = device.interval + 5;
        tx.execute(
            "UPDATE device_authorizations SET interval=?,nextPollAt=? WHERE id=?",
            params![interval, time + interval * 1000, device.id],
        )?;
        tx.commit()?;
        return Ok(PollResult::Error(
            json!({"error":"slow_down","interval":interval}),
        ));
    }
    tx.execute(
        "UPDATE device_authorizations SET nextPollAt=? WHERE id=?",
        params![time + device.interval * 1000, device.id],
    )?;
    if device.status == "pending" {
        tx.commit()?;
        return Ok(PollResult::Error(json!({"error":"authorization_pending"})));
    }
    let Some(user_id) = device.user_id.as_deref() else {
        tx.execute(
            "UPDATE device_authorizations SET status='denied' WHERE id=?",
            [&device.id],
        )?;
        tx.commit()?;
        return Ok(PollResult::Error(json!({"error":"access_denied"})));
    };
    let user: Option<(i64, i64)> = tx
        .query_row(
            "SELECT disabled,pending FROM users WHERE id=?",
            [user_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if user.is_none_or(|(disabled, pending)| disabled != 0 || pending != 0) {
        tx.execute(
            "UPDATE device_authorizations SET status='denied' WHERE id=?",
            [&device.id],
        )?;
        tx.commit()?;
        return Ok(PollResult::Error(json!({"error":"access_denied"})));
    }
    let record = AccessToken {
        id: token_id.to_owned(),
        user_id: user_id.to_owned(),
        name: device.name,
        scopes: device.scopes,
        created_at: time,
        last_used_at: None,
        expires_at: device.token_lifetime_ms.map(|ms| time + ms),
        revoked: 0,
    };
    create_token(&tx, &record, raw_token)?;
    tx.execute(
        "UPDATE device_authorizations SET status='consumed' WHERE id=?",
        [&device.id],
    )?;
    tx.commit()?;
    Ok(PollResult::Token(record))
}

pub fn create_browser_session(
    db: &Connection,
    user_id: &str,
    session_hash: &str,
    expires_at: i64,
    time: i64,
    user_agent: Option<&str>,
    ip_summary: &str,
) -> ApiResult<()> {
    db.execute("INSERT INTO sessions (sessionHash,userId,expiresAt,id,createdAt,lastSeenAt,userAgent,ipSummary) VALUES (?,?,?,?,?,?,?,?)", params![session_hash, user_id, expires_at, Uuid::new_v4().to_string(), time, time, user_agent, ip_summary])?;
    Ok(())
}

pub fn is_admin(account: &Account) -> bool {
    account.user.role == "admin" && account.user.disabled == 0
}
