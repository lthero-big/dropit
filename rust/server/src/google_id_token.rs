//! Strict RS256 verification for Google ID Tokens using Google's JWKS endpoint.

use std::{collections::HashMap, env, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Client;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

use crate::{ApiError, ApiResult, now};

const DEFAULT_GOOGLE_JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const DEFAULT_TTL_MS: i64 = 3_600_000;
const MIN_TTL_MS: i64 = 60_000;
const MAX_TTL_MS: i64 = 86_400_000;
const MIN_REFRESH_INTERVAL_MS: i64 = 10_000;
const MAX_JWKS_BYTES: usize = 256 * 1024;
const CLOCK_SKEW_SECS: f64 = 60.0;

#[derive(Clone)]
struct RsaJwk {
    n: Vec<u8>,
    e: Vec<u8>,
}

#[derive(Default)]
struct CachedJwks {
    keys: HashMap<String, RsaJwk>,
    expires_at: i64,
    last_refresh_at: i64,
}

pub(crate) struct GoogleIdentity {
    pub(crate) subject: String,
    pub(crate) email: String,
    pub(crate) name: String,
}

pub(crate) struct GoogleJwksCache {
    jwks_url: String,
    cache: RwLock<CachedJwks>,
    refresh_lock: Mutex<()>,
}

impl GoogleJwksCache {
    pub(crate) fn new() -> Self {
        let jwks_url = env::var("GOOGLE_JWKS_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_GOOGLE_JWKS_URL.to_owned());
        Self {
            jwks_url,
            cache: RwLock::new(CachedJwks::default()),
            refresh_lock: Mutex::new(()),
        }
    }

    pub(crate) async fn verify_id_token(
        &self,
        id_token: &str,
        expected_client_id: &str,
    ) -> ApiResult<GoogleIdentity> {
        let mut segments = id_token.split('.');
        let (Some(header_b64), Some(payload_b64), Some(signature_b64), None) = (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ) else {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        };
        if header_b64.is_empty() || payload_b64.is_empty() || signature_b64.is_empty() {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        }

        let header = decode_json_object(header_b64)?;
        if header.get("alg").and_then(Value::as_str) != Some("RS256") {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        }
        if let Some(typ) = header.get("typ")
            && typ.as_str() != Some("JWT")
        {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        }
        let Some(kid) = header
            .get("kid")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
        else {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        };

        let signature = URL_SAFE_NO_PAD
            .decode(signature_b64.as_bytes())
            .map_err(|_| ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?;
        if signature.is_empty() {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        }

        let key = self
            .get_key(kid)
            .await?
            .ok_or(ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?;

        let signing_input = format!("{header_b64}.{payload_b64}");
        let public_key = RsaPublicKeyComponents {
            n: key.n.as_slice(),
            e: key.e.as_slice(),
        };
        public_key
            .verify(
                &RSA_PKCS1_2048_8192_SHA256,
                signing_input.as_bytes(),
                &signature,
            )
            .map_err(|_| ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?;

        let payload = decode_json_object(payload_b64)?;
        let iss = payload
            .get("iss")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?;
        if iss != "https://accounts.google.com" && iss != "accounts.google.com" {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        }

        let aud = payload
            .get("aud")
            .and_then(Value::as_str)
            .ok_or(ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?;
        if aud != expected_client_id {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        }

        let now_sec = (now() as f64) / 1000.0;
        let exp = json_number(payload.get("exp"))?;
        if exp + CLOCK_SKEW_SECS <= now_sec {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        }
        let iat = json_number(payload.get("iat"))?;
        if iat < 0.0 || iat > now_sec + CLOCK_SKEW_SECS {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        }
        if let Some(nbf_val) = payload.get("nbf") {
            let nbf = json_number(Some(nbf_val))?;
            if nbf > now_sec + CLOCK_SKEW_SECS {
                return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
            }
        }

        let subject = payload
            .get("sub")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 255)
            .ok_or(ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?
            .to_owned();

        let email_verified = payload.get("email_verified").and_then(Value::as_bool);
        let email = payload
            .get("email")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 320);
        if email_verified != Some(true) || email.is_none() {
            return Err(ApiError::new(403, "VERIFIED_EMAIL_REQUIRED"));
        }
        let email = email.unwrap().to_lowercase();

        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("User")
            .chars()
            .take(200)
            .collect();

        Ok(GoogleIdentity {
            subject,
            email,
            name,
        })
    }

    async fn get_key(&self, kid: &str) -> ApiResult<Option<RsaJwk>> {
        let current = now();
        {
            let guard = self.cache.read().await;
            if guard.expires_at > current {
                if let Some(key) = guard.keys.get(kid) {
                    return Ok(Some(key.clone()));
                }
                if current - guard.last_refresh_at < MIN_REFRESH_INTERVAL_MS {
                    return Ok(None);
                }
            }
        }

        let _refresh_guard = self.refresh_lock.lock().await;
        let current = now();
        {
            let guard = self.cache.read().await;
            if guard.expires_at > current {
                if let Some(key) = guard.keys.get(kid) {
                    return Ok(Some(key.clone()));
                }
                if current - guard.last_refresh_at < MIN_REFRESH_INTERVAL_MS {
                    return Ok(None);
                }
            }
        }

        let refreshed = fetch_jwks(&self.jwks_url, current).await?;
        let found = refreshed.keys.get(kid).cloned();
        *self.cache.write().await = refreshed;
        Ok(found)
    }
}

async fn fetch_jwks(url: &str, started_at: i64) -> ApiResult<CachedJwks> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(ApiError::internal)?;
    let mut response = client
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", "dropit")
        .send()
        .await
        .map_err(|_| ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?;
    if !response.status().is_success() {
        return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
    }
    let ttl_ms = parse_max_age_ms(
        response
            .headers()
            .get(reqwest::header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_JWKS_BYTES {
            return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let parsed: Value =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?;
    let Some(items) = parsed.get("keys").and_then(Value::as_array) else {
        return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
    };
    let mut keys = HashMap::new();
    for item in items {
        if item.get("kty").and_then(Value::as_str) != Some("RSA") {
            continue;
        }
        if let Some(usage) = item.get("use")
            && usage.as_str() != Some("sig")
        {
            continue;
        }
        if let Some(alg) = item.get("alg")
            && alg.as_str() != Some("RS256")
        {
            continue;
        }
        let Some(kid) = item
            .get("kid")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
        else {
            continue;
        };
        let (Some(n_b64), Some(e_b64)) = (
            item.get("n").and_then(Value::as_str),
            item.get("e").and_then(Value::as_str),
        ) else {
            continue;
        };
        let (Ok(n), Ok(e)) = (
            URL_SAFE_NO_PAD.decode(n_b64.as_bytes()),
            URL_SAFE_NO_PAD.decode(e_b64.as_bytes()),
        ) else {
            continue;
        };
        if n.is_empty() || e.is_empty() {
            continue;
        }
        keys.insert(kid.to_owned(), RsaJwk { n, e });
    }
    if keys.is_empty() {
        return Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR"));
    }
    Ok(CachedJwks {
        keys,
        expires_at: started_at + ttl_ms,
        last_refresh_at: started_at,
    })
}

fn parse_max_age_ms(cache_control: Option<&str>) -> i64 {
    let Some(header) = cache_control else {
        return DEFAULT_TTL_MS;
    };
    for part in header.split(',') {
        let trimmed = part.trim();
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("max-age")
            && let Ok(seconds) = value.trim().parse::<i64>()
            && seconds > 0
        {
            return seconds.saturating_mul(1000).clamp(MIN_TTL_MS, MAX_TTL_MS);
        }
    }
    DEFAULT_TTL_MS
}

fn decode_json_object(segment: &str) -> ApiResult<serde_json::Map<String, Value>> {
    let bytes = URL_SAFE_NO_PAD
        .decode(segment.as_bytes())
        .map_err(|_| ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(ApiError::new(401, "OAUTH_PROVIDER_ERROR")),
    }
}

fn json_number(value: Option<&Value>) -> ApiResult<f64> {
    let number = value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or(ApiError::new(401, "OAUTH_PROVIDER_ERROR"))?;
    Ok(number)
}
