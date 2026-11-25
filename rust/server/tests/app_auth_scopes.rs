#[test]
fn app_auth_scopes_and_bearer_regression() {
    let status = std::process::Command::new("node")
        .arg("tests/app-auth-scopes.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node 22 and the app-auth-scopes harness must be available");
    assert!(
        status.success(),
        "app-auth-scopes and Bearer regression checks failed"
    );
}
