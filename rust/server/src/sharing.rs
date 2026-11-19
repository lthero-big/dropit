//! Share-link capabilities for private-space and temporary-room items.

use axum::{
    Extension, Json,
    extract::{Path, Query, Request, State, rejection::PathRejection},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    ApiError, ApiResult, App, RequestContext, browser_session, db, downloads, now, origin_for,
    password, read_json, rooms,
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
    rooms::random_chars(b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
}
fn public_limit(app: &App, context: &RequestContext, raw: &str) -> ApiResult<()> {
    app.limit("share:ip", &context.ip, app.config.rate_auth)?;
    app.limit(
        "share:link",
        &format!("{}:{}", password::hash(raw), context.ip),
        app.config.rate_upload,
    )
}

fn write_limit(app: &App, context: &RequestContext, room: bool) -> ApiResult<()> {
    let (ip, user, count) = if room {
        ("room-write:ip", "room-write:user", app.config.rate_room)
    } else {
        ("write:ip", "write:user", app.config.rate_upload)
    };
    app.limit(ip, &context.ip, count)?;
    if let Some(auth) = &context.auth {
        app.limit(user, &auth.account.user.id, count)?;
    }
    Ok(())
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
    write_limit(&app, &context, false)?;
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
    write_limit(&app, &context, true)?;
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
            .run(move |db| db::space(db, &id, &user_id, true))
            .await?
    };
    let space_id = space.id.clone();
    if !room {
        let id = share_id.clone();
        let scope = space_id.clone();
        let author=app.db.run(move|db|Ok(db.query_row("SELECT i.userId FROM shares s JOIN items i ON i.id=s.itemId WHERE s.id=? AND s.spaceId=?",rusqlite::params![id,scope],|row|row.get::<_,Option<String>>(0)).optional()?)).await?.ok_or(ApiError::NOT_FOUND)?;
        let caller = &context.require_auth()?.account.user.id;
        if author.as_deref() != Some(caller.as_str())
            && space.owner_id.as_deref() != Some(caller.as_str())
        {
            return Err(ApiError::new(403, "FORBIDDEN"));
        }
    }
    write_limit(&app, &context, room)?;
    let id = share_id.clone();
    let changed = app.db.run(move |db| Ok(db.execute("UPDATE shares SET revoked=1,downloadTicketHash=NULL,downloadTicketExpiresAt=NULL WHERE id=? AND spaceId=?", rusqlite::params![id, space_id])?)).await?;
    if changed == 0 {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

// Managed views reveal source content only while the creator can still read it.
const MANAGED_SELECT: &str = "SELECT s.id,s.itemId,s.expiresAt,s.maxViews,s.views,s.revoked,s.createdAt,s.copyToken,
    i.id,i.kind,i.filename,i.text,i.expiresAt,sp.id,sp.name,sp.expiresAt,sp.closedAt,
    (sp.roomKey IS NOT NULL OR sp.ownerId=?1 OR EXISTS(SELECT 1 FROM members m WHERE m.spaceId=sp.id AND m.userId=?1))
    FROM shares s LEFT JOIN items i ON i.id=s.itemId LEFT JOIN spaces sp ON sp.id=s.spaceId";

fn managed_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Value, Option<String>)> {
    let expires: Option<i64> = row.get(2)?;
    let max_views: Option<i64> = row.get(3)?;
    let views: i64 = row.get(4)?;
    let revoked: i64 = row.get(5)?;
    let created: i64 = row.get(6)?;
    let copy: Option<String> = row.get(7)?;
    let item_id: Option<String> = row.get(8)?;
    let kind: Option<String> = row.get(9)?;
    let filename: Option<String> = row.get(10)?;
    let text: Option<String> = row.get(11)?;
    let item_expires: Option<i64> = row.get(12)?;
    let space_id: Option<String> = row.get(13)?;
    let space_name: Option<String> = row.get(14)?;
    let space_expires: Option<i64> = row.get(15)?;
    let closed: Option<i64> = row.get(16)?;
    let visible: Option<bool> = row.get(17)?;
    let unavailable = item_id.is_none()
        || space_id.is_none()
        || visible != Some(true)
        || item_expires.is_some_and(|t| t <= now())
        || space_expires.is_some_and(|t| t <= now())
        || closed.is_some();
    let state = if revoked != 0 {
        "revoked"
    } else if unavailable {
        "source_unavailable"
    } else if expires.is_some_and(|t| t <= now()) {
        "expired"
    } else if max_views.is_some_and(|n| views >= n) {
        "exhausted"
    } else {
        "active"
    };
    let source_name = if unavailable {
        None
    } else if kind.as_deref() == Some("file") {
        Some(
            filename
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "未命名文件".into()),
        )
    } else {
        let name = text
            .unwrap_or_default()
            .split(crate::js_space)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let name = String::from_utf16_lossy(&name.encode_utf16().take(80).collect::<Vec<_>>());
        Some(if name.is_empty() {
            "文本条目".into()
        } else {
            name
        })
    };
    Ok((
        json!({ "id": row.get::<_,String>(0)?, "itemId": row.get::<_,String>(1)?, "expiresAt": expires, "maxViews": max_views, "views": views, "revoked": revoked, "createdAt": created,
        "state": state, "copyStatus": if state != "active" { "unavailable" } else if copy.is_some() { "available" } else { "legacy" },
        "sourceName": source_name, "sourceKind": if unavailable { None } else { kind }, "spaceName": if visible == Some(true) { space_name } else { None } }),
        copy,
    ))
}
fn purge_invalid_shares(db: &rusqlite::Connection, user: &str) -> ApiResult<()> {
    db.execute("DELETE FROM shares WHERE createdBy=?1 AND (expiresAt<=?2 OR NOT EXISTS (
        SELECT 1 FROM items i JOIN spaces sp ON sp.id=i.spaceId WHERE i.id=shares.itemId AND sp.id=shares.spaceId
        AND (i.expiresAt IS NULL OR i.expiresAt>?2) AND (sp.expiresAt IS NULL OR sp.expiresAt>?2) AND sp.closedAt IS NULL
        AND (shares.createdBy IS NULL OR sp.roomKey IS NOT NULL OR sp.ownerId=shares.createdBy OR EXISTS(SELECT 1 FROM members m WHERE m.spaceId=sp.id AND m.userId=shares.createdBy))))", rusqlite::params![user, now()])?;
    Ok(())
}
pub async fn managed_shares(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let user = browser_session(&context)?.account.user.id.clone();
    let cursor = match query.get("cursor").filter(|value| !value.is_empty()) {
        None => None,
        Some(value) => {
            let (time, id) = value.split_once(':').ok_or(ApiError::INVALID_INPUT)?;
            if time.is_empty()
                || time.len() > 16
                || !time.bytes().all(|b| b.is_ascii_digit())
                || id.is_empty()
                || id.len() > 64
                || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                return Err(ApiError::INVALID_INPUT);
            }
            let time: i64 = time.parse().map_err(|_| ApiError::INVALID_INPUT)?;
            if time >= 1_i64 << 53 {
                return Err(ApiError::INVALID_INPUT);
            }
            Some((time, id.to_owned()))
        }
    };
    let rows = app.db.run(move |db| {
        purge_invalid_shares(db, &user)?;
        let (created, id) = cursor.unwrap_or((i64::MAX, "~".into()));
        let query = format!("{MANAGED_SELECT} WHERE s.createdBy=?1 AND (s.createdAt<?2 OR (s.createdAt=?2 AND s.id<?3)) ORDER BY s.createdAt DESC,s.id DESC LIMIT 51");
        let mut statement = db.prepare(&query)?;
        Ok(statement.query_map(rusqlite::params![user,created,id], managed_row)?.map(|row| row.map(|(value,_)| value)).collect::<rusqlite::Result<Vec<_>>>()?)
    }).await?;
    let next = if rows.len() > 50 {
        Some(format!(
            "{}:{}",
            rows[49]["createdAt"].as_i64().unwrap(),
            rows[49]["id"].as_str().unwrap()
        ))
    } else {
        None
    };
    let rows: Vec<_> = rows.into_iter().take(50).collect();
    Ok(Json(json!({ "shares": rows, "nextCursor": next })))
}
pub async fn managed_link(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let user = browser_session(&context)?.account.user.id.clone();
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    manage_limit(&app, &context)?;
    let (view, token) = app
        .db
        .run(move |db| {
            Ok(db
                .query_row(
                    &format!("{MANAGED_SELECT} WHERE s.id=?2 AND s.createdBy=?1"),
                    rusqlite::params![user, id],
                    managed_row,
                )
                .optional()?)
        })
        .await?
        .ok_or(ApiError::NOT_FOUND)?;
    if view["state"] != "active" {
        return Err(ApiError::NOT_FOUND);
    }
    let token = token.ok_or(ApiError::NOT_FOUND)?;
    let origin = origin_for(&app, &context);
    let mut result = json!({ "url": format!("{origin}/s/{token}") });
    if view["sourceKind"] == "file" {
        result["directUrl"] = format!("{origin}/d/{token}").into();
    }
    Ok(Json(result))
}
fn manage_limit(app: &App, context: &RequestContext) -> ApiResult<()> {
    app.limit("share-manage:ip", &context.ip, app.config.rate_upload)?;
    if let Some(auth) = &context.auth {
        app.limit(
            "share-manage:user",
            &auth.account.user.id,
            app.config.rate_upload,
        )?;
    }
    Ok(())
}
pub async fn managed_revoke(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<StatusCode> {
    manage_limit(&app, &context)?;
    let user = browser_session(&context)?.account.user.id.clone();
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let changed=app.db.run(move |db| Ok(db.execute("UPDATE shares SET revoked=1,downloadTicketHash=NULL,downloadTicketExpiresAt=NULL WHERE id=? AND createdBy=?",rusqlite::params![id,user])?)).await?;
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
    manage_limit(&app, &context)?;
    let user = browser_session(&context)?.account.user.id.clone();
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    app.db
        .run(move |db| {
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let revoked = tx
                .query_row(
                    "SELECT revoked FROM shares WHERE id=? AND createdBy=?",
                    rusqlite::params![id, user],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .ok_or(ApiError::NOT_FOUND)?;
            if revoked == 0 {
                return Err(ApiError::new(409, "SHARE_NOT_REVOKED"));
            }
            tx.execute(
                "DELETE FROM shares WHERE id=? AND createdBy=?",
                rusqlite::params![id, user],
            )?;
            tx.commit()?;
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
        let should_spend = !ticket_ok;
        let _ = spend;
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
    public_limit(&app, &context, &raw)?;
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
    if let Err(error) = public_limit(&app, &context, &raw) {
        return error.into_response();
    }
    let access = query
        .get("access")
        .filter(|s| !s.is_empty())
        .map(String::as_str);
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
    if !valid_token(raw) {
        return Err(ApiError::NOT_FOUND);
    }
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
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Ok(Path(raw)) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    if let Err(error) = public_limit(&app, &context, &raw) {
        return error.into_response();
    }
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
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Ok(Path(raw)) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    if let Err(error) = public_limit(&app, &context, &raw) {
        return error.into_response();
    }
    let Ok(shared) = read_shared(&app, &raw, query.get("access").map(String::as_str), true).await
    else {
        return ApiError::NOT_FOUND.into_response();
    };
    let Some(key) = shared.file.file_key.filter(|key| !key.is_empty()) else {
        return ApiError::NOT_FOUND.into_response();
    };
    if shared
        .file
        .thumbnail_key
        .as_deref()
        .is_none_or(str::is_empty)
    {
        return ApiError::NOT_FOUND.into_response();
    }
    crate::uploads::preview_item(
        app,
        db::PreviewSource {
            item_id: shared.item.id,
            file_key: key,
            expires_at: shared.item.expires_at,
        },
        true,
    )
    .await
}

pub async fn media(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    Query(query): Query<HashMap<String, String>>,
    request: Request,
) -> Response {
    let Ok(Path(raw)) = path else {
        return ApiError::NOT_FOUND.into_response();
    };
    if let Err(error) = public_limit(&app, &context, &raw) {
        return error.into_response();
    }
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

const EMPTY_PRESETS: &str = r#"{"hours":[],"days":[],"months":[],"views":[]}"#;

/// Older preferences stored only days and views. Missing keys become empty arrays.
fn preset_response(saved: Option<&str>) -> ApiResult<Value> {
    let mut body: Value = serde_json::from_str(EMPTY_PRESETS).map_err(ApiError::internal)?;
    if let Some(saved) = saved {
        let saved: Value =
            serde_json::from_str(saved).map_err(|_| ApiError::internal("share presets"))?;
        if let (Some(body), Some(saved)) = (body.as_object_mut(), saved.as_object()) {
            for (key, value) in saved {
                body.insert(key.clone(), value.clone());
            }
        }
    }
    Ok(body)
}

fn preset_values(raw: Option<&Value>, max: i64) -> ApiResult<Vec<i64>> {
    let Some(raw) = raw else {
        return Err(ApiError::INVALID_INPUT);
    };
    let Some(values) = raw.as_array() else {
        return Err(ApiError::INVALID_INPUT);
    };
    if values.len() > 20 {
        return Err(ApiError::INVALID_INPUT);
    }
    let mut numbers = Vec::with_capacity(values.len());
    for value in values {
        // JSON numbers stay exact. A fractional value is not a JavaScript safe integer.
        let Some(number) = value
            .as_i64()
            .filter(|_| value.as_f64().is_some_and(|float| float.fract() == 0.0))
        else {
            return Err(ApiError::INVALID_INPUT);
        };
        if !(1..=max).contains(&number) || number > (1_i64 << 53) {
            return Err(ApiError::INVALID_INPUT);
        }
        if !numbers.contains(&number) {
            numbers.push(number);
        }
    }
    numbers.sort_unstable();
    Ok(numbers)
}

fn normalized_presets(input: &Map<String, Value>) -> ApiResult<Value> {
    let empty = Value::Array(Vec::new());
    let hours = preset_values(input.get("hours").or(Some(&empty)), 87_600)?;
    let days = preset_values(input.get("days"), 3_650)?;
    let months = preset_values(input.get("months").or(Some(&empty)), 121)?;
    let views = preset_values(input.get("views"), 1_000_000)?;
    if hours.len() + days.len() + months.len() > 20 {
        return Err(ApiError::INVALID_INPUT);
    }
    Ok(json!({ "hours": hours, "days": days, "months": months, "views": views }))
}

pub async fn share_presets(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let user_id = browser_session(&context)?.account.user.id.clone();
    let saved = app
        .db
        .run(move |db| Ok(db::setting(db, &format!("sharePresets:{user_id}"))?))
        .await?;
    Ok(Json(preset_response(saved.as_deref())?))
}

pub async fn save_share_presets(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> ApiResult<Json<Value>> {
    let auth = browser_session(&context)?;
    let user_id = auth.account.user.id.clone();
    manage_limit(&app, &context)?;
    let presets = normalized_presets(&read_json(request, 2048).await?)?;
    let stored = presets.to_string();
    app.db
        .run(move |db| {
            db.execute(
                "INSERT INTO app_settings (key,value,updatedAt,updatedBy) VALUES (?,?,?,?)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy",
                rusqlite::params![format!("sharePresets:{user_id}"), stored, now(), user_id],
            )?;
            Ok(())
        })
        .await?;
    Ok(Json(presets))
}

#[cfg(test)]
mod preset_tests {
    use super::{normalized_presets, preset_response};
    use serde_json::{Value, json};

    fn numbers(value: &Value, key: &str) -> Vec<i64> {
        value[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_i64().unwrap())
            .collect()
    }

    #[test]
    fn legacy_presets_fill_missing_units() {
        let body = preset_response(Some(r#"{"days":[14],"views":[50]}"#)).unwrap();
        assert_eq!(numbers(&body, "hours"), Vec::<i64>::new());
        assert_eq!(numbers(&body, "days"), vec![14]);
        assert_eq!(numbers(&body, "months"), Vec::<i64>::new());
        assert_eq!(numbers(&body, "views"), vec![50]);
        assert!(
            preset_response(None).unwrap()["hours"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn presets_dedupe_sort_and_reject_bounds() {
        let saved = normalized_presets(
            json!({"hours":[6,2,6],"days":[30,3,30],"months":[2,1,2],"views":[200,20,200]})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(numbers(&saved, "hours"), vec![2, 6]);
        assert_eq!(numbers(&saved, "days"), vec![3, 30]);
        assert_eq!(numbers(&saved, "months"), vec![1, 2]);
        assert_eq!(numbers(&saved, "views"), vec![20, 200]);
        let omitted =
            normalized_presets(json!({"days":[],"views":[]}).as_object().unwrap()).unwrap();
        assert!(omitted["hours"].as_array().unwrap().is_empty());
        for invalid in [
            json!({}),
            json!({"days":"3","views":[]}),
            json!({"days":[0],"views":[]}),
            json!({"days":[3651],"views":[]}),
            json!({"days":[1.5],"views":[]}),
            json!({"days":[],"views":[1000001]}),
            json!({"hours":[87601],"days":[],"months":[],"views":[]}),
            json!({"hours":null,"days":[],"months":[],"views":[]}),
            json!({"hours":[2,3,4,5,6,7,8,9,10,11],"days":[2,3,4,5,6,7,8,9,10,11],"months":[2],"views":[]}),
        ] {
            assert!(
                normalized_presets(invalid.as_object().unwrap()).is_err(),
                "{invalid}"
            );
        }
    }
}
