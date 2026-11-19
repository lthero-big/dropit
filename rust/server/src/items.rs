//! Schema-19 item editing, labels and ordered group management for spaces and rooms.
use std::collections::HashMap;

use axum::{
    Extension, Json,
    extract::{Path, Request, State, rejection::PathRejection},
    http::StatusCode,
};
use rusqlite::{Connection, TransactionBehavior, params};
use serde_json::{Map, Value, json};

use crate::{
    ApiError, ApiResult, App, Auth, RequestContext, clean_group, db, input_string, js_space, now,
    read_json, rooms,
};

type Parameters = Result<Path<HashMap<String, String>>, PathRejection>;

struct Target {
    id: String,
    // Anonymous and signed-in room holders use the same capability authorization.
    auth: Option<Auth>,
}

impl Target {
    fn check(&self, db: &Connection, write: bool) -> ApiResult<db::Space> {
        match &self.auth {
            None => db::room(db, &self.id, now()),
            Some(auth) => {
                let account = db::principal_account(
                    db,
                    (!auth.session_hash.is_empty()).then_some(auth.session_hash.as_str()),
                    auth.bearer.as_ref().map(|bearer| bearer.id.as_str()),
                    now(),
                )?
                .ok_or(ApiError::UNAUTHENTICATED)?;
                if account.must_change_password {
                    return Err(ApiError::new(403, "PASSWORD_CHANGE_REQUIRED"));
                }
                db::space(db, &self.id, &account.user.id, write)
            }
        }
    }

    fn item(&self, db: &Connection, id: &str) -> ApiResult<db::Item> {
        db::item_by_id(db, id, now())?
            .filter(|item| item.space_id == self.id)
            .ok_or(ApiError::NOT_FOUND)
    }

    fn can_manage(&self, space: &db::Space, item: &db::Item, edit: bool) -> ApiResult<()> {
        if let Some(auth) = &self.auth
            && item.user_id.as_deref() != Some(auth.account.user.id.as_str())
            && (edit || space.owner_id.as_deref() != Some(auth.account.user.id.as_str()))
        {
            return Err(ApiError::new(403, "FORBIDDEN"));
        }
        Ok(())
    }
}

async fn target(
    app: &App,
    context: &RequestContext,
    parameters: Parameters,
    write: bool,
) -> ApiResult<(Target, HashMap<String, String>)> {
    let Path(parameters) = parameters.map_err(|_| ApiError::NOT_FOUND)?;
    let target = if let Some(raw) = parameters.get("room") {
        let space = rooms::scope(app, context, raw).await?;
        Target {
            id: space.id,
            auth: None,
        }
    } else {
        let auth = context.require_auth()?.clone();
        let id = parameters.get("space").ok_or(ApiError::NOT_FOUND)?.clone();
        let user = auth.account.user.id.clone();
        let scope = id.clone();
        app.db
            .run(move |db| db::space(db, &scope, &user, write))
            .await?;
        Target {
            id,
            auth: Some(auth),
        }
    };
    if write {
        let (ip, user, limit) = if target.auth.is_none() {
            ("room-write:ip", "room-write:user", app.config.rate_room)
        } else {
            ("write:ip", "write:user", app.config.rate_upload)
        };
        app.limit(ip, &context.ip, limit)?;
        if let Some(auth) = &context.auth {
            app.limit(user, &auth.account.user.id, limit)?;
        }
    }
    Ok((target, parameters))
}

pub async fn groups(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    parameters: Parameters,
) -> ApiResult<Json<Value>> {
    let (target, _) = target(&app, &context, parameters, false).await?;
    let groups = app.db.run(move |db| db::groups(db, &target.id)).await?;
    Ok(Json(json!({ "groups": groups })))
}

enum GroupChange {
    Create(String),
    Rename(String, String),
    Delete(String),
}

fn named(body: &Map<String, Value>) -> ApiResult<String> {
    clean_group(
        body.get("name")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(400, "INVALID_GROUP"))?,
    )
}

pub async fn create_group(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    parameters: Parameters,
    request: Request,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let (target, _) = target(&app, &context, parameters, true).await?;
    let change = GroupChange::Create(named(&read_json(request, 2048).await?)?);
    Ok((
        StatusCode::CREATED,
        change_group(&app, target, change).await?,
    ))
}

pub async fn rename_group(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    parameters: Parameters,
    request: Request,
) -> ApiResult<Json<Value>> {
    let (target, mut parameters) = target(&app, &context, parameters, true).await?;
    let change = GroupChange::Rename(
        parameters.remove("name").ok_or(ApiError::NOT_FOUND)?,
        named(&read_json(request, 2048).await?)?,
    );
    change_group(&app, target, change).await
}

pub async fn delete_group(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    parameters: Parameters,
) -> ApiResult<Json<Value>> {
    let (target, mut parameters) = target(&app, &context, parameters, true).await?;
    let change = GroupChange::Delete(parameters.remove("name").ok_or(ApiError::NOT_FOUND)?);
    change_group(&app, target, change).await
}

fn group_exists(db: &Connection, space: &str, name: &str) -> ApiResult<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM item_groups WHERE spaceId=? AND name=?)",
        params![space, name],
        |row| row.get(0),
    )?)
}

fn group_items(db: &Connection, space: &str, name: &str, time: i64) -> ApiResult<Vec<db::Item>> {
    let mut statement =
        db.prepare("SELECT * FROM items WHERE spaceId=? AND groupName=? AND expiresAt>?")?;
    Ok(statement
        .query_map(params![space, name, time], db::item)?
        .collect::<rusqlite::Result<_>>()?)
}

async fn change_group(app: &App, target: Target, change: GroupChange) -> ApiResult<Json<Value>> {
    let channel = target.id.clone();
    let _gate = app.realtime.gate.lock().await;
    let (groups, updated) = app
        .db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            target.check(&tx, true)?;
            let space = &target.id;
            let time = now();
            let mut updated = Vec::new();
            match change {
                GroupChange::Create(name) => {
                    if group_exists(&tx, space, &name)? {
                        return Err(ApiError::new(409, "GROUP_EXISTS"));
                    }
                    db::ensure_group(&tx, space, &name, time)?;
                }
                GroupChange::Rename(from, to) => {
                    if !group_exists(&tx, space, &from)? {
                        return Err(ApiError::new(404, "GROUP_NOT_FOUND"));
                    }
                    if from != to {
                        if group_exists(&tx, space, &to)? {
                            return Err(ApiError::new(409, "GROUP_EXISTS"));
                        }
                        tx.execute(
                            "UPDATE item_groups SET name=? WHERE spaceId=? AND name=?",
                            params![to, space, from],
                        )?;
                        tx.execute(
                            "UPDATE items SET groupName=? WHERE spaceId=? AND groupName=?",
                            params![to, space, from],
                        )?;
                        updated = group_items(&tx, space, &to, time)?;
                    }
                }
                GroupChange::Delete(name) => {
                    if !group_exists(&tx, space, &name)? {
                        return Err(ApiError::new(404, "GROUP_NOT_FOUND"));
                    }
                    updated = group_items(&tx, space, &name, time)?;
                    tx.execute(
                        "UPDATE items SET groupName=NULL WHERE spaceId=? AND groupName=?",
                        params![space, name],
                    )?;
                    tx.execute(
                        "DELETE FROM item_groups WHERE spaceId=? AND name=?",
                        params![space, name],
                    )?;
                    for item in &mut updated {
                        item.group = None;
                    }
                }
            }
            let groups = db::groups(&tx, space)?;
            tx.commit()?;
            Ok((groups, updated))
        })
        .await?;
    app.realtime
        .publish(&channel, json!({ "type": "groups", "groups": groups }));
    for item in updated {
        app.realtime
            .publish(&channel, json!({ "type": "item.updated", "item": item }));
    }
    Ok(Json(json!({ "groups": groups })))
}

fn normalize_tags(value: &Value) -> ApiResult<Vec<String>> {
    let values = value
        .as_array()
        .filter(|values| values.len() <= 8)
        .ok_or(ApiError::INVALID_INPUT)?;
    let mut tags = Vec::new();
    for value in values {
        let tag = value
            .as_str()
            .ok_or(ApiError::INVALID_INPUT)?
            .trim_matches(js_space)
            .trim_start_matches('#')
            .trim_matches(js_space);
        if !(1..=24).contains(&tag.chars().count())
            || tag.contains(',')
            || tag
                .chars()
                .any(|ch| js_space(ch) || ch <= '\u{1f}' || ch == '\u{7f}')
        {
            return Err(ApiError::INVALID_INPUT);
        }
        if !tags.iter().any(|entry| entry == tag) {
            tags.push(tag.to_owned());
        }
    }
    Ok(tags)
}

fn author_active(db: &Connection, current: &db::Item) -> ApiResult<()> {
    if let Some(author) = &current.user_id {
        let active: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM users u JOIN members m ON m.userId=u.id WHERE u.id=? AND u.disabled=0 AND m.spaceId=?)", params![author, current.space_id], |row| row.get(0))?;
        if !active {
            return Err(ApiError::new(403, "FORBIDDEN"));
        }
    }
    Ok(())
}

pub async fn labels(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    parameters: Parameters,
    request: Request,
) -> ApiResult<Json<Value>> {
    let (target, mut parameters) = target(&app, &context, parameters, true).await?;
    let id = parameters.remove("id").ok_or(ApiError::NOT_FOUND)?;
    let body = read_json(request, 4096).await?;
    // TS validates these field types before looking up the item.
    if body.get("pinned").is_some_and(|v| !v.is_boolean()) {
        return Err(ApiError::INVALID_INPUT);
    }
    if body
        .get("group")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(ApiError::new(400, "INVALID_GROUP"));
    }
    let channel = target.id.clone();
    let _gate = app.realtime.gate.lock().await;
    let (result, groups) = app
        .db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let space = target.check(&tx, true)?;
            let current = target.item(&tx, &id)?;
            target.can_manage(&space, &current, false)?;
            if !["pinned", "tags", "group"]
                .iter()
                .any(|key| body.contains_key(*key))
            {
                return Err(ApiError::INVALID_INPUT);
            }
            let tags = match body.get("tags") {
                Some(value) => normalize_tags(value)?,
                None => current.tags.clone(),
            };
            let before = db::groups(&tx, &target.id)?;
            let group = match body.get("group") {
                None => current.group.clone(),
                Some(Value::Null) => None,
                Some(Value::String(value)) if value.is_empty() => None,
                Some(Value::String(value)) => {
                    let group = clean_group(value)?;
                    db::ensure_group(&tx, &target.id, &group, now())?;
                    Some(group)
                }
                _ => unreachable!("group type was validated"),
            };
            let after = db::groups(&tx, &target.id)?;
            // A newly resolved group survives a later author/state rejection in TS.
            let result = (|| {
                if space.expires_at.is_some_and(|time| time <= now()) {
                    return Err(ApiError::NOT_FOUND);
                }
                author_active(&tx, &current)?;
                if let Some(group) = &group
                    && !group_exists(&tx, &target.id, group)?
                {
                    return Err(ApiError::new(404, "GROUP_NOT_FOUND"));
                }
                let pinned = body
                    .get("pinned")
                    .and_then(Value::as_bool)
                    .unwrap_or(current.pinned);
                let tags = serde_json::to_string(&tags).map_err(ApiError::internal)?;
                tx.execute(
                    "UPDATE items SET pinned=?,tags=?,groupName=? WHERE id=?",
                    params![pinned, tags, group, id],
                )?;
                target.item(&tx, &id)
            })();
            tx.commit()?;
            Ok((result, (before != after).then_some(after)))
        })
        .await?;
    if let Some(groups) = groups {
        app.realtime
            .publish(&channel, json!({ "type": "groups", "groups": groups }));
    }
    let item = result?;
    app.realtime
        .publish(&channel, json!({ "type": "item.updated", "item": item }));
    Ok(Json(json!({ "item": item })))
}

pub async fn edit(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    parameters: Parameters,
    request: Request,
) -> ApiResult<Json<Value>> {
    let (target, mut parameters) = target(&app, &context, parameters, true).await?;
    let id = parameters.remove("id").ok_or(ApiError::NOT_FOUND)?;
    let body = read_json(request, app.config.max_text * 6 + 1024).await?;
    let text = input_string(body.get("text"), usize::MAX)?.to_owned();
    let config = app.config.clone();
    let channel = target.id.clone();
    let _gate = app.realtime.gate.lock().await;
    let item = app
        .db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let space = target.check(&tx, true)?;
            let current = target.item(&tx, &id)?;
            if current.kind != "text" {
                return Err(ApiError::INVALID_INPUT);
            }
            target.can_manage(&space, &current, true)?;
            if text.trim_matches(js_space).is_empty() {
                return Err(ApiError::new(400, "EMPTY_TEXT"));
            }
            if text.len() > config.max_text {
                return Err(ApiError::new(413, "TEXT_TOO_LARGE"));
            }
            if space.expires_at.is_some_and(|time| time <= now()) {
                return Err(ApiError::NOT_FOUND);
            }
            author_active(&tx, &current)?;
            let old_size: i64 =
                tx.query_row("SELECT storedBytes FROM items WHERE id=?", [&id], |row| {
                    row.get(0)
                })?;
            let size = text.len() as i64;
            let delta = size - old_size;
            if delta > 0 {
                let (used, reserved, quota) = if let Some(author) = &current.user_id {
                    let (used, reserved) = db::usage(&tx, author, now())?;
                    let quota = tx
                        .query_row("SELECT quotaBytes FROM users WHERE id=?", [author], |row| {
                            row.get::<_, Option<i64>>(0)
                        })?
                        .unwrap_or(config.quota);
                    (used, reserved, quota)
                } else {
                    let used: i64 = tx.query_row(
                        "SELECT coalesce(sum(storedBytes),0) FROM items WHERE spaceId=?",
                        [&target.id],
                        |row| row.get(0),
                    )?;
                    let reserved: i64 = tx.query_row(
                        "SELECT coalesce(sum(size),0) FROM uploads WHERE spaceId=? AND expiresAt>?",
                        params![target.id, now()],
                        |row| row.get(0),
                    )?;
                    (used, reserved, config.room_quota)
                };
                if used.saturating_add(reserved).saturating_add(delta) > quota {
                    return Err(ApiError::new(413, "QUOTA_EXCEEDED"));
                }
            }
            tx.execute(
                "UPDATE items SET text=?,size=?,storedBytes=?,updatedAt=? WHERE id=?",
                params![text, size, size, now(), id],
            )?;
            let updated = target.item(&tx, &id)?;
            tx.commit()?;
            Ok(updated)
        })
        .await?;
    app.realtime
        .publish(&channel, json!({ "type": "item.updated", "item": item }));
    Ok(Json(json!({ "item": item })))
}
