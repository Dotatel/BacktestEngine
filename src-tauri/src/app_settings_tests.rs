use super::*;

/// Fresh isolated state shared by domain tests; it never changes a live app profile.
pub(crate) fn state(root: &Path) -> AppSettingsState {
    AppSettingsState {
        store: Arc::new(Mutex::new(AppSettingsStore {
            path: root.join("app-settings.json"),
        })),
        update_check_running: Arc::new(AtomicBool::new(false)),
        extensions_directory: root.join("extensions"),
        runs_directory: root.join("runs"),
        resources_directory: root.join("resources"),
        app_version: "1.0.0".into(),
    }
}

#[test]
fn missing_settings_are_offline_first_run_without_creating_a_file() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let snapshot = state.snapshot(None).unwrap();
    assert_eq!(snapshot.state, "firstRun");
    assert!(!snapshot.settings.unwrap().updates.enabled);
    assert!(!root.path().join("app-settings.json").exists());
}

#[test]
fn corruption_is_preserved_and_only_explicit_recovery_creates_a_byte_exact_backup() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let bytes = b"{ broken preferences";
    fs::write(root.path().join("app-settings.json"), bytes).unwrap();
    assert_eq!(state.snapshot(None).unwrap().state, "corrupt");
    assert!(state
        .change(|value| {
            value.updates.enabled = true;
            Ok(())
        })
        .is_err());
    assert_eq!(
        fs::read(root.path().join("app-settings.json")).unwrap(),
        bytes
    );
    let backup = state.store.lock().unwrap().recover().unwrap();
    assert_eq!(fs::read(backup).unwrap(), bytes);
    assert!(!state.read().unwrap().updates.enabled);
    assert!(state.store.lock().unwrap().recover().is_err());
}

#[test]
fn strict_schema_and_versions_never_replace_a_valid_prior_document() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    state.change(|_| Ok(())).unwrap();
    let before = fs::read(root.path().join("app-settings.json")).unwrap();
    assert!(state
        .change(|value| {
            value.version = 2;
            Ok(())
        })
        .is_err());
    assert_eq!(
        fs::read(root.path().join("app-settings.json")).unwrap(),
        before
    );
    let mut raw = serde_json::to_value(AppSettings::default()).unwrap();
    raw["updates"]["automaticInstall"] = serde_json::json!(true);
    fs::write(
        root.path().join("app-settings.json"),
        serde_json::to_vec(&raw).unwrap(),
    )
    .unwrap();
    assert!(state.read().is_err());
}

#[test]
fn serialized_mutations_preserve_concurrent_extension_and_update_choices() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let threads: Vec<_> = (0..8)
        .map(|index| {
            let state = state.clone();
            std::thread::spawn(move || {
                state
                    .change(|settings| {
                        settings.extensions.insert(
                            format!("tools-{index}"),
                            ExtensionPreference {
                                enabled: false,
                                manifest_sha256: "a".repeat(64),
                            },
                        );
                        if index == 0 {
                            settings.updates.enabled = true;
                        }
                        Ok(())
                    })
                    .unwrap()
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let settings = state.read().unwrap();
    assert_eq!(settings.extensions.len(), 8);
    assert!(settings.updates.enabled);
}

#[test]
fn export_default_is_existing_canonical_outside_run_storage_and_revalidated_at_use() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let outside = root.path().join("reports");
    let inside = state.runs_directory.join("run-1");
    fs::create_dir_all(&outside).unwrap();
    fs::create_dir_all(&inside).unwrap();
    assert!(validate_export_directory(&inside, &state.runs_directory).is_err());
    let canonical = validate_export_directory(&outside, &state.runs_directory).unwrap();
    state
        .change(|settings| {
            settings.default_export_directory = Some(canonical.to_string_lossy().into_owned());
            Ok(())
        })
        .unwrap();
    assert_eq!(default_export_directory(&state).unwrap(), Some(canonical));
    fs::remove_dir(outside).unwrap();
    assert!(default_export_directory(&state).is_err());
}
