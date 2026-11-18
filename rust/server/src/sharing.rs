//! Share-link capabilities for private-space and temporary-room items.

use axum::{
    Extension, Json,
    body::Body,
    extract::{Path, Query, Request, State, rejection::PathRejection},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    ApiError, ApiResult, App, RequestContext, browser_session, db, downloads, images, now,
    origin_for, password, read_json, rooms,
};

struct Shared {
    item: db::Item,
    file: db::StoredFile,
    expires_at: Option<i64>,
    max_views: Option<i64>,
    views: i64,
}

type ShareLookup = (
    String,
    String,
    Option<i64>,
    Option<i64>,
    i64,
    i64,
    Option<String>,
    Option<i64>,
);
type ShareOpen = (String, String, Option<i64>, Option<i64>, i64);

fn short_token() -> ApiResult<String> {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut bytes = [0_u8; 6];
    getrandom::fill(&mut bytes).map_err(ApiError::internal)?;
    Ok(bytes
        .into_iter()
        .map(|byte| ALPHABET[(byte as usize) % ALPHABET.len()] as char)
        .collect())
}

fn share_hash(raw: &str) -> String {
    password::hash(raw)
}

fn valid_token(raw: &str) -> bool {
    (raw.len() == 6 && raw.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        || (raw.len() == 43
            && raw
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
}

fn public_item(item: &db::Item) -> ApiResult<Value> {
    let mut value = serde_json::to_value(item).map_err(ApiError::internal)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| ApiError::internal("item"))?;
    let has_thumbnail = object
        .get("hasThumbnail")
        .cloned()
        .unwrap_or(Value::Bool(false));
    for key in [
        "id",
        "spaceId",
        "userId",
        "updatedAt",
        "group",
        "device",
        "storedBytes",
        "fileKey",
        "thumbnailKey",
    ] {
        object.remove(key);
    }
    object.insert("hasThumbnail".into(), has_thumbnail);
    Ok(value)
}

fn public_share_item(shared: &Shared) -> ApiResult<Value> {
    let item = public_item(&shared.item)?;
    let object = item.as_object().ok_or_else(|| ApiError::internal("item"))?;
    let mut output = Map::new();
    for key in [
        "kind",
        "text",
        "filename",
        "mime",
        "size",
        "hasThumbnail",
        "createdAt",
        "expiresAt",
        "pinned",
        "tags",
    ] {
        if let Some(value) = object.get(key) {
            output.insert(key.into(), value.clone());
        }
    }
    Ok(Value::Object(output))
}

fn expires_at(raw: &str, time: i64) -> ApiResult<Option<i64>> {
    if raw == "never" {
        return Ok(None);
    }
    let (number, unit) = if let Some(number) = raw.strip_suffix("mo") {
        (number, "mo")
    } else if let Some(number) = raw.strip_suffix('h') {
        (number, "h")
    } else if let Some(number) = raw.strip_suffix('d') {
        (number, "d")
    } else {
        return Err(ApiError::INVALID_INPUT);
    };
    if number.is_empty() || number.len() > 5 || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ApiError::INVALID_INPUT);
    }
    let number: i64 = number.parse().map_err(|_| ApiError::INVALID_INPUT)?;
    if number < 1 {
        return Err(ApiError::INVALID_INPUT);
    }
    let hours = match unit {
        "h" => number,
        "d" => number * 24,
        "mo" => number * 720,
        _ => return Err(ApiError::INVALID_INPUT),
    };
    if hours > 3650 * 24 {
        return Err(ApiError::INVALID_INPUT);
    }
    Ok(Some(time + hours * 3_600_000))
}

async fn load_private(
    app: &App,
    context: &RequestContext,
    space_id: &str,
    item_id: &str,
    write: bool,
) -> ApiResult<(db::Space, db::Item)> {
    let user_id = context.require_auth()?.account.user.id.clone();
    let scope = space_id.to_owned();
    let item = item_id.to_owned();
    app.db
        .run(move |db| {
            let space = db::space(db, &scope, &user_id, write)?;
            let item = db::item_by_id(db, &item, now())?
                .filter(|item| item.space_id == scope)
                .ok_or(ApiError::NOT_FOUND)?;
            Ok((space, item))
        })
        .await
}

async fn load_room_item(app: &App, token: &str, item_id: &str) -> ApiResult<(db::Space, db::Item)> {
    let space = rooms::load_room(app, token).await?;
    let id = item_id.to_owned();
    let space_id = space.id.clone();
    let item = app.db.run(move |db| db::item_by_id(db, &id, now())).await?;
    let item = item
        .filter(|item| item.space_id == space_id)
        .ok_or(ApiError::NOT_FOUND)?;
    Ok((space, item))
}

async fn can_manage_private(
    _app: &App,
    context: &RequestContext,
    space: &db::Space,
    item: &db::Item,
) -> ApiResult<()> {
    let user_id = context.require_auth()?.account.user.id.clone();
    if item.user_id.as_deref() != Some(user_id.as_str())
        && space.owner_id.as_deref() != Some(user_id.as_str())
    {
        return Err(ApiError::new(403, "FORBIDDEN"));
    }
    Ok(())
}

async fn create_inner(
    app: App,
    context: RequestContext,
    space: db::Space,
    item: db::Item,
    request: Request,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if space.room_key.is_none() {
        can_manage_private(&app, &context, &space, &item).await?;
    }
    let body = read_json(request, 2048).await?;
    let expires = body
        .get("expiresIn")
        .and_then(Value::as_str)
        .ok_or(ApiError::INVALID_INPUT)?;
    let max_views = match body.get("maxViews") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_i64()
                .filter(|value| (1..=1_000_000).contains(value))
                .ok_or(ApiError::INVALID_INPUT)?,
        ),
    };
    let time = now();
    let expires_at = expires_at(expires, time)?;
    let creator = context
        .auth
        .as_ref()
        .map(|auth| auth.account.user.id.clone());
    let item_id = item.id.clone();
    let space_id = space.id.clone();
    let origin = origin_for(&app, &context);
    for _ in 0..12 {
        let raw = short_token()?;
        let share_id = Uuid::new_v4().to_string();
        let inserted = app.db.run({
            let hash = share_hash(&raw); let db_raw = raw.clone(); let share_id = share_id.clone(); let item_id = item_id.clone(); let space_id = space_id.clone(); let creator = creator.clone();
            move |db| Ok(db.execute(
                "INSERT INTO shares (id,tokenHash,itemId,spaceId,createdBy,expiresAt,maxViews,views,revoked,createdAt,downloadTicketHash,downloadTicketExpiresAt,copyToken)
                 VALUES (?,?,?,?,?,?,?,0,0,?,NULL,NULL,?)",
                rusqlite::params![share_id, hash, item_id, space_id, creator, expires_at, max_views, time, db_raw],
            )?)
        }).await;
        match inserted {
            Ok(_) => {
                let mut output = json!({ "id": share_id, "itemId": item.id, "expiresAt": expires_at, "maxViews": max_views,
                    "views": 0, "revoked": 0, "createdAt": time, "token": raw,
                    "url": format!("{origin}/s/{raw}") });
                if item.kind == "file" {
                    output["directUrl"] = format!("{origin}/d/{raw}").into();
                }
                return Ok((StatusCode::CREATED, Json(output)));
            }
            Err(error) if error.code == "INTERNAL_ERROR" => continue,
            Err(error) => return Err(error),
        }
    }
    Err(ApiError::new(503, "UNAVAILABLE"))
}

pub async fn create_private(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
    request: Request,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let Path((space_id, item_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let (space, item) = load_private(&app, &context, &space_id, &item_id, true).await?;
    app.limit("share:ip", &context.ip, app.config.rate_upload)?;
    create_inner(app, context, space, item, request).await
}

pub async fn create_room(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
    request: Request,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let Path((token, item_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let (space, item) = load_room_item(&app, &token, &item_id).await?;
    app.limit("share:ip", &context.ip, app.config.rate_room)?;
    create_inner(app, context, space, item, request).await
}

pub async fn list_private(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path((space_id, item_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let (space, item) = load_private(&app, &context, &space_id, &item_id, false).await?;
    can_manage_private(&app, &context, &space, &item).await?;
    list_for_item(&app, &item.id).await
}

pub async fn list_room(
    State(app): State<App>,
    Extension(_context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path((token, item_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let (_, item) = load_room_item(&app, &token, &item_id).await?;
    list_for_item(&app, &item.id).await
}

async fn list_for_item(app: &App, item_id: &str) -> ApiResult<Json<Value>> {
    let id = item_id.to_owned();
    let shares = app.db.run(move |db| {
        let mut statement = db.prepare("SELECT id,itemId,expiresAt,maxViews,views,revoked,createdAt FROM shares WHERE itemId=? ORDER BY createdAt DESC,id DESC")?;
        Ok(statement.query_map([id], |row| Ok(json!({
            "id": row.get::<_, String>(0)?, "itemId": row.get::<_, String>(1)?, "expiresAt": row.get::<_, Option<i64>>(2)?,
            "maxViews": row.get::<_, Option<i64>>(3)?, "views": row.get::<_, i64>(4)?, "revoked": row.get::<_, i64>(5)?, "createdAt": row.get::<_, i64>(6)?,
        })))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await?;
    Ok(Json(json!({ "shares": shares })))
}

pub async fn revoke_private(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> ApiResult<StatusCode> {
    revoke_resource(app, context, path, false).await
}

pub async fn revoke_room(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> ApiResult<StatusCode> {
    revoke_resource(app, context, path, true).await
}

async fn revoke_resource(
    app: App,
    context: RequestContext,
    path: Result<Path<(String, String)>, PathRejection>,
    room: bool,
) -> ApiResult<StatusCode> {
    let Path((resource, share_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let space = if room {
        rooms::load_room(&app, &resource).await?
    } else {
        let user_id = context.require_auth()?.account.user.id.clone();
        let id = resource.clone();
        app.db
            .run(move |db| db::space(db, &id, &user_id, false))
            .await?
    };
    let space_id = space.id.clone();
    let user_id = context
        .auth
        .as_ref()
        .map(|auth| auth.account.user.id.clone());
    if !room {
        let id = share_id.clone();
        let scope = space_id.clone();
        let caller = user_id.clone().ok_or(ApiError::UNAUTHENTICATED)?;
        let allowed = app.db.run(move |db| Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM shares s LEFT JOIN items i ON i.id=s.itemId WHERE s.id=? AND s.spaceId=? AND (s.createdBy=? OR i.userId=? OR EXISTS(SELECT 1 FROM spaces WHERE id=? AND ownerId=?)))", rusqlite::params![id, scope, caller, caller, scope, caller], |row| row.get::<_, bool>(0))?)).await?;
        if !allowed {
            return Err(ApiError::NOT_FOUND);
        }
    }
    let id = share_id.clone();
    let changed = app.db.run(move |db| Ok(db.execute("UPDATE shares SET revoked=1,downloadTicketHash=NULL,downloadTicketExpiresAt=NULL WHERE id=? AND spaceId=?", rusqlite::params![id, space_id])?)).await?;
    if changed == 0 {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn managed_shares(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let user_id = context.require_auth()?.account.user.id.clone();
    let cursor = query
        .get("cursor")
        .and_then(|value| value.split_once(':'))
        .and_then(|(created, id)| Some((created.parse::<i64>().ok()?, id.to_owned())));
    let rows = app.db.run(move |db| {
        let (cursor_created, cursor_id) = cursor.unwrap_or((i64::MAX, "\u{10ffff}".into()));
        let mut statement = db.prepare(
            "SELECT s.id,s.itemId,s.expiresAt,s.maxViews,s.views,s.revoked,s.createdAt,s.copyToken,
                    i.kind,i.filename,i.text,i.expiresAt,sp.name,sp.expiresAt,sp.closedAt
             FROM shares s LEFT JOIN items i ON i.id=s.itemId LEFT JOIN spaces sp ON sp.id=s.spaceId
             WHERE s.createdBy=? AND (s.createdAt<? OR (s.createdAt=? AND s.id<?))
             ORDER BY s.createdAt DESC,s.id DESC LIMIT 51",
        )?;
        let mut values = statement.query(rusqlite::params![user_id, cursor_created, cursor_created, cursor_id])?;
        let mut output = Vec::new();
        while let Some(row) = values.next()? {
            let expires: Option<i64> = row.get(2)?; let max_views: Option<i64> = row.get(3)?; let views: i64 = row.get(4)?;
            let revoked: i64 = row.get(5)?; let created: i64 = row.get(6)?; let copy: Option<String> = row.get(7)?;
            let kind: Option<String> = row.get(8)?; let filename: Option<String> = row.get(9)?; let text: Option<String> = row.get(10)?;
            let item_expires: Option<i64> = row.get(11)?; let space_name: Option<String> = row.get(12)?; let space_expires: Option<i64> = row.get(13)?; let closed: Option<i64> = row.get(14)?;
            let state = if revoked != 0 { "revoked" } else if expires.is_some_and(|value| value <= now()) { "expired" } else if max_views.is_some_and(|value| views >= value) { "exhausted" } else if kind.is_none() || space_name.is_none() || item_expires.is_some_and(|value| value <= now()) || space_expires.is_some_and(|value| value <= now()) || closed.is_some() { "source_unavailable" } else { "active" };
            let copy_status = if state != "active" { "unavailable" } else if copy.is_some() { "available" } else { "legacy" };
            output.push(json!({ "id": row.get::<_, String>(0)?, "itemId": row.get::<_, String>(1)?, "expiresAt": expires, "maxViews": max_views, "views": views, "revoked": revoked, "createdAt": created,
                "state": state, "copyStatus": copy_status, "sourceName": filename.or(text), "spaceName": space_name, "sourceKind": kind }));
        }
        Ok(output)
    }).await?;
    let next = if rows.len() == 51 {
        rows.get(49).and_then(|row| {
            Some(format!(
                "{}:{}",
                row.get("createdAt")?.as_i64()?,
                row.get("id")?.as_str()?
            ))
        })
    } else {
        None
    };
    let mut rows = rows;
    if rows.len() > 50 {
        rows.truncate(50);
    }
    Ok(Json(json!({ "shares": rows, "nextCursor": next })))
}

pub async fn managed_link(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<(axum::http::HeaderMap, Json<Value>)> {
    let auth = browser_session(&context)?;
    let Path(share_id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let id = share_id.clone();
    let user = auth.account.user.id.clone();
    let copy = app
        .db
        .run(move |db| {
            Ok(db
                .query_row(
                    "SELECT copyToken,revoked,expiresAt FROM shares WHERE id=? AND createdBy=?",
                    rusqlite::params![id, user],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                        ))
                    },
                )
                .optional()?)
        })
        .await?
        .ok_or(ApiError::NOT_FOUND)?;
    if copy.1 != 0 || copy.0.is_none() || copy.2.is_some_and(|value| value <= now()) {
        return Err(ApiError::NOT_FOUND);
    }
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((
        headers,
        Json(json!({ "url": format!("{}/s/{}", origin_for(&app, &context), copy.0.unwrap()) })),
    ))
}

pub async fn managed_revoke(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<StatusCode> {
    let auth = context.require_auth()?;
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let user = auth.account.user.id.clone();
    let changed = app.db.run(move |db| Ok(db.execute("UPDATE shares SET revoked=1,downloadTicketHash=NULL,downloadTicketExpiresAt=NULL WHERE id=? AND createdBy=?", rusqlite::params![id, user])?)).await?;
    if changed == 0 {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn managed_delete(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<StatusCode> {
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let user = context.require_auth()?.account.user.id.clone();
    let lookup_id = id.clone();
    let lookup_user = user.clone();
    let state = app
        .db
        .run(move |db| {
            Ok(db
                .query_row(
                    "SELECT revoked FROM shares WHERE id=? AND createdBy=?",
                    rusqlite::params![lookup_id, lookup_user],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?)
        })
        .await?
        .ok_or(ApiError::NOT_FOUND)?;
    if state == 0 {
        return Err(ApiError::new(409, "SHARE_NOT_REVOKED"));
    }
    app.db
        .run(move |db| {
            db.execute(
                "DELETE FROM shares WHERE id=? AND createdBy=?",
                rusqlite::params![id, user],
            )?;
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn read_shared(app: &App, raw: &str, access: Option<&str>, spend: bool) -> ApiResult<Shared> {
    if !valid_token(raw) {
        return Err(ApiError::NOT_FOUND);
    }
    let token_hash = share_hash(raw);
    let access_hash = access.filter(|value| value.len() <= 128).map(share_hash);
    let raw_hash = token_hash.clone();
    let share_key = raw_hash.clone();
    app.db.run(move |db| {
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let row: Option<ShareLookup> = tx.query_row(
            "SELECT s.itemId,s.spaceId,s.expiresAt,s.maxViews,s.views,s.revoked,s.downloadTicketHash,s.downloadTicketExpiresAt FROM shares s WHERE s.tokenHash=?",
            [raw_hash], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?)),
        ).optional()?;
        let Some((item_id, space_id, expires, max_views, views, revoked, ticket_hash, ticket_expires)) = row else { return Err(ApiError::NOT_FOUND); };
        let time = now();
        if revoked != 0 || expires.is_some_and(|expires| expires <= time) { return Err(ApiError::NOT_FOUND); }
        let space_live: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM spaces WHERE id=? AND (expiresAt IS NULL OR expiresAt>?) AND (roomKey IS NULL OR closedAt IS NULL))", rusqlite::params![space_id, time], |row| row.get(0))?;
        let item = db::item_by_id(&tx, &item_id, time)?.filter(|item| item.space_id == space_id).ok_or(ApiError::NOT_FOUND)?;
        if !space_live { return Err(ApiError::NOT_FOUND); }
        let ticket_ok = access_hash.as_deref().zip(ticket_hash.as_deref()).is_some_and(|(provided, stored)| provided == stored && ticket_expires.is_some_and(|until| until > time));
        let should_spend = spend && !ticket_ok;
        let next_views = if should_spend {
            let changed = tx.execute("UPDATE shares SET views=views+1 WHERE tokenHash=? AND revoked=0 AND (maxViews IS NULL OR views<maxViews)", [share_key])?;
            if changed != 1 { return Err(ApiError::NOT_FOUND); }
            views + 1
        } else { views };
        let file: db::StoredFile = tx.query_row("SELECT filename,size,fileKey,thumbnailKey FROM items WHERE id=?", [item_id], |row| Ok(db::StoredFile { filename: row.get(0)?, size: row.get(1)?, file_key: row.get(2)?, thumbnail_key: row.get(3)? }))?;
        tx.commit()?;
        Ok(Shared { item, file, expires_at: expires, max_views, views: next_views })
    }).await
}

// The public open response needs a ticket that is also stored on the link.
pub async fn open_public(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path(raw) = path.map_err(|_| ApiError::NOT_FOUND)?;
    app.limit("share:ip", &context.ip, app.config.rate_auth)?;
    let (shared, access) = open_shared(&app, &raw).await?;
    Ok(Json(
        json!({ "item": public_share_item(&shared)?, "linkExpiresAt": shared.expires_at, "views": shared.views, "maxViews": shared.max_views, "access": access }),
    ))
}

async fn public_file_response(
    app: App,
    context: RequestContext,
    raw: String,
    query: HashMap<String, String>,
    request: Request,
) -> Response {
    let access = query.get("access").map(String::as_str);
    let (shared, fresh_access) = if access.is_none() {
        match open_shared(&app, &raw).await {
            Ok((value, access)) => (value, Some(access)),
            Err(error) => return error.into_response(),
        }
    } else {
        match read_shared(&app, &raw, access, false).await {
            Ok(value) => (value, None),
            Err(error) => return error.into_response(),
        }
    };
    let (Some(key), Some(filename)) = (
        shared.file.file_key.filter(|key| !key.is_empty()),
        shared.file.filename.filter(|name| !name.is_empty()),
    ) else {
        return ApiError::NOT_FOUND.into_response();
    };
    let range = downloads::range_header(request.headers());
    let head = request.method() == Method::HEAD;
    let directory = downloads::files_dir(&app.config.data);
    let prepared = downloads::prepare_download(
        &directory,
        &key,
        &filename,
        shared.file.size.max(0) as u64,
        range,
        head,
    );
    let mut response = match prepared {
        Ok(value) => downloads::into_response(value, head),
        Err(error) => error.into_response(),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(access) = fresh_access {
        if let Ok(value) = HeaderValue::from_str(&access) {
            response.headers_mut().insert("x-share-access", value);
        }
        if let Ok(value) = HeaderValue::from_str(&format!("/api/s/{raw}/file?access={access}")) {
            response
                .headers_mut()
                .insert(header::CONTENT_LOCATION, value);
        }
    }
    let _ = context;
    response
}

async fn open_shared(app: &App, raw: &str) -> ApiResult<(Shared, String)> {
    let access = password::session_token()?;
    let hash = share_hash(raw);
    let ticket = share_hash(&access);
    let raw_hash = hash.clone();
    let returned_access = access.clone();
    app.db.run(move |db| {
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let row: Option<ShareOpen> = tx.query_row("SELECT itemId,spaceId,expiresAt,maxViews,views FROM shares WHERE tokenHash=? AND revoked=0", [raw_hash], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional()?;
        let Some((item_id, space_id, expires, max_views, views)) = row else { return Err(ApiError::NOT_FOUND); };
        let time = now(); if expires.is_some_and(|value| value <= time) { return Err(ApiError::NOT_FOUND); }
        if !tx.query_row("SELECT EXISTS(SELECT 1 FROM spaces WHERE id=? AND (expiresAt IS NULL OR expiresAt>?) AND (roomKey IS NULL OR closedAt IS NULL))", rusqlite::params![space_id, time], |row| row.get::<_, bool>(0))? { return Err(ApiError::NOT_FOUND); }
        let item = db::item_by_id(&tx, &item_id, time)?.filter(|item| item.space_id == space_id).ok_or(ApiError::NOT_FOUND)?;
        let changed = tx.execute("UPDATE shares SET views=views+1,downloadTicketHash=?,downloadTicketExpiresAt=? WHERE tokenHash=? AND revoked=0 AND (maxViews IS NULL OR views<maxViews)", rusqlite::params![ticket, time + 600000, hash])?;
        if changed != 1 { return Err(ApiError::NOT_FOUND); }
        let file = tx.query_row("SELECT filename,size,fileKey,thumbnailKey FROM items WHERE id=?", [item_id], |row| Ok(db::StoredFile { filename: row.get(0)?, size: row.get(1)?, file_key: row.get(2)?, thumbnail_key: row.get(3)? }))?;
        tx.commit()?; Ok((Shared { item, file, expires_at: expires, max_views, views: views + 1 }, returned_access))
    }).await
}

use std::collections::HashMap;

pub async fn file(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    Query(query): Query<HashMap<String, String>>,
    request: Request,
) -> Response {
    let Ok(Path(raw)) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    public_file_response(app, context, raw, query, request).await
}

pub async fn thumbnail(
    State(app): State<App>,
    Extension(_context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Ok(Path(raw)) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    let shared = match read_shared(&app, &raw, query.get("access").map(String::as_str), true).await
    {
        Ok(shared) => shared,
        Err(error) => return error.into_response(),
    };
    let Some(key) = shared.file.thumbnail_key.filter(|key| !key.is_empty()) else {
        return ApiError::NOT_FOUND.into_response();
    };
    let prepared =
        downloads::prepare_thumbnail(&downloads::files_dir(&app.config.data), &key, false);
    match prepared {
        Ok(value) => downloads::into_response(value, false),
        Err(error) => error.into_response(),
    }
}

pub async fn preview(
    State(app): State<App>,
    Extension(_context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Ok(Path(raw)) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    let Ok(shared) = read_shared(&app, &raw, query.get("access").map(String::as_str), true).await
    else {
        return ApiError::NOT_FOUND.into_response();
    };
    let Some(key) = shared.file.file_key.filter(|key| !key.is_empty()) else {
        return ApiError::NOT_FOUND.into_response();
    };
    let directory = downloads::files_dir(&app.config.data);
    let path = match downloads::object_path(&directory, &key) {
        Ok(path) => path,
        Err(error) => return error.into_response(),
    };
    let bytes = match tokio::task::spawn_blocking(move || images::derive_file(&path, 2048)).await {
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
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn media(
    State(app): State<App>,
    Extension(_context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    Query(query): Query<HashMap<String, String>>,
    request: Request,
) -> Response {
    let Ok(Path(raw)) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    let Ok(shared) = read_shared(&app, &raw, query.get("access").map(String::as_str), true).await
    else {
        return ApiError::NOT_FOUND.into_response();
    };
    let Some(key) = shared.file.file_key.filter(|key| !key.is_empty()) else {
        return ApiError::NOT_FOUND.into_response();
    };
    let range = downloads::range_header(request.headers());
    let head = request.method() == Method::HEAD;
    match downloads::prepare_media(
        &downloads::files_dir(&app.config.data),
        &key,
        shared.file.filename.as_deref().unwrap_or("media"),
        shared.file.size.max(0) as u64,
        range,
        head,
    ) {
        Ok(value) => downloads::into_response(value, head),
        Err(error) => error.into_response(),
    }
}
