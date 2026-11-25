#[test]
fn ts_fixture_upload_preview_retract() {
    let status = std::process::Command::new("node")
        .arg("tests/uploads-compat.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node 22 and the built TS reference must be available");
    assert!(
        status.success(),
        "upload, preview, and retract compatibility checks failed"
    );
}
