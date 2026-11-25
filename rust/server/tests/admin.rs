#[test]
fn offline_admin_compatibility() {
    let status = std::process::Command::new("node")
        .arg("tests/admin.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node and pnpm are required for the fixed TS reference");
    assert!(status.success(), "offline admin compatibility failed");
}
