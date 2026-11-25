//! Browser authentication and account lifecycle.
//!
//! This module keeps the Rust service compatible with the schema-19 account
//! tables used by the TypeScript service. Credentials are never stored in
//! cookies or logs; only SHA-256 digests of session/OAuth flow values reach
//! SQLite.

use std::{
    collections::{HashMap, HashSet},
    env,
    time::Duration,
};

use axum::{
    Extension, Json,
    extract::{Path, Query, State, rejection::PathRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use reqwest::Client;
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde_json::{Value, json};
use url::Url;
use uuid::Uuid;

use crate::{
    ApiError, ApiResult, App, Auth, RequestContext, db, header_value, input_string, now, password,
    read_cookie, read_json, set_cookie,
};

const PASSWORD_MIN: usize = 8;
const PASSWORD_MAX: usize = 256;
const FLOW_MAX_AGE: i64 = 600;
const APP_OAUTH_REDIRECT: &str = "dropit://auth/callback";
const APP_TOKEN_MS: i64 = 365 * 86_400_000;
const SETUP_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TEMP_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";

#[derive(Clone)]
pub(crate) struct AppOAuthFlow {
    app_state: String,
    device_name: crate::js::JsString,
    link_user_id: Option<String>,
    link_token_id: Option<String>,
    expires_at: i64,
}

#[derive(Clone)]
pub(crate) struct AppOAuthCode {
    user_id: String,
    device_name: crate::js::JsString,
    expires_at: i64,
}

#[derive(Clone)]
pub(crate) struct AppLinkTicket {
    user_id: String,
    provider: String,
    token_id: Option<String>,
    expires_at: i64,
}

#[derive(Clone)]
struct OAuthApp {
    provider: String,
    client_id: String,
    client_secret: String,
    enabled: bool,
    source: &'static str,
    updated_at: Option<i64>,
    checked_at: Option<i64>,
    check_ok: Option<bool>,
    check_code: Option<String>,
}

#[derive(Clone)]
struct Identity {
    provider: String,
    subject: String,
    email: String,
    name: String,
}

fn random_token() -> ApiResult<String> {
    password::session_token()
}

pub fn setup_code() -> ApiResult<String> {
    let raw = random_token()?;
    let bytes = raw.as_bytes();
    let mut result = String::with_capacity(9);
    for (index, byte) in bytes.iter().take(8).enumerate() {
        if index == 4 {
            result.push('-');
        }
        result.push(SETUP_ALPHABET[usize::from(*byte) % SETUP_ALPHABET.len()] as char);
    }
    Ok(result)
}

fn temporary_password() -> ApiResult<String> {
    let raw = random_token()?;
    let bytes = raw.as_bytes();
    let mut result = String::with_capacity(14);
    for (index, byte) in bytes.iter().take(12).enumerate() {
        if index == 4 || index == 8 {
            result.push('-');
        }
        result.push(TEMP_ALPHABET[usize::from(*byte) % TEMP_ALPHABET.len()] as char);
    }
    Ok(result)
}

async fn hash_password(value: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || password::hash_password(&value))
        .await
        .map_err(ApiError::internal)?
}

async fn verify_password(value: String, stored: Option<String>) -> ApiResult<bool> {
    tokio::task::spawn_blocking(move || password::verify(&value, stored.as_deref()))
        .await
        .map_err(ApiError::internal)?
}

fn check_password(value: Option<&crate::js::Value>) -> ApiResult<String> {
    let value = crate::input_js_string(value, PASSWORD_MAX)?.utf8();
    if value.chars().count() < PASSWORD_MIN {
        return Err(ApiError::new(400, "PASSWORD_TOO_SHORT"));
    }
    Ok(value)
}

fn email(value: Option<&crate::js::Value>) -> ApiResult<String> {
    let value = input_string(value, 200)?.trim().to_lowercase();
    let valid = value.len() <= 200
        && value.split_once('@').is_some_and(|(local, host)| {
            !local.is_empty()
                && !host.is_empty()
                && host.contains('.')
                && host
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
                && local
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._%+-".contains(c))
        });
    valid.then_some(value).ok_or(ApiError::INVALID_INPUT)
}

fn person_name(value: Option<&crate::js::Value>) -> ApiResult<crate::js::JsString> {
    value
        .and_then(crate::js::Value::as_js_str)
        .ok_or(ApiError::INVALID_INPUT)?
        .clean_name()
}
fn name(value: Option<&crate::js::Value>, email: &str) -> ApiResult<crate::js::JsString> {
    match value {
        None | Some(crate::js::Value::Null) => {
            Ok(email.split('@').next().unwrap_or(email).to_owned().into())
        }
        Some(crate::js::Value::String(value)) if value.is_empty() => {
            Ok(email.split('@').next().unwrap_or(email).to_owned().into())
        }
        _ => person_name(value),
    }
}
fn user_response(user: &db::User, name: crate::js::JsString) -> ApiResult<crate::js::Value> {
    let mut response = crate::js::to_value(&json!({"user": user, "mustChangePassword": false}))?;
    response
        .as_object_mut()
        .unwrap()
        .get_mut("user")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .insert("name", crate::js::Value::String(name));
    Ok(response)
}

fn browser(context: &RequestContext) -> ApiResult<Auth> {
    let auth = context.require_auth()?.clone();
    if auth.bearer.is_some() {
        return Err(ApiError::new(403, "BROWSER_SESSION_REQUIRED"));
    }
    Ok(auth)
}

fn account(context: &RequestContext) -> ApiResult<Auth> {
    Ok(crate::account_session(context)?.clone())
}

fn admin(context: &RequestContext) -> ApiResult<Auth> {
    Ok(crate::admin_session(context)?.clone())
}

fn valid_app_state(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
}

fn optional_device_name(value: Option<&crate::js::Value>) -> ApiResult<crate::js::JsString> {
    match value {
        None | Some(crate::js::Value::Null) => Ok("dropit App".to_owned().into()),
        Some(crate::js::Value::String(text)) if text.is_empty() => {
            Ok("dropit App".to_owned().into())
        }
        _ => person_name(value),
    }
}

fn optional_device_name_str(value: Option<&str>) -> ApiResult<crate::js::JsString> {
    match value {
        None | Some("") => Ok("dropit App".to_owned().into()),
        Some(raw) => crate::js::JsString::from(raw.to_owned()).clean_name(),
    }
}

fn app_redirect_url(pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse(APP_OAUTH_REDIRECT).expect("valid app redirect");
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key, value);
        }
    }
    url.into()
}

fn app_scopes(role: &str) -> Vec<String> {
    if role == "admin" {
        vec![
            "read".into(),
            "write".into(),
            "account".into(),
            "admin".into(),
        ]
    } else {
        vec!["read".into(), "write".into(), "account".into()]
    }
}

fn app_token_response(
    raw: String,
    scopes: &[String],
    user: &db::User,
    must_change_password: bool,
) -> Value {
    json!({
        "access_token": raw,
        "token_type": "Bearer",
        "scope": scopes.join(" "),
        "expires_in": APP_TOKEN_MS / 1000,
        "user": {
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "role": user.role,
        },
        "mustChangePassword": must_change_password,
    })
}

fn origin(app: &crate::StateData, context: &RequestContext) -> String {
    crate::origin_for(app, context)
}

fn flow_cookie_name(secure: bool) -> &'static str {
    if secure {
        "__Secure-dropit_oauth"
    } else {
        "dropit_oauth"
    }
}

fn flow_cookie(secure: bool, raw: &str, max_age: i64) -> HeaderValue {
    let secure_attribute = if secure { "; Secure" } else { "" };
    format!(
        "{}={raw}; Max-Age={max_age}; Path=/api/auth; HttpOnly{secure_attribute}; SameSite=Lax",
        flow_cookie_name(secure)
    )
    .parse()
    .expect("valid OAuth cookie")
}

fn clear_flow_cookie(secure: bool) -> HeaderValue {
    flow_cookie(secure, "", 0)
}

fn redirect(location: String) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&location)
            .unwrap_or_else(|_| HeaderValue::from_static("/login?error=INTERNAL_ERROR")),
    );
    response
}

fn oauth_error(app: &crate::StateData, context: &RequestContext, code: &str) -> Response {
    redirect(format!("{}/login?error={code}", origin(app, context)))
}

fn retry_after_header(error: &ApiError) -> Option<&HeaderValue> {
    error
        .header
        .as_ref()
        .filter(|(name, _)| *name == header::RETRY_AFTER)
        .map(|(_, value)| value)
}

fn oauth_failure(
    app: &crate::StateData,
    context: &RequestContext,
    linking: bool,
    app_state: Option<&str>,
    code: &str,
    clear_flow: bool,
    retry_after: Option<&HeaderValue>,
) -> Response {
    let mut response = if let Some(state) = app_state {
        redirect(app_redirect_url(&[("error", code), ("state", state)]))
    } else if linking {
        redirect(format!(
            "{}/settings?link_error={code}#login-methods",
            origin(app, context)
        ))
    } else {
        oauth_error(app, context, code)
    };
    if clear_flow {
        response
            .headers_mut()
            .append(header::SET_COOKIE, clear_flow_cookie(context.secure_cookie));
    }
    if let Some(retry_after) = retry_after {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, retry_after.clone());
    }
    response
}

fn oauth_error_code(error: &ApiError) -> &'static str {
    match error.code {
        "OAUTH_STATE_INVALID"
        | "OAUTH_DENIED"
        | "OAUTH_PROVIDER_ERROR"
        | "INVITE_INVALID"
        | "INVITATION_REQUIRED"
        | "USER_DISABLED"
        | "VERIFIED_EMAIL_REQUIRED"
        | "ACCOUNT_EXISTS"
        | "IDENTITY_IN_USE"
        | "PROVIDER_ALREADY_LINKED"
        | "UNAUTHENTICATED"
        | "REGISTRATION_CLOSED"
        | "INVITE_NEEDS_ACCOUNT"
        | "RATE_LIMITED" => error.code,
        _ => "INTERNAL_ERROR",
    }
}

fn provider_supported(provider: &str) -> bool {
    matches!(provider, "github" | "google")
}

fn oauth_env(provider: &str, suffix: &str) -> Option<String> {
    env::var(format!("{}_{}", provider.to_ascii_uppercase(), suffix))
        .ok()
        .filter(|value| !value.is_empty())
}

async fn oauth_app(app: &App, provider: &str) -> ApiResult<Option<OAuthApp>> {
    if !provider_supported(provider) {
        return Ok(None);
    }
    let provider_name = provider.to_owned();
    let saved = app
        .db
        .run(move |db| {
            db.query_row(
                "SELECT clientId,clientSecret,enabled,updatedAt,checkedAt,checkOk,checkCode FROM oauth_apps WHERE provider=?",
                [&provider_name],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, bool>(2)?,
                        row.get(3)?, row.get(4)?, row.get::<_, Option<bool>>(5)?, row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(ApiError::from)
        })
        .await?;
    let (client_id, client_secret, enabled, updated_at, checked_at, check_ok, check_code, source) =
        if let Some((id, secret, enabled, updated_at, checked_at, check_ok, check_code)) = saved {
            (
                id, secret, enabled, updated_at, checked_at, check_ok, check_code, "database",
            )
        } else {
            let Some(id) = oauth_env(provider, "CLIENT_ID") else {
                return Ok(None);
            };
            let Some(secret) = oauth_env(provider, "CLIENT_SECRET") else {
                return Ok(None);
            };
            (id, secret, true, None, None, None, None, "env")
        };
    if !enabled {
        return Ok(Some(OAuthApp {
            provider: provider.into(),
            client_id,
            client_secret,
            enabled,
            source,
            updated_at,
            checked_at,
            check_ok,
            check_code,
        }));
    }
    Ok(Some(OAuthApp {
        provider: provider.into(),
        client_id,
        client_secret,
        enabled,
        source,
        updated_at,
        checked_at,
        check_ok,
        check_code,
    }))
}

fn oauth_urls(provider: &str) -> ApiResult<(String, String, String, String)> {
    let (authorize, token, profile, emails) = if provider == "github" {
        (
            oauth_env(provider, "AUTHORIZE_URL")
                .unwrap_or_else(|| "https://github.com/login/oauth/authorize".into()),
            oauth_env(provider, "TOKEN_URL")
                .unwrap_or_else(|| "https://github.com/login/oauth/access_token".into()),
            oauth_env(provider, "PROFILE_URL")
                .unwrap_or_else(|| "https://api.github.com/user".into()),
            oauth_env(provider, "EMAILS_URL")
                .unwrap_or_else(|| "https://api.github.com/user/emails".into()),
        )
    } else if provider == "google" {
        (
            oauth_env(provider, "AUTHORIZE_URL")
                .unwrap_or_else(|| "https://accounts.google.com/o/oauth2/v2/auth".into()),
            oauth_env(provider, "TOKEN_URL")
                .unwrap_or_else(|| "https://oauth2.googleapis.com/token".into()),
            oauth_env(provider, "PROFILE_URL")
                .unwrap_or_else(|| "https://openidconnect.googleapis.com/v1/userinfo".into()),
            String::new(),
        )
    } else {
        return Err(ApiError::new(404, "PROVIDER_UNSUPPORTED"));
    };
    Ok((authorize, token, profile, emails))
}

fn authorization_url(
    provider: &str,
    app: &OAuthApp,
    state: &str,
    verifier: &str,
    redirect_uri: &str,
) -> ApiResult<String> {
    let (authorize, _, _, _) = oauth_urls(provider)?;
    let mut url = Url::parse(&authorize).map_err(|_| ApiError::new(500, "OAUTH_PROVIDER_ERROR"))?;
    let challenge = password::hash(verifier);
    let scope = if provider == "github" {
        "read:user user:email"
    } else {
        "openid email profile"
    };
    url.query_pairs_mut().extend_pairs([
        ("client_id", app.client_id.as_str()),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("state", state),
        ("scope", scope),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ]);
    Ok(url.into())
}

async fn exchange(
    app: &OAuthApp,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> ApiResult<Identity> {
    let (_, token_url, profile_url, emails_url) = oauth_urls(&app.provider)?;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(ApiError::internal)?;
    let token = client
        .post(token_url)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", &app.client_id),
            ("client_secret", &app.client_secret),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(|_| ApiError::new(400, "OAUTH_PROVIDER_ERROR"))?;
    let status = token.status();
    let body: Value = token
        .json()
        .await
        .map_err(|_| ApiError::new(400, "OAUTH_PROVIDER_ERROR"))?;
    if !status.is_success() || body.get("access_token").and_then(Value::as_str).is_none() {
        return Err(ApiError::new(400, "OAUTH_PROVIDER_ERROR"));
    }
    let access = body
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    let profile_response = client
        .get(profile_url)
        .bearer_auth(&access)
        .header("User-Agent", "dropit")
        .send()
        .await
        .map_err(|_| ApiError::new(400, "OAUTH_PROVIDER_ERROR"))?;
    if !profile_response.status().is_success() {
        return Err(ApiError::new(400, "OAUTH_PROVIDER_ERROR"));
    }
    let profile: Value = profile_response
        .json()
        .await
        .map_err(|_| ApiError::new(400, "OAUTH_PROVIDER_ERROR"))?;
    let (subject, name) = if app.provider == "github" {
        let subject = profile
            .get("id")
            .map(Value::to_string)
            .filter(|v| !v.is_empty())
            .ok_or(ApiError::new(403, "VERIFIED_EMAIL_REQUIRED"))?;
        let subject = subject.trim_matches('"').to_owned();
        let name = profile
            .get("name")
            .or_else(|| profile.get("login"))
            .and_then(Value::as_str)
            .unwrap_or("User")
            .chars()
            .take(200)
            .collect();
        (subject, name)
    } else {
        let subject = profile
            .get("sub")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(403, "VERIFIED_EMAIL_REQUIRED"))?
            .to_owned();
        let name = profile
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("User")
            .chars()
            .take(200)
            .collect();
        (subject, name)
    };
    let email = if app.provider == "github" {
        let response = client
            .get(emails_url)
            .bearer_auth(&access)
            .header("User-Agent", "dropit")
            .send()
            .await
            .map_err(|_| ApiError::new(400, "OAUTH_PROVIDER_ERROR"))?;
        if !response.status().is_success() {
            return Err(ApiError::new(400, "OAUTH_PROVIDER_ERROR"));
        }
        let emails: Vec<Value> = response
            .json()
            .await
            .map_err(|_| ApiError::new(400, "OAUTH_PROVIDER_ERROR"))?;
        emails
            .iter()
            .find(|item| {
                item.get("primary").and_then(Value::as_bool) == Some(true)
                    && item.get("verified").and_then(Value::as_bool) == Some(true)
            })
            .and_then(|item| item.get("email"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else if profile.get("email_verified").and_then(Value::as_bool) == Some(true) {
        profile
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        None
    };
    let email = email
        .filter(|v| !v.is_empty())
        .ok_or(ApiError::new(403, "VERIFIED_EMAIL_REQUIRED"))?;
    Ok(Identity {
        provider: app.provider.clone(),
        subject,
        email: email.to_lowercase(),
        name,
    })
}

fn flow_cookie_from_request(context: &RequestContext, headers: &HeaderMap) -> Option<String> {
    read_cookie(headers, flow_cookie_name(context.secure_cookie))
}

pub async fn app_password_login(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    app.limit("auth", &context.ip, app.config().rate_auth)?;
    let body = read_json(request, 4096).await?;
    let email = body
        .get("email")
        .and_then(crate::js::Value::as_str)
        .unwrap_or_default()
        .trim_matches(crate::js_space)
        .to_lowercase();
    let password = crate::input_js_string(body.get("password"), PASSWORD_MAX)?.utf8();
    if email.is_empty() || email.encode_utf16().count() > 200 {
        return Err(ApiError::INVALID_INPUT);
    }
    let device_name = optional_device_name(body.get("deviceName"))?;
    app.limit(
        "auth:email",
        &password::hash(&email),
        app.config().rate_auth,
    )?;
    let invite = optional_invite(body.get("invite"))?;
    let email_to_find = email.clone();
    let account = app
        .db
        .run(move |db| db::password_account(db, &email_to_find))
        .await?;
    let stored = account
        .as_ref()
        .and_then(|account| account.password_hash.clone());
    let slot = app
        .password_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(ApiError::internal)?;
    let verified = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        password::verify(&password, stored.as_deref())
    })
    .await
    .map_err(ApiError::internal)??;
    let bad_credentials = || ApiError::new(401, "INVALID_CREDENTIALS");
    let account = account.filter(|_| verified).ok_or_else(bad_credentials)?;

    let raw_token = crate::machine::raw_token()?;
    let raw_for_db = raw_token.clone();
    let token_id = Uuid::new_v4().to_string();
    let (current, scopes) = app
        .db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = db::password_account(&tx, &email)?
                .filter(|current| {
                    current.user.id == account.user.id
                        && current.password_hash == account.password_hash
                })
                .ok_or_else(bad_credentials)?;
            if current.user.disabled != 0 {
                return Err(ApiError::new(403, "USER_DISABLED"));
            }
            let time = now();
            if let Some(invite) = invite {
                db::accept_invite(&tx, &invite, &current.user.id, time)?;
            }
            if current.user.pending != 0 {
                tx.execute("UPDATE users SET pending=0 WHERE id=?", [&current.user.id])?;
            }
            let scopes = app_scopes(&current.user.role);
            let record = crate::machine::AccessToken {
                id: token_id,
                user_id: current.user.id.clone(),
                name: device_name,
                scopes: scopes.clone(),
                created_at: time,
                last_used_at: None,
                expires_at: Some(time + APP_TOKEN_MS),
                revoked: 0,
            };
            crate::machine::create_token(&tx, &record, &raw_for_db)?;
            tx.commit()?;
            Ok((current, scopes))
        })
        .await?;
    Ok(Json(app_token_response(
        raw_token,
        &scopes,
        &current.user,
        current.must_change_password,
    )))
}

pub async fn app_oauth_exchange(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    app.limit("auth", &context.ip, app.config().rate_auth)?;
    let body = read_json(request, 2048).await?;
    let raw_code = input_string(body.get("code"), 128)?;
    let override_name = match body.get("deviceName") {
        None | Some(crate::js::Value::Null) => None,
        Some(crate::js::Value::String(text)) if text.is_empty() => None,
        other => Some(person_name(other)?),
    };
    let entry = if crate::is_bearer(raw_code) {
        let key = password::hash(raw_code);
        app.app_oauth_codes
            .lock()
            .map_err(ApiError::internal)?
            .remove(&key)
    } else {
        None
    };
    let Some(entry) = entry.filter(|entry| entry.expires_at > now()) else {
        return Err(ApiError::new(401, "OAUTH_CODE_INVALID"));
    };
    let device_name = override_name.unwrap_or(entry.device_name);
    let raw_token = crate::machine::raw_token()?;
    let raw_for_db = raw_token.clone();
    let token_id = Uuid::new_v4().to_string();
    let user_id = entry.user_id;
    let (account, scopes) = app
        .db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let account = tx
                .query_row("SELECT * FROM users WHERE id=?", [&user_id], db::account)
                .optional()?
                .ok_or(ApiError::new(401, "OAUTH_CODE_INVALID"))?;
            if account.user.pending != 0 {
                return Err(ApiError::new(401, "OAUTH_CODE_INVALID"));
            }
            if account.user.disabled != 0 {
                return Err(ApiError::new(403, "USER_DISABLED"));
            }
            let time = now();
            let scopes = app_scopes(&account.user.role);
            let record = crate::machine::AccessToken {
                id: token_id,
                user_id: account.user.id.clone(),
                name: device_name,
                scopes: scopes.clone(),
                created_at: time,
                last_used_at: None,
                expires_at: Some(time + APP_TOKEN_MS),
                revoked: 0,
            };
            crate::machine::create_token(&tx, &record, &raw_for_db)?;
            tx.commit()?;
            Ok((account, scopes))
        })
        .await?;
    Ok(Json(app_token_response(
        raw_token,
        &scopes,
        &account.user,
        account.must_change_password,
    )))
}

pub async fn app_oauth_link(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(provider): Path<String>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    let auth = account(&context)?;
    app.limit("identity", &context.ip, app.config().rate_auth)?;
    let Some(oauth) = oauth_app(&app, &provider).await? else {
        return Err(ApiError::new(404, "PROVIDER_UNAVAILABLE"));
    };
    if !oauth.enabled {
        return Err(ApiError::new(404, "PROVIDER_UNAVAILABLE"));
    }
    let body = if header_value(request.headers(), "content-type")
        .is_some_and(|value| value.starts_with("application/json"))
    {
        read_json(request, 2048).await?
    } else {
        crate::js::Object::new()
    };
    let requested_state = body.get("appState").or_else(|| body.get("app_state"));
    let app_state = match requested_state {
        None | Some(crate::js::Value::Null) => random_token()?,
        Some(crate::js::Value::String(text)) if text.is_empty() => random_token()?,
        Some(value) => {
            let text = value.as_str().ok_or(ApiError::INVALID_INPUT)?;
            if !valid_app_state(text) {
                return Err(ApiError::INVALID_INPUT);
            }
            text.to_owned()
        }
    };
    let raw = random_token()?;
    let time = now();
    {
        let mut tickets = app.app_link_tickets.lock().map_err(ApiError::internal)?;
        tickets.retain(|_, entry| entry.expires_at > time);
        if tickets.len() >= 10_000 {
            return Err(ApiError::new(429, "RATE_LIMITED"));
        }
        tickets.insert(
            password::hash(&raw),
            AppLinkTicket {
                user_id: auth.account.user.id.clone(),
                provider: provider.clone(),
                token_id: auth.bearer.as_ref().map(|bearer| bearer.id.clone()),
                expires_at: time + 60_000,
            },
        );
    }
    let mut path_url =
        Url::parse(&format!("http://local/api/auth/{provider}")).map_err(ApiError::internal)?;
    path_url.query_pairs_mut().extend_pairs([
        ("link_ticket", raw.as_str()),
        ("app_redirect", APP_OAUTH_REDIRECT),
        ("app_state", app_state.as_str()),
    ]);
    let path = format!(
        "{}?{}",
        path_url.path(),
        path_url.query().unwrap_or_default()
    );
    let url = format!("{}{path}", origin(&app, &context));
    Ok(Json(json!({
        "ticket": raw,
        "state": app_state,
        "path": path,
        "url": url,
        "expires_in": 60,
    })))
}

pub async fn oauth_start(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(provider): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    app.limit("auth", &context.ip, app.config().rate_auth)?;
    let Some(oauth) = oauth_app(&app, &provider).await? else {
        return Err(ApiError::new(404, "PROVIDER_UNAVAILABLE"));
    };
    if !oauth.enabled {
        return Err(ApiError::new(404, "PROVIDER_UNAVAILABLE"));
    }
    let app_redirect = query.get("app_redirect").map(String::as_str);
    let app_state = query.get("app_state").map(String::as_str);
    let raw_device_name = query.get("device_name").map(String::as_str);
    let link_ticket = query.get("link_ticket").map(String::as_str);
    let mut app_mode: Option<(String, crate::js::JsString, Option<String>)> = None;
    if let Some(target) = app_redirect {
        if target != APP_OAUTH_REDIRECT {
            return Err(ApiError::new(400, "INVALID_APP_REDIRECT"));
        }
        let Some(state) = app_state.filter(|value| valid_app_state(value)) else {
            return Err(ApiError::INVALID_INPUT);
        };
        app_mode = Some((
            state.to_owned(),
            optional_device_name_str(raw_device_name)?,
            None,
        ));
    } else if app_state.is_some() || raw_device_name.is_some() || link_ticket.is_some() {
        return Err(ApiError::INVALID_INPUT);
    }

    let link_user_id = if let Some(raw_ticket) = link_ticket {
        if query.contains_key("link") {
            return Err(ApiError::INVALID_INPUT);
        }
        let entry = if crate::is_bearer(raw_ticket) {
            let key = password::hash(raw_ticket);
            app.app_link_tickets
                .lock()
                .map_err(ApiError::internal)?
                .remove(&key)
        } else {
            None
        };
        let state_ref = app_mode.as_ref().expect("app mode set").0.clone();
        let Some(entry) =
            entry.filter(|entry| entry.expires_at > now() && entry.provider == provider)
        else {
            return Ok(redirect(app_redirect_url(&[
                ("error", "UNAUTHENTICATED"),
                ("state", &state_ref),
            ])));
        };
        let check_user_id = entry.user_id.clone();
        let check_token_id = entry.token_id.clone();
        let valid = app
            .db
            .run(move |db| {
                let user_ok: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=0 AND pending=0)",
                    [&check_user_id],
                    |row| row.get(0),
                )?;
                if !user_ok {
                    return Ok(false);
                }
                if let Some(token_id) = check_token_id.as_deref() {
                    return crate::machine::token_live(
                        db,
                        token_id,
                        &check_user_id,
                        now(),
                        "account",
                    );
                }
                Ok(true)
            })
            .await?;
        if !valid {
            return Ok(redirect(app_redirect_url(&[
                ("error", "UNAUTHENTICATED"),
                ("state", &state_ref),
            ])));
        }
        if let Some((_, _, ref mut link_token)) = app_mode {
            *link_token = entry.token_id;
        }
        Some(entry.user_id)
    } else if query.contains_key("link") {
        match browser(&context) {
            Ok(auth) => Some(auth.account.user.id.clone()),
            Err(_) => {
                if let Some((ref state, _, _)) = app_mode {
                    return Ok(redirect(app_redirect_url(&[
                        ("error", "UNAUTHENTICATED"),
                        ("state", state),
                    ])));
                }
                return Ok(oauth_error(&app, &context, "UNAUTHENTICATED"));
            }
        }
    } else {
        None
    };
    let raw_invite_hash = if link_user_id.is_none() {
        query
            .get("invite")
            .filter(|value| !value.is_empty())
            .map(|value| password::hash(value))
    } else {
        None
    };
    let invite_hash = if let Some(hash) = raw_invite_hash {
        let valid = app
            .db
            .run({
                let hash = hash.clone();
                move |db| invite(db, &hash, now()).map(|v| v.is_some())
            })
            .await?;
        let count = app.db.run(|db| Ok(db::user_count(&*db)?)).await?;
        if !valid && count > 0 {
            if let Some((ref state, _, _)) = app_mode {
                return Ok(redirect(app_redirect_url(&[
                    ("error", "INVITE_INVALID"),
                    ("state", state),
                ])));
            }
            return Ok(oauth_error(&app, &context, "INVITE_INVALID"));
        }
        valid.then_some(hash)
    } else {
        None
    };
    let state = random_token()?;
    let browser_token = random_token()?;
    let verifier = random_token()?;
    let state_hash = password::hash(&state);
    let browser_hash = password::hash(&browser_token);
    if let Some((app_state, device_name, link_token_id)) = app_mode {
        let time = now();
        let mut flows = app.app_oauth_flows.lock().map_err(ApiError::internal)?;
        flows.retain(|_, entry| entry.expires_at > time);
        if flows.len() >= 10_000 {
            return Err(ApiError::new(429, "RATE_LIMITED"));
        }
        flows.insert(
            state_hash.clone(),
            AppOAuthFlow {
                app_state,
                device_name,
                link_user_id: link_user_id.clone(),
                link_token_id,
                expires_at: time + FLOW_MAX_AGE * 1000,
            },
        );
    }
    let provider_name = provider.clone();
    let invite_hash_for_db = invite_hash.clone();
    let link_for_db = link_user_id.clone();
    let verifier_for_db = verifier.clone();
    app.db.run(move |db| {
        db.execute("INSERT INTO flows (stateHash,browserHash,provider,verifier,inviteHash,expiresAt,linkUserId) VALUES (?,?,?,?,?,?,?)",
            params![state_hash, browser_hash, provider_name, verifier_for_db, invite_hash_for_db, now()+FLOW_MAX_AGE*1000, link_for_db])?;
        Ok(())
    }).await?;
    let redirect_uri = format!("{}/api/auth/{provider}/callback", origin(&app, &context));
    let location = authorization_url(&provider, &oauth, &state, &verifier, &redirect_uri)?;
    let mut response = redirect(location);
    response.headers_mut().insert(
        header::SET_COOKIE,
        flow_cookie(context.secure_cookie, &browser_token, FLOW_MAX_AGE),
    );
    Ok(response)
}

pub async fn oauth_callback(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(provider): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    request: axum::extract::Request,
) -> ApiResult<Response> {
    if let Err(error) = app.limit("auth", &context.ip, app.config().rate_auth) {
        return Ok(oauth_failure(
            &app,
            &context,
            false,
            None,
            oauth_error_code(&error),
            false,
            retry_after_header(&error),
        ));
    }
    let flow_cookie = flow_cookie_from_request(&context, request.headers());
    let state = query
        .get("state")
        .filter(|value| !value.is_empty())
        .cloned();
    let oauth = match oauth_app(&app, &provider).await {
        Ok(Some(oauth)) if oauth.enabled => oauth,
        Ok(_) => {
            return Ok(oauth_failure(
                &app,
                &context,
                false,
                None,
                "OAUTH_STATE_INVALID",
                false,
                None,
            ));
        }
        Err(error) => {
            return Ok(oauth_failure(
                &app,
                &context,
                false,
                None,
                oauth_error_code(&error),
                false,
                retry_after_header(&error),
            ));
        }
    };
    let (Some(state), Some(browser_raw)) = (state, flow_cookie) else {
        return Ok(oauth_failure(
            &app,
            &context,
            false,
            None,
            "OAUTH_STATE_INVALID",
            false,
            None,
        ));
    };
    let state_hash = password::hash(&state);
    let state_hash_for_app = state_hash.clone();
    let browser_hash = password::hash(&browser_raw);
    let provider_for_db = provider.clone();
    let flow = match app.db.run(move |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let flow = tx.query_row("SELECT stateHash,browserHash,provider,verifier,inviteHash,expiresAt,linkUserId FROM flows WHERE stateHash=? AND browserHash=? AND provider=? AND expiresAt>?",
            params![state_hash, browser_hash, provider_for_db, now()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, i64>(5)?, row.get::<_, Option<String>>(6)?))).optional()?;
        if flow.is_some() { tx.execute("DELETE FROM flows WHERE stateHash=?", [state_hash])?; }
        tx.commit()?;
        Ok(flow)
    }).await {
        Ok(flow) => flow,
        Err(error) => {
            return Ok(oauth_failure(
                &app,
                &context,
                false,
                None,
                oauth_error_code(&error),
                false,
                retry_after_header(&error),
            ));
        }
    };
    let Some((_, _, _, verifier, invite_hash, _, link_user_id)) = flow else {
        return Ok(oauth_failure(
            &app,
            &context,
            false,
            None,
            "OAUTH_STATE_INVALID",
            false,
            None,
        ));
    };
    let app_flow = app
        .app_oauth_flows
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&state_hash_for_app));
    let app_state = app_flow.as_ref().map(|flow| flow.app_state.as_str());
    let linking = link_user_id.is_some();
    let has_error = query.get("error").is_some_and(|value| !value.is_empty());
    let Some(code) = query
        .get("code")
        .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 4096)
        .filter(|_| !has_error)
    else {
        return Ok(oauth_failure(
            &app,
            &context,
            linking,
            app_state,
            "OAUTH_DENIED",
            true,
            None,
        ));
    };
    let identity = match exchange(
        &oauth,
        code,
        &verifier,
        &format!("{}/api/auth/{provider}/callback", origin(&app, &context)),
    )
    .await
    {
        Ok(identity) => identity,
        Err(error) => {
            return Ok(oauth_failure(
                &app,
                &context,
                linking,
                app_state,
                oauth_error_code(&error),
                true,
                retry_after_header(&error),
            ));
        }
    };
    if identity.provider != provider {
        return Ok(oauth_failure(
            &app,
            &context,
            linking,
            app_state,
            "OAUTH_PROVIDER_ERROR",
            true,
            None,
        ));
    }
    let identity_key = password::hash(&format!("{provider}:{}", identity.subject));
    if let Err(error) = app.limit("auth:identity", &identity_key, app.config().rate_auth) {
        return Ok(oauth_failure(
            &app,
            &context,
            linking,
            app_state,
            oauth_error_code(&error),
            true,
            retry_after_header(&error),
        ));
    }
    if oauth.source == "database" {
        let provider_for_check = provider.clone();
        if let Err(error) = app
            .db
            .run(move |db| {
                db.execute(
                    "UPDATE oauth_apps SET checkedAt=?,checkOk=1,checkCode='LOGIN_OK' WHERE provider=?",
                    params![now(), provider_for_check],
                )?;
                Ok(())
            })
            .await
        {
            return Ok(oauth_failure(
                &app,
                &context,
                linking,
                app_state,
                oauth_error_code(&error),
                true,
                retry_after_header(&error),
            ));
        }
    }
    if let Some(user_id) = link_user_id {
        if let Some(ref flow_meta) = app_flow {
            if flow_meta.link_user_id.as_deref() != Some(user_id.as_str()) {
                return Ok(oauth_failure(
                    &app,
                    &context,
                    true,
                    Some(&flow_meta.app_state),
                    "UNAUTHENTICATED",
                    true,
                    None,
                ));
            }
            if let Some(token_id) = flow_meta.link_token_id.clone() {
                let check_user = user_id.clone();
                let live = app
                    .db
                    .run(move |db| {
                        crate::machine::token_live(db, &token_id, &check_user, now(), "account")
                    })
                    .await
                    .unwrap_or(false);
                if !live {
                    return Ok(oauth_failure(
                        &app,
                        &context,
                        true,
                        Some(&flow_meta.app_state),
                        "UNAUTHENTICATED",
                        true,
                        None,
                    ));
                }
            }
            let identity_for_db = identity.clone();
            let added = match app
                .db
                .run(move |db| link_identity(db, &user_id, &identity_for_db, now()))
                .await
            {
                Ok(result) => result,
                Err(error) => {
                    return Ok(oauth_failure(
                        &app,
                        &context,
                        true,
                        Some(&flow_meta.app_state),
                        oauth_error_code(&error),
                        true,
                        retry_after_header(&error),
                    ));
                }
            };
            let mut pairs = vec![
                ("linked", provider.as_str()),
                ("state", flow_meta.app_state.as_str()),
            ];
            if !added {
                pairs.push(("already", "1"));
            }
            let mut result = redirect(app_redirect_url(&pairs));
            result
                .headers_mut()
                .insert(header::SET_COOKIE, clear_flow_cookie(context.secure_cookie));
            return Ok(result);
        }
        let current = match browser(&context) {
            Ok(current) => current,
            Err(_) => {
                return Ok(oauth_failure(
                    &app,
                    &context,
                    true,
                    None,
                    "UNAUTHENTICATED",
                    true,
                    None,
                ));
            }
        };
        if current.account.user.id != user_id {
            return Ok(oauth_failure(
                &app,
                &context,
                true,
                None,
                "UNAUTHENTICATED",
                true,
                None,
            ));
        }
        let identity_for_db = identity.clone();
        let result = match app
            .db
            .run(move |db| link_identity(db, &user_id, &identity_for_db, now()))
            .await
        {
            Ok(result) => result,
            Err(error) => {
                return Ok(oauth_failure(
                    &app,
                    &context,
                    true,
                    None,
                    oauth_error_code(&error),
                    true,
                    retry_after_header(&error),
                ));
            }
        };
        let suffix = if result {
            String::new()
        } else {
            "&already=1".into()
        };
        let mut result = redirect(format!(
            "{}/settings?linked={}{}#login-methods",
            origin(&app, &context),
            provider,
            suffix
        ));
        result
            .headers_mut()
            .insert(header::SET_COOKIE, clear_flow_cookie(context.secure_cookie));
        return Ok(result);
    }
    let admin_emails = env::var("ADMIN_EMAILS")
        .unwrap_or_default()
        .split(',')
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    if let Some(flow_meta) = app_flow {
        let identity_for_db = identity.clone();
        let account = match app
            .db
            .run(move |db| {
                oauth_resolve_user(
                    db,
                    &identity_for_db,
                    invite_hash.as_deref(),
                    &admin_emails,
                    now(),
                )
            })
            .await
        {
            Ok(account) => account,
            Err(error) => {
                return Ok(oauth_failure(
                    &app,
                    &context,
                    false,
                    Some(&flow_meta.app_state),
                    oauth_error_code(&error),
                    true,
                    retry_after_header(&error),
                ));
            }
        };
        let exchange_code = match random_token() {
            Ok(code) => code,
            Err(error) => {
                return Ok(oauth_failure(
                    &app,
                    &context,
                    false,
                    Some(&flow_meta.app_state),
                    oauth_error_code(&error),
                    true,
                    retry_after_header(&error),
                ));
            }
        };
        let time = now();
        {
            let Ok(mut codes) = app.app_oauth_codes.lock() else {
                return Ok(oauth_failure(
                    &app,
                    &context,
                    false,
                    Some(&flow_meta.app_state),
                    "INTERNAL_ERROR",
                    true,
                    None,
                ));
            };
            codes.retain(|_, entry| entry.expires_at > time);
            if codes.len() >= 10_000 {
                return Ok(oauth_failure(
                    &app,
                    &context,
                    false,
                    Some(&flow_meta.app_state),
                    "RATE_LIMITED",
                    true,
                    None,
                ));
            }
            codes.insert(
                password::hash(&exchange_code),
                AppOAuthCode {
                    user_id: account.user.id,
                    device_name: flow_meta.device_name,
                    expires_at: time + 60_000,
                },
            );
        }
        let mut response = redirect(app_redirect_url(&[
            ("code", &exchange_code),
            ("state", &flow_meta.app_state),
        ]));
        response
            .headers_mut()
            .insert(header::SET_COOKIE, clear_flow_cookie(context.secure_cookie));
        return Ok(response);
    }
    let token = match random_token() {
        Ok(token) => token,
        Err(error) => {
            return Ok(oauth_failure(
                &app,
                &context,
                false,
                None,
                oauth_error_code(&error),
                true,
                retry_after_header(&error),
            ));
        }
    };
    let hash = password::hash(&token);
    let user_agent = header_value(request.headers(), "user-agent").map(str::to_owned);
    let ip = context.ip_summary.clone();
    let identity_for_db = identity.clone();
    let session_ms = app.config().session;
    let _account = match app
        .db
        .run(move |db| {
            oauth_login(
                db,
                &identity_for_db,
                invite_hash.as_deref(),
                &admin_emails,
                &hash,
                now() + session_ms,
                now(),
                user_agent.as_deref(),
                &ip,
            )
        })
        .await
    {
        Ok(account) => account,
        Err(error) => {
            return Ok(oauth_failure(
                &app,
                &context,
                false,
                None,
                oauth_error_code(&error),
                true,
                retry_after_header(&error),
            ));
        }
    };
    let mut response = redirect(format!("{}/", origin(&app, &context)));
    response
        .headers_mut()
        .insert(header::SET_COOKIE, clear_flow_cookie(context.secure_cookie));
    let session_cookie = set_cookie(context.secure_cookie, &token, session_ms / 1000);
    response.headers_mut().append(
        header::SET_COOKIE,
        session_cookie.get(header::SET_COOKIE).unwrap().clone(),
    );
    Ok(response)
}

pub async fn setup(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<impl IntoResponse> {
    app.limit("setup", &context.ip, app.config().rate_auth)?;
    let body = read_json(request, 4096).await?;
    let code = input_string(body.get("code"), 32)?
        .to_uppercase()
        .replace(['-', ' ', '\t', '\n', '\r'], "");
    let expected = app.setup_code.lock().map_err(ApiError::internal)?.clone();
    if !expected
        .as_deref()
        .map(|expected| expected.replace('-', "").eq_ignore_ascii_case(&code))
        .unwrap_or(false)
    {
        return Err(ApiError::new(403, "SETUP_CODE_INVALID"));
    }
    let email = email(body.get("email"))?;
    let password = check_password(body.get("password"))?;
    let name = name(body.get("name"), &email)?;
    let response_name = name.clone();
    let hash = hash_password(password).await?;
    let token = random_token()?;
    let session_hash = password::hash(&token);
    let session_expires = now() + app.config().session;
    let account = app
        .db
        .run(move |db| {
            create_password_user(
                db,
                &email,
                &name,
                &hash,
                now(),
                true,
                None,
                &session_hash,
                session_expires,
            )
        })
        .await?;
    *app.setup_code.lock().map_err(ApiError::internal)? = None;
    Ok((
        StatusCode::CREATED,
        set_cookie(context.secure_cookie, &token, app.config().session / 1000),
        Json(user_response(&account.user, response_name)?),
    ))
}

pub async fn register(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<impl IntoResponse> {
    app.limit("auth", &context.ip, app.config().rate_auth)?;
    let body = read_json(request, 4096).await?;
    if app.db.run(|db| Ok(db::user_count(&*db)?)).await? == 0 {
        return Err(ApiError::new(409, "SETUP_REQUIRED"));
    }
    let email = email(body.get("email"))?;
    let password = check_password(body.get("password"))?;
    let name = name(body.get("name"), &email)?;
    let response_name = name.clone();
    let invite_hash = optional_invite(body.get("invite"))?;
    let policy = registration_policy(&app).await?;
    if policy == "closed" {
        return Err(ApiError::new(403, "REGISTRATION_CLOSED"));
    }
    if policy == "invite" && invite_hash.is_none() {
        return Err(ApiError::new(403, "INVITATION_REQUIRED"));
    }
    let hash = hash_password(password).await?;
    let token = random_token()?;
    let session_hash = password::hash(&token);
    let session_expires = now() + app.config().session;
    let account = app
        .db
        .run(move |db| {
            create_password_user(
                db,
                &email,
                &name,
                &hash,
                now(),
                false,
                invite_hash.as_deref(),
                &session_hash,
                session_expires,
            )
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        set_cookie(context.secure_cookie, &token, app.config().session / 1000),
        Json(user_response(&account.user, response_name)?),
    ))
}

fn optional_invite(value: Option<&crate::js::Value>) -> ApiResult<Option<String>> {
    match value {
        None | Some(crate::js::Value::Null) => Ok(None),
        Some(crate::js::Value::String(value)) if value.is_empty() => Ok(None),
        Some(value) => Ok(Some(password::hash(
            &crate::input_js_string(Some(value), 128)?.utf8(),
        ))),
    }
}

async fn registration_policy(app: &App) -> ApiResult<String> {
    app.db
        .run(|db| {
            Ok(match db::setting(db, "registration")?.as_deref() {
                Some("closed") => "closed",
                Some("open") => "open",
                _ => "invite",
            }
            .into())
        })
        .await
}

type InviteRecord = (String, String, bool, bool, String);

fn invite(db: &Connection, hash: &str, time: i64) -> ApiResult<Option<InviteRecord>> {
    Ok(db.query_row("SELECT i.id,i.spaceId,i.joinSpace,(u.role='admin' AND u.disabled=0),coalesce(i.role,'editor') FROM invites i LEFT JOIN users u ON u.id=i.createdBy WHERE i.tokenHash=? AND i.revoked=0 AND i.uses<i.maxUses AND i.expiresAt>? AND (i.joinSpace=1 OR u.role='admin')",
        params![hash, time], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).optional()?)
}

fn spend_invite(
    db: &Connection,
    hash: &str,
    user_id: &str,
    time: i64,
    registration: bool,
) -> ApiResult<()> {
    let Some((id, space, join, creator_admin, role)) = invite(db, hash, time)? else {
        return Err(ApiError::new(403, "INVITE_INVALID"));
    };
    if registration && (!creator_admin || join) {
        return Err(ApiError::new(403, "INVITE_NEEDS_ACCOUNT"));
    }
    if !registration && !join {
        return Ok(());
    }
    if join
        && db.query_row(
            "SELECT EXISTS(SELECT 1 FROM members WHERE spaceId=? AND userId=?)",
            params![space, user_id],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Ok(());
    }
    if db.execute(
        "UPDATE invites SET uses=uses+1 WHERE id=? AND uses<maxUses AND revoked=0 AND expiresAt>?",
        params![id, time],
    )? != 1
    {
        return Err(ApiError::new(403, "INVITE_INVALID"));
    }
    if join {
        db.execute(
            "INSERT INTO members (spaceId,userId,role) VALUES (?,?,?)",
            params![space, user_id, role],
        )?;
    }
    Ok(())
}

fn create_private_space(db: &Connection, user_id: &str) -> ApiResult<()> {
    let id = Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO spaces (id,name,ownerId,expiresAt) VALUES (?,?,?,NULL)",
        params![id, "Private space", user_id],
    )?;
    db.execute(
        "INSERT INTO members (spaceId,userId) VALUES (?,?)",
        params![id, user_id],
    )?;
    Ok(())
}

pub fn bootstrap_admin(
    db: &mut Connection,
    email: &str,
    password_hash: &str,
    time: i64,
) -> ApiResult<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if tx.query_row("SELECT count(*) FROM users", [], |row| row.get::<_, i64>(0))? != 0 {
        tx.commit()?;
        return Ok(());
    }
    let id = Uuid::new_v4().to_string();
    let name = email
        .split('@')
        .next()
        .unwrap_or(email)
        .chars()
        .take(80)
        .collect::<String>();
    tx.execute("INSERT INTO users (id,email,name,role,disabled,createdAt,pending,quotaBytes,passwordHash,mustChangePassword,passwordUpdatedAt) VALUES (?,?,?,'admin',0,?,0,NULL,?,0,?)", params![id, email, name, time, password_hash, time])?;
    create_private_space(&tx, &id)?;
    tx.commit()?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn create_password_user(
    db: &mut Connection,
    email: &str,
    name: &crate::js::JsString,
    hash: &str,
    time: i64,
    first_admin: bool,
    invite_hash: Option<&str>,
    session_hash: &str,
    session_time: i64,
) -> ApiResult<db::Account> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if first_admin
        && tx.query_row("SELECT count(*) FROM users", [], |row| row.get::<_, i64>(0))? != 0
    {
        return Err(ApiError::new(409, "SETUP_DONE"));
    }
    if tx.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE lower(email)=lower(?) OR EXISTS(SELECT 1 FROM identities i WHERE i.userId=users.id AND lower(i.email)=lower(?)) )", params![email, email], |row| row.get::<_, bool>(0))? { return Err(ApiError::new(409, "EMAIL_IN_USE")); }
    let policy = db::setting(&tx, "registration")?.unwrap_or_else(|| "invite".into());
    if !first_admin {
        let invite_ok = invite_hash
            .map(|hash| invite(&tx, hash, time))
            .transpose()?
            .flatten();
        if invite_hash.is_some() && invite_ok.is_none() {
            return Err(ApiError::new(403, "INVITE_INVALID"));
        }
        if policy == "closed" {
            return Err(ApiError::new(403, "REGISTRATION_CLOSED"));
        }
        if policy == "invite" && invite_ok.is_none() {
            return Err(ApiError::new(403, "INVITATION_REQUIRED"));
        }
        if policy == "invite" && invite_ok.is_some_and(|(_, _, join, admin, _)| join || !admin) {
            return Err(ApiError::new(403, "INVITE_NEEDS_ACCOUNT"));
        }
    }
    let id = Uuid::new_v4().to_string();
    tx.execute("INSERT INTO users (id,email,name,role,disabled,createdAt,pending,quotaBytes,passwordHash,mustChangePassword,passwordUpdatedAt) VALUES (?,?,?, ?,0,?,0,NULL,?,0,?)",
        params![id, email, name, if first_admin { "admin" } else { "user" }, time, hash, time])?;
    create_private_space(&tx, &id)?;
    if let Some(invite_hash) = invite_hash {
        spend_invite(&tx, invite_hash, &id, time, true)?;
    }
    tx.execute("INSERT INTO sessions (sessionHash,userId,expiresAt,id,createdAt,lastSeenAt) VALUES (?,?,?, ?,?,?)", params![session_hash, id, session_time, Uuid::new_v4().to_string(), time, time])?;
    let account = tx.query_row("SELECT * FROM users WHERE id=?", [&id], db::account)?;
    tx.commit()?;
    Ok(account)
}

fn resolve_oauth_user_in_tx(
    tx: &rusqlite::Transaction<'_>,
    identity: &Identity,
    invite_hash: Option<&str>,
    admins: &[String],
    time: i64,
) -> ApiResult<db::Account> {
    let mut user_id: Option<String> = tx
        .query_row(
            "SELECT userId FROM identities WHERE provider=? AND subject=?",
            params![identity.provider, identity.subject],
            |row| row.get(0),
        )
        .optional()?;
    let mut created = false;
    if let Some(id) = user_id.as_deref() {
        if tx.query_row("SELECT disabled FROM users WHERE id=?", [id], |row| {
            row.get::<_, bool>(0)
        })? {
            return Err(ApiError::new(403, "USER_DISABLED"));
        }
        tx.execute(
            "UPDATE identities SET email=? WHERE provider=? AND subject=?",
            params![identity.email, identity.provider, identity.subject],
        )?;
    }
    if user_id.is_none() {
        let pending = tx
            .query_row(
                "SELECT id,disabled FROM users WHERE pending=1 AND lower(email)=lower(?)",
                [&identity.email],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        if let Some((id, disabled)) = pending {
            if disabled {
                return Err(ApiError::new(403, "USER_DISABLED"));
            }
            user_id = Some(id.clone());
            tx.execute("UPDATE users SET pending=0 WHERE id=?", [&id])?;
            tx.execute("INSERT INTO identities (provider,subject,userId,email,linkedAt) VALUES (?,?,?,?,?)", params![identity.provider, identity.subject, id, identity.email, time])?;
        }
    }
    let first = tx.query_row("SELECT count(*) FROM users", [], |row| row.get::<_, i64>(0))? == 0;
    let invite_row = invite_hash
        .map(|hash| invite(tx, hash, time))
        .transpose()?
        .flatten();
    if invite_hash.is_some() && invite_row.is_none() && !first {
        return Err(ApiError::new(403, "INVITE_INVALID"));
    }
    if user_id.is_none() {
        let existing: Option<bool> = tx.query_row("SELECT disabled FROM users WHERE pending=0 AND (lower(email)=lower(?) OR EXISTS(SELECT 1 FROM identities WHERE identities.userId=users.id AND lower(identities.email)=lower(?))) LIMIT 1", params![identity.email, identity.email], |row| row.get(0)).optional()?;
        if existing.is_some() {
            return Err(if existing == Some(true) {
                ApiError::new(403, "USER_DISABLED")
            } else {
                ApiError::new(409, "ACCOUNT_EXISTS")
            });
        }
        let listed = admins.iter().any(|email| email == &identity.email);
        let policy = db::setting(tx, "registration")?.unwrap_or_else(|| "invite".into());
        if !first && !listed && policy == "closed" {
            return Err(ApiError::new(403, "REGISTRATION_CLOSED"));
        }
        if !first && !listed && policy != "open" && invite_row.is_none() {
            return Err(ApiError::new(403, "INVITATION_REQUIRED"));
        }
        if !first
            && !listed
            && policy != "open"
            && invite_row
                .as_ref()
                .is_some_and(|(_, _, join, admin, _)| *join || !*admin)
        {
            return Err(ApiError::new(403, "INVITE_NEEDS_ACCOUNT"));
        }
        let id = Uuid::new_v4().to_string();
        tx.execute("INSERT INTO users (id,email,name,role,disabled,createdAt,pending,quotaBytes) VALUES (?,?,?, ?,0,?,0,NULL)", params![id, identity.email, identity.name, if first || listed { "admin" } else { "user" }, time])?;
        tx.execute(
            "INSERT INTO identities (provider,subject,userId,email,linkedAt) VALUES (?,?,?,?,?)",
            params![
                identity.provider,
                identity.subject,
                id,
                identity.email,
                time
            ],
        )?;
        create_private_space(tx, &id)?;
        user_id = Some(id);
        created = true;
    }
    if let Some(hash) = invite_hash
        && invite_row.is_some()
    {
        spend_invite(tx, hash, user_id.as_deref().unwrap(), time, created)?;
    }
    Ok(tx.query_row(
        "SELECT * FROM users WHERE id=?",
        [user_id.as_deref().unwrap()],
        db::account,
    )?)
}

fn oauth_resolve_user(
    db: &mut Connection,
    identity: &Identity,
    invite_hash: Option<&str>,
    admins: &[String],
    time: i64,
) -> ApiResult<db::Account> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let account = resolve_oauth_user_in_tx(&tx, identity, invite_hash, admins, time)?;
    tx.commit()?;
    Ok(account)
}

#[allow(clippy::too_many_arguments)]
fn oauth_login(
    db: &mut Connection,
    identity: &Identity,
    invite_hash: Option<&str>,
    admins: &[String],
    session_hash: &str,
    expires: i64,
    time: i64,
    user_agent: Option<&str>,
    ip: &str,
) -> ApiResult<db::Account> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let account = resolve_oauth_user_in_tx(&tx, identity, invite_hash, admins, time)?;
    tx.execute("INSERT INTO sessions (sessionHash,userId,expiresAt,id,createdAt,lastSeenAt,userAgent,ipSummary) VALUES (?,?,?, ?,?,?,?,?)", params![session_hash, account.user.id, expires, Uuid::new_v4().to_string(), time, time, user_agent, ip])?;
    tx.commit()?;
    Ok(account)
}

fn linked_identities(db: &Connection, user_id: &str) -> ApiResult<Vec<Value>> {
    let mut stmt = db.prepare("SELECT provider,email,linkedAt FROM identities WHERE userId=? ORDER BY linkedAt IS NULL,linkedAt,provider")?;
    Ok(stmt.query_map([user_id], |row| Ok(json!({"provider": row.get::<_, String>(0)?, "email": row.get::<_, Option<String>>(1)?, "linkedAt": row.get::<_, Option<i64>>(2)?})))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn link_identity(
    db: &mut Connection,
    user_id: &str,
    identity: &Identity,
    time: i64,
) -> ApiResult<bool> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let owner: Option<String> = tx
        .query_row(
            "SELECT userId FROM identities WHERE provider=? AND subject=?",
            params![identity.provider, identity.subject],
            |row| row.get(0),
        )
        .optional()?;
    if owner.as_deref() == Some(user_id) {
        tx.execute(
            "UPDATE identities SET email=? WHERE provider=? AND subject=?",
            params![identity.email, identity.provider, identity.subject],
        )?;
        tx.commit()?;
        return Ok(false);
    }
    if owner.is_some() {
        return Err(ApiError::new(409, "IDENTITY_IN_USE"));
    }
    let disabled: bool = tx
        .query_row("SELECT disabled FROM users WHERE id=?", [user_id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or(ApiError::UNAUTHENTICATED)?;
    if disabled {
        return Err(ApiError::new(403, "USER_DISABLED"));
    }
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM identities WHERE userId=? AND provider=?)",
        params![user_id, identity.provider],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(ApiError::new(409, "PROVIDER_ALREADY_LINKED"));
    }
    tx.execute(
        "INSERT INTO identities (provider,subject,userId,email,linkedAt) VALUES (?,?,?,?,?)",
        params![
            identity.provider,
            identity.subject,
            user_id,
            identity.email,
            time
        ],
    )?;
    tx.commit()?;
    Ok(true)
}

pub async fn change_password(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    let auth = account(&context)?;
    app.limit("password", &context.ip, app.config().rate_auth)?;
    let body = read_json(request, 4096).await?;
    let next = check_password(body.get("newPassword"))?;
    let id = auth.account.user.id.clone();
    let state = app
        .db
        .run(move |db| {
            db.query_row("SELECT passwordHash FROM users WHERE id=?", [&id], |row| {
                row.get::<_, Option<String>>(0)
            })
            .optional()
            .map_err(ApiError::from)
        })
        .await?;
    let Some(stored) = state else {
        return Err(ApiError::UNAUTHENTICATED);
    };
    if let Some(stored) = stored.clone() {
        let current = body
            .get("currentPassword")
            .and_then(crate::js::Value::as_js_str)
            .map(crate::js::JsString::utf8)
            .unwrap_or_default();
        if !verify_password(current.clone(), Some(stored)).await? {
            return Err(ApiError::new(400, "CURRENT_PASSWORD_INVALID"));
        }
        if current == next {
            return Err(ApiError::new(400, "PASSWORD_UNCHANGED"));
        }
    }
    let hash = hash_password(next).await?;
    let keep = auth.session_hash.clone();
    let id = auth.account.user.id.clone();
    let revoked = app.db.run(move |db| { let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?; tx.execute("UPDATE users SET passwordHash=?,mustChangePassword=0,passwordUpdatedAt=? WHERE id=?", params![hash, now(), id])?; let n = tx.execute("DELETE FROM sessions WHERE userId=? AND sessionHash<>?", params![id, keep])?; tx.commit()?; Ok(n) }).await?;
    Ok(Json(
        json!({"hasPassword":true,"mustChangePassword":false,"revokedSessions":revoked}),
    ))
}

pub async fn identities(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let auth = account(&context)?;
    let id = auth.account.user.id.clone();
    let values = app.db.run(move |db| linked_identities(db, &id)).await?;
    let mut available = Vec::new();
    for provider in ["github", "google"] {
        if oauth_app(&app, provider)
            .await?
            .is_some_and(|app| app.enabled)
        {
            available.push(provider);
        }
    }
    Ok(Json(json!({"identities": values, "available": available})))
}

pub async fn unlink_identity(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(provider): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let auth = account(&context)?;
    app.limit("identity", &context.ip, app.config().rate_auth)?;
    let id = auth.account.user.id.clone();
    app.db
        .run(move |db| {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM identities WHERE userId=? AND provider=?)",
                params![id, provider],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(ApiError::NOT_FOUND);
            }
            let has_password: bool = tx.query_row(
                "SELECT passwordHash IS NOT NULL FROM users WHERE id=?",
                [&id],
                |row| row.get(0),
            )?;
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM identities WHERE userId=?",
                [&id],
                |row| row.get(0),
            )?;
            if count <= 1 && !has_password {
                return Err(ApiError::new(409, "LAST_IDENTITY"));
            }
            tx.execute(
                "DELETE FROM identities WHERE userId=? AND provider=?",
                params![id, provider],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn secret_hint(secret: &str) -> Option<String> {
    if secret.is_empty() {
        return None;
    }
    let suffix: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    Some(if secret.chars().count() >= 16 {
        format!("••••••••{suffix}")
    } else {
        "••••••••".into()
    })
}

fn view_oauth(app: &crate::StateData, rows: Vec<OAuthApp>, context: &RequestContext) -> Value {
    let origin = origin(app, context);
    Value::Array(rows.into_iter().map(|app| json!({
        "provider": app.provider,
        "label": if app.provider == "github" { "GitHub" } else { "Google" },
        "consoleUrl": if app.provider == "github" { "https://github.com/settings/developers" } else { "https://console.cloud.google.com/apis/credentials" },
        "docsUrl": if app.provider == "github" { "https://docs.github.com/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app" } else { "https://developers.google.com/identity/protocols/oauth2/web-server" },
        "callbackUrl": format!("{origin}/api/auth/{}/callback", app.provider),
        "homepageUrl": origin,
        "source": app.source,
        "enabled": app.enabled,
        "active": app.enabled && !app.client_id.is_empty() && !app.client_secret.is_empty(),
        "clientId": app.client_id,
        "secretSet": !app.client_secret.is_empty(),
        "secretHint": secret_hint(&app.client_secret),
        "envConfigured": oauth_env(&app.provider, "CLIENT_ID").is_some() && oauth_env(&app.provider, "CLIENT_SECRET").is_some(),
        "updatedAt": app.updated_at,
        "check": app.checked_at.map(|at| json!({"at": at, "ok": app.check_ok, "code": app.check_code})),
    })).collect())
}

async fn all_oauth(app: &App) -> ApiResult<Vec<OAuthApp>> {
    let mut rows = Vec::new();
    for provider in ["github", "google"] {
        rows.push(oauth_app(app, provider).await?.unwrap_or(OAuthApp {
            provider: provider.into(),
            client_id: String::new(),
            client_secret: String::new(),
            enabled: false,
            source: "none",
            updated_at: None,
            checked_at: None,
            check_ok: None,
            check_code: None,
        }));
    }
    Ok(rows)
}

pub async fn admin_oauth(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    admin(&context)?;
    Ok(Json(
        json!({"origin": origin(&app, &context), "providers": view_oauth(&app, all_oauth(&app).await?, &context)}),
    ))
}

pub async fn save_oauth(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(provider): Path<String>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    let auth = admin(&context)?;
    if !provider_supported(&provider) {
        return Err(ApiError::new(404, "PROVIDER_UNSUPPORTED"));
    }
    let body = read_json(request, 4096).await?;
    let client_id = input_string(body.get("clientId"), 256)?.trim().to_owned();
    if client_id.is_empty()
        || !client_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
    {
        return Err(ApiError::new(400, "INVALID_CLIENT_ID"));
    }
    let secret = body
        .get("clientSecret")
        .and_then(crate::js::Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    if secret
        .as_deref()
        .is_some_and(|value| value.chars().any(char::is_whitespace))
    {
        return Err(ApiError::INVALID_INPUT);
    }
    let enabled = match body.get("enabled") {
        None => true,
        Some(crate::js::Value::Bool(value)) => *value,
        Some(_) => return Err(ApiError::INVALID_INPUT),
    };
    let actor = auth.account.user.email.clone();
    app.db.run(move |db| {
        let existing: Option<String> = db.query_row("SELECT clientSecret FROM oauth_apps WHERE provider=?", [&provider], |row| row.get(0)).optional()?;
        let secret = secret.or(existing).or_else(|| oauth_env(&provider, "CLIENT_SECRET")).ok_or(ApiError::new(400, "OAUTH_SECRET_REQUIRED"))?;
        db.execute("INSERT INTO oauth_apps (provider,clientId,clientSecret,enabled,updatedAt,updatedBy,checkedAt,checkOk,checkCode) VALUES (?,?,?,?,?,?,NULL,NULL,NULL) ON CONFLICT(provider) DO UPDATE SET clientId=excluded.clientId,clientSecret=excluded.clientSecret,enabled=excluded.enabled,updatedAt=excluded.updatedAt,updatedBy=excluded.updatedBy", params![provider, client_id, secret, enabled, now(), actor])?;
        Ok(())
    }).await?;
    Ok(Json(
        json!({"origin": origin(&app, &context), "providers": view_oauth(&app, all_oauth(&app).await?, &context)}),
    ))
}

pub async fn delete_oauth(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(provider): Path<String>,
) -> ApiResult<Json<Value>> {
    admin(&context)?;
    if !provider_supported(&provider) {
        return Err(ApiError::new(404, "PROVIDER_UNSUPPORTED"));
    }
    app.db
        .run(move |db| {
            db.execute("DELETE FROM oauth_apps WHERE provider=?", [&provider])?;
            Ok(())
        })
        .await?;
    Ok(Json(
        json!({"origin": origin(&app, &context), "providers": view_oauth(&app, all_oauth(&app).await?, &context)}),
    ))
}

pub async fn verify_oauth(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(provider): Path<String>,
) -> ApiResult<Json<Value>> {
    admin(&context)?;
    let Some(oauth) = oauth_app(&app, &provider).await? else {
        return Err(ApiError::new(400, "PROVIDER_UNAVAILABLE"));
    };
    let (_, token_url, _, _) = oauth_urls(&provider)?;
    let code = match Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(ApiError::internal)?
        .post(token_url)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", &oauth.client_id),
            ("client_secret", &oauth.client_secret),
            ("code", "dropit-credential-check"),
            (
                "code_verifier",
                "dropit-credential-check-verifier-0000000000000",
            ),
            (
                "redirect_uri",
                &format!("{}/api/auth/{provider}/callback", origin(&app, &context)),
            ),
        ])
        .send()
        .await
    {
        Ok(response) => {
            let body: Value = response.json().await.unwrap_or_default();
            match body.get("error").and_then(Value::as_str) {
                Some("invalid_grant") | Some("bad_verification_code") => (true, "CREDENTIALS_OK"),
                Some("redirect_uri_mismatch") => (false, "REDIRECT_MISMATCH"),
                Some("invalid_request") if provider == "google" => (false, "REDIRECT_NOT_ALLOWED"),
                Some("incorrect_client_credentials")
                | Some("invalid_client")
                | Some("unauthorized_client") => (false, "INVALID_CLIENT"),
                Some(_) => (false, "UNEXPECTED_RESPONSE"),
                None => (false, "UNEXPECTED_RESPONSE"),
            }
        }
        Err(_) => (false, "PROVIDER_UNREACHABLE"),
    };
    let code_string = code.1.to_owned();
    app.db
        .run(move |db| {
            db.execute(
                "UPDATE oauth_apps SET checkedAt=?,checkOk=?,checkCode=? WHERE provider=?",
                params![now(), code.0, code_string, provider],
            )?;
            Ok(())
        })
        .await?;
    Ok(Json(
        json!({"ok": code.0, "code": code.1, "checkedAt": now(), "source": oauth.source, "origin": origin(&app, &context), "providers": view_oauth(&app, all_oauth(&app).await?, &context)}),
    ))
}

fn describe_agent(user_agent: Option<&str>) -> (&'static str, &'static str) {
    let user_agent = user_agent.unwrap_or_default();
    let browser = if user_agent.contains("Firefox") {
        "Firefox"
    } else if user_agent.contains("Chrome") {
        "Chrome"
    } else if user_agent.contains("Safari") {
        "Safari"
    } else if user_agent.contains("curl") {
        "curl"
    } else {
        "Unknown"
    };
    let os = if user_agent.contains("Android") {
        "Android"
    } else if user_agent.contains("iPhone") || user_agent.contains("iPad") {
        "iOS"
    } else if user_agent.contains("Windows") {
        "Windows"
    } else if user_agent.contains("Mac OS") {
        "macOS"
    } else if user_agent.contains("Linux") {
        "Linux"
    } else {
        "Unknown"
    };
    (browser, os)
}

fn session_value(row: &Row<'_>, current: Option<&str>, online: bool) -> rusqlite::Result<Value> {
    let id: String = row.get("id")?;
    let session_hash: String = row.get("sessionHash")?;
    let device_id: Option<String> = row.get("deviceId")?;
    let device_name: Option<String> = db::optional_text(row, "deviceName")?;
    let device_kind: Option<String> = row.get("deviceKind")?;
    let device = device_id.map(|id| json!({"id": id, "name": device_name.unwrap_or_else(|| "未命名设备".into()), "kind": device_kind.unwrap_or_else(|| "pc".into())}));
    let (browser, os) = describe_agent(row.get::<_, Option<String>>("userAgent")?.as_deref());
    Ok(
        json!({"id": id, "current": current == Some(id.as_str()), "online": online && !session_hash.is_empty(), "createdAt": row.get::<_, Option<i64>>("createdAt")?, "lastSeenAt": row.get::<_, Option<i64>>("lastSeenAt")?, "expiresAt": row.get::<_, i64>("expiresAt")?, "ipSummary": row.get::<_, Option<String>>("ipSummary")?, "browser": browser, "os": os, "device": device}),
    )
}

async fn list_sessions(
    app: &App,
    user_id: String,
    current: Option<String>,
) -> ApiResult<Vec<Value>> {
    let online: HashSet<String> = app.realtime.online_sessions(&user_id);
    app.db.run(move |db| { let mut stmt = db.prepare("SELECT id,sessionHash,createdAt,lastSeenAt,expiresAt,ipSummary,userAgent,deviceId,deviceName,deviceKind FROM sessions WHERE userId=? AND expiresAt>? ORDER BY coalesce(lastSeenAt,createdAt,0) DESC,id")?; Ok(stmt.query_map(params![user_id, now()], |row| { let session_hash: String = row.get("sessionHash")?; session_value(row, current.as_deref(), online.contains(&session_hash)) })?.collect::<rusqlite::Result<Vec<_>>>()?) }).await
}

pub async fn sessions(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let auth = account(&context)?;
    Ok(Json(
        json!({"sessions": list_sessions(&app, auth.account.user.id.clone(), auth_session_id(&app, &auth).await?).await?}),
    ))
}

async fn auth_session_id(app: &App, auth: &Auth) -> ApiResult<Option<String>> {
    if auth.session_hash.is_empty() {
        return Ok(None);
    }
    let hash = auth.session_hash.clone();
    app.db
        .run(move |db| {
            db.query_row(
                "SELECT id FROM sessions WHERE sessionHash=?",
                [hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(ApiError::from)
        })
        .await
}

pub async fn revoke_session(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    path: Result<Path<String>, PathRejection>,
) -> ApiResult<impl IntoResponse> {
    let auth = account(&context)?;
    let Path(id) = path.map_err(|_| ApiError::NOT_FOUND)?;
    let user_id = auth.account.user.id.clone();
    let removed = app
        .db
        .run(move |db| {
            let hash: String = db
                .query_row(
                    "SELECT sessionHash FROM sessions WHERE id=? AND userId=?",
                    params![id, user_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(ApiError::NOT_FOUND)?;
            db.execute("DELETE FROM sessions WHERE sessionHash=?", [hash.clone()])?;
            Ok(hash)
        })
        .await?;
    if !auth.session_hash.is_empty() && removed == auth.session_hash {
        Ok((
            StatusCode::NO_CONTENT,
            set_cookie(context.secure_cookie, "", 0),
        ))
    } else {
        Ok((StatusCode::NO_CONTENT, HeaderMap::new()))
    }
}

pub async fn revoke_other_sessions(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let auth = account(&context)?;
    let id = auth.account.user.id.clone();
    let keep = auth.session_hash.clone();
    let revoked = app
        .db
        .run(move |db| {
            Ok(db.execute(
                "DELETE FROM sessions WHERE userId=? AND sessionHash<>?",
                params![id, keep],
            )?)
        })
        .await?;
    Ok(Json(json!({"revoked":revoked})))
}

pub async fn admin_user_sessions(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    admin(&context)?;
    let exists = app
        .db
        .run({
            let user_id = user_id.clone();
            move |db| {
                db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE id=?)",
                    [&user_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(ApiError::from)
            }
        })
        .await?;
    if !exists {
        return Err(ApiError::NOT_FOUND);
    }
    Ok(Json(
        json!({"sessions": list_sessions(&app, user_id, None).await?}),
    ))
}

pub async fn admin_revoke_session(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    admin(&context)?;
    app.db
        .run(move |db| {
            if db.execute("DELETE FROM sessions WHERE id=?", [id])? == 0 {
                return Err(ApiError::NOT_FOUND);
            }
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn user_view(row: &Row<'_>, quota: i64) -> rusqlite::Result<Value> {
    let providers: Option<String> = row.get("providers")?;
    Ok(json!({
        "id": row.get::<_, String>("id")?, "email": row.get::<_, String>("email")?, "name": db::text(row, "name")?,
        "role": row.get::<_, String>("role")?, "disabled": row.get::<_, i64>("disabled")?,
        "pending": row.get::<_, i64>("pending")?, "createdAt": row.get::<_, i64>("createdAt")?,
        "usedBytes": row.get::<_, i64>("usedBytes")?, "quotaBytes": row.get::<_, Option<i64>>("quotaBytes")?.unwrap_or(quota),
        "quotaOverride": row.get::<_, Option<i64>>("quotaBytes")?, "hasPassword": row.get::<_, i64>("hasPassword")? != 0,
        "mustChangePassword": row.get::<_, i64>("mustChangePassword")? != 0,
        "inviteLimit": row.get::<_, Option<i64>>("inviteLimit")?,
        "providers": providers.unwrap_or_default().split(',').filter(|v| !v.is_empty()).collect::<Vec<_>>(),
    }))
}

pub async fn admin_users(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    admin(&context)?;
    let quota = app.config().quota;
    let users = app.db.run(move |db| {
        let mut stmt = db.prepare("SELECT u.id,u.email,u.name,u.role,u.disabled,u.pending,u.createdAt,u.quotaBytes,u.inviteLimit,coalesce((SELECT sum(storedBytes) FROM items WHERE userId=u.id),0) AS usedBytes,(u.passwordHash IS NOT NULL) AS hasPassword,u.mustChangePassword,(SELECT group_concat(provider) FROM identities WHERE userId=u.id) AS providers FROM users u ORDER BY createdAt")?;
        Ok(stmt.query_map([], |row| user_view(row, quota))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await?;
    Ok(Json(json!({"users": users})))
}

pub async fn reset_password(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let auth = admin(&context)?;
    app.limit("password-reset", &context.ip, app.config().rate_auth)?;
    let temporary = temporary_password()?;
    let hash = hash_password(temporary.clone()).await?;
    let self_reset = id == auth.account.user.id;
    app.db.run(move |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute("UPDATE users SET passwordHash=?,mustChangePassword=1,passwordUpdatedAt=? WHERE id=?", params![hash, now(), id])? == 0 { return Err(ApiError::NOT_FOUND); }
        if self_reset { tx.execute("DELETE FROM sessions WHERE userId=? AND sessionHash<>?", params![auth.account.user.id, auth.session_hash])?; } else { tx.execute("DELETE FROM sessions WHERE userId=?", [&id])?; }
        tx.commit()?; Ok(())
    }).await?;
    Ok(Json(
        json!({"temporaryPassword": temporary, "mustChangePassword": true}),
    ))
}

pub async fn logout_user(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    admin(&context)?;
    app.db
        .run(move |db| {
            if !db.query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE id=?)",
                [&id],
                |row| row.get::<_, bool>(0),
            )? {
                return Err(ApiError::NOT_FOUND);
            }
            db.execute("DELETE FROM sessions WHERE userId=?", [id])?;
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_user(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<impl IntoResponse> {
    admin(&context)?;
    let body = read_json(request, 2048).await?;
    let email = email(body.get("email"))?;
    let name = if body.contains_key("name") {
        person_name(body.get("name"))?
    } else {
        name(None, &email)?
    };
    let response_name = name.clone();
    let mut role = match body.get("role") {
        None => "user",
        Some(value) => match value.as_str() {
            Some("user") => "user",
            Some("admin") => "admin",
            _ => return Err(ApiError::INVALID_INPUT),
        },
    };
    if env::var("ADMIN_EMAILS")
        .unwrap_or_default()
        .split(',')
        .map(|value| value.trim().to_lowercase())
        .any(|value| value == email)
    {
        role = "admin";
    }
    let quota = match body.get("quotaBytes") {
        None | Some(crate::js::Value::Null) => None,
        Some(crate::js::Value::Number(value)) => value
            .as_i64()
            .filter(|v| *v > 0 && *v <= 100 * (1_i64 << 30)),
        _ => None,
    };
    if body.get("quotaBytes").is_some()
        && body.get("quotaBytes") != Some(&crate::js::Value::Null)
        && quota.is_none()
    {
        return Err(ApiError::INVALID_INPUT);
    }
    let temporary = body
        .get("temporaryPassword")
        .and_then(crate::js::Value::as_bool)
        .unwrap_or(false);
    if body.get("temporaryPassword").is_some()
        && body
            .get("temporaryPassword")
            .and_then(crate::js::Value::as_bool)
            .is_none()
    {
        return Err(ApiError::INVALID_INPUT);
    }
    let id = Uuid::new_v4().to_string();
    let tmp = if temporary {
        Some(temporary_password()?)
    } else {
        None
    };
    let hash = match tmp.as_deref() {
        Some(value) => Some(hash_password(value.to_owned()).await?),
        None => None,
    };
    let row = app.db.run(move |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE lower(email)=lower(?))", [&email], |row| row.get::<_, bool>(0))? { return Err(ApiError::new(409, "EMAIL_IN_USE")); }
        tx.execute("INSERT INTO users (id,email,name,role,disabled,createdAt,pending,quotaBytes,passwordHash,mustChangePassword,passwordUpdatedAt) VALUES (?,?,?, ?,0,?,1,?,?,?,?)", params![id, email, name, role, now(), quota, hash, temporary, now()])?;
        create_private_space(&tx, &id)?;
        let row = tx.query_row("SELECT * FROM users WHERE id=?", [&id], db::account)?;
        tx.commit()?; Ok(row)
    }).await?;
    let mut response = json!({"id":row.user.id,"email":row.user.email,"name":row.user.name,"role":row.user.role,"disabled":0,"pending":1,"createdAt":row.user.created_at,"usedBytes":0,"quotaBytes":row.quota.unwrap_or(app.config().quota),"quotaOverride":row.quota,"hasPassword":tmp.is_some(),"mustChangePassword":tmp.is_some(),"providers":[]});
    if let Some(temporary) = tmp {
        response
            .as_object_mut()
            .unwrap()
            .insert("temporaryPassword".into(), temporary.into());
    }
    let mut response = crate::js::to_value(&response)?;
    response
        .as_object_mut()
        .unwrap()
        .insert("name", crate::js::Value::String(response_name));
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn update_user(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
    request: axum::extract::Request,
) -> ApiResult<impl IntoResponse> {
    admin(&context)?;
    let body = read_json(request, 2048).await?;
    if !body
        .keys()
        .any(|key| ["disabled", "role", "name", "quotaBytes", "inviteLimit"].contains(&key))
    {
        return Err(ApiError::INVALID_INPUT);
    }
    let name = if body.contains_key("name") {
        Some(person_name(body.get("name"))?)
    } else {
        None
    };
    let disabled = match body.get("disabled") {
        None => None,
        Some(value) => Some(value.as_bool().ok_or(ApiError::INVALID_INPUT)?),
    };
    let role = body
        .get("role")
        .map(|v| match v.as_str() {
            Some("admin") => Ok("admin"),
            Some("user") => Ok("user"),
            _ => Err(ApiError::INVALID_INPUT),
        })
        .transpose()?;
    let quota = if body.contains_key("quotaBytes") {
        match body.get("quotaBytes") {
            Some(crate::js::Value::Null) => Some(None),
            Some(crate::js::Value::Number(n))
                if n.as_i64()
                    .is_some_and(|v| v > 0 && v <= 100 * (1_i64 << 30)) =>
            {
                Some(n.as_i64())
            }
            _ => return Err(ApiError::INVALID_INPUT),
        }
    } else {
        None
    };
    let invite_limit = if body.contains_key("inviteLimit") {
        match body.get("inviteLimit") {
            Some(crate::js::Value::Null) => Some(None),
            Some(crate::js::Value::Number(n))
                if n.as_i64().is_some_and(|v| (0..=100).contains(&v)) =>
            {
                Some(n.as_i64())
            }
            _ => return Err(ApiError::INVALID_INPUT),
        }
    } else {
        None
    };
    let user_id = id.clone();
    app.db.run(move |db| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<(String, bool, String)> = tx.query_row("SELECT role,disabled,email FROM users WHERE id=?", [&id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((old_role, old_disabled, _)) = current else { return Err(ApiError::NOT_FOUND); };
        let next_disabled = disabled.unwrap_or(old_disabled);
        let next_role = role.unwrap_or(old_role.as_str());
        if old_role == "admin" && !old_disabled && (next_disabled || next_role != "admin") && tx.query_row("SELECT count(*) FROM users WHERE role='admin' AND disabled=0", [], |row| row.get::<_, i64>(0))? <= 1 { return Err(ApiError::new(409, "LAST_ADMIN")); }
        tx.execute("UPDATE users SET disabled=?,role=?,name=coalesce(?,name),quotaBytes=case when ? then ? else quotaBytes end,inviteLimit=case when ? then ? else inviteLimit end WHERE id=?", params![next_disabled, next_role, name, quota.is_some(), quota.flatten(), invite_limit.is_some(), invite_limit.flatten(), id])?;
        if next_disabled && !old_disabled { tx.execute("DELETE FROM sessions WHERE userId=?", [&id])?; tx.execute("UPDATE access_tokens SET revoked=1 WHERE userId=?", [&id])?; tx.execute("UPDATE device_authorizations SET status='denied' WHERE userId=? AND status='approved'", [&id])?; }
        tx.commit()?; Ok(())
    }).await?;
    if disabled == Some(true) {
        let ids = app
            .db
            .run(move |db| db::delete_user_uploads(db, &user_id))
            .await?;
        crate::uploads::abort_sessions(&app, &ids).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn registration(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let auth = admin(&context)?;
    let value = app.db.run(move |db| {
        let row = db.query_row("SELECT value,updatedAt,updatedBy FROM app_settings WHERE key='registration'", [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<String>>(2)?))).optional()?;
        Ok(json!({"policy": row.as_ref().map(|v| v.0.as_str()).unwrap_or("invite"), "default":"invite", "updatedAt":row.as_ref().map(|v|v.1), "updatedBy":row.as_ref().and_then(|v|v.2.clone()), "actor":auth.account.user.email}))
    }).await?;
    Ok(Json(value))
}

pub async fn save_registration(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    let auth = admin(&context)?;
    let body = read_json(request, 1024).await?;
    let policy = match body.get("policy").and_then(crate::js::Value::as_str) {
        Some("closed") | Some("invite") | Some("open") => body
            .get("policy")
            .and_then(crate::js::Value::as_str)
            .unwrap()
            .to_owned(),
        _ => return Err(ApiError::INVALID_INPUT),
    };
    let actor = auth.account.user.email.clone();
    app.db.run(move |db| { db.execute("INSERT INTO app_settings (key,value,updatedAt,updatedBy) VALUES ('registration',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt,updatedBy=excluded.updatedBy", params![policy, now(), actor])?; Ok(()) }).await?;
    registration(State(app), Extension(context)).await
}

fn invite_view(row: &Row<'_>, kind: &str, token: Option<&str>) -> rusqlite::Result<Value> {
    let mut value = json!({"id":row.get::<_,String>("id")?,"spaceId":row.get::<_,String>("spaceId")?,"maxUses":row.get::<_,i64>("maxUses")?,"uses":row.get::<_,i64>("uses")?,"expiresAt":row.get::<_,i64>("expiresAt")?,"revoked":row.get::<_,i64>("revoked")? != 0,"createdBy":row.get::<_,String>("createdBy")?,"joinSpace":row.get::<_,i64>("joinSpace")?,"createdAt":row.get::<_,Option<i64>>("createdAt")?,"role":row.get::<_,Option<String>>("role")?,"kind":kind});
    if let Some(token) = token {
        value
            .as_object_mut()
            .unwrap()
            .insert("token".into(), token.into());
    }
    Ok(value)
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
        "exhausted"
    } else if expires_at <= time {
        "expired"
    } else {
        "active"
    }
}

fn admin_invite_view(row: &Row<'_>) -> rusqlite::Result<Value> {
    let uses: i64 = row.get(3)?;
    let max_uses: i64 = row.get(2)?;
    let expires_at: i64 = row.get(4)?;
    let revoked: i64 = row.get(5)?;
    let join_space: i64 = row.get(7)?;
    let creator_role: Option<String> = row.get(11)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?, "spaceId": row.get::<_, String>(1)?, "maxUses": max_uses,
        "uses": uses, "expiresAt": expires_at, "revoked": revoked != 0, "createdBy": row.get::<_, String>(6)?,
        "joinSpace": join_space, "createdAt": row.get::<_, Option<i64>>(8)?, "role": row.get::<_, Option<String>>(9)?,
        "createdByEmail": row.get::<_, Option<String>>(10)?, "creatorAdmin": creator_role.as_deref() == Some("admin"),
        "kind": if join_space == 0 { "registration" } else { "space" },
        "status": invite_status(uses, max_uses, expires_at, revoked, now()),
    }))
}

#[allow(clippy::too_many_arguments)]
async fn create_invite_for(
    app: &App,
    creator: &Auth,
    registration: bool,
    max_uses: i64,
    hours: i64,
    role: Option<&str>,
    space_id: Option<String>,
    origin: String,
) -> ApiResult<Value> {
    let raw = random_token()?;
    let token_hash = password::hash(&raw);
    let creator_id = creator.account.user.id.clone();
    let role = role.map(str::to_owned);
    let raw_for_db = raw.clone();
    let value = app.db.run(move |db| {
        let space = match space_id {
            Some(space) => {
                let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM spaces WHERE id=? AND roomKey IS NULL)", [&space], |row| row.get(0))?;
                if !exists { return Err(ApiError::NOT_FOUND); }
                space
            }
            None => db.query_row("SELECT id FROM spaces WHERE ownerId=? AND roomKey IS NULL LIMIT 1", [&creator_id], |row| row.get(0)).optional()?.ok_or(ApiError::NOT_FOUND)?,
        };
        let id = Uuid::new_v4().to_string();
        let now = now();
        db.execute("INSERT INTO invites (id,tokenHash,spaceId,maxUses,uses,expiresAt,revoked,createdBy,joinSpace,createdAt,role) VALUES (?,?,?, ?,0,?,0,?,?,?,?)", params![id, token_hash, space, max_uses, now+hours*3_600_000, creator_id, if registration { 0 } else { 1 }, now, role])?;
        let row = db.query_row("SELECT id,spaceId,maxUses,uses,expiresAt,revoked,createdBy,joinSpace,createdAt,role FROM invites WHERE id=?", [&id], |row| invite_view(row, if registration { "registration" } else { "space" }, Some(&raw_for_db)))?;
        Ok(row)
    }).await?;
    let mut value = value;
    value
        .as_object_mut()
        .unwrap()
        .insert("url".into(), format!("{}/invite/{}", origin, raw).into());
    Ok(value)
}

pub async fn admin_invites(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let auth = admin(&context)?;
    let values = app.db.run(|db| {
        let mut stmt = db.prepare("SELECT i.id,i.spaceId,i.maxUses,i.uses,i.expiresAt,i.revoked,i.createdBy,i.joinSpace,i.createdAt,i.role,u.email,u.role FROM invites i LEFT JOIN users u ON u.id=i.createdBy ORDER BY i.expiresAt DESC")?;
        Ok(stmt.query_map([], admin_invite_view)?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await?;
    let _ = auth;
    Ok(Json(json!({"invites":values})))
}

pub async fn create_admin_invite(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<impl IntoResponse> {
    let auth = admin(&context)?;
    let body = read_json(request, 2048).await?;
    let kind = body
        .get("kind")
        .and_then(crate::js::Value::as_str)
        .unwrap_or("space");
    let max = body
        .get("maxUses")
        .and_then(crate::js::Value::as_i64)
        .unwrap_or(1);
    let hours = body
        .get("expiresInHours")
        .and_then(crate::js::Value::as_i64)
        .unwrap_or(if kind == "registration" { 168 } else { 24 });
    if !(1..=100).contains(&max)
        || !(1..=720).contains(&hours)
        || !["registration", "space"].contains(&kind)
    {
        return Err(ApiError::INVALID_INPUT);
    }
    let space_id = if kind == "space" {
        Some(input_string(body.get("spaceId"), 64)?.to_owned())
    } else {
        None
    };
    let role = if kind == "space" {
        match body
            .get("role")
            .and_then(crate::js::Value::as_str)
            .unwrap_or("editor")
        {
            "viewer" | "editor" => body.get("role").and_then(crate::js::Value::as_str),
            _ => return Err(ApiError::INVALID_INPUT),
        }
    } else {
        None
    };
    let invite = create_invite_for(
        &app,
        &auth,
        kind == "registration",
        max,
        hours,
        role,
        space_id,
        origin(&app, &context),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(invite)))
}

pub async fn my_invites(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    let auth = admin(&context)?;
    let id = auth.account.user.id.clone();
    let invites = app.db.run(move |db| { let mut stmt = db.prepare("SELECT id,spaceId,maxUses,uses,expiresAt,revoked,createdBy,joinSpace,createdAt,role FROM invites WHERE createdBy=? AND joinSpace=0 ORDER BY coalesce(createdAt,0) DESC,expiresAt DESC")?; Ok(stmt.query_map([id], |row| invite_view(row,"registration",None))?.collect::<rusqlite::Result<Vec<_>>>()?) }).await?;
    Ok(Json(
        json!({"invites":invites,"registration":registration_policy(&app).await?}),
    ))
}

pub async fn create_personal_invite(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<impl IntoResponse> {
    let auth = admin(&context)?;
    let body = read_json(request, 1024).await?;
    let max = 1;
    let hours = body
        .get("expiresInHours")
        .and_then(crate::js::Value::as_i64)
        .unwrap_or(168);
    if !(1..=720).contains(&hours) {
        return Err(ApiError::INVALID_INPUT);
    }
    Ok((
        StatusCode::CREATED,
        Json(
            create_invite_for(
                &app,
                &auth,
                true,
                max,
                hours,
                None,
                None,
                origin(&app, &context),
            )
            .await?,
        ),
    ))
}

pub async fn revoke_personal_invite(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let auth = admin(&context)?;
    app.db
        .run(move |db| {
            let row: Option<(i64, bool)> = db
                .query_row(
                    "SELECT uses,revoked FROM invites WHERE id=? AND createdBy=? AND joinSpace=0",
                    params![id, auth.account.user.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((uses, revoked)) = row else {
                return Err(ApiError::NOT_FOUND);
            };
            if revoked {
                return Err(ApiError::NOT_FOUND);
            };
            if uses > 0 {
                return Err(ApiError::new(409, "INVITE_USED"));
            };
            db.execute("UPDATE invites SET revoked=1 WHERE id=?", [&id])?;
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn revoke_admin_invite(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    admin(&context)?;
    app.db
        .run(move |db| {
            if db.execute("UPDATE invites SET revoked=1 WHERE id=?", [&id])? == 0 {
                return Err(ApiError::NOT_FOUND);
            }
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn site_view(app: &App, context: &RequestContext) -> ApiResult<Value> {
    let row: Option<(i64, Option<String>)> = app
        .db
        .run(|db| {
            db.query_row(
                "SELECT updatedAt,updatedBy FROM app_settings WHERE key='appOrigin'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(ApiError::from)
        })
        .await?;
    let config = app.config();
    let effective = origin(app, context);
    let source = config
        .origin
        .as_ref()
        .map(|(_, source)| *source)
        .unwrap_or("request");
    let secure_cookies = config.production && effective.starts_with("https:");
    Ok(json!({
        "origin": config.origin.as_ref().map(|(value, _)| value),
        "source": source,
        "adminOrigin": config.admin_origin,
        "envOrigin": config.env_origin,
        "requestOrigin": context.request_origin,
        "effectiveOrigin": effective,
        "production": config.production,
        "secureCookies": secure_cookies,
        "trustProxy": !config.trusted_proxies.is_empty(),
        "updatedAt": row.as_ref().map(|(at, _)| *at),
        "updatedBy": row.and_then(|(_, by)| by),
        "callbacks": [
            { "provider": "github", "label": "GitHub", "url": format!("{effective}/api/auth/github/callback") },
            { "provider": "google", "label": "Google", "url": format!("{effective}/api/auth/google/callback") },
        ],
    }))
}

pub async fn admin_site(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
) -> ApiResult<Json<Value>> {
    admin(&context)?;
    Ok(Json(site_view(&app, &context).await?))
}

pub async fn save_admin_site(
    State(app): State<App>,
    Extension(context): Extension<RequestContext>,
    request: axum::extract::Request,
) -> ApiResult<Json<Value>> {
    let auth = admin(&context)?;
    app.limit("site-config", &context.ip, app.config().rate_auth)?;
    let body = read_json(request, 2048).await?;
    let confirm = match body.get("confirm") {
        None => false,
        Some(crate::js::Value::Bool(value)) => *value,
        Some(_) => return Err(ApiError::INVALID_INPUT),
    };
    let next: Option<String> = match body.get("origin") {
        None => return Err(ApiError::INVALID_INPUT),
        Some(crate::js::Value::Null) => None,
        Some(crate::js::Value::String(text)) if text.is_empty() => None,
        Some(value) => {
            let raw = value.as_str().ok_or(ApiError::INVALID_INPUT)?;
            let parsed =
                crate::config::parse_origin(raw).ok_or(ApiError::new(400, "INVALID_ORIGIN"))?;
            Some(parsed)
        }
    };
    let config = app.config();
    let effective = next.clone().or_else(|| config.env_origin.clone());
    let current = context.received_origin.as_deref().unwrap_or_default();
    if let Some(ref eff) = effective
        && eff != current
        && !confirm
    {
        let mut error = ApiError::new(409, "ORIGIN_CONFIRM_REQUIRED");
        error.details = Some(Box::new(serde_json::Map::from_iter([
            ("origin".into(), eff.clone().into()),
            ("current".into(), current.into()),
        ])));
        return Err(error);
    }
    let actor = auth.account.user.email.clone();
    let next_for_db = next.clone();
    app.db
        .run(move |db| {
            if let Some(value) = next_for_db {
                db.execute(
                    "INSERT INTO app_settings (key,value,updatedAt,updatedBy) VALUES ('appOrigin',?,?,?)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt,updatedBy=excluded.updatedBy",
                    params![value, now(), actor],
                )?;
            } else {
                db.execute("DELETE FROM app_settings WHERE key='appOrigin'", [])?;
            }
            Ok(())
        })
        .await?;
    let mut updated = (*app.config()).clone();
    updated.admin_origin = next.clone();
    updated.origin = next
        .map(|value| (value, "admin"))
        .or_else(|| updated.env_origin.clone().map(|value| (value, "env")));
    app.replace_config(updated)?;
    Ok(Json(site_view(&app, &context).await?))
}
