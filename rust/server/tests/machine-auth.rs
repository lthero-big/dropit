#[test]
fn machine_auth_compatibility() {
    let status = std::process::Command::new("node")
        .arg("tests/machine-auth.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node 22 and the machine-auth harness must be available");
    assert!(status.success(), "machine-auth compatibility checks failed");
}
