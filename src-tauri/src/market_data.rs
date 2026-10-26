//! Local historical market-data import and validation.
//!
//! The host owns file validation, canonicalization, size/shape checks and the copy into
//! app-owned storage. The original user file is never modified or overwritten; provenance
//! (original path, content hash, timestamp) is recorded in a sidecar JSON file.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path, path::PathBuf};

/// Maximum bytes one imported market-data file may contribute.
pub const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;

/// Maximum rows validated per import (shape check stops early but count is recorded).
pub const MAX_IMPORT_ROWS: usize = 5_000_000;

/// Bound metadata and actual bytes read, including a file that grows after its size check.
pub(crate) fn read_limited_bytes(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file =
        fs::File::open(path).map_err(|error| format!("The file could not be read ({error})."))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("The file size could not be read ({error})."))?;
    if metadata.len() > limit {
        return Err("The file is too large.".to_string());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("The file could not be read ({error})."))?;
    if bytes.len() as u64 > limit {
        return Err("The file is too large.".to_string());
    }
    Ok(bytes)
}

/// Imported dataset record persisted with content provenance.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDataset {
    pub id: String,
    pub original_path: String,
    pub stored_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub kind: String,
    pub row_count: usize,
    pub imported_at: String,
}

/// Imported symbol specification record persisted with content provenance.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSymbolSpec {
    pub id: String,
    pub original_path: String,
    pub stored_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub schema_version: String,
    pub imported_at: String,
}

/// One registered dependency in a symbol-spec manifest.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SymbolSpecDependency {
    pub field: String,
    pub relative: String,
    pub absolute: String,
    pub sha256: String,
}

/// Typed dependency manifest for an imported symbol specification.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SymbolSpecDependencyManifest {
    pub id: String,
    pub original_path: String,
    pub original_sha256: String,
    pub stored_path: String,
    pub derived_sha256: String,
    pub dependencies: Vec<SymbolSpecDependency>,
    pub imported_at: String,
}

/// Returns the active authority references declared by a symbol specification.
///
/// Conditional references follow the original C# validator: the commission
/// authority is active only for `fixed_base_to_usd`, and the swap authority is
/// active only when its status is `Authenticated`.
pub fn active_symbol_spec_references(
    document: &serde_json::Value,
) -> Result<Vec<(String, String)>, String> {
    let mut references = vec![(
        "specification_source_path".to_string(),
        required_reference(document, "specification_source_path")?,
    )];
    let usd_rule = document
        .get("usd_notional_conversion_rule")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if usd_rule == "fixed_base_to_usd"
        && document
            .get("commission_conversion_authority_path")
            .is_some()
    {
        references.push((
            "commission_conversion_authority_path".to_string(),
            required_reference(document, "commission_conversion_authority_path")?,
        ));
    }
    let swap_status = document
        .get("swap_time_authority_status")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if swap_status
        .replace('_', "")
        .eq_ignore_ascii_case("Authenticated")
    {
        references.push((
            "swap_time_authority_path".to_string(),
            required_reference(document, "swap_time_authority_path")?,
        ));
    }
    Ok(references)
}

/// Match the retained C# RequiredString contract, including whitespace trimming.
fn required_reference(document: &serde_json::Value, field: &str) -> Result<String, String> {
    document
        .get(field)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("The symbol specification requires a non-empty {field}."))
}

/// Validates and imports one historical CSV into app-owned storage.
pub fn import_market_data(
    storage_directory: &Path,
    original_path: &str,
    kind: &str,
) -> Result<ImportedDataset, String> {
    if kind != "ticks" && kind != "bars" {
        return Err("Market data kind must be 'ticks' or 'bars'.".to_string());
    }
    let original = Path::new(original_path);
    let metadata = fs::metadata(original)
        .map_err(|error| format!("The market data file could not be read ({error})."))?;
    if !metadata.is_file() {
        return Err("The selected market data path is not a file.".to_string());
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(format!(
            "The market data file is larger than {} MB.",
            MAX_IMPORT_BYTES / (1024 * 1024)
        ));
    }
    let canonical_original = original
        .canonicalize()
        .map_err(|error| format!("The market data path could not be resolved ({error})."))?;
    let extension = canonical_original
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "csv" {
        return Err("Historical market data must be a .csv file.".to_string());
    }

    let bytes = read_limited_bytes(&canonical_original, MAX_IMPORT_BYTES)
        .map_err(|error| format!("The market data file could not be read ({error})."))?;
    if bytes.is_empty() {
        return Err("The market data file is empty.".to_string());
    }
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| "The market data file is not valid UTF-8.".to_string())?;
    let (header, row_count) = validate_shape(&text, kind)?;
    let _ = header;

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha256 = format!("{:x}", hasher.finalize());

    fs::create_dir_all(storage_directory)
        .map_err(|error| format!("The app market data folder could not be created ({error})."))?;
    let id = format!(
        "dataset-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        &sha256[..8]
    );
    let stored_path = storage_directory.join(format!("{id}.csv"));
    if stored_path.exists() {
        return Err("A dataset with that id already exists; retry the import.".to_string());
    }
    fs::write(&stored_path, &bytes).map_err(|error| {
        format!("The market data could not be copied into app storage ({error}).")
    })?;

    let imported_at = chrono::Utc::now().to_rfc3339();
    let record = ImportedDataset {
        id: id.clone(),
        original_path: canonical_original.to_string_lossy().to_string(),
        stored_path: stored_path.to_string_lossy().to_string(),
        sha256,
        size_bytes: bytes.len() as u64,
        kind: kind.to_string(),
        row_count,
        imported_at,
    };
    let sidecar = storage_directory.join(format!("{id}.json"));
    let sidecar_bytes = serde_json::to_vec_pretty(&record)
        .map_err(|error| format!("The dataset provenance could not be written ({error})."))?;
    fs::write(&sidecar, sidecar_bytes)
        .map_err(|error| format!("The dataset provenance could not be written ({error})."))?;
    Ok(record)
}

/// Validates CSV shape and returns the header plus data row count.
fn validate_shape(text: &str, kind: &str) -> Result<(Vec<String>, usize), String> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let mut lines = text.lines();
    let header_line = lines
        .next()
        .ok_or_else(|| "The market data file has no header row.".to_string())?
        .trim_end_matches('\r');
    let header: Vec<String> = header_line
        .split(',')
        .map(|value| value.trim().to_string())
        .collect();
    let required = if kind == "ticks" { 3 } else { 5 };
    if header.len() < required {
        return Err(format!(
            "The market data header must contain at least {required} columns."
        ));
    }
    let mut row_count = 0usize;
    for (index, raw_line) in lines.enumerate() {
        let line = raw_line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        row_count += 1;
        if row_count > MAX_IMPORT_ROWS {
            return Err(format!(
                "The market data file exceeds {MAX_IMPORT_ROWS} rows."
            ));
        }
        validate_row(line, kind)
            .map_err(|error| format!("Market data row {} is invalid: {error}", index + 2))?;
    }
    if row_count == 0 {
        return Err("The market data file contains no data rows.".to_string());
    }
    Ok((header, row_count))
}

/// Validates one data row's parseability.
fn validate_row(line: &str, kind: &str) -> Result<(), String> {
    let parts: Vec<&str> = line.split(',').collect();
    let required = if kind == "ticks" { 3 } else { 5 };
    if parts.len() < required {
        return Err(format!(
            "A market data row must contain at least {required} columns."
        ));
    }
    if kind == "ticks" {
        let time = parts[0].trim();
        if time.is_empty() {
            return Err("A tick row has an empty timestamp.".to_string());
        }
        if parse_utc_instant(time).is_none() {
            return Err("A tick row has an invalid timestamp.".to_string());
        }
        let bid: f64 = parts[1]
            .trim()
            .parse()
            .map_err(|_| "A tick row has an invalid bid value.".to_string())?;
        let ask: f64 = parts[2]
            .trim()
            .parse()
            .map_err(|_| "A tick row has an invalid ask value.".to_string())?;
        if !bid.is_finite() || !ask.is_finite() || bid < 0.0 || ask < bid {
            return Err("A tick row has a non-finite or invalid bid/ask.".to_string());
        }
    } else {
        let time = parts[0].trim();
        if time.is_empty() {
            return Err("A bar row has an empty timestamp.".to_string());
        }
        if parse_utc_instant(time).is_none() {
            return Err("A bar row has an invalid timestamp.".to_string());
        }
        let values: Vec<f64> = (1..5)
            .map(|index| {
                parts[index]
                    .trim()
                    .parse::<f64>()
                    .map_err(|_| "A bar row has an invalid OHLC value.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        for value in &values {
            if !value.is_finite() {
                return Err("A bar row has a non-finite OHLC value.".to_string());
            }
        }
        let (open, high, low, close) = (values[0], values[1], values[2], values[3]);
        if high < low || high < open || high < close || low > open || low > close {
            return Err("A bar row has inconsistent OHLC values.".to_string());
        }
    }
    Ok(())
}

/// Parses a UTC instant from an ISO-8601 or date-only string.
fn parse_utc_instant(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(dt.with_timezone(&chrono::Utc));
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S") {
        return Some(dt.and_utc());
    }
    None
}

/// Read a single typed dataset receipt and bind its id, path, kind, size and SHA-256.
pub fn load_dataset(
    storage_directory: &Path,
    dataset_id: &str,
) -> Result<(PathBuf, ImportedDataset), String> {
    if Path::new(dataset_id).is_absolute() {
        return Err(
            "The dataset is outside app-owned storage; select an imported dataset id.".to_string(),
        );
    }
    if dataset_id.is_empty()
        || dataset_id.contains(['/', '\\'])
        || !dataset_id.starts_with("dataset-")
    {
        return Err("The dataset identifier is invalid; select an imported dataset.".to_string());
    }
    let sidecar = storage_directory.join(format!("{dataset_id}.json"));
    let bytes = read_limited_bytes(&sidecar, MAX_IMPORT_BYTES)
        .map_err(|error| format!("Dataset provenance is missing or unreadable ({error})."))?;
    let record: ImportedDataset = serde_json::from_slice(&bytes)
        .map_err(|_| "The dataset provenance is damaged.".to_string())?;
    if record.id != dataset_id || !matches!(record.kind.as_str(), "ticks" | "bars") {
        return Err("The dataset provenance identity or kind is damaged.".to_string());
    }
    let canonical = Path::new(&record.stored_path)
        .canonicalize()
        .map_err(|error| format!("The dataset file could not be resolved ({error})."))?;
    let storage = storage_directory
        .canonicalize()
        .map_err(|error| format!("The storage directory could not be resolved ({error})."))?;
    let expected = storage.join(format!("{dataset_id}.csv"));
    if !canonical.starts_with(&storage) || canonical != expected {
        return Err(
            "The dataset provenance path does not match its registered identity.".to_string(),
        );
    }
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("The dataset could not be read ({error})."))?;
    if !metadata.is_file()
        || metadata.len() > MAX_IMPORT_BYTES
        || metadata.len() != record.size_bytes
    {
        return Err("The dataset content does not match its provenance size.".to_string());
    }
    let file_bytes = read_limited_bytes(&canonical, MAX_IMPORT_BYTES)
        .map_err(|error| format!("The dataset could not be read ({error})."))?;
    if file_bytes.len() as u64 != record.size_bytes
        || format!("{:x}", Sha256::digest(&file_bytes)) != record.sha256
    {
        return Err("The dataset content does not match its provenance hash.".to_string());
    }
    let text = std::str::from_utf8(&file_bytes)
        .map_err(|_| "The dataset content is not valid UTF-8.".to_string())?;
    let (_, row_count) = validate_shape(text, &record.kind)?;
    if row_count != record.row_count {
        return Err("The dataset row count does not match its provenance.".to_string());
    }
    Ok((canonical, record))
}

/// Lists imported datasets from the durable sidecar catalog.
pub fn list_datasets(storage_directory: &Path) -> Result<Vec<ImportedDataset>, String> {
    let mut records = Vec::new();
    if !storage_directory.is_dir() {
        return Ok(records);
    }
    let read = fs::read_dir(storage_directory)
        .map_err(|error| format!("The market data folder could not be read ({error})."))?;
    for entry in read.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        if let Ok(bytes) = read_limited_bytes(&path, MAX_IMPORT_BYTES) {
            if let Ok(record) = serde_json::from_slice::<ImportedDataset>(&bytes) {
                records.push(record);
            }
        }
    }
    records.sort_by(|left, right| left.imported_at.cmp(&right.imported_at));
    Ok(records)
}

/// Imports one symbol specification into an app-owned derived profile.
///
/// The original profile and its authority files are never modified. Active
/// authority references are resolved to canonical absolute paths in the derived
/// profile; those original dependencies must remain available. The bundle becomes
/// visible only after all of its files have been written.
#[allow(clippy::vec_init_then_push)]
pub fn import_symbol_spec(
    storage_directory: &Path,
    original_path: &str,
) -> Result<ImportedSymbolSpec, String> {
    let original = Path::new(original_path);
    let metadata = fs::metadata(original)
        .map_err(|error| format!("The symbol specification could not be read ({error})."))?;
    if !metadata.is_file() {
        return Err("The selected symbol specification is not a file.".to_string());
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err("The symbol specification is too large.".to_string());
    }
    let canonical_original = original.canonicalize().map_err(|error| {
        format!("The symbol specification path could not be resolved ({error}).")
    })?;
    let extension = canonical_original
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "json" {
        return Err("The symbol specification must be a JSON file.".to_string());
    }
    let bytes = read_limited_bytes(&canonical_original, MAX_IMPORT_BYTES)
        .map_err(|error| format!("The symbol specification could not be read ({error})."))?;
    let mut document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The symbol specification is not valid JSON.".to_string())?;
    let schema_version = document
        .get("schema_version")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "The symbol specification is missing schema_version.".to_string())?
        .to_string();
    if schema_version != "backtestengine.economic-symbol/v2" {
        return Err(format!(
            "Unsupported symbol specification schema_version '{schema_version}'."
        ));
    }

    let original_dir = canonical_original
        .parent()
        .ok_or_else(|| "The symbol specification path is invalid.".to_string())?;

    // Resolve only the active authority references, using the C# validator's
    // conditional rules. Original files are read, never written.
    let active_refs = active_symbol_spec_references(&document)?;
    let mut resolved: Vec<(String, String, String)> = Vec::new(); // field, relative, absolute
    for (field, relative) in active_refs {
        let absolute = original_dir
            .join(&relative)
            .canonicalize()
            .map_err(|error| {
                format!("The authority dependency '{field}' could not be resolved ({error}).")
            })?;
        if !absolute.is_file() {
            return Err(format!("The authority dependency '{field}' is missing."));
        }
        let metadata = fs::metadata(&absolute)
            .map_err(|error| format!("The authority dependency could not be read ({error})."))?;
        if metadata.len() > MAX_IMPORT_BYTES {
            return Err("The authority dependency is too large.".to_string());
        }
        resolved.push((field, relative, absolute.to_string_lossy().to_string()));
    }

    // Normalize the active root reference fields to canonical absolute paths.
    if let Some(object) = document.as_object_mut() {
        for (field, _relative, absolute) in &resolved {
            object.insert(field.clone(), serde_json::Value::String(absolute.clone()));
        }
    }

    let derived_bytes = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("The derived profile could not be serialized ({error})."))?;

    let bundle_id = uuid::Uuid::new_v4();
    let symbol_specs_root = storage_directory.join("symbol_specs");
    fs::create_dir_all(&symbol_specs_root).map_err(|error| {
        format!("The app symbol specification folder could not be created ({error}).")
    })?;
    let final_bundle = symbol_specs_root.join(format!("symbol-spec-{bundle_id}"));
    let staging = tempfile::Builder::new()
        .prefix("symbol-spec-")
        .tempdir_in(&symbol_specs_root)
        .map_err(|error| format!("The staging folder could not be created ({error})."))?;

    let stored_root = staging.path().join("profile.json");
    fs::write(&stored_root, &derived_bytes)
        .map_err(|error| format!("The derived profile could not be written ({error})."))?;

    let mut original_hasher = Sha256::new();
    original_hasher.update(&bytes);
    let original_hash = format!("{:x}", original_hasher.finalize());
    let mut derived_hasher = Sha256::new();
    derived_hasher.update(&derived_bytes);
    let derived_hash = format!("{:x}", derived_hasher.finalize());

    let mut dependency_records: Vec<SymbolSpecDependency> = Vec::new();
    for (field, relative, absolute) in &resolved {
        let dep_bytes = read_limited_bytes(Path::new(absolute), MAX_IMPORT_BYTES)
            .map_err(|error| format!("The authority dependency could not be read ({error})."))?;
        let mut dep_hasher = Sha256::new();
        dep_hasher.update(&dep_bytes);
        dependency_records.push(SymbolSpecDependency {
            field: field.clone(),
            relative: relative.clone(),
            absolute: absolute.clone(),
            sha256: format!("{:x}", dep_hasher.finalize()),
        });
    }

    let id = format!("symbol-spec-{bundle_id}");
    let imported_at = chrono::Utc::now().to_rfc3339();
    let record = ImportedSymbolSpec {
        id: id.clone(),
        original_path: canonical_original.to_string_lossy().to_string(),
        stored_path: final_bundle
            .join("profile.json")
            .to_string_lossy()
            .to_string(),
        sha256: derived_hash.clone(),
        size_bytes: derived_bytes.len() as u64,
        schema_version,
        imported_at: imported_at.clone(),
    };

    let provenance_path = staging.path().join("provenance.json");
    let provenance_bytes = serde_json::to_vec_pretty(&record).map_err(|error| {
        format!("The symbol specification provenance could not be written ({error}).")
    })?;
    fs::write(&provenance_path, provenance_bytes).map_err(|error| {
        format!("The symbol specification provenance could not be written ({error}).")
    })?;

    let dependency_manifest = SymbolSpecDependencyManifest {
        id: id.clone(),
        original_path: canonical_original.to_string_lossy().to_string(),
        original_sha256: original_hash,
        stored_path: final_bundle
            .join("profile.json")
            .to_string_lossy()
            .to_string(),
        derived_sha256: derived_hash,
        dependencies: dependency_records,
        imported_at: imported_at.clone(),
    };
    let dependency_path = staging.path().join("dependencies.json");
    let dependency_bytes = serde_json::to_vec_pretty(&dependency_manifest).map_err(|error| {
        format!("The symbol specification dependency manifest could not be written ({error}).")
    })?;
    fs::write(&dependency_path, dependency_bytes).map_err(|error| {
        format!("The symbol specification dependency manifest could not be written ({error}).")
    })?;

    // Atomic catalog visibility: publish the complete bundle with one rename.
    fs::rename(staging.path(), &final_bundle).map_err(|error| {
        format!("The symbol specification bundle could not be published ({error}).")
    })?;
    let _ = staging.keep();

    Ok(record)
}
/// Reads one ImportedSymbolSpec from a provenance file, if present.
fn collect_symbol_spec_record(path: &Path, records: &mut Vec<ImportedSymbolSpec>) {
    let provenance = if path.is_dir() {
        path.join("provenance.json")
    } else {
        path.to_path_buf()
    };
    if !provenance.is_file() {
        return;
    }
    let Ok(bytes) = read_limited_bytes(&provenance, MAX_IMPORT_BYTES) else {
        return;
    };
    let Ok(record) = serde_json::from_slice::<ImportedSymbolSpec>(&bytes) else {
        return;
    };
    records.push(record);
}

/// List only complete published symbol specification registration records.
pub fn list_symbol_specs(storage_directory: &Path) -> Result<Vec<ImportedSymbolSpec>, String> {
    let mut records = Vec::new();
    let target_directory = storage_directory.join("symbol_specs");
    if !target_directory.is_dir() {
        return Ok(records);
    }
    let read = fs::read_dir(&target_directory)
        .map_err(|error| format!("The symbol specification folder could not be read ({error})."))?;
    for entry in read.filter_map(Result::ok) {
        collect_symbol_spec_record(&entry.path(), &mut records);
    }
    records.sort_by(|left, right| left.imported_at.cmp(&right.imported_at));
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn import_validates_shape_and_copies_file() {
        let storage = TempDir::new().unwrap();
        let source_dir = TempDir::new().unwrap();
        let source = source_dir.path().join("ticks.csv");
        fs::write(&source, "time_utc,bid,ask\n2026-01-01T00:00:00Z,1.0,1.1\n").unwrap();
        let record = import_market_data(storage.path(), source.to_str().unwrap(), "ticks").unwrap();
        assert_eq!(record.row_count, 1);
        assert!(Path::new(&record.stored_path).is_file());
        assert!(storage.path().join(format!("{}.json", record.id)).is_file());
        // original untouched
        assert!(source.is_file());
    }

    #[test]
    fn import_rejects_bad_shape() {
        let storage = TempDir::new().unwrap();
        let source_dir = TempDir::new().unwrap();
        let source = source_dir.path().join("bad.csv");
        fs::write(&source, "time_utc,bid,ask\nbad,row\n").unwrap();
        let error =
            import_market_data(storage.path(), source.to_str().unwrap(), "ticks").unwrap_err();
        assert!(error.contains("invalid bid") || error.contains("columns"));
    }

    #[test]
    fn load_dataset_enforces_containment() {
        let storage = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("x.csv");
        fs::write(&outside_file, "a,b,c\n1,2,3\n").unwrap();
        let error = load_dataset(storage.path(), outside_file.to_str().unwrap()).unwrap_err();
        assert!(error.contains("outside app-owned storage"));
    }
}

#[cfg(test)]
#[path = "market_data_safety_tests.rs"]
mod safety_tests;
