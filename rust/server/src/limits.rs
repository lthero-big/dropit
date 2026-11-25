//! Runtime limit administration and audit endpoints, aligned with apps/server/src/limits.ts.

use std::collections::HashMap;

use axum::{
    Extension, Json,
    extract::{Query, Request, State},
};
use rusqlite::{TransactionBehavior, params};
use serde_json::{Map, Value, json};

use crate::{
    ApiError, ApiResult, App, RequestContext, admin_session, config::Config, now, read_json,
};

struct LimitSpec {
    key: &'static str,
    min: i64,
    max: i64,
}

const LIMIT_SPECS: &[LimitSpec] = &[
    LimitSpec {
        key: "maxFileBytes",
        min: 1,
        max: 1 << 30,
    },
    LimitSpec {
        key: "maxTextBytes",
        min: 1,
        max: 1 << 20,
    },
    LimitSpec {
        key: "maxItems",
        min: 1,
        max: 100_000,
    },
    LimitSpec {
        key: "userQuotaBytes",
        min: 1,
        max: 100 << 30,
    },
    LimitSpec {
        key: "retentionMs",
        min: 1,
        max: 365 * 86_400_000,
    },
    LimitSpec {
        key: "roomQuotaBytes",
        min: 1,
        max: 100 << 30,
    },
    LimitSpec {
        key: "roomMaxFileBytes",
        min: 1,
        max: 1 << 30,
    },
    LimitSpec {
        key: "roomRetentionMs",
        min: 1,
        max: 86_400_000,
    },
    LimitSpec {
        key: "rateWindowMs",
        min: 1,
        max: 3_600_000,
    },
    LimitSpec {
        key: "rateGeneral",
        min: 1,
        max: 1_000_000,
    },
    LimitSpec {
        key: "rateAuth",
        min: 1,
        max: 1_000_000,
    },
    LimitSpec {
        key: "rateInvite",
        min: 1,
        max: 1_000_000,
    },
    LimitSpec {
        key: "rateUpload",
        min: 1,
        max: 1_000_000,
    },
    LimitSpec {
        key: "rateRoom",
        min: 1,
        max: 1_000_000,
    },
    LimitSpec {
        key: "sessionMs",
        min: 1,
        max: 365 * 86_400_000,
    },
    LimitSpec {
        key: "uploadChunkBytes",
        min: 64 * 1024,
        max: 24 << 20,
    },
    LimitSpec {
        key: "uploadChunkTimeoutMs",
        min: 1,
        max: 3_600_000,
    },
    LimitSpec {
        key: "rateChunk",
        min: 1,
        max: 1_000_000,
    },
    LimitSpec {
        key: "uploadChunksPerSession",
        min: 1,
        max: 16,
    },
    LimitSpec {
        key: "uploadChunksPerUser",
        min: 1,
        max: 64,
    },
    LimitSpec {
        key: "uploadChunksGlobal",
        min: 1,
        max: 256,
    },
    LimitSpec {
        key: "uploadSessionsPerUser",
        min: 1,
        max: 1_000,
    },
    LimitSpec {
        key: "uploadSessionsGlobal",
        min: 1,
        max: 10_000,
    },
];

fn spec_for(key: &str) -> Option<&'static LimitSpec> {
    LIMIT_SPECS.iter().find(|spec| spec.key == key)
}

fn current_value(config: &Config, key: &str) -> i64 {
    match key {
        "maxFileBytes" => config.max_file,
        "maxTextBytes" => config.max_text as i64,
        "maxItems" => config.max_items,
        "userQuotaBytes" => config.quota,
        "retentionMs" => config.retention,
        "roomQuotaBytes" => config.room_quota,
        "roomMaxFileBytes" => config.room_max_file,
        "roomRetentionMs" => config.room_retention,
        "rateWindowMs" => config.rate_window,
        "rateGeneral" => i64::from(config.rate_general),
        "rateAuth" => i64::from(config.rate_auth),
        "rateInvite" => i64::from(config.rate_invite),
        "rateUpload" => i64::from(config.rate_upload),
        "rateRoom" => i64::from(config.rate_room),
        "sessionMs" => config.session,
        "uploadChunkBytes" => config.upload_chunk_bytes,
        "uploadChunkTimeoutMs" => config.upload_chunk_timeout_ms,
        "rateChunk" => i64::from(config.rate_chunk),
        "uploadChunksPerSession" => i64::from(config.upload_chunks_per_session),
        "uploadChunksPerUser" => i64::from(config.upload_chunks_per_user),
        "uploadChunksGlobal" => i64::from(config.upload_chunks_global),
        "uploadSessionsPerUser" => config.upload_sessions_per_user,
        "uploadSessionsGlobal" => config.upload_sessions_global,
        _ => 0,
    }
}

fn apply_values(config: &mut Config, values: &HashMap<&'static str, i64>) {
    config.max_file = values["maxFileBytes"];
    config.max_text = values["maxTextBytes"] as usize;
    config.max_items = values["maxItems"];
    config.quota = values["userQuotaBytes"];
    config.retention = values["retentionMs"];
    config.room_quota = values["roomQuotaBytes"];
    config.room_max_file = values["roomMaxFileBytes"];
    config.room_retention = values["roomRetentionMs"];
    config.rate_window = values["rateWindowMs"];
    config.rate_general = values["rateGeneral"] as u32;
    config.rate_auth = values["rateAuth"] as u32;
    config.rate_invite = values["rateInvite"] as u32;
    config.rate_upload = values["rateUpload"] as u32;
    config.rate_room = values["rateRoom"] as u32;
    config.session = values["sessionMs"];
    config.upload_chunk_bytes = values["uploadChunkBytes"];
    config.upload_chunk_timeout_ms = values["uploadChunkTimeoutMs"];
    config.rate_chunk = values["rateChunk"] as u32;
    config.upload_chunks_per_session = values["uploadChunksPerSession"] as u32;
    config.upload_chunks_per_user = values["uploadChunksPerUser"] as u32;
    config.upload_chunks_global = values["uploadChunksGlobal"] as u32;
    config.upload_sessions_per_user = values["uploadSessionsPerUser"];
    config.upload_sessions_global = values["uploadSessionsGlobal"];
}

fn describe(config: &Config) -> Value {
    let mut out = Map::new();
    for spec in LIMIT_SPECS {
        let value = current_value(config, spec.key);
        let default = config
            .limit_defaults
            .get(spec.key)
            .copied()
            .unwrap_or(value);
        let overridden = config.limit_overrides.contains_key(spec.key);
        out.insert(
            spec.key.into(),
            json!({
                "value": value,
                "default": default,
                "overridden": overridden,
                "min": spec.min,
                "max": spec.max,
            }),
        );
    }
    Value::Object(out)
}

fn js_safe_integer(value: &crate::js::Value) -> Option<i64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 || number.abs() >= (1_u64 << 53) as f64 {
        return None;
    }
    Some(number as i64)
}

fn validate_all(values: &HashMap<&'static str, i64>) -> ApiResult<()> {
    for spec in LIMIT_SPECS {
        let value = values[spec.key];
        if !(spec.min..=spec.max).contains(&value) {
            return Err(ApiError::new(400, "INVALID_LIMITS"));
        }
    }
    if values["roomRetentionMs"] > values["retentionMs"]
        || values["roomMaxFileBytes"] >= values["maxFileBytes"]
        || values["roomQuotaBytes"] >= values["userQuotaBytes"]
        || values["rateAuth"] >= values["rateGeneral"]
        || values["rateInvite"] >= values["rateGeneral"]
        || values["rateUpload"] >= values["rateGeneral"]
        || values["rateRoom"] >= values["rateUpload"]
    {
        return Err(ApiError::new(400, "INVALID_LIMITS"));
    }
    Ok(())
}

pub async fn get_limits(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    admin_session(&context)?;
    Ok(Json(describe(&app.config())))
}

pub async fn patch_limits(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> ApiResult<Json<Value>> {
    let auth = admin_session(&context)?;
    let body = read_json(request, 4096).await?;
    if body.is_empty() {
        return Err(ApiError::new(400, "INVALID_LIMITS"));
    }
    let current = app.config();
    let mut next_overrides = current.limit_overrides.clone();
    for (key, value) in body.iter() {
        let Some(spec) = key.as_str().and_then(spec_for) else {
            return Err(ApiError::new(400, "INVALID_LIMITS"));
        };
        match value {
            crate::js::Value::Null => {
                next_overrides.remove(spec.key);
            }
            crate::js::Value::Number(_) => {
                let parsed = js_safe_integer(value).ok_or(ApiError::new(400, "INVALID_LIMITS"))?;
                next_overrides.insert(spec.key, parsed);
            }
            _ => return Err(ApiError::new(400, "INVALID_LIMITS")),
        }
    }
    let mut next_values = HashMap::new();
    for spec in LIMIT_SPECS {
        let default = current
            .limit_defaults
            .get(spec.key)
            .copied()
            .unwrap_or_else(|| current_value(&current, spec.key));
        let value = next_overrides.get(spec.key).copied().unwrap_or(default);
        next_values.insert(spec.key, value);
    }
    validate_all(&next_values)?;

    let mut changes = Vec::new();
    for spec in LIMIT_SPECS {
        let old_override = current.limit_overrides.get(spec.key).copied();
        let new_override = next_overrides.get(spec.key).copied();
        if old_override != new_override {
            changes.push((
                spec.key,
                current_value(&current, spec.key),
                next_values[spec.key],
                old_override,
                new_override,
            ));
        }
    }
    let actor_id = auth.account.user.id.clone();
    let actor_email = auth.account.user.email.clone();
    let time = now();
    app.db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            for (key, old_value, new_value, old_override, new_override) in changes {
                if let Some(value) = new_override {
                    tx.execute(
                        "INSERT INTO runtime_limits (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        params![key, value],
                    )?;
                } else {
                    tx.execute("DELETE FROM runtime_limits WHERE key=?", [key])?;
                }
                tx.execute(
                    "INSERT INTO limit_audit (actorId,actorEmail,createdAt,key,oldValue,newValue,oldOverride,newOverride) VALUES (?,?,?,?,?,?,?,?)",
                    params![actor_id, actor_email, time, key, old_value, new_value, old_override, new_override],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;

    let mut updated = (*app.config()).clone();
    apply_values(&mut updated, &next_values);
    updated.limit_overrides = next_overrides;
    let body = describe(&updated);
    app.replace_config(updated)?;
    Ok(Json(body))
}

fn page_integer(value: Option<&String>, max: i64) -> ApiResult<Option<i64>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    if raw.is_empty() || raw.starts_with('0') || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::INVALID_INPUT);
    }
    let parsed: i64 = raw.parse().map_err(|_| ApiError::INVALID_INPUT)?;
    if !(1..=max).contains(&parsed) {
        return Err(ApiError::INVALID_INPUT);
    }
    Ok(Some(parsed))
}

pub async fn audit_limits(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    admin_session(&context)?;
    let size = page_integer(query.get("limit"), 100)?.unwrap_or(50);
    let cursor = page_integer(query.get("cursor"), (1_i64 << 53) - 1)?;
    let entries = app
        .db
        .run(move |db| {
            let mut stmt = db.prepare(
                "SELECT id,actorId,actorEmail,createdAt,key,oldValue,newValue,oldOverride,newOverride FROM limit_audit WHERE id < ? ORDER BY id DESC LIMIT ?",
            )?;
            let rows = stmt
                .query_map(params![cursor.unwrap_or(i64::MAX), size + 1], |row| {
                    Ok(json!({
                        "id": row.get::<_, i64>(0)?,
                        "actorId": row.get::<_, String>(1)?,
                        "actorEmail": row.get::<_, String>(2)?,
                        "createdAt": row.get::<_, i64>(3)?,
                        "key": row.get::<_, String>(4)?,
                        "oldValue": row.get::<_, i64>(5)?,
                        "newValue": row.get::<_, i64>(6)?,
                        "oldOverride": row.get::<_, Option<i64>>(7)?,
                        "newOverride": row.get::<_, Option<i64>>(8)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await?;
    let more = entries.len() > size as usize;
    let slice: Vec<_> = entries.into_iter().take(size as usize).collect();
    let next_cursor = if more {
        slice.last().and_then(|entry| entry["id"].as_i64())
    } else {
        None
    };
    Ok(Json(json!({ "entries": slice, "nextCursor": next_cursor })))
}
