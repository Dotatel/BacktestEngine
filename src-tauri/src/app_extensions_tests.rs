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

#[test]
fn bundled_examples_are_offline_data_only_and_require_explicit_enablement() {
    let root = tempfile::tempdir().unwrap();
    let current = state(root.path());
    for (id, name, command_count) in [
        ("report-tools", "Report tools", 3),
        ("trade-ledger-export", "Trade ledger export", 1),
        ("html-reports", "HTML reports", 1),
    ] {
        let entry = install_example(&current, id).unwrap();
        assert_eq!(entry.id, id);
        assert_eq!(entry.name, name);
        assert_eq!(entry.version.as_deref(), Some("1.0.0"));
        assert_eq!(entry.api_version.as_deref(), Some("1.0.0"));
        assert_eq!(entry.permissions, vec!["commands"]);
        assert_eq!(entry.commands.len(), command_count);
        assert!(!entry.enabled);
        assert!(entry.compatible);
        let hash = entry.manifest_sha256.as_deref().unwrap();
        assert!(authorize_command(&current, id, hash, entry.commands[0].id).is_err());
        let folder = current.extensions_directory.join(id);
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 2);
        let receipt: ManifestReceipt =
            serde_json::from_slice(&fs::read(folder.join("receipt.json")).unwrap()).unwrap();
        assert_eq!(receipt.original_directory, format!("bundled:{id}"));
        set_enabled(&current, id, Some(hash), true).unwrap();
        assert!(authorize_command(&current, id, hash, entry.commands[0].id).is_ok());
        set_enabled(&current, id, None, false).unwrap();
    }
    let restarted = state(root.path());
    let entries = list(&restarted).unwrap();
    assert_eq!(entries.len(), 3);
    assert!(entries
        .iter()
        .all(|entry| entry.compatible && !entry.enabled));
    assert!(!restarted.read().unwrap().updates.enabled);
}

#[test]
fn unknown_bundled_ids_do_not_create_preferences_or_a_registry() {
    let root = tempfile::tempdir().unwrap();
    let current = state(root.path());
    for id in [
        "claude",
        "../report-tools",
        "REPORT-TOOLS",
        "report-tools/",
        "",
    ] {
        assert!(install_example(&current, id)
            .unwrap_err()
            .contains("unavailable"));
    }
    assert!(!current.extensions_directory.exists());
    assert!(!root.path().join("app-settings.json").exists());
}

#[test]
fn installing_an_example_again_preserves_the_prior_manifest_and_enabled_state() {
    let root = tempfile::tempdir().unwrap();
    let current = state(root.path());
    let entry = import_folder(&current, &source(root.path(), &manifest())).unwrap();
    let hash = entry.manifest_sha256.as_deref().unwrap();
    set_enabled(&current, "report-tools", Some(hash), true).unwrap();
    let manifest_path = current
        .extensions_directory
        .join("report-tools/manifest.json");
    let before = fs::read(&manifest_path).unwrap();
    let settings_before = fs::read(root.path().join("app-settings.json")).unwrap();
    assert!(install_example(&current, "report-tools")
        .unwrap_err()
        .contains("already installed"));
    assert_eq!(fs::read(manifest_path).unwrap(), before);
    assert_eq!(
        fs::read(root.path().join("app-settings.json")).unwrap(),
        settings_before
    );
    assert!(list(&current).unwrap()[0].enabled);
}

#[test]
fn damaged_preferences_cannot_be_replaced_by_example_installation() {
    let root = tempfile::tempdir().unwrap();
    let current = state(root.path());
    let settings_path = root.path().join("app-settings.json");
    let bytes = b"{ damaged owner settings";
    fs::write(&settings_path, bytes).unwrap();
    assert!(install_example(&current, "report-tools").is_err());
    assert_eq!(fs::read(settings_path).unwrap(), bytes);
    assert!(!current.extensions_directory.join("report-tools").exists());
}
