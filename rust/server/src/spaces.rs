//! Space membership and invitation endpoints.
//!
//! These handlers intentionally keep the authorization boundary in the same
//! SQLite transaction model as item writes. A member may read a shared space,
//! but only its owner may administer members and invitations.

use axum::{
    Extension, Json,
    extract::{Path, State, rejection::PathRejection},
    http::StatusCode,
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    ApiError, ApiResult, App, RequestContext, db, header_value, now, origin_for, password,
    read_json,
};

fn value_i64(value: Option<&Value>, default: i64, min: i64, max: i64) -> ApiResult<i64> {
    let value = value.and_then(Value::as_i64).unwrap_or(default);
    if !(min..=max).contains(&value) {
        return Err(ApiError::INVALID_INPUT);
    }
    Ok(value)
}

async fn body_if_json(
    request: axum::extract::Request,
) -> ApiResult<serde_json::Map<String, Value>> {
    if header_value(request.headers(), "content-type")
        .is_some_and(|value| value.starts_with("application/json"))
    {
        read_json(request, 2048).await
    } else {
        Ok(serde_json::Map::new())
    }
}

async fn owned_space(
    app: &App,
    context: &RequestContext,
    id: &str,
) -> ApiResult<(crate::Auth, db::Space)> {
    let auth = context.require_auth()?.clone();
    let user_id = auth.account.user.id.clone();
    let space_id = id.to_owned();
    let space = app
        .db
        .run(move |db| db::space(db, &space_id, &user_id, false))
        .await?;
    if space.owner_id.as_deref() != Some(auth.account.user.id.as_str()) {
        return Err(ApiError::new(403, "FORBIDDEN"));
    }
    Ok((auth, space))
}

fn invite_status(
    uses: i64,
    max_uses: i64,
    expires_at: i64,
    revoked: i64,
    time: i64,
) -> &'static str {
    if revoked != 0 {
        "revoked"
    } else if uses >= max_uses {
        "used"
    } else if expires_at <= time {
        "expired"
    } else {
        "open"
    }
}

pub async fn list_invites(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path(space_id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let (auth, _) = owned_space(&app, &context, &space_id).await?;
    let user_id = auth.account.user.id.clone();
    let rows = app.db.run(move |db| {
        let mut statement = db.prepare(
            "SELECT id,maxUses,uses,expiresAt,revoked,createdAt,role FROM invites
             WHERE spaceId=? AND joinSpace=1 AND NOT (revoked=1 AND uses=0)
             ORDER BY coalesce(createdAt,0) DESC,expiresAt DESC",
        )?;
        let rows = statement.query_map([&space_id], |row| {
            let max: i64 = row.get(1)?;
            let uses: i64 = row.get(2)?;
            let expires: i64 = row.get(3)?;
            let revoked: i64 = row.get(4)?;
            Ok(json!({
                "id": row.get::<_, String>(0)?, "maxUses": max, "uses": uses,
                "expiresAt": expires, "revoked": revoked, "createdAt": row.get::<_, Option<i64>>(5)?,
                "role": row.get::<_, Option<String>>(6)?.unwrap_or_else(|| "editor".into()),
                "status": invite_status(uses, max, expires, revoked, now()),
            }))
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        let active: i64 = db.query_row(
            "SELECT count(*) FROM invites WHERE createdBy=? AND joinSpace=1 AND revoked=0 AND uses<maxUses AND expiresAt>?",
            rusqlite::params![user_id, now()], |row| row.get(0),
        )?;
        Ok((rows, active))
    }).await?;
    let (invites, active) = rows;
    let limit = if auth.account.user.role == "admin" {
        None
    } else {
        Some(5_i64)
    };
    let remaining = limit.map(|limit| (limit - active).max(0));
    Ok(Json(json!({
        "enabled": remaining != Some(0), "limit": limit, "active": active, "remaining": remaining,
        "invites": invites,
    })))
}

pub async fn create_invite(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
    request: axum::extract::Request,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let Path(space_id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let (auth, _) = owned_space(&app, &context, &space_id).await?;
    app.limit("invite:ip", &context.ip, app.config.rate_invite)?;
    app.limit("invite:user", &auth.account.user.id, app.config.rate_invite)?;
    let body = body_if_json(request).await?;
    let max_uses = value_i64(body.get("maxUses"), 1, 1, 100)?;
    let hours = value_i64(body.get("expiresInHours"), 168, 1, 720)?;
    let role = match body.get("role") {
        None => "viewer",
        Some(Value::String(role)) if role == "viewer" || role == "editor" => role.as_str(),
        _ => return Err(ApiError::INVALID_INPUT),
    }
    .to_owned();
    if auth.account.user.role != "admin" {
        let creator = auth.account.user.id.clone();
        let open = app.db.run(move |db| Ok(db.query_row(
            "SELECT count(*) FROM invites WHERE createdBy=? AND joinSpace=1 AND revoked=0 AND uses<maxUses AND expiresAt>?",
            rusqlite::params![creator, now()], |row| row.get::<_, i64>(0),
        )?)).await?;
        if open >= 5 {
            return Err(ApiError::new(403, "INVITE_LIMIT_REACHED"));
        }
    }
    let raw = password::session_token()?;
    let invite_id = Uuid::new_v4().to_string();
    let created_at = now();
    let hash = password::hash(&raw);
    let space = space_id.clone();
    let creator = auth.account.user.id.clone();
    let inserted_id = invite_id.clone();
    let inserted_role = role.clone();
    app.db.run(move |db| {
        db.execute(
            "INSERT INTO invites (id,tokenHash,spaceId,maxUses,uses,expiresAt,revoked,createdBy,joinSpace,createdAt,role)
             VALUES (?,?,?,?,0,?,0,?,1,?,?)",
            rusqlite::params![inserted_id, hash, space, max_uses, created_at + hours * 3_600_000, creator, created_at, inserted_role],
        )?;
        Ok(())
    }).await?;
    let expires_at = created_at + hours * 3_600_000;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": invite_id, "maxUses": max_uses, "uses": 0, "expiresAt": expires_at, "revoked": 0,
            "createdAt": created_at, "role": role, "status": "active", "token": raw,
            "url": format!("{}/invite/{raw}", origin_for(&app, &context)),
        })),
    ))
}

pub async fn revoke_invite(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> ApiResult<StatusCode> {
    let Path((space_id, invite_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    owned_space(&app, &context, &space_id).await?;
    app.limit("invite:ip", &context.ip, app.config.rate_invite)?;
    let changed = app
        .db
        .run(move |db| {
            Ok(db.execute(
        "UPDATE invites SET revoked=1 WHERE id=? AND spaceId=? AND joinSpace=1 AND revoked=0",
        rusqlite::params![invite_id, space_id],
    )?)
        })
        .await?;
    if changed == 0 {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn members(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path(space_id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    owned_space(&app, &context, &space_id).await?;
    let members = app
        .db
        .run(move |db| {
            let mut statement = db.prepare(
                "SELECT u.id,u.email,u.name,CASE WHEN s.ownerId=u.id THEN 'owner' ELSE m.role END
             FROM members m JOIN users u ON u.id=m.userId JOIN spaces s ON s.id=m.spaceId
             WHERE m.spaceId=? ORDER BY s.ownerId=u.id DESC,lower(u.email)",
            )?;
            Ok(statement
                .query_map([&space_id], |row| {
                    Ok(json!({
                        "userId": row.get::<_, String>(0)?, "email": row.get::<_, String>(1)?,
                        "name": row.get::<_, String>(2)?, "role": row.get::<_, String>(3)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
    Ok(Json(json!({ "members": members })))
}

pub async fn set_member_role(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    let Path((space_id, user_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    owned_space(&app, &context, &space_id).await?;
    let body = read_json(request, 1024).await?;
    let role = body
        .get("role")
        .and_then(Value::as_str)
        .filter(|role| matches!(*role, "viewer" | "editor"))
        .ok_or(ApiError::INVALID_INPUT)?
        .to_owned();
    let scope = space_id.clone();
    app.db.run(move |db| {
        let changed = db.execute(
            "UPDATE members SET role=? WHERE spaceId=? AND userId=? AND userId IS NOT (SELECT ownerId FROM spaces WHERE id=?)",
            rusqlite::params![role, scope, user_id, scope],
        )?;
        if changed == 0 { return Err(ApiError::NOT_FOUND); }
        Ok(())
    }).await?;
    members(State(app), Extension(context), Ok(Path(space_id))).await
}

pub async fn remove_member(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> ApiResult<StatusCode> {
    let Path((space_id, user_id)) = path.map_err(|_| ApiError::NOT_FOUND)?;
    owned_space(&app, &context, &space_id).await?;
    let db_space_id = space_id.clone();
    let db_space_id_for_subquery = space_id.clone();
    let changed = app.db.run(move |db| Ok(db.execute(
        "DELETE FROM members WHERE spaceId=? AND userId=? AND userId IS NOT (SELECT ownerId FROM spaces WHERE id=?)",
        rusqlite::params![db_space_id, user_id, db_space_id_for_subquery],
    )?)).await?;
    if changed == 0 {
        return Err(ApiError::NOT_FOUND);
    }
    app.realtime.revoke_space(&space_id);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn leave(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<StatusCode> {
    let Path(space_id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let auth = context.require_auth()?.clone();
    let user_id = auth.account.user.id.clone();
    let db_space_id = space_id.clone();
    let changed = app
        .db
        .run(move |db| {
            let owner: Option<String> = db
                .query_row(
                    "SELECT ownerId FROM spaces WHERE id=?",
                    [&db_space_id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            if owner.is_none() {
                return Err(ApiError::NOT_FOUND);
            }
            if owner.as_deref() == Some(user_id.as_str()) {
                return Err(ApiError::new(409, "OWNER_CANNOT_LEAVE"));
            }
            Ok(db.execute(
                "DELETE FROM members WHERE spaceId=? AND userId=?",
                rusqlite::params![db_space_id, user_id],
            )?)
        })
        .await?;
    if changed == 0 {
        return Err(ApiError::NOT_FOUND);
    }
    app.realtime.revoke_space(&space_id);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn invite_info(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path(raw) = path.map_err(|_| ApiError::NOT_FOUND)?;
    app.limit("invite:ip", &context.ip, app.config.rate_invite)?;
    let hash = password::hash(&raw);
    let auth_user = context
        .auth
        .as_ref()
        .map(|auth| auth.account.user.id.clone());
    let invite = app.db.run(move |db| {
        Ok(db.query_row(
            "SELECT i.spaceId,i.maxUses,i.uses,i.expiresAt,i.revoked,i.joinSpace,i.role,i.createdBy,
                    s.name,u.name,(u.role='admin' AND u.disabled=0)
             FROM invites i LEFT JOIN spaces s ON s.id=i.spaceId LEFT JOIN users u ON u.id=i.createdBy
             WHERE i.tokenHash=? AND i.revoked=0 AND i.uses<i.maxUses AND i.expiresAt>? AND (i.joinSpace=1 OR u.role='admin')",
            rusqlite::params![hash, now()],
            |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?, row.get::<_, i64>(5)?, row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?,
                row.get::<_, bool>(10)?,
            )),
        ).optional()?)
    }).await?.ok_or(ApiError::NOT_FOUND)?;
    let (
        space_id,
        max_uses,
        uses,
        expires_at,
        revoked,
        join_space,
        role,
        _created_by,
        space_name,
        inviter_name,
        creator_admin,
    ) = invite;
    if join_space == 0 {
        return Ok(Json(
            json!({ "personal": true, "spaceName": Value::Null, "inviterName": inviter_name,
            "expiresAt": expires_at, "remainingUses": max_uses - uses }),
        ));
    }
    let member = if let Some(user_id) = auth_user.clone() {
        let space = space_id.clone();
        app.db
            .run(move |db| {
                Ok(db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM members WHERE spaceId=? AND userId=?)",
                    rusqlite::params![space, user_id],
                    |row| row.get::<_, bool>(0),
                )?)
            })
            .await?
    } else {
        false
    };
    let role = role.unwrap_or_else(|| "editor".to_owned());
    Ok(Json(
        json!({ "personal": false, "spaceName": space_name, "expiresAt": expires_at,
        "remainingUses": max_uses - uses, "inviterName": inviter_name, "role": role,
        "canRegister": creator_admin, "member": member, "spaceId": member.then_some(space_id), "revoked": revoked }),
    ))
}

pub async fn accept_invite(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<Json<Value>> {
    let Path(raw) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let auth = context.require_auth()?.clone();
    app.limit("invite:ip", &context.ip, app.config.rate_invite)?;
    let token_hash = password::hash(&raw);
    let user_id = auth.account.user.id.clone();
    let result = app.db.run(move |db| {
        let invite: Option<(String, i64)> = db.query_row(
            "SELECT spaceId,joinSpace FROM invites WHERE tokenHash=? AND revoked=0 AND uses<maxUses AND expiresAt>?",
            rusqlite::params![token_hash, now()], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((space_id, join_space)) = invite else { return Err(ApiError::new(403, "INVITE_INVALID")); };
        if join_space == 0 { return Err(ApiError::new(403, "INVITE_INVALID")); }
        db::accept_invite(db, &token_hash, &user_id, now())?;
        let role: String = db.query_row("SELECT coalesce(role,'editor') FROM members WHERE spaceId=? AND userId=?", rusqlite::params![space_id, user_id], |row| row.get(0))?;
        Ok(json!({ "spaceId": space_id, "role": role }))
    }).await?;
    Ok(Json(result))
}
