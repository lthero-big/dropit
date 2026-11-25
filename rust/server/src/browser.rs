//! Read-only browser bootstrap endpoints. OAuth flows and setup writes are later slices.
use axum::{Extension, Json, extract::State};
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::{Value, json};
use std::{env, path::Path, process::Command};

use crate::{ApiResult, App, RequestContext, db};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub(crate) version: String,
    pub(crate) commit: Option<String>,
    pub(crate) build_date: Option<String>,
    pub(crate) install: String,
}

pub async fn auth_providers(State(app): State<App>) -> ApiResult<Json<Value>> {
    app.db
        .run(|db| {
            let policy = db::setting(db, "registration")?.unwrap_or_default();
            let policy = match policy.as_str() {
                "closed" => "closed",
                "open" => "open",
                _ => "invite",
            };
            let mut payload = serde_json::Map::new();
            payload.insert("providers".into(), json!(providers(db)?));
            payload.insert("password".into(), json!(true));
            payload.insert("registration".into(), json!(policy));
            payload.insert("setupRequired".into(), json!(db::user_count(db)? == 0));
            if let Some(google_client_id) = active_google_client_id(db)? {
                payload.insert("googleClientId".into(), json!(google_client_id));
            }
            Ok(Json(Value::Object(payload)))
        })
        .await
}

fn active_google_client_id(db: &rusqlite::Connection) -> ApiResult<Option<String>> {
    let saved: Option<(String, bool)> = db
        .query_row(
            "SELECT clientId, enabled<>0 FROM oauth_apps WHERE provider='google'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((client_id, enabled)) = saved {
        return Ok((enabled && !client_id.is_empty()).then_some(client_id));
    }
    let client_id = env::var("GOOGLE_CLIENT_ID")
        .ok()
        .filter(|value| !value.is_empty());
    let client_secret = env::var("GOOGLE_CLIENT_SECRET")
        .ok()
        .filter(|value| !value.is_empty());
    Ok(match (client_id, client_secret) {
        (Some(id), Some(_)) => Some(id),
        _ => None,
    })
}

pub async fn setup(State(app): State<App>) -> ApiResult<Json<Value>> {
    app.db
        .run(|db| {
            Ok(Json(
                json!({ "required": db::user_count(db)? == 0, "providers": providers(db)? }),
            ))
        })
        .await
}

fn providers(db: &rusqlite::Connection) -> ApiResult<Vec<&'static str>> {
    let mut active = Vec::new();
    for provider in ["github", "google"] {
        let saved: Option<bool> = db
            .query_row(
                "SELECT enabled<>0 FROM oauth_apps WHERE provider=?",
                [provider],
                |row| row.get(0),
            )
            .optional()?;
        let env_enabled = ["CLIENT_ID", "CLIENT_SECRET"].iter().all(|suffix| {
            env::var(format!("{}_{suffix}", provider.to_ascii_uppercase()))
                .is_ok_and(|v| !v.is_empty())
        });
        if saved.unwrap_or(env_enabled) {
            active.push(provider);
        }
    }
    Ok(active)
}

pub async fn site(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> Json<Value> {
    let config = app.config();
    Json(
        json!({ "origin": config.origin.as_ref().map(|(origin, _)| origin),
        "source": config.origin.as_ref().map(|(_, source)| *source).unwrap_or("request"),
        "requestOrigin": context.request_origin }),
    )
}

pub async fn version(State(app): State<App>) -> Json<BuildInfo> {
    Json(app.build.clone())
}

pub fn build_info() -> BuildInfo {
    // A future Rust packaging step can place the same metadata next to the executable.
    let stored: Option<Value> = env::current_exe()
        .ok()
        .and_then(|exe| std::fs::read(exe.parent()?.join("build-info.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let value = |key: &str| {
        stored
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
    };
    let commit = env::var("DROPIT_COMMIT")
        .ok()
        .and_then(|v| normalize_commit(&v))
        .or_else(|| value("commit").and_then(normalize_commit))
        .or_else(|| {
            if stored.is_some() || env::var("NODE_ENV").is_ok_and(|v| v == "production") {
                return None;
            }
            Command::new("git")
                .args(["rev-parse", "--short=7", "HEAD"])
                .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")))
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| normalize_commit(&String::from_utf8_lossy(&o.stdout)))
        });
    let version = env::var("DROPIT_VERSION")
        .ok()
        .and_then(|v| normalize_version(&v))
        .or_else(|| value("version").and_then(normalize_version))
        .unwrap_or_else(|| "0.0.0".into());
    let date = |v: &str| {
        chrono::DateTime::parse_from_rfc3339(v.trim())
            .ok()
            .map(|d| {
                d.to_utc()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
    };
    let build_date = env::var("DROPIT_BUILD_DATE")
        .ok()
        .and_then(|v| date(&v))
        .or_else(|| value("buildDate").and_then(date));
    let install = env::var("DROPIT_INSTALL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| value("install").unwrap_or_default().into());
    let install = match install.trim() {
        "docker" | "docker-rust" => "docker",
        "docker-build" => "docker-build",
        _ => "source",
    }
    .into();
    BuildInfo {
        version,
        commit,
        build_date,
        install,
    }
}

fn normalize_commit(v: &str) -> Option<String> {
    let v = v.trim();
    ((7..=40).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| v[..7].to_ascii_lowercase())
}

fn normalize_version(v: &str) -> Option<String> {
    let v = v.trim().strip_prefix('v').unwrap_or(v.trim());
    let (core, suffix) = match v.find(['-', '+']) {
        Some(i) => (&v[..i], Some(&v[i + 1..])),
        None => (v, None),
    };
    if core.split('.').count() != 3
        || !core
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    if suffix.is_some_and(|s| {
        s.is_empty()
            || s.len() > 40
            || !s
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
    }) {
        return None;
    }
    Some(v.into())
}
