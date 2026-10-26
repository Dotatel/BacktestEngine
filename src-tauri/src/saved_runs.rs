//! Durable successful-run records; numerical values are restored only from exact verified engine artifacts.
use crate::{execution, replay_receipt, workspace::ProjectRoot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[path = "saved_runs_catalog.rs"]
mod catalog;
#[path = "saved_runs_restore.rs"]
mod restore;
pub(crate) use catalog::{list_saved_runs, SavedRunPage};
pub(crate) use restore::{
    restore_selected_run, select_saved_run, SavedRunRequest, SavedRunSelection,
};

const VERSION: u32 = 1;
const MAX_RECORD_BYTES: u64 = 256 * 1024;
const MAX_RECEIPT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FROZEN_BYTES: u64 = 1024 * 1024 * 1024;

/// Core startup performs no history I/O; one expiring enumeration cursor is enough for the open project.
pub(crate) struct SavedRunState {
    pub runs_directory: PathBuf,
    pub selections_directory: PathBuf,
    scan: Mutex<Option<catalog::CatalogScan>>,
    opening: Mutex<bool>,
}

impl SavedRunState {
    /// Bind only native app-owned roots; no renderer-supplied directory can enter the store.
    pub(crate) fn new(runs_directory: PathBuf, selections_directory: PathBuf) -> Self {
        Self {
            runs_directory,
            selections_directory,
            scan: Mutex::new(None),
            opening: Mutex::new(false),
        }
    }
}

/// Bound aggregate verification work to one opening per native state, releasing on success and every error.
struct SavedRunOpenGuard<'a>(&'a SavedRunState);

impl Drop for SavedRunOpenGuard<'_> {
    /// No process is started; only the saved-run verification latch is released.
    fn drop(&mut self) {
        if let Ok(mut opening) = self.0.opening.lock() {
            *opening = false;
        }
    }
}

/// Acquire before project snapshots or disk reads; concurrent selection/recovery fails without changing state.
fn acquire_opening(state: &SavedRunState) -> Result<SavedRunOpenGuard<'_>, String> {
    let mut opening = state
        .opening
        .lock()
        .map_err(|_| "Saved-run opening state is busy.")?;
    if *opening {
        return Err("A saved run is already opening. Wait for it to finish.".into());
    }
    *opening = true;
    Ok(SavedRunOpenGuard(state))
}

/// Fixed artifact names belong to the schema, not serialized paths that could escape a run folder.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredFile {
    sha256: String,
    size_bytes: u64,
}

/// Immutable completion metadata deliberately excludes account statistics, trades and equity samples.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletionRecord {
    version: u32,
    run_id: String,
    canonical_project_root: String,
    strategy: String,
    symbol: String,
    timeframe: String,
    build_revision: String,
    dataset_id: String,
    started_at: String,
    completed_at: String,
    duration_ms: u64,
    output: String,
    report: StoredFile,
    trades: StoredFile,
    open_positions: StoredFile,
    equity: Option<StoredFile>,
    receipt: StoredFile,
}

/// Metadata is only recorded history until selection revalidates every output and frozen input.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedRunSummary {
    pub run_id: String,
    pub completion_sha256: String,
    pub project_root: String,
    pub strategy: String,
    pub symbol: String,
    pub timeframe: String,
    pub completed_at: String,
    pub verification: &'static str,
}

/// Durable-save failure is separate from the engine's successful exit; callers retain its artifacts and prior selection.
#[derive(Debug)]
pub(crate) struct SavedRunCommitError(pub String);

impl std::fmt::Display for SavedRunCommitError {
    /// Explain that execution completed while the durable record did not, without reporting an engine failure.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Engine completed; saved-run record could not be committed: {}",
            self.0
        )
    }
}

/// Create one immutable record after existing successful report/receipt verification; never publish last-good here.
pub(crate) fn commit_successful_run(
    state: &SavedRunState,
    project: &ProjectRoot,
    run: &execution::ExecutionRunResult,
) -> Result<SavedRunSummary, SavedRunCommitError> {
    commit_record(state, project, run).map_err(SavedRunCommitError)
}

/// Hold output/receipt handles throughout hashing and atomic record creation, refusing incomplete or failed runs.
fn commit_record(
    state: &SavedRunState,
    project: &ProjectRoot,
    run: &execution::ExecutionRunResult,
) -> Result<SavedRunSummary, String> {
    if !run.success || run.status != "completed" || !run.errors.is_empty() {
        return Err("Only an accepted successful execution can be saved.".into());
    }
    let folder = run_folder(state, &run.run_id)?;
    if Path::new(&run.run_folder)
        .canonicalize()
        .map_err(|error| error.to_string())?
        != folder
    {
        return Err("Execution output does not belong to its exact native run folder.".into());
    }
    require_path(&run.report_json_path, &folder.join("report.json"))?;
    require_path(&run.trades_csv_path, &folder.join("trades.csv"))?;
    require_path(
        &run.open_positions_csv_path,
        &folder.join("open_positions.csv"),
    )?;
    let mut locks = Vec::new();
    let report = capture_file(&folder.join("report.json"), MAX_OUTPUT_BYTES, &mut locks)?;
    let receipt = capture_file(
        &folder.join("replay-inputs/receipt.json"),
        MAX_RECEIPT_BYTES,
        &mut locks,
    )?;
    if run.report_sha256.as_deref() != Some(report.sha256.as_str())
        || run.replay_receipt_sha256.as_deref() != Some(receipt.sha256.as_str())
    {
        return Err("Completion hashes differ from the accepted execution.".into());
    }
    let record = CompletionRecord {
        version: VERSION,
        run_id: run.run_id.clone(),
        canonical_project_root: project.directory().to_string_lossy().into_owned(),
        strategy: run.strategy.clone(),
        symbol: run.symbol.clone(),
        timeframe: run.timeframe.clone(),
        build_revision: run.build_revision.clone(),
        dataset_id: run.dataset_id.clone(),
        started_at: run.started_at.clone(),
        completed_at: run.completed_at.clone(),
        duration_ms: run.duration_ms,
        output: run.output.clone(),
        report,
        receipt,
        trades: capture_file(&folder.join("trades.csv"), MAX_OUTPUT_BYTES, &mut locks)?,
        open_positions: capture_file(
            &folder.join("open_positions.csv"),
            MAX_OUTPUT_BYTES,
            &mut locks,
        )?,
        equity: capture_equity(&folder, run, &mut locks)?,
    };
    validate_record(&record)?;
    restore::verify_captured_inputs(&folder, &record, &mut locks)?;
    let bytes = serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("Saved completion record exceeds its bound.".into());
    }
    write_new(&folder.join("completion.json"), &bytes)?;
    Ok(summary(&record, digest(&bytes), project))
}

/// Preserve an explicitly skipped equity file as absence, never an empty or invented series.
fn capture_equity(
    folder: &Path,
    run: &execution::ExecutionRunResult,
    locks: &mut Vec<fs::File>,
) -> Result<Option<StoredFile>, String> {
    let expected = folder.join("equity.csv");
    let Some(path) = run.equity_csv_path.as_ref() else {
        assert_absent(&expected)?;
        return Ok(None);
    };
    require_path(path, &expected)?;
    capture_file(&expected, MAX_OUTPUT_BYTES, locks).map(Some)
}

/// Canonical UUID filenames reject traversal, stream, absolute-path and alternate-spelling inputs.
fn validate_run_id(id: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| "Saved run id is not a native UUID.")?;
    if parsed.to_string() != id {
        return Err("Saved run id is not canonical.".into());
    }
    Ok(())
}

/// Resolve exactly one native child folder, refusing links in every ancestor before reads or writes.
fn run_folder(state: &SavedRunState, id: &str) -> Result<PathBuf, String> {
    validate_run_id(id)?;
    assert_plain_path(&state.runs_directory)?;
    let root = state
        .runs_directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let expected = root.join(id);
    assert_plain_path(&expected)?;
    let actual = expected.canonicalize().map_err(|error| error.to_string())?;
    if actual != expected
        || !fs::metadata(&actual)
            .map_err(|error| error.to_string())?
            .is_dir()
    {
        return Err("Saved run folder is redirected or unavailable.".into());
    }
    Ok(actual)
}

/// Paths already emitted by native execution must identify the exact fixed output file.
fn require_path(value: &str, expected: &Path) -> Result<(), String> {
    assert_plain_path(Path::new(value))?;
    if Path::new(value)
        .canonicalize()
        .map_err(|error| error.to_string())?
        != expected
    {
        return Err("Saved output has a foreign artifact path.".into());
    }
    Ok(())
}

/// Lock a bounded regular file against concurrent Windows writes/deletes and retain the same inspected handle.
fn open_locked(path: &Path) -> Result<fs::File, String> {
    assert_plain_path(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(path)
            .map_err(|error| format!("Saved evidence cannot be locked ({error})."))?;
        if !file
            .metadata()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            return Err("Saved evidence is not a regular file.".into());
        }
        Ok(file)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Saved-run write/delete exclusion requires Windows.".into())
    }
}

/// Read from an already locked handle with bounds before and during accumulation.
fn locked_bytes(file: &mut fs::File, maximum: u64) -> Result<Vec<u8>, String> {
    if file.metadata().map_err(|error| error.to_string())?.len() > maximum {
        return Err("Saved evidence exceeds its size limit.".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > maximum {
        return Err("Saved evidence exceeds its size limit.".into());
    }
    Ok(bytes)
}

/// Capture actual bytes under the retained lock, not a later reopened approximation.
fn capture_file(
    path: &Path,
    maximum: u64,
    locks: &mut Vec<fs::File>,
) -> Result<StoredFile, String> {
    let mut file = open_locked(path)?;
    let bytes = locked_bytes(&mut file, maximum)?;
    locks.push(file);
    Ok(StoredFile {
        sha256: digest(&bytes),
        size_bytes: bytes.len() as u64,
    })
}

/// Keep strict bounded metadata separate from report statistics; unknown versions and fields never get defaulted.
fn validate_record(record: &CompletionRecord) -> Result<(), String> {
    validate_run_id(&record.run_id)?;
    if record.version != VERSION
        || record.canonical_project_root.is_empty()
        || record.canonical_project_root.len() > 131072
        || record.output.chars().count() > execution::MAX_OUTPUT_CHARS + 32
    {
        return Err("Saved completion metadata is unsupported or exceeds its bounds.".into());
    }
    for value in [
        &record.strategy,
        &record.symbol,
        &record.timeframe,
        &record.build_revision,
        &record.dataset_id,
    ] {
        if value.trim().is_empty() || value.len() > 1024 {
            return Err("Saved completion identity is malformed.".into());
        }
    }
    let start = chrono::DateTime::parse_from_rfc3339(&record.started_at)
        .map_err(|_| "Saved start time is malformed.")?;
    let end = chrono::DateTime::parse_from_rfc3339(&record.completed_at)
        .map_err(|_| "Saved completion time is malformed.")?;
    if end < start {
        return Err("Saved completion precedes its start.".into());
    }
    for file in [&record.report, &record.trades, &record.open_positions]
        .into_iter()
        .chain(record.equity.iter())
    {
        validate_file(file, MAX_OUTPUT_BYTES)?;
    }
    validate_file(&record.receipt, MAX_RECEIPT_BYTES)
}

/// Hash declarations are bounded lowercase SHA-256 values and nonempty original files.
fn validate_file(file: &StoredFile, maximum: u64) -> Result<(), String> {
    if file.size_bytes == 0 || file.size_bytes > maximum || !valid_digest(&file.sha256) {
        return Err("Saved artifact hash or size is malformed.".into());
    }
    Ok(())
}

/// Read only fixed completion metadata; numerical reports are deliberately not parsed during catalog enumeration.
fn read_record(state: &SavedRunState, id: &str) -> Result<(CompletionRecord, String), String> {
    let folder = run_folder(state, id)?;
    let mut file = open_locked(&folder.join("completion.json"))?;
    let bytes = locked_bytes(&mut file, MAX_RECORD_BYTES)?;
    let record: CompletionRecord =
        serde_json::from_slice(&bytes).map_err(|_| "Saved completion record is malformed.")?;
    validate_record(&record)?;
    if record.run_id != id {
        return Err("Saved completion record has a different run id.".into());
    }
    Ok((record, digest(&bytes)))
}

/// Create an immutable record atomically, flushing first and never replacing an existing completion.
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Saved record has no parent.")?;
    assert_plain_path(path)?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    temporary.persist_noclobber(path).map_err(|error| {
        format!("Completion record already exists or cannot be committed ({error}).")
    })?;
    Ok(())
}

/// Emit only public selected-project identity and bounded non-numerical recorded metadata.
fn summary(record: &CompletionRecord, sha256: String, project: &ProjectRoot) -> SavedRunSummary {
    SavedRunSummary {
        run_id: record.run_id.clone(),
        completion_sha256: sha256,
        project_root: project.display().into(),
        strategy: record.strategy.clone(),
        symbol: record.symbol.clone(),
        timeframe: record.timeframe.clone(),
        completed_at: record.completed_at.clone(),
        verification: "recordedNotOpened",
    }
}

/// All completion and selection hashes use one canonical lowercase representation.
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Hash actual bounded bytes without serializing numerical values into completion records.
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Only NotFound means absent; permissions and I/O failures must never become skipped evidence or empty history.
fn metadata_boundary(
    result: std::io::Result<fs::Metadata>,
) -> Result<Option<fs::Metadata>, String> {
    match result {
        Ok(metadata) if is_reparse(&metadata) => {
            Err("Saved-run paths cannot traverse a reparse point.".into())
        }
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Saved-run metadata cannot be inspected ({error}).")),
    }
}

/// Check every ancestor without suppressing metadata errors, including an intended new pointer or skipped file.
fn assert_plain_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata = metadata_boundary(fs::symlink_metadata(ancestor))?;
        if ancestor != path && metadata.is_some_and(|value| !value.is_dir()) {
            return Err("Saved-run path has a non-directory ancestor.".into());
        }
    }
    Ok(())
}

/// A genuinely missing target is valid only after its existing ancestors have passed strict metadata checks.
fn optional_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    assert_plain_path(path)?;
    metadata_boundary(fs::symlink_metadata(path))
}

/// Explicit absence checks refuse existing objects, reparse points and all non-NotFound failures.
fn assert_absent(path: &Path) -> Result<(), String> {
    if optional_metadata(path)?.is_some() {
        return Err("Saved run has an unexpected artifact where absence was recorded.".into());
    }
    Ok(())
}

/// Windows junctions and symbolic links are equally redirected; portable checks still reject symbolic links.
fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(test)]
#[path = "saved_runs_tests.rs"]
mod tests;
