#[test]
fn room_chunk_compatibility() {
    let status = std::process::Command::new("node")
        .arg("tests/room-chunks-compat.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node 22 and the built TS fixture must be available");
    assert!(status.success(), "room chunk compatibility checks failed");
}
