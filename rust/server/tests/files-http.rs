#[test]
fn ts_fixture_file_reads() {
    let status = std::process::Command::new("node")
        .arg("tests/files-compat.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node 22 and the built TS reference must be available");
    assert!(status.success(), "file read compatibility checks failed");
}
