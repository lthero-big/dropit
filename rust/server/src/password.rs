use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use scrypt::{Params, scrypt};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;

use crate::{ApiError, ApiResult};

pub fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

pub fn session_token() -> ApiResult<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(ApiError::internal)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// Hash a short room PIN using the same self-describing scrypt format as the
/// TypeScript service. Room PINs are credentials, so they must not be stored
/// as the fast request hash used for tokens and sessions.
pub fn hash_password(password: &str) -> ApiResult<String> {
    let mut salt = [0; 16];
    getrandom::fill(&mut salt).map_err(ApiError::internal)?;
    let params = Params::new(14, 8, 1, 64).map_err(ApiError::internal)?;
    let normalized: String = password.nfkc().collect();
    let mut key = [0; 64];
    scrypt(normalized.as_bytes(), &salt, &params, &mut key).map_err(ApiError::internal)?;
    Ok(format!(
        "scrypt$16384$8$1${}${}",
        URL_SAFE_NO_PAD.encode(salt),
        URL_SAFE_NO_PAD.encode(key)
    ))
}

pub fn verify(password: &str, stored: Option<&str>) -> ApiResult<bool> {
    // Missing or malformed hashes still incur the default work.
    let (params, salt, expected, valid) = match stored.and_then(parse) {
        Some((params, salt, expected)) => (params, salt, expected, true),
        None => (
            Params::new(14, 8, 1, 64).unwrap(),
            vec![0; 16],
            vec![0; 64],
            false,
        ),
    };
    let password: String = password.nfkc().collect();
    let mut actual = [0; 64];
    scrypt(password.as_bytes(), &salt, &params, &mut actual).map_err(ApiError::internal)?;
    Ok(bool::from(actual.as_slice().ct_eq(&expected)) && valid)
}

fn parse(stored: &str) -> Option<(Params, Vec<u8>, Vec<u8>)> {
    let parts: Vec<_> = stored.split('$').collect();
    let ["scrypt", n, r, p, salt, key] = parts.as_slice() else {
        return None;
    };
    let n: u32 = n.parse().ok()?;
    let r: u32 = r.parse().ok()?;
    let p: u32 = p.parse().ok()?;
    if !(1024..=1 << 20).contains(&n)
        || !n.is_power_of_two()
        || !(1..=32).contains(&r)
        || !(1..=16).contains(&p)
    {
        return None;
    }
    // Match the reference's OpenSSL scrypt memory ceiling before allocating.
    if 128 * u64::from(r) * u64::from(n + p + 2) > 64 * 1024 * 1024 {
        return None;
    }
    let params = Params::new(n.trailing_zeros() as u8, r, p, 64).ok()?;
    Some((
        params,
        URL_SAFE_NO_PAD.decode(salt).ok()?,
        URL_SAFE_NO_PAD.decode(key).ok()?,
    ))
}
