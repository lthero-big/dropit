#[test]
fn browser_bootstrap_and_realtime_match_ts() {
    let status = std::process::Command::new("node")
        .arg("tests/realtime.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node and pnpm are required for the fixed TS reference");
    assert!(status.success(), "realtime compatibility checks failed");
}
