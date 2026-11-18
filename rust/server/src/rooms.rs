//! Temporary-room capabilities and their lifecycle.
//!
//! A room URL contains an entry proof derived from the room's private key. The
//! human room code is only used by the PIN-protected `/enter` endpoint; it is
//! never accepted as an item API credential.

use axum::{
    Extension, Json,
    body::Body,
    extract::{Path, State, rejection::PathRejection},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    ApiError, ApiResult, App, RequestContext, db, header_value, input_string, now, origin_for,
    parse_device, password, read_json,
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

fn room_view(space: &db::Space, origin: &str, reused: bool) -> ApiResult<Value> {
    Ok(json!({
        "token": entry_token(space)?, "expiresAt": space.expires_at,
        "url": format!("{}/r/{}", origin, urlencoding(space.room_code.as_deref().unwrap_or_default())),
        "code": space.room_code, "hasPin": space.pin_hash.is_some(), "reused": reused,
    }))
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
    let mut bytes = [0_u8; 6];
    getrandom::fill(&mut bytes).map_err(ApiError::internal)?;
    Ok(bytes
        .into_iter()
        .map(|byte| ROOM_CODE_ALPHABET[(byte as usize) % ROOM_CODE_ALPHABET.len()] as char)
        .collect())
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
    (4..=32).contains(&length) && !value.chars().any(|ch| ch.is_control())
}

fn device_key(value: Option<&Value>) -> ApiResult<Option<String>> {
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
        serde_json::Map::new()
    };
    let device = device_key(body.get("deviceKey"))?;
    let custom_code = match body.get("code") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.is_empty() => None,
        Some(Value::String(value)) if valid_custom_code(value, false) => Some(value.clone()),
        Some(_) => return Err(ApiError::new(400, "INVALID_CODE")),
    };
    let pin = match body.get("pin") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.is_empty() => None,
        Some(Value::String(value)) if valid_pin(value) => Some(password::hash_password(value)?),
        Some(_) => return Err(ApiError::new(400, "INVALID_PIN")),
    };
    if custom_code.is_some() {
        app.limit("guess:ip", &context.ip, app.config.rate_auth)?;
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
                    Json(room_view(&space, &origin_for(&app, &context), true)?),
                ));
            }
            let next_pin = if body.contains_key("pin") {
                pin
            } else {
                space.pin_hash.clone()
            };
            set_code_inner(&app, &space, custom_code, next_pin, false).await?;
            let fresh = load_by_id(&app, &space.id).await?;
            return Ok((
                StatusCode::OK,
                Json(room_view(&fresh, &origin_for(&app, &context), true)?),
            ));
        }
    }
    app.limit("room-create:ip", &context.ip, app.config.rate_room)?;
    let room_id = Uuid::new_v4().to_string();
    let key = password::session_token()?;
    let was_random = custom_code.is_none();
    let code = custom_code.clone().unwrap_or(random_code()?);
    let pin_hash = pin;
    let created_by = context
        .auth
        .as_ref()
        .map(|auth| auth.account.user.id.clone());
    let expires = now() + app.config.room_retention;
    let inserted = app.db.run({
        let room_id = room_id.clone(); let key = key.clone(); let code = code.clone(); let pin_hash = pin_hash.clone(); let device_hash = device_hash.clone();
        move |db| {
            if db.query_row("SELECT EXISTS(SELECT 1 FROM spaces WHERE roomKey=? OR roomCode=?)", rusqlite::params![key, code], |row| row.get::<_, bool>(0))? {
                return Err(ApiError::new(409, "CODE_TAKEN"));
            }
            db.execute("INSERT INTO spaces (id,name,ownerId,expiresAt,roomKey,deviceHash,roomCode,pinHash,createdAt,lastActiveAt,closedAt,createdBy) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)",
                rusqlite::params![room_id, "Temporary room", Option::<String>::None, expires, key, device_hash, code, pin_hash, now(), now(), created_by])?;
            Ok(())
        }
    }).await;
    if let Err(error) = inserted {
        if error.code == "CODE_TAKEN" && was_random {
            return Err(ApiError::new(503, "UNAVAILABLE"));
        }
        return Err(error);
    }
    let space = load_by_id(&app, &room_id).await?;
    Ok((
        StatusCode::CREATED,
        Json(room_view(&space, &origin_for(&app, &context), false)?),
    ))
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
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .ok_or(ApiError::new(400, "INVALID_CODE"))?;
    app.limit("guess:ip", &context.ip, app.config.rate_auth)?;
    let code_owned = code.to_owned();
    let space = app
        .db
        .run(move |db| db::room_by_code(db, &code_owned, now()))
        .await?
        .ok_or(ApiError::NOT_FOUND)?;
    if let Some(pin_hash) = space.pin_hash.as_deref() {
        let key = space.id.clone();
        let locked = app
            .pin_lockouts
            .lock()
            .map_err(ApiError::internal)?
            .get(&key)
            .copied();
        if let Some((_, until)) = locked.filter(|(_, until)| *until > now()) {
            let mut error = ApiError::new(429, "RATE_LIMITED");
            error.header = Some((
                axum::http::header::RETRY_AFTER,
                ((until - now() + 999) / 1000).to_string().parse().unwrap(),
            ));
            return Err(error);
        }
        let pin = body
            .get("pin")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 256)
            .unwrap_or_default();
        if pin.is_empty() {
            return Err(ApiError::new(401, "PIN_REQUIRED"));
        }
        if !password::verify(pin, Some(pin_hash))? {
            let mut locks = app.pin_lockouts.lock().map_err(ApiError::internal)?;
            let entry = locks.entry(space.id.clone()).or_insert((0, 0));
            entry.0 = entry.0.saturating_add(1);
            if entry.0 >= app.config.pin_lock_failures {
                entry.1 = now() + app.config.pin_lock_ms;
                let mut error = ApiError::new(429, "RATE_LIMITED");
                error.header = Some((
                    axum::http::header::RETRY_AFTER,
                    ((entry.1 - now() + 999) / 1000)
                        .to_string()
                        .parse()
                        .unwrap(),
                ));
                return Err(error);
            }
            return Err(ApiError::new(403, "PIN_INVALID"));
        }
        app.pin_lockouts
            .lock()
            .map_err(ApiError::internal)?
            .remove(&space.id);
    }
    Ok(Json(room_view(&space, &origin_for(&app, &context), false)?))
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
        .and_then(Value::as_str)
        .ok_or(ApiError::INVALID_INPUT)?;
    let key = device_key(Some(&Value::String(key.to_owned())))?.ok_or(ApiError::INVALID_INPUT)?;
    let space = load_room(&app, &raw).await?;
    if space.device_hash.as_deref() != Some(password::hash(&format!("room-device:{key}")).as_str())
    {
        return Err(ApiError::new(403, "FORBIDDEN"));
    }
    app.limit("room-code:ip", &context.ip, app.config.rate_room)?;
    if !body.contains_key("code") && !body.contains_key("pin") {
        return Err(ApiError::INVALID_INPUT);
    }
    let code = if body.contains_key("code") {
        match body.get("code") {
            Some(Value::Null) => None,
            Some(Value::String(value)) if value.is_empty() => None,
            Some(Value::String(value)) if valid_custom_code(value, true) => Some(value.clone()),
            _ => return Err(ApiError::new(400, "INVALID_CODE")),
        }
    } else {
        space.room_code.clone()
    };
    let pin = if body.contains_key("pin") {
        match body.get("pin") {
            Some(Value::Null) => None,
            Some(Value::String(value)) if value.is_empty() => None,
            Some(Value::String(value)) if valid_pin(value) => Some(password::hash_password(value)?),
            _ => return Err(ApiError::new(400, "INVALID_PIN")),
        }
    } else {
        space.pin_hash.clone()
    };
    set_code_inner(&app, &space, code, pin, true).await?;
    let fresh = load_by_id(&app, &space.id).await?;
    app.pin_lockouts
        .lock()
        .map_err(ApiError::internal)?
        .remove(&space.id);
    let view = room_view(&fresh, &origin_for(&app, &context), false)?;
    Ok(Json(view))
}

pub async fn info(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path(raw) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let space = load_room(&app, &raw).await?;
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
    let rows = app.db.run(move |db| {
        let mut statement = db.prepare(
            "SELECT s.id,s.roomCode,u.email,s.createdAt,s.lastActiveAt,s.expiresAt,s.closedAt,
                    s.pinHash IS NOT NULL,(SELECT count(*) FROM items WHERE spaceId=s.id AND expiresAt>?),
                    (SELECT coalesce(sum(storedBytes),0) FROM items WHERE spaceId=s.id AND expiresAt>?)
             FROM spaces s LEFT JOIN users u ON u.id=s.createdBy WHERE s.roomKey IS NOT NULL AND s.expiresAt>? ORDER BY coalesce(s.lastActiveAt,s.createdAt,0) DESC,s.expiresAt DESC",
        )?;
        Ok(statement.query_map(rusqlite::params![now(), now(), now()], |row| Ok(json!({
            "id": row.get::<_, String>(0)?, "code": row.get::<_, Option<String>>(1)?, "owner": row.get::<_, Option<String>>(2)?,
            "anonymous": row.get::<_, Option<String>>(2)?.is_none(), "createdAt": row.get::<_, Option<i64>>(3)?,
            "lastActiveAt": row.get::<_, Option<i64>>(4)?, "expiresAt": row.get::<_, i64>(5)?, "closed": row.get::<_, Option<i64>>(6)?.is_some(),
            "closedAt": row.get::<_, Option<i64>>(6)?, "hasPin": row.get::<_, bool>(7)?, "itemCount": row.get::<_, i64>(8)?, "bytes": row.get::<_, i64>(9)?,
        })))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await?;
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
    if !reopen {
        app.realtime.revoke_space(&id);
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
    let db_id = id.clone();
    let changed = app.db.run(move |db| Ok(db.execute("UPDATE spaces SET expiresAt=?,closedAt=coalesce(closedAt,?),deviceHash=NULL,roomCode=NULL,pinHash=NULL WHERE id=? AND roomKey IS NOT NULL AND expiresAt>?", rusqlite::params![now(), now(), db_id, now()])?)).await?;
    if changed == 0 {
        return Err(ApiError::NOT_FOUND);
    }
    app.realtime.revoke_space(&id);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn items(
    State(app): State<App>,
    Extension(_context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path(raw) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let space = load_room(&app, &raw).await?;
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
) -> ApiResult<(StatusCode, Json<Value>)> {
    let Path(raw) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let space = load_room(&app, &raw).await?;
    app.limit("room-write:ip", &context.ip, app.config.rate_room)?;
    let headers = request.headers().clone();
    let body = read_json(request, app.config.max_text * 6 + 1024).await?;
    let text = input_string(body.get("text"), usize::MAX)?;
    if text.trim_matches(crate::js_space).is_empty() {
        return Err(ApiError::new(400, "EMPTY_TEXT"));
    }
    if text.len() > app.config.max_text {
        return Err(ApiError::new(413, "TEXT_TOO_LARGE"));
    }
    let group = match body.get("group") {
        None | Some(Value::Null) => {
            header_value(&headers, "x-dropit-group").and_then(crate::decode_uri_component)
        }
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => return Err(ApiError::new(400, "INVALID_GROUP")),
    };
    let group = group
        .filter(|value| !value.is_empty())
        .map(|value| crate::clean_group(&value))
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
    let item = app
        .db
        .run(move |db| db::insert_room_text(db, &config, &db_channel, input))
        .await?;
    app.realtime
        .publish(&channel, json!({ "type": "item.created", "item": item }));
    Ok((StatusCode::CREATED, Json(json!({ "item": item }))))
}

pub async fn delete_item(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> ApiResult<StatusCode> {
    let Path((raw, item_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let space = load_room(&app, &raw).await?;
    app.limit("room-write:ip", &context.ip, app.config.rate_room)?;
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
    let path =
        match crate::downloads::object_path(&crate::downloads::files_dir(&app.config.data), &key) {
            Ok(path) => path,
            Err(error) => return error.into_response(),
        };
    let bytes =
        match tokio::task::spawn_blocking(move || crate::images::derive_file(&path, 2048)).await {
            Ok(Ok(bytes)) => bytes,
            _ => return ApiError::new(415, "INVALID_IMAGE").into_response(),
        };
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
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
