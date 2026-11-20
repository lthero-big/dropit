//! Temporary-room capabilities and their lifecycle.
//!
//! A room URL contains an entry proof derived from the room's private key. The
//! human room code is only used by the PIN-protected `/enter` endpoint; it is
//! never accepted as an item API credential.

use axum::{
    Extension, Json,
    extract::{Path, State, rejection::PathRejection},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    ApiError, ApiResult, App, RequestContext, db, header_value, now, origin_for, parse_device,
    password, read_json,
};

const ROOM_CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";

fn entry_token(space: &db::Space) -> ApiResult<String> {
    let key = space.room_key.as_deref().ok_or(ApiError::NOT_FOUND)?;
    let proof = password::hash(&format!("room-entry:{}:{key}", space.id));
    Ok(format!("{}.{}", space.id, proof))
}

fn entry_id(raw: &str) -> Option<&str> {
    let (id, proof) = raw.split_once('.')?;
    (Uuid::parse_str(id).is_ok()
        && proof.len() == 43
        && proof
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
    .then_some(id)
}

pub async fn load_room(app: &App, raw: &str) -> ApiResult<db::Space> {
    let id = entry_id(raw).ok_or(ApiError::NOT_FOUND)?.to_owned();
    let space = app.db.run(move |db| db::room(db, &id, now())).await?;
    if entry_token(&space)?.as_str() != raw {
        return Err(ApiError::NOT_FOUND);
    }
    // Keep the admin activity timestamp cheap and bounded to once a minute.
    let id = space.id.clone();
    app.db.run(move |db| {
        db.execute("UPDATE spaces SET lastActiveAt=? WHERE id=? AND (lastActiveAt IS NULL OR lastActiveAt<?)", rusqlite::params![now(), id, now() - 60000])?;
        Ok(())
    }).await?;
    Ok(space)
}

fn room_view(space: &db::Space, origin: &str, reused: Option<bool>) -> ApiResult<Value> {
    let mut view = json!({
        "token": entry_token(space)?, "expiresAt": space.expires_at,
        "url": format!("{}/r/{}", origin, urlencoding(space.room_code.as_deref().unwrap_or_default())),
        "code": space.room_code, "hasPin": space.pin_hash.is_some(),
    });
    if let Some(reused) = reused {
        view["reused"] = reused.into();
    }
    Ok(view)
}

fn urlencoding(value: &str) -> String {
    value.bytes().fold(String::new(), |mut output, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
        output
    })
}

fn random_code() -> ApiResult<String> {
    random_chars(ROOM_CODE_ALPHABET)
}
pub fn random_chars(alphabet: &[u8]) -> ApiResult<String> {
    let ceiling = 256 - 256 % alphabet.len();
    let mut result = String::with_capacity(6);
    while result.len() < 6 {
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).map_err(ApiError::internal)?;
        for byte in bytes {
            if (byte as usize) < ceiling {
                result.push(alphabet[byte as usize % alphabet.len()] as char);
                if result.len() == 6 {
                    break;
                }
            }
        }
    }
    Ok(result)
}
async fn pin_hash(app: &App, pin: &str) -> ApiResult<String> {
    let permit = app
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(ApiError::internal)?;
    let pin = pin.to_owned();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        password::hash_password(&pin)
    })
    .await
    .map_err(ApiError::internal)?
}
async fn verify_pin(app: &App, pin: &str, hash: &str) -> ApiResult<bool> {
    let permit = app
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(ApiError::internal)?;
    let pin = pin.to_owned();
    let hash = hash.to_owned();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        password::verify(&pin, Some(&hash))
    })
    .await
    .map_err(ApiError::internal)?
}
fn guess_blocked(app: &App, context: &RequestContext, code: Option<&str>) -> ApiResult<()> {
    let keys = [
        ("guess:ip", context.ip.clone()),
        ("guess:code", code.map(password::hash).unwrap_or_default()),
    ];
    let buckets = app.limiter.lock().map_err(ApiError::internal)?;
    for key in keys.into_iter().filter(|(_, key)| !key.is_empty()) {
        if let Some(bucket) = buckets.get(&key)
            && bucket.reset > now()
            && bucket.count >= app.config.rate_auth
        {
            return Err(rate_error((bucket.reset - now() + 999) / 1000));
        }
    }
    Ok(())
}
fn guess_failed(app: &App, context: &RequestContext, code: Option<&str>) {
    let _ = app.limit("guess:ip", &context.ip, app.config.rate_auth);
    if let Some(code) = code {
        let _ = app.limit("guess:code", &password::hash(code), app.config.rate_auth);
    }
}
fn caller_limit(
    app: &App,
    context: &RequestContext,
    group: (&'static str, &'static str),
    count: u32,
) -> ApiResult<()> {
    app.limit(group.0, &context.ip, count)?;
    if let Some(auth) = &context.auth {
        app.limit(group.1, &auth.account.user.id, count)?;
    }
    Ok(())
}
pub async fn scope(app: &App, context: &RequestContext, raw: &str) -> ApiResult<db::Space> {
    caller_limit(
        app,
        context,
        ("room-access:ip", "room-access:user"),
        app.config.rate_upload,
    )?;
    load_room(app, raw).await
}

fn valid_custom_code(value: &str, change: bool) -> bool {
    let length = value.len();
    let bounds = if change { 6..=6 } else { 3..=32 };
    bounds.contains(&length)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || (!change && matches!(byte, b'_' | b'-')))
}

fn valid_pin(value: &str) -> bool {
    let length = value.chars().count();
    (4..=32).contains(&length) && !value.chars().any(|ch| ch < ' ' || ch == '\u{7f}')
}

fn device_key(value: Option<&crate::js::Value>) -> ApiResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let key = value.as_str().ok_or(ApiError::INVALID_INPUT)?;
    if !(32..=128).contains(&key.len())
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(ApiError::INVALID_INPUT);
    }
    Ok(Some(key.to_owned()))
}

pub async fn create(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let body = if header_value(request.headers(), "content-type")
        .is_some_and(|value| value.starts_with("application/json"))
    {
        read_json(request, 2048).await?
    } else {
        crate::js::Object::new()
    };
    let device = device_key(body.get("deviceKey"))?;
    let custom_code = match body.get("code") {
        None | Some(crate::js::Value::Null) => None,
        Some(crate::js::Value::String(value)) if value.is_empty() => None,
        Some(crate::js::Value::String(value))
            if value.as_str().is_some_and(|v| valid_custom_code(v, false)) =>
        {
            Some(value.as_str().unwrap().to_owned())
        }
        Some(_) => return Err(ApiError::new(400, "INVALID_CODE")),
    };
    let pin = match body.get("pin") {
        None | Some(crate::js::Value::Null) => None,
        Some(crate::js::Value::String(value)) if value.is_empty() => None,
        Some(crate::js::Value::String(value)) if value.as_str().is_some_and(valid_pin) => {
            Some(pin_hash(&app, value.as_str().unwrap()).await?)
        }
        Some(_) => return Err(ApiError::new(400, "INVALID_PIN")),
    };
    if custom_code.is_some() {
        guess_blocked(&app, &context, None)?;
    }
    let device_hash = device
        .as_deref()
        .map(|key| password::hash(&format!("room-device:{key}")));
    if let Some(device_hash) = device_hash.as_deref() {
        let lookup = device_hash.to_owned();
        if let Some(space) = app
            .db
            .run(move |db| db::device_room(db, &lookup, now()))
            .await?
        {
            if custom_code.is_none() && pin.is_none() {
                return Ok((
                    StatusCode::OK,
                    Json(room_view(&space, &origin_for(&app, &context), Some(true))?),
                ));
            }
            let next_pin = if body.contains_key("pin") {
                pin
            } else {
                space.pin_hash.clone()
            };
            if let Err(error) = set_code_inner(&app, &space, custom_code, next_pin, false).await {
                if error.code == "CODE_TAKEN" {
                    guess_failed(&app, &context, None);
                }
                return Err(error);
            }
            let fresh = load_by_id(&app, &space.id).await?;
            return Ok((
                StatusCode::OK,
                Json(room_view(&fresh, &origin_for(&app, &context), Some(true))?),
            ));
        }
    }
    caller_limit(
        &app,
        &context,
        ("room-create:ip", "room-create:user"),
        app.config.rate_room,
    )?;
    let room_id = Uuid::new_v4().to_string();
    let created_by = context
        .auth
        .as_ref()
        .map(|auth| auth.account.user.id.clone());
    let expires = now() + app.config.room_retention;
    for _ in 0..12 {
        let key = password::session_token()?;
        let code = custom_code.clone().unwrap_or(random_code()?);
        let result = app.db.run({
            let room_id = room_id.clone(); let code = code.clone(); let pin = pin.clone(); let device_hash = device_hash.clone(); let created_by = created_by.clone();
            move |db| {
                let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                // Expired rooms release both the browser binding and their human code.
                tx.execute("UPDATE spaces SET roomCode=NULL,pinHash=NULL WHERE roomCode=? AND expiresAt<=?", rusqlite::params![code, now()])?;
                if tx.query_row("SELECT EXISTS(SELECT 1 FROM spaces WHERE roomCode=?)", [&code], |row| row.get::<_,bool>(0))? { return Err(ApiError::new(409, "CODE_TAKEN")); }
                if let Some(device_hash) = &device_hash { tx.execute("UPDATE spaces SET deviceHash=NULL WHERE deviceHash=?", [device_hash])?; }
                tx.execute("INSERT INTO spaces (id,name,ownerId,expiresAt,roomKey,deviceHash,roomCode,pinHash,createdAt,lastActiveAt,closedAt,createdBy) VALUES (?,'Temporary room',NULL,?,?,?,?,?,?,?,NULL,?)",
                    rusqlite::params![room_id, expires, key, device_hash, code, pin, now(), now(), created_by])?;
                tx.commit()?;
                Ok(())
            }
        }).await;
        match result {
            Ok(()) => {
                let space = load_by_id(&app, &room_id).await?;
                return Ok((
                    StatusCode::CREATED,
                    Json(room_view(&space, &origin_for(&app, &context), Some(false))?),
                ));
            }
            Err(error) if error.code == "CODE_TAKEN" && custom_code.is_none() => continue,
            Err(error) => {
                if error.code == "CODE_TAKEN" {
                    guess_failed(&app, &context, None);
                }
                return Err(error);
            }
        }
    }
    Err(ApiError::new(503, "UNAVAILABLE"))
}

async fn load_by_id(app: &App, id: &str) -> ApiResult<db::Space> {
    let id = id.to_owned();
    app.db.run(move |db| db::room(db, &id, now())).await
}

async fn set_code_inner(
    app: &App,
    space: &db::Space,
    code: Option<String>,
    pin: Option<String>,
    change: bool,
) -> ApiResult<()> {
    let next_code = match code {
        Some(code) => code,
        None => space.room_code.clone().unwrap_or(random_code()?),
    };
    if !valid_custom_code(&next_code, change) {
        return Err(ApiError::new(400, "INVALID_CODE"));
    }
    let id = space.id.clone();
    app.db.run(move |db| {
        db.execute("UPDATE spaces SET roomCode=NULL,pinHash=NULL WHERE roomCode=? AND expiresAt<=?", rusqlite::params![next_code, now()])?;
        let holder: Option<String> = db.query_row("SELECT id FROM spaces WHERE roomCode=?", [&next_code], |row| row.get(0)).optional()?;
        if holder.as_deref().is_some_and(|holder| holder != id.as_str()) { return Err(ApiError::new(409, "CODE_TAKEN")); }
        let changed = db.execute("UPDATE spaces SET roomCode=?,pinHash=? WHERE id=? AND roomKey IS NOT NULL AND closedAt IS NULL AND expiresAt>?",
            rusqlite::params![next_code, pin, id, now()])?;
        if changed == 0 { return Err(ApiError::NOT_FOUND); }
        Ok(())
    }).await
}

pub async fn enter(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    let body = read_json(request, 2048).await?;
    let code = body
        .get("code")
        .and_then(crate::js::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .ok_or(ApiError::new(400, "INVALID_CODE"))?;
    guess_blocked(&app, &context, Some(code))?;
    let code_owned = code.to_owned();
    let space = app
        .db
        .run(move |db| db::room_by_code(db, &code_owned, now()))
        .await?;
    let Some(space) = space else {
        guess_failed(&app, &context, None);
        return Err(ApiError::NOT_FOUND);
    };
    if let Some(pin_hash) = space.pin_hash.as_deref() {
        if let Some(seconds) = locked_for(&app, &space.id)? {
            return Err(rate_error(seconds));
        }
        let pin = body
            .get("pin")
            .and_then(crate::js::Value::as_str)
            .filter(|value| value.len() <= 256)
            .unwrap_or_default();
        if pin.is_empty() {
            return Err(ApiError::new(401, "PIN_REQUIRED"));
        }
        if !verify_pin(&app, pin, pin_hash).await? {
            guess_failed(&app, &context, Some(code));
            let mut locks = app.pin_lockouts.lock().map_err(ApiError::internal)?;
            let time = now();
            locks.retain(|_, (_, since, until)| {
                if *until > 0 {
                    *until > time
                } else {
                    *since + app.config.pin_lock_ms > time
                }
            });
            if locks.len() >= 10000
                && !locks.contains_key(&space.id)
                && let Some(key) = locks.keys().next().cloned()
            {
                locks.remove(&key);
            }
            let entry = locks.entry(space.id.clone()).or_insert((0, time, 0));
            entry.0 += 1;
            if entry.0 >= app.config.pin_lock_failures {
                entry.2 = time + app.config.pin_lock_ms;
                return Err(rate_error((app.config.pin_lock_ms + 999) / 1000));
            }
            return Err(ApiError::new(403, "PIN_INVALID"));
        }
        app.pin_lockouts
            .lock()
            .map_err(ApiError::internal)?
            .remove(&space.id);
    }
    Ok(Json(room_view(&space, &origin_for(&app, &context), None)?))
}

pub async fn change_code(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    let Path(raw) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let body = read_json(request, 2048).await?;
    let key = body
        .get("deviceKey")
        .and_then(crate::js::Value::as_str)
        .ok_or(ApiError::INVALID_INPUT)?;
    let key = device_key(Some(&crate::js::Value::String(key.to_owned().into())))?
        .ok_or(ApiError::INVALID_INPUT)?;
    let space = load_room(&app, &raw).await?;
    if space.device_hash.as_deref() != Some(password::hash(&format!("room-device:{key}")).as_str())
    {
        return Err(ApiError::new(403, "FORBIDDEN"));
    }
    caller_limit(
        &app,
        &context,
        ("room-code:ip", "room-code:user"),
        app.config.rate_room,
    )?;
    guess_blocked(&app, &context, None)?;
    if !body.contains_key("code") && !body.contains_key("pin") {
        return Err(ApiError::INVALID_INPUT);
    }
    let code = if body.contains_key("code") {
        match body.get("code") {
            Some(crate::js::Value::Null) => Some(random_code()?),
            Some(crate::js::Value::String(value)) if value.is_empty() => Some(random_code()?),
            Some(crate::js::Value::String(value))
                if value.as_str().is_some_and(|v| valid_custom_code(v, true)) =>
            {
                Some(value.as_str().unwrap().to_owned())
            }
            _ => return Err(ApiError::new(400, "INVALID_CODE")),
        }
    } else {
        space.room_code.clone()
    };
    let pin = if body.contains_key("pin") {
        match body.get("pin") {
            Some(crate::js::Value::Null) => None,
            Some(crate::js::Value::String(value)) if value.is_empty() => None,
            Some(crate::js::Value::String(value)) if value.as_str().is_some_and(valid_pin) => {
                Some(pin_hash(&app, value.as_str().unwrap()).await?)
            }
            _ => return Err(ApiError::new(400, "INVALID_PIN")),
        }
    } else {
        space.pin_hash.clone()
    };
    if let Err(error) = set_code_inner(&app, &space, code, pin, false).await {
        if error.code == "CODE_TAKEN" {
            guess_failed(&app, &context, None);
        }
        return Err(error);
    }
    let fresh = load_by_id(&app, &space.id).await?;
    app.pin_lockouts
        .lock()
        .map_err(ApiError::internal)?
        .remove(&space.id);
    Ok(Json(
        json!({ "code": fresh.room_code, "hasPin": fresh.pin_hash.is_some(), "url": format!("{}/r/{}", origin_for(&app, &context), urlencoding(fresh.room_code.as_deref().unwrap_or_default())) }),
    ))
}

pub async fn info(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path(raw) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let space = scope(&app, &context, &raw).await?;
    Ok(Json(
        json!({ "id": space.id, "name": space.name, "expiresAt": space.expires_at,
        "code": space.room_code, "hasPin": space.pin_hash.is_some(),
        "url": format!("{}/r/{}", origin_for(&app, &context), urlencoding(space.room_code.as_deref().unwrap_or_default())),
        "maxFileBytes": app.config.room_max_file, "quotaBytes": app.config.room_quota }),
    ))
}

pub async fn admin_rooms(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    crate::admin_session(&context)?;
    let mut rows = app.db.run(move |db| {
        let mut statement = db.prepare(
            "SELECT s.id,s.roomCode,u.email,s.createdAt,s.lastActiveAt,s.expiresAt,s.closedAt,
                    s.pinHash IS NOT NULL,(SELECT count(*) FROM items WHERE spaceId=s.id AND expiresAt>?),
                    (SELECT coalesce(sum(storedBytes),0) FROM items WHERE spaceId=s.id)
             FROM spaces s LEFT JOIN users u ON u.id=s.createdBy WHERE s.roomKey IS NOT NULL AND s.expiresAt>? ORDER BY coalesce(s.lastActiveAt,s.createdAt,0) DESC,s.expiresAt DESC",
        )?;
        Ok(statement.query_map(rusqlite::params![now(), now()], |row| Ok(json!({
            "id": row.get::<_, String>(0)?, "code": row.get::<_, Option<String>>(1)?, "owner": row.get::<_, Option<String>>(2)?,
            "anonymous": row.get::<_, Option<String>>(2)?.is_none(), "createdAt": row.get::<_, Option<i64>>(3)?,
            "lastActiveAt": row.get::<_, Option<i64>>(4)?, "expiresAt": row.get::<_, i64>(5)?, "closed": row.get::<_, Option<i64>>(6)?.is_some(),
            "closedAt": row.get::<_, Option<i64>>(6)?, "hasPin": row.get::<_, bool>(7)?, "itemCount": row.get::<_, i64>(8)?, "bytes": row.get::<_, i64>(9)?,
        })))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await?;
    for row in &mut rows {
        let estimated = row["createdAt"].is_null();
        if estimated {
            row["createdAt"] =
                (row["expiresAt"].as_i64().unwrap_or_default() - app.config.room_retention).into();
        }
        row["createdAtEstimated"] = estimated.into();
        row["lockedFor"] = locked_for(&app, row["id"].as_str().unwrap_or_default())?
            .map_or(Value::Null, Value::from);
    }
    Ok(Json(json!({ "rooms": rows })))
}

async fn set_closed(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    reopen: bool,
) -> ApiResult<StatusCode> {
    crate::admin_session(&context)?;
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let closed: Option<i64> = (!reopen).then_some(now());
    let db_id = id.clone();
    let changed = app
        .db
        .run(move |db| {
            Ok(db.execute(
                "UPDATE spaces SET closedAt=? WHERE id=? AND roomKey IS NOT NULL AND expiresAt>?",
                rusqlite::params![closed, db_id, now()],
            )?)
        })
        .await?;
    if changed == 0 {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn admin_reopen(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<StatusCode> {
    set_closed(State(app), Extension(context), path, true).await
}

pub async fn admin_close(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<StatusCode> {
    set_closed(State(app), Extension(context), path, false).await
}

pub async fn admin_delete(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<StatusCode> {
    crate::admin_session(&context)?;
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let keys=app.db.run(move|db| {
        let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM spaces WHERE id=? AND roomKey IS NOT NULL AND expiresAt>?)",rusqlite::params![id,now()],|row|row.get(0))?;
        if !exists { return Err(ApiError::NOT_FOUND); }
        let mut statement=tx.prepare("SELECT fileKey FROM items WHERE spaceId=?1 AND fileKey IS NOT NULL UNION SELECT thumbnailKey FROM items WHERE spaceId=?1 AND thumbnailKey IS NOT NULL UNION SELECT key FROM upload_chunks WHERE uploadId IN (SELECT id FROM uploads WHERE spaceId=?1)")?;
        let keys=statement.query_map([&id],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?; drop(statement);
        for key in &keys { tx.execute("INSERT OR IGNORE INTO garbage (key) VALUES (?)",[key])?; }
        tx.execute("DELETE FROM uploads WHERE spaceId=?",[&id])?;
        tx.execute("DELETE FROM items WHERE spaceId=?",[&id])?;
        tx.execute("DELETE FROM shares WHERE spaceId=?",[&id])?;
        tx.execute("DELETE FROM spaces WHERE id=?",[&id])?;
        tx.commit()?; Ok(keys)
    }).await?;
    let directory = crate::downloads::files_dir(&app.config.data);
    for key in keys {
        let path = crate::downloads::object_path(&directory, &key)?;
        match tokio::fs::remove_file(path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(ApiError::internal(error)),
        }
        app.db.run(move |db| db::forget_garbage(db, &key)).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn items(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Box<serde_json::value::RawValue>>> {
    let Path(raw) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let space = scope(&app, &context, &raw).await?;
    let id = space.id.clone();
    Ok(Json(
        app.db
            .run(move |db| db::snapshot(db, db::room(db, &id, now())?))
            .await?,
    ))
}

pub async fn text(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    request: axum::extract::Request,
) -> ApiResult<(StatusCode, Json<crate::js::ItemResponse>)> {
    let Path(raw) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let space = scope(&app, &context, &raw).await?;
    caller_limit(
        &app,
        &context,
        ("room-write:ip", "room-write:user"),
        app.config.rate_room,
    )?;
    let headers = request.headers().clone();
    let body = read_json(request, app.config.max_text * 6 + 1024).await?;
    let text = body.text("text")?;
    if text.is_blank() {
        return Err(ApiError::new(400, "EMPTY_TEXT"));
    }
    if text.len() > app.config.max_text {
        return Err(ApiError::new(413, "TEXT_TOO_LARGE"));
    }
    let group = match body.get("group") {
        None | Some(crate::js::Value::Null) => header_value(&headers, "x-dropit-group")
            .filter(|v| !v.is_empty())
            .map(|v| {
                crate::decode_uri_component(v)
                    .map(Into::into)
                    .ok_or(ApiError::new(400, "INVALID_GROUP"))
            })
            .transpose()?,
        Some(crate::js::Value::String(value)) => Some(value.clone()),
        _ => return Err(ApiError::new(400, "INVALID_GROUP")),
    };
    let group = group
        .filter(|value| !value.is_empty())
        .map(|value| value.clean_group())
        .transpose()?;
    let input = db::TextInput {
        text: text.to_owned(),
        group,
        device: parse_device(&headers),
    };
    let channel = space.id.clone();
    let _gate = app.realtime.gate.lock().await;
    let config = app.config.clone();
    let db_channel = channel.clone();
    let (item, groups) = app
        .db
        .run(move |db| {
            let before = db::groups(db, &db_channel)?;
            let item = db::insert_room_text(db, &config, &db_channel, input);
            let after = db::groups(db, &db_channel)?;
            Ok((item, (before != after).then_some(after)))
        })
        .await?;
    if let Some(groups) = groups {
        app.realtime
            .publish(&channel, json!({"type":"groups","groups":groups}));
    }
    let item = item?;
    app.realtime.publish_item(&channel, "item.created", &item);
    Ok((StatusCode::CREATED, Json(crate::js::ItemResponse { item })))
}

pub async fn delete_item(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> ApiResult<StatusCode> {
    let Path((raw, item_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let space = scope(&app, &context, &raw).await?;
    caller_limit(
        &app,
        &context,
        ("room-write:ip", "room-write:user"),
        app.config.rate_room,
    )?;
    let channel = space.id.clone();
    let deleted = item_id.clone();
    let _gate = app.realtime.gate.lock().await;
    let db_channel = channel.clone();
    let keys = app
        .db
        .run(move |db| db::delete_room_item(db, &db_channel, &item_id))
        .await?;
    app.realtime
        .publish(&channel, json!({ "type": "item.deleted", "id": deleted }));
    for key in keys {
        let directory = crate::downloads::files_dir(&app.config.data);
        let path = crate::downloads::object_path(&directory, &key)?;
        let _ = tokio::fs::remove_file(path).await;
        app.db.run(move |db| db::forget_garbage(db, &key)).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn room_file(app: &App, raw: &str, item_id: &str) -> ApiResult<db::StoredFile> {
    let space = load_room(app, raw).await?;
    let space_id = space.id.clone();
    let item_id = item_id.to_owned();
    app.db.run(move |db| db.query_row(
        "SELECT filename,size,fileKey,thumbnailKey FROM items WHERE id=? AND spaceId=? AND expiresAt>?",
        rusqlite::params![item_id, space_id, now()], |row| Ok(db::StoredFile { filename: row.get(0)?, size: row.get(1)?, file_key: row.get(2)?, thumbnail_key: row.get(3)? }),
    ).optional()?.ok_or(ApiError::NOT_FOUND)).await
}

pub async fn download(
    State(app): State<App>,
    Extension(_context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
    request: axum::extract::Request,
) -> Response {
    let Ok(Path((raw, item_id))) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    let file = match room_file(&app, &raw, &item_id).await {
        Ok(file) => file,
        Err(error) => return error.into_response(),
    };
    let (Some(key), Some(filename)) = (
        file.file_key.filter(|key| !key.is_empty()),
        file.filename.filter(|name| !name.is_empty()),
    ) else {
        return ApiError::NOT_FOUND.into_response();
    };
    let range = crate::downloads::range_header(request.headers());
    let head = request.method() == Method::HEAD;
    match crate::downloads::prepare_download(
        &crate::downloads::files_dir(&app.config.data),
        &key,
        &filename,
        file.size.max(0) as u64,
        range,
        head,
    ) {
        Ok(value) => crate::downloads::into_response(value, head),
        Err(error) => error.into_response(),
    }
}

pub async fn thumbnail(
    State(app): State<App>,
    Extension(_context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> Response {
    let Ok(Path((raw, item_id))) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    let file = match room_file(&app, &raw, &item_id).await {
        Ok(file) => file,
        Err(error) => return error.into_response(),
    };
    let Some(key) = file.thumbnail_key.filter(|key| !key.is_empty()) else {
        return ApiError::NOT_FOUND.into_response();
    };
    match crate::downloads::prepare_thumbnail(
        &crate::downloads::files_dir(&app.config.data),
        &key,
        false,
    ) {
        Ok(value) => crate::downloads::into_response(value, false),
        Err(error) => error.into_response(),
    }
}

pub async fn preview(
    State(app): State<App>,
    Extension(_context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> Response {
    let Ok(Path((raw, item_id))) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    let file = match room_file(&app, &raw, &item_id).await {
        Ok(file) => file,
        Err(error) => return error.into_response(),
    };
    if file.thumbnail_key.as_deref().is_none_or(str::is_empty) {
        return ApiError::NOT_FOUND.into_response();
    }
    let Some(key) = file.file_key.filter(|key| !key.is_empty()) else {
        return ApiError::NOT_FOUND.into_response();
    };
    let item = match app
        .db
        .run({
            let id = item_id.clone();
            move |db| db::item_by_id(db, &id, now())
        })
        .await
    {
        Ok(Some(item)) => item,
        _ => return ApiError::NOT_FOUND.into_response(),
    };
    crate::uploads::preview_item(
        app,
        db::PreviewSource {
            item_id,
            file_key: key,
            expires_at: item.expires_at,
        },
        false,
    )
    .await
}

pub async fn media(
    State(app): State<App>,
    Extension(_context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
    request: axum::extract::Request,
) -> Response {
    let Ok(Path((raw, item_id))) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    let file = match room_file(&app, &raw, &item_id).await {
        Ok(file) => file,
        Err(error) => return error.into_response(),
    };
    let Some(key) = file.file_key.filter(|key| !key.is_empty()) else {
        return ApiError::NOT_FOUND.into_response();
    };
    let range = crate::downloads::range_header(request.headers());
    let head = request.method() == Method::HEAD;
    match crate::downloads::prepare_media(
        &crate::downloads::files_dir(&app.config.data),
        &key,
        file.filename.as_deref().unwrap_or("media"),
        file.size.max(0) as u64,
        range,
        head,
    ) {
        Ok(value) => crate::downloads::into_response(value, head),
        Err(error) => error.into_response(),
    }
}

fn rate_error(seconds: i64) -> ApiError {
    let mut error = ApiError::new(429, "RATE_LIMITED");
    error.header = Some((header::RETRY_AFTER, HeaderValue::from(seconds.max(1))));
    error
}
fn locked_for(app: &App, id: &str) -> ApiResult<Option<i64>> {
    let mut locks = app.pin_lockouts.lock().map_err(ApiError::internal)?;
    let time = now();
    locks.retain(|_, (_, since, until)| {
        if *until > 0 {
            *until > time
        } else {
            *since + app.config.pin_lock_ms > time
        }
    });
    Ok(locks
        .get(id)
        .and_then(|(_, _, until)| (*until > time).then_some((*until - time + 999) / 1000)))
}
pub async fn admin_unlock(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<StatusCode> {
    crate::admin_session(&context)?;
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let lookup = id.clone();
    let code=app.db.run(move|db|Ok(db.query_row("SELECT roomCode FROM spaces WHERE id=? AND roomKey IS NOT NULL AND expiresAt>?",rusqlite::params![lookup,now()],|row|row.get::<_,Option<String>>(0)).optional()?)).await?.ok_or(ApiError::NOT_FOUND)?;
    app.pin_lockouts
        .lock()
        .map_err(ApiError::internal)?
        .remove(&id);
    if let Some(code) = code {
        app.limiter
            .lock()
            .map_err(ApiError::internal)?
            .remove(&("guess:code", password::hash(&code)));
    }
    Ok(StatusCode::NO_CONTENT)
}
