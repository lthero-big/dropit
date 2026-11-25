#[test]
fn app_oauth_bridge_and_google_id_token() {
    let status = std::process::Command::new("node")
        .arg("tests/app-oauth-google.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node 22 and the app-oauth-google harness must be available");
    assert!(
        status.success(),
        "app-oauth HTML bridge and Google ID Token checks failed"
    );
}
