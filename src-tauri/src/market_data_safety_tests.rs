//! Isolated native import regressions; all sources are deliberately synthetic.
use super::*;
use serde_json::json;
use tempfile::TempDir;

/// Import one real-shaped CSV into a fresh synthetic storage directory.
fn imported_ticks() -> (TempDir, ImportedDataset) {
    let directory = TempDir::new().unwrap();
    let source = directory.path().join("ticks.csv");
    fs::write(&source, "time_utc,bid,ask\n2026-01-01T00:00:00Z,1.0,1.1\n").unwrap();
    let record = import_market_data(
        &directory.path().join("storage"),
        source.to_str().unwrap(),
        "ticks",
    )
    .unwrap();
    (directory, record)
}

#[test]
fn imported_bytes_are_verified_even_when_tampering_keeps_the_same_size() {
    let (directory, record) = imported_ticks();
    let storage = directory.path().join("storage");
    assert!(load_dataset(&storage, &record.id).is_ok());
    fs::write(
        &record.stored_path,
        "time_utc,bid,ask\n2026-01-01T00:00:00Z,9.0,9.1\n",
    )
    .unwrap();
    assert!(load_dataset(&storage, &record.id)
        .unwrap_err()
        .contains("provenance hash"));
}

#[test]
fn catalog_identity_path_kind_and_traversal_are_verified() {
    let (directory, record) = imported_ticks();
    let storage = directory.path().join("storage");
    let sidecar = storage.join(format!("{}.json", record.id));
    let original = fs::read(&sidecar).unwrap();
    for field in ["id", "storedPath", "kind"] {
        let mut changed: serde_json::Value = serde_json::from_slice(&original).unwrap();
        changed[field] = json!("invalid");
        fs::write(&sidecar, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(
            load_dataset(&storage, &record.id).is_err(),
            "Forged {field} was accepted"
        );
    }
    assert!(load_dataset(&storage, "../dataset-escape")
        .unwrap_err()
        .contains("identifier"));
    assert!(load_dataset(&storage, &record.stored_path)
        .unwrap_err()
        .contains("outside app-owned"));
}

#[test]
fn active_authority_paths_match_trimmed_case_insensitive_csharp_semantics() {
    let profile = json!({"specification_source_path":" source.json ","swap_time_authority_status":" AUTH_ENTICATED ","swap_time_authority_path":" swap.json ","usd_notional_conversion_rule":" fixed_base_to_usd ","commission_conversion_authority_path":" commission.json "});
    let references = active_symbol_spec_references(&profile).unwrap();
    assert_eq!(references.len(), 3);
    assert!(references.contains(&(
        "specification_source_path".to_string(),
        "source.json".to_string()
    )));
    assert!(references.contains(&(
        "swap_time_authority_path".to_string(),
        "swap.json".to_string()
    )));
    assert!(references.contains(&(
        "commission_conversion_authority_path".to_string(),
        "commission.json".to_string()
    )));
    let mut broken = profile;
    broken["commission_conversion_authority_path"] = serde_json::Value::Null;
    assert!(active_symbol_spec_references(&broken).is_err());
}

#[test]
fn failed_dependency_import_publishes_no_catalog_or_partial_bundle() {
    let directory = TempDir::new().unwrap();
    let profile = directory.path().join("profile.json");
    let bytes = serde_json::to_vec(&json!({"schema_version":"backtestengine.economic-symbol/v2","specification_source_path":"missing.json"})).unwrap();
    fs::write(&profile, &bytes).unwrap();
    let storage = directory.path().join("storage");
    assert!(import_symbol_spec(&storage, profile.to_str().unwrap())
        .unwrap_err()
        .contains("dependency"));
    assert!(list_symbol_specs(&storage).unwrap().is_empty());
    assert_eq!(fs::read(profile).unwrap(), bytes);
}

/// The declared import cap applies to actual file reads, including sparse oversized sources.
#[test]
fn actual_import_reads_enforce_cap_and_preserve_exact_accepted_bytes() {
    let directory = TempDir::new().unwrap();
    let file = directory.path().join("oversized.csv");
    fs::File::create(&file)
        .unwrap()
        .set_len(MAX_IMPORT_BYTES + 1)
        .unwrap();
    assert!(read_limited_bytes(&file, MAX_IMPORT_BYTES)
        .unwrap_err()
        .contains("too large"));
    assert!(import_market_data(
        &directory.path().join("storage"),
        file.to_str().unwrap(),
        "ticks"
    )
    .unwrap_err()
    .contains("larger"));
    let exact = b"exact bytes including \r\n";
    fs::write(&file, exact).unwrap();
    assert_eq!(
        read_limited_bytes(&file, exact.len() as u64).unwrap(),
        exact
    );
    assert!(read_limited_bytes(&file, exact.len() as u64 - 1).is_err());
}
