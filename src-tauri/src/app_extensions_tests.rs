use super::*;
use crate::app_settings::tests::state;
use std::path::PathBuf;

/// Match the retained report-tools manifest's declarative-only schema.
fn manifest() -> serde_json::Value {
    serde_json::json!({ "id": "report-tools", "name": "Report Tools", "version": "1.0.0", "apiVersion": "1.0.0", "description": "Local report actions", "permissions": ["commands"], "contributes": { "commands": [{ "id": "report.export-json", "title": "Export JSON", "category": "Reports" }] } })
}

/// Create an ordinary selected source folder for real filesystem import tests.
fn source(root: &Path, value: &serde_json::Value) -> PathBuf {
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("manifest.json"),
        serde_json::to_vec_pretty(value).unwrap(),
    )
    .unwrap();
    fs::write(
        source.join("never-execute.js"),
        "throw new Error('must never execute')",
    )
    .unwrap();
    source
}

#[test]
fn import_copies_only_the_manifest_and_is_durably_disabled() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let source = source(root.path(), &manifest());
    let original = fs::read(source.join("manifest.json")).unwrap();
    let imported = import_folder(&state, &source).unwrap();
    assert!(!imported.enabled);
    assert!(imported.compatible);
    assert_eq!(fs::read(source.join("manifest.json")).unwrap(), original);
    assert!(!state
        .extensions_directory
        .join("report-tools/never-execute.js")
        .exists());
    assert_eq!(
        fs::read_dir(state.extensions_directory.join("report-tools"))
            .unwrap()
            .count(),
        2
    );
    assert!(!list(&crate::app_settings::tests::state(root.path())).unwrap()[0].enabled);
}

#[test]
fn enabled_hash_binding_persists_and_disabled_commands_are_refused() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let entry = import_folder(&state, &source(root.path(), &manifest())).unwrap();
    let hash = entry.manifest_sha256.as_deref().unwrap();
    assert!(
        authorize_command(&state, "report-tools", hash, ExtensionCommandId::Json)
            .unwrap_err()
            .contains("disabled")
    );
    assert!(set_enabled(&state, "report-tools", Some(&"b".repeat(64)), true).is_err());
    set_enabled(&state, "report-tools", Some(hash), true).unwrap();
    assert!(list(&crate::app_settings::tests::state(root.path())).unwrap()[0].enabled);
    assert!(matches!(
        authorize_command(&state, "report-tools", hash, ExtensionCommandId::Json).unwrap(),
        reports::ReportFormat::Json
    ));
    assert!(authorize_command(&state, "report-tools", hash, ExtensionCommandId::Csv).is_err());
    set_enabled(&state, "report-tools", None, false).unwrap();
    assert!(authorize_command(&state, "report-tools", hash, ExtensionCommandId::Json).is_err());
}

#[test]
fn collision_unsupported_permissions_code_api_and_path_escape_are_refused() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let source = source(root.path(), &manifest());
    import_folder(&state, &source).unwrap();
    assert!(import_folder(&state, &source)
        .unwrap_err()
        .contains("already installed"));
    for (field, value) in [
        ("permissions", serde_json::json!(["filesystem"])),
        ("id", serde_json::json!("../escape")),
        ("apiVersion", serde_json::json!("2.0.0")),
        ("main", serde_json::json!("script.js")),
    ] {
        let mut raw = manifest();
        raw[field] = value;
        assert!(parse_manifest(&serde_json::to_vec(&raw).unwrap()).is_err());
    }
    let mut raw = manifest();
    raw["contributes"]["commands"][0]["id"] = serde_json::json!("arbitrary.execute");
    assert!(parse_manifest(&serde_json::to_vec(&raw).unwrap()).is_err());
}

#[test]
fn tampering_and_mid_dialog_disablement_are_rechecked_and_isolated() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let entry = import_folder(&state, &source(root.path(), &manifest())).unwrap();
    let hash = entry.manifest_sha256.as_deref().unwrap();
    set_enabled(&state, "report-tools", Some(hash), true).unwrap();
    assert!(authorize_command(&state, "report-tools", hash, ExtensionCommandId::Json).is_ok());
    set_enabled(&state, "report-tools", None, false).unwrap();
    assert!(authorize_command(&state, "report-tools", hash, ExtensionCommandId::Json).is_err());
    set_enabled(&state, "report-tools", Some(hash), true).unwrap();
    let path = state
        .extensions_directory
        .join("report-tools/manifest.json");
    let mut bytes = fs::read(&path).unwrap();
    bytes.push(b' ');
    fs::write(path, bytes).unwrap();
    assert!(authorize_command(&state, "report-tools", hash, ExtensionCommandId::Json).is_err());
    let entries = list(&state).unwrap();
    assert!(!entries[0].compatible);
    assert!(!entries[0].enabled);
    assert!(entries[0].issue.as_ref().unwrap().contains("changed"));
    set_enabled(&state, "report-tools", None, false).unwrap();
}

#[test]
fn one_broken_entry_does_not_hide_a_valid_extension_or_execute_its_files() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    import_folder(&state, &source(root.path(), &manifest())).unwrap();
    fs::create_dir(state.extensions_directory.join("broken-tools")).unwrap();
    fs::write(
        state
            .extensions_directory
            .join("broken-tools/manifest.json"),
        b"not json",
    )
    .unwrap();
    let entries = list(&state).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries
        .iter()
        .any(|entry| entry.id == "broken-tools" && entry.issue.is_some() && !entry.enabled));
    assert!(entries
        .iter()
        .any(|entry| entry.id == "report-tools" && entry.compatible));
}
