#[test]
fn room_chunk_compatibility() {
    let bin = env!("CARGO_BIN_EXE_dropit-server");
    for script in [
        "tests/room-chunks-compat.mjs",
        "tests/rhea243-review-probe.mjs",
    ] {
        let status = std::process::Command::new("node")
            .arg(script)
            .env("RUST_SERVER_BIN", bin)
            .status()
            .expect("Node 22 and the built TS fixture must be available");
        assert!(status.success(), "{script} failed");
    }
}
