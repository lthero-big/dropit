#[test]
fn authentication_and_account_compatibility() {
    let status = std::process::Command::new("node")
        .arg("tests/auth.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node 22 and the mock OAuth test must be available");
    assert!(
        status.success(),
        "authentication compatibility checks failed"
    );
}
