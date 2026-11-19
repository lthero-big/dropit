#[test]
fn documented_unicode_write_storage_restart_boundary() {
    run(false);
}

#[test]
#[ignore = "RHEA-245: exact UTF-16 response/event representation needs a coordinator contract decision"]
fn unicode_ts_rust_parity() {
    run(true);
}

fn run(require_parity: bool) {
    let mut command = std::process::Command::new("node");
    command
        .arg("tests/unicode.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"));
    if require_parity {
        command.arg("--require-parity");
    }
    let status = command
        .status()
        .expect("Node 22 and the fixed TS reference must be available");
    assert!(
        status.success(),
        "Unicode characterization/parity check failed"
    );
}
