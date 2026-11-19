#[test]
fn update_http_compatibility() {
    let status = std::process::Command::new("node")
        .arg("../../apps/server/node_modules/tsx/dist/cli.mjs")
        .arg("tests/update-http.mts")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node and tsx must be installed");
    assert!(status.success(), "update HTTP compatibility failed");
}
