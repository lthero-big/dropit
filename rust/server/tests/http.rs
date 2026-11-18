#[test]
fn ts_fixture_http_compatibility() {
    let status = std::process::Command::new("node")
        .arg("tests/compat.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node 22 and the built TS reference must be available");
    assert!(status.success(), "HTTP compatibility checks failed");
}
