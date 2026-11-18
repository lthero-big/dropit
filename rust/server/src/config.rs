use ipnet::IpNet;
use rusqlite::{Connection, OptionalExtension};
use std::{env, net::IpAddr, path::PathBuf};
use url::Url;

use crate::js_space;

pub type StartupResult<T> = Result<T, Box<dyn std::error::Error>>;

pub struct Config {
    pub host: String,
    pub port: u16,
    pub data: PathBuf,
    pub production: bool,
    pub origin: Option<(String, &'static str)>,
    pub trusted_proxies: Vec<IpNet>,
    pub max_file: i64,
    pub max_text: usize,
    pub max_items: i64,
    pub quota: i64,
    pub retention: i64,
    pub session: i64,
    pub rate_window: i64,
    pub rate_general: u32,
    pub rate_auth: u32,
    pub rate_upload: u32,
    pub rate_token: u32,
}

impl Config {
    pub fn load() -> StartupResult<Self> {
        let raw_origin = env::var("APP_ORIGIN").unwrap_or_default();
        let origin = if raw_origin.trim_matches(js_space).is_empty() {
            None
        } else {
            Some((
                parse_origin(&raw_origin).ok_or("Invalid APP_ORIGIN")?,
                "env",
            ))
        };
        let mut trusted_proxies = Vec::new();
        for value in env::var("TRUST_PROXY")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            match value {
                "loopback" => trusted_proxies
                    .extend(["127.0.0.0/8", "::1/128"].map(|net| net.parse::<IpNet>().unwrap())),
                "linklocal" => trusted_proxies.extend(
                    ["169.254.0.0/16", "fe80::/10"].map(|net| net.parse::<IpNet>().unwrap()),
                ),
                "uniquelocal" => trusted_proxies.extend(
                    ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]
                        .map(|net| net.parse::<IpNet>().unwrap()),
                ),
                _ => trusted_proxies.push(if let Ok(ip) = value.parse::<IpAddr>() {
                    IpNet::from(ip)
                } else {
                    value.parse()?
                }),
            }
        }
        Ok(Self {
            host: env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: env_limit("PORT", 8787, 1, u16::MAX.into())? as u16,
            data: env::var_os("DATA_DIR")
                .filter(|dir| !dir.is_empty())
                .map_or_else(|| PathBuf::from("data"), PathBuf::from),
            production: env::var("NODE_ENV").is_ok_and(|v| v == "production"),
            origin,
            trusted_proxies,
            max_file: 0,
            max_text: 0,
            max_items: 0,
            quota: 0,
            retention: 0,
            session: 0,
            rate_window: 0,
            rate_general: 0,
            rate_auth: 0,
            rate_upload: 0,
            rate_token: 0,
        })
    }

    pub fn apply_settings(&mut self, db: &Connection) -> StartupResult<()> {
        let reset = env::var("RESET_APP_ORIGIN").unwrap_or_default();
        let reset = matches!(
            reset.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes"
        );
        let stored: Option<String> = db
            .query_row(
                "SELECT value FROM app_settings WHERE key='appOrigin'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if !reset && let Some(stored) = stored {
            if let Some(origin) = parse_origin(&stored) {
                self.origin = Some((origin, "admin"));
            } else {
                eprintln!("Ignoring an invalid site address saved in 管理 → 站点地址");
            }
        }

        let mut query = db.prepare("SELECT value FROM runtime_limits WHERE key=?")?;
        let mut limit = |key, env, default, scale, max| -> StartupResult<i64> {
            let from_env = env_limit(env, default, scale, max)?;
            let persisted: Option<i64> = query.query_row([key], |row| row.get(0)).optional()?;
            let value = persisted.unwrap_or(from_env);
            if !(1..=max).contains(&value) {
                return Err(format!("Invalid persisted limit {key}").into());
            }
            Ok(value)
        };
        self.max_file = limit("maxFileBytes", "MAX_FILE_BYTES", 25 << 20, 1, 1 << 30)?;
        self.max_text = limit("maxTextBytes", "MAX_TEXT_BYTES", 65536, 1, 1 << 20)? as usize;
        self.max_items = limit("maxItems", "MAX_ITEMS", 1000, 1, 100000)?;
        self.quota = limit("userQuotaBytes", "USER_QUOTA_BYTES", 1 << 30, 1, 100 << 30)?;
        self.retention = limit(
            "retentionMs",
            "RETENTION_HOURS",
            168,
            3600000,
            365 * 86400000,
        )?;
        self.session = limit("sessionMs", "SESSION_HOURS", 168, 3600000, 365 * 86400000)?;
        self.rate_window = limit("rateWindowMs", "RATE_WINDOW_MS", 60000, 1, 3600000)?;
        self.rate_general = limit("rateGeneral", "RATE_GENERAL", 240, 1, 1000000)? as u32;
        self.rate_auth = limit("rateAuth", "RATE_AUTH", 20, 1, 1000000)? as u32;
        self.rate_upload = limit("rateUpload", "RATE_UPLOAD", 30, 1, 1000000)? as u32;
        self.rate_token = limit("rateToken", "RATE_TOKEN", 120, 1, 1000000)? as u32;
        if self.rate_auth >= self.rate_general || self.rate_upload >= self.rate_general {
            return Err("Invalid rate limits".into());
        }
        if reset {
            db.execute("DELETE FROM app_settings WHERE key='appOrigin'", [])?;
        }
        Ok(())
    }

    pub fn trusts(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        self.trusted_proxies.iter().any(|net| {
            net.contains(&ip)
                || match ip {
                    IpAddr::V4(ip) => net.contains(&IpAddr::V6(ip.to_ipv6_mapped())),
                    IpAddr::V6(_) => false,
                }
        })
    }
}

fn env_limit(key: &str, default: i64, scale: i64, max: i64) -> StartupResult<i64> {
    let value = match env::var(key) {
        Ok(raw) => {
            let raw = raw.trim_matches(js_space);
            let number: f64 = raw.parse()?;
            if number.fract() != 0.0 || !(1.0..=(max / scale) as f64).contains(&number) {
                return Err(format!("Invalid {key}").into());
            }
            number as i64
        }
        Err(env::VarError::NotPresent) => default,
        Err(err) => return Err(err.into()),
    };
    Ok(value * scale)
}

pub fn parse_origin(value: &str) -> Option<String> {
    let value = value.trim_matches(js_space);
    if value.encode_utf16().count() > 300
        || value.contains(['?', '#', '\\', '@'])
        || value.contains(js_space)
    {
        return None;
    }
    let (scheme, host) = value.split_once("://")?;
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")) {
        return None;
    }
    let host = host.strip_suffix('/').unwrap_or(host);
    if host.is_empty() || host.contains('/') {
        return None;
    }
    let url = Url::parse(value).ok()?;
    url.host()?;
    Some(url.origin().ascii_serialization())
}
