#[test]
fn item_edit_labels_and_groups_compatibility() {
    let status = std::process::Command::new("node")
        .arg("tests/labels-compat.mjs")
        .env("RUST_SERVER_BIN", env!("CARGO_BIN_EXE_dropit-server"))
        .status()
        .expect("Node 22 and the built TS fixture must be available");
    assert!(
        status.success(),
        "item editing/labels/groups compatibility checks failed"
    );
}
