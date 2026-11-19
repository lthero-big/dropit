//! Offline recovery. Installed as a symlink to the server executable; no listener starts.
use crate::{config::StartupResult, migrations, password};
use rusqlite::OptionalExtension;
use std::{
    env,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

const USAGE: &str = "Usage:
  dropit-admin reset-password <email>   set a temporary password (must be changed at next sign-in)
  dropit-admin list-users               list accounts (email, role, state)

Reads the database in DATA_DIR (default /data in the Docker image).";

pub fn run(args: Vec<String>) -> StartupResult<i32> {
    let command = args.first().map(String::as_str);
    if matches!(command, None | Some("help" | "--help" | "-h")) {
        println!("{USAGE}");
        return Ok(i32::from(command.is_none()));
    }
    if !matches!(command, Some("list-users" | "reset-password")) {
        eprintln!("Unknown command: {}\n\n{USAGE}", command.unwrap());
        return Ok(1);
    }
    if command == Some("reset-password") && args.len() < 2 {
        eprintln!("{USAGE}");
        return Ok(1);
    }
    let data = env::var_os("DATA_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data"));
    let mut db = migrations::open(&data.join("dropit.sqlite"))?;
    if command == Some("list-users") {
        let mut query = db.prepare("SELECT email,role,disabled,pending,passwordHash IS NOT NULL FROM users ORDER BY createdAt")?;
        let mut rows = query.query([])?;
        let mut empty = true;
        while let Some(row) = rows.next()? {
            empty = false;
            let email: String = row.get(0)?;
            let role: String = row.get(1)?;
            let state = if row.get::<_, i64>(2)? != 0 {
                "disabled"
            } else if row.get::<_, i64>(3)? != 0 {
                "pending"
            } else {
                "active"
            };
            let password = if row.get::<_, bool>(4)? {
                "password"
            } else {
                "no password"
            };
            println!("{email}\t{role}\t{state}\t{password}");
        }
        if empty {
            println!("No accounts yet. Open /setup (the setup code is in the server log).");
        }
        return Ok(0);
    }
    let email = &args[1];
    let account = db.query_row("SELECT id,email,role,disabled FROM users WHERE lower(email)=lower(?) ORDER BY passwordHash IS NULL, createdAt LIMIT 1",
        [email.trim_matches(crate::js_space).to_lowercase()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?))).optional()?;
    let Some((id, email, role, disabled)) = account else {
        eprintln!("No account with email {email}. Run \"dropit-admin list-users\" to see them.");
        return Ok(2);
    };
    // Rejection sampling matches crypto.randomInt without modulo bias.
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut temporary = String::new();
    for i in 0..12 {
        if i == 4 || i == 8 {
            temporary.push('-');
        }
        loop {
            let mut byte = [0];
            getrandom::fill(&mut byte)?;
            let ceiling = 256 / ALPHABET.len() * ALPHABET.len();
            if usize::from(byte[0]) < ceiling {
                temporary.push(ALPHABET[usize::from(byte[0]) % ALPHABET.len()] as char);
                break;
            }
        }
    }
    let hash = password::hash_password(&temporary)
        .map_err(|e| format!("Password hashing failed: {e:?}"))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64;
    let tx = db.transaction()?;
    tx.execute(
        "UPDATE users SET passwordHash=?,mustChangePassword=1,passwordUpdatedAt=? WHERE id=?",
        rusqlite::params![hash, now, id],
    )?;
    tx.execute("DELETE FROM sessions WHERE userId=?", [&id])?;
    tx.commit()?;
    if disabled {
        eprintln!(
            "Warning: {email} is disabled; another admin must enable it before it can sign in."
        );
    }
    println!("Temporary password for {email} ({role}): {temporary}");
    println!(
        "Sign in with it at /login; you will be asked to choose a new password. All existing sessions were signed out."
    );
    Ok(0)
}
