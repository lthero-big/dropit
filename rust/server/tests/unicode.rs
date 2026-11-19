#[test]
fn unicode_ts_rust_parity() {
    let status = std::process::Command::new("node")
        .arg("tests/unicode.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node 22 and the fixed TS reference must be available");
    assert!(status.success(), "Unicode compatibility checks failed");
}
