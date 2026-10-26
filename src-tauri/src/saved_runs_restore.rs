//! Reopen frozen evidence without running an engine, borrowing current source or trusting serialized statistics.
use super::*;
use crate::{
    market_data,
    replay_receipt::{FrozenFile, FrozenReplayReceipt},
    WorkspaceState,
};
use std::collections::{BTreeMap, BTreeSet};

/// Native-only seam: reuse strict apply_report with seeded identity and pure receipt/report control checks.
/// The caller holds all output/receipt/input handles against writes/deletes throughout this synchronous call.
pub(crate) type RestoreParser = fn(
    &execution::ExecutionRunResult,
    &FrozenReplayReceipt,
    &Path,
    &Path,
) -> Result<execution::ExecutionRunResult, String>;

/// Renderer values are only a public project expectation and an exact native-issued UUID/hash capability.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavedRunRequest {
    pub project_root: String,
    pub run_id: String,
    pub completion_sha256: String,
}

/// Frozen dataset identity excludes mutable catalog paths and original private source paths.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedDataset {
    id: String,
    sha256: String,
    kind: String,
    row_count: usize,
    size_bytes: u64,
}

/// Frozen profile identity is available without reopening any original economics authority path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedProfile {
    id: String,
    sha256: String,
    schema_version: String,
}

/// Captured authority hashes identify evidence; original absolute paths never leave this native view.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedAuthority {
    sha256: String,
    size_bytes: u64,
}

/// Actual settings come directly from the verified receipt, never from current controls or defaults.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedRunInputs {
    settings: replay_receipt::ReplaySettings,
    commission_terms: replay_receipt::CommissionTerms,
    dataset: SavedDataset,
    profile: SavedProfile,
    approved_artifact_sha256: String,
    approved_runtime_sha256: BTreeMap<String, String>,
    source_manifest_sha256: String,
    source_file_count: usize,
    authorities: Vec<SavedAuthority>,
}

/// Rehydrated numerical values are strictly parsed original outputs; frozen controls remain separate evidence.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedRunSelection {
    pub project_root: String,
    pub completion_sha256: String,
    pub run: execution::ExecutionRunResult,
    pub inputs: SavedRunInputs,
}

/// Only one small mutable selection pointer exists per canonical project; it contains no statistics.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectedPointer {
    version: u32,
    canonical_project_root: String,
    run_id: String,
    completion_sha256: String,
}

/// Native last-good changes during verification cause a stale-selection error instead of overwriting a newer run.
#[derive(PartialEq)]
struct SlotIdentity {
    project: Option<String>,
    run_id: Option<String>,
    report_sha256: Option<String>,
}

/// Locks are retained through strict parse and publication, including original frozen copies but no live authorities.
struct PreparedSavedRun {
    folder: PathBuf,
    record: CompletionRecord,
    completion_sha256: String,
    receipt: FrozenReplayReceipt,
    _locks: Vec<fs::File>,
}

/// Select only a native UUID and expected immutable record hash for the currently open project.
pub(crate) fn select_saved_run(
    state: &SavedRunState,
    execution: &execution::ExecutionState,
    workspace: &WorkspaceState,
    request: &SavedRunRequest,
    parse: RestoreParser,
) -> Result<SavedRunSelection, String> {
    let _opening = acquire_opening(state)?;
    let project = selected_project(workspace, &request.project_root)?;
    let snapshot = capture_slot(execution)?;
    select_with_snapshot(
        state, execution, workspace, project, snapshot, request, parse,
    )
}

/// Use the caller's original selection snapshot across pointer reads as well as expensive evidence verification.
fn select_with_snapshot(
    state: &SavedRunState,
    execution: &execution::ExecutionState,
    workspace: &WorkspaceState,
    project: ProjectRoot,
    snapshot: SlotIdentity,
    request: &SavedRunRequest,
    parse: RestoreParser,
) -> Result<SavedRunSelection, String> {
    assert_plain_path(&execution.runs_directory)?;
    if execution
        .runs_directory
        .canonicalize()
        .map_err(|error| error.to_string())?
        != state
            .runs_directory
            .canonicalize()
            .map_err(|error| error.to_string())?
    {
        return Err("Saved-run storage differs from native execution storage.".into());
    }
    let prepared = prepare_reopen(state, &project, &request.run_id, &request.completion_sha256)?;
    let run = parse_locked(&prepared, project.display(), parse)?;
    publish_selection(
        state, execution, workspace, &project, &snapshot, &prepared, &run,
    )?;
    Ok(SavedRunSelection {
        project_root: project.display().into(),
        completion_sha256: prepared.completion_sha256,
        run,
        inputs: public_inputs(prepared.receipt),
    })
}

/// Restore only the explicit durable pointer for the opened project; never guess a recent run or rerun an engine.
pub(crate) fn restore_selected_run(
    state: &SavedRunState,
    execution: &execution::ExecutionState,
    workspace: &WorkspaceState,
    expected_project: &str,
    parse: RestoreParser,
) -> Result<Option<SavedRunSelection>, String> {
    let _opening = acquire_opening(state)?;
    let project = selected_project(workspace, expected_project)?;
    let snapshot = capture_slot(execution)?;
    let path = pointer_path(state, &project);
    if optional_metadata(&path)?.is_none() {
        return Ok(None);
    }
    let mut file = open_locked(&path)?;
    let pointer: SelectedPointer =
        serde_json::from_slice(&locked_bytes(&mut file, MAX_RECORD_BYTES)?)
            .map_err(|_| "Saved selection pointer is malformed.")?;
    validate_pointer(&pointer, &project)?;
    drop(file);
    let request = SavedRunRequest {
        project_root: expected_project.into(),
        run_id: pointer.run_id,
        completion_sha256: pointer.completion_sha256,
    };
    select_with_snapshot(
        state, execution, workspace, project, snapshot, &request, parse,
    )
    .map(Some)
}

/// Resolve only host-selected project identity; renderer strings are equality expectations, never opened paths.
pub(super) fn selected_project(
    workspace: &WorkspaceState,
    expected: &str,
) -> Result<ProjectRoot, String> {
    let project = workspace
        .selected
        .lock()
        .map_err(|_| "Workspace state is busy.")?
        .clone()
        .ok_or("Open a project before browsing saved runs.")?;
    if project.display() != expected {
        return Err("Selected project changed. Refresh saved runs.".into());
    }
    Ok(project)
}

/// Refuse active execution before disk work and snapshot the coherent publisher slot in its established order.
fn capture_slot(execution: &execution::ExecutionState) -> Result<SlotIdentity, String> {
    let running = execution
        .running
        .lock()
        .map_err(|_| "Execution state is busy.")?;
    if *running {
        return Err("Wait for or cancel the active execution before selecting a saved run.".into());
    }
    let project = execution
        .last_good_project
        .lock()
        .map_err(|_| "Execution state is busy.")?;
    let last = execution
        .last_good
        .lock()
        .map_err(|_| "Execution state is busy.")?;
    Ok(slot_identity(&project, last.as_ref()))
}

/// Keep stored numerical objects out of identity comparisons and persistence transactions.
fn slot_identity(
    project: &Option<String>,
    last: Option<&execution::ExecutionRunResult>,
) -> SlotIdentity {
    SlotIdentity {
        project: project.clone(),
        run_id: last.map(|run| run.run_id.clone()),
        report_sha256: last.and_then(|run| run.report_sha256.clone()),
    }
}

/// Authenticate metadata first, then hold each exact raw output and receipt before allowing any parser call.
fn prepare_reopen(
    state: &SavedRunState,
    project: &ProjectRoot,
    id: &str,
    expected_hash: &str,
) -> Result<PreparedSavedRun, String> {
    if !valid_digest(expected_hash) {
        return Err("Saved completion hash is malformed.".into());
    }
    let folder = run_folder(state, id)?;
    let mut file = open_locked(&folder.join("completion.json"))?;
    let bytes = locked_bytes(&mut file, MAX_RECORD_BYTES)?;
    if digest(&bytes) != expected_hash {
        return Err("Saved completion changed since it was selected.".into());
    }
    let record: CompletionRecord =
        serde_json::from_slice(&bytes).map_err(|_| "Saved completion record is malformed.")?;
    validate_record(&record)?;
    if record.run_id != id || !project.matches_canonical_identity(&record.canonical_project_root) {
        return Err("Saved run belongs to a different project or run identity.".into());
    }
    let mut locks = vec![file];
    verify_outputs(&folder, &record, &mut locks)?;
    let receipt = verify_captured_inputs(&folder, &record, &mut locks)?;
    Ok(PreparedSavedRun {
        folder,
        record,
        completion_sha256: expected_hash.into(),
        receipt,
        _locks: locks,
    })
}

/// An absent skipped equity file must remain absent; every existing output retains its completion digest.
fn verify_outputs(
    folder: &Path,
    record: &CompletionRecord,
    locks: &mut Vec<fs::File>,
) -> Result<(), String> {
    for (name, expected) in [
        ("report.json", &record.report),
        ("trades.csv", &record.trades),
        ("open_positions.csv", &record.open_positions),
    ] {
        verify_locked(&folder.join(name), expected, MAX_OUTPUT_BYTES, locks)?;
    }
    if let Some(equity) = &record.equity {
        return verify_locked(&folder.join("equity.csv"), equity, MAX_OUTPUT_BYTES, locks);
    }
    assert_absent(&folder.join("equity.csv"))
}

/// Verify captured copies only; reading historical evidence does not reopen original authority paths.
pub(super) fn verify_captured_inputs(
    folder: &Path,
    record: &CompletionRecord,
    locks: &mut Vec<fs::File>,
) -> Result<FrozenReplayReceipt, String> {
    let root = folder.join("replay-inputs");
    let bytes = verify_locked_bytes(
        &root.join("receipt.json"),
        &record.receipt,
        MAX_RECEIPT_BYTES,
        locks,
    )?;
    let receipt: FrozenReplayReceipt =
        serde_json::from_slice(&bytes).map_err(|_| "Saved replay receipt is malformed.")?;
    validate_receipt(&receipt, record)?;
    let mut paths = BTreeSet::new();
    for file in receipt.files.iter().chain(
        receipt
            .authorities
            .iter()
            .map(|authority| &authority.frozen),
    ) {
        if !paths.insert(&file.relative_path) {
            return Err("Saved receipt has duplicate frozen file paths.".into());
        }
        verify_frozen_file(&root, file, locks)?;
    }
    validate_required_files(&receipt)?;
    if replay_receipt::source_manifest(&root.join("runner"))? != receipt.source_manifest {
        return Err("Saved source tree differs from its exact source manifest.".into());
    }
    Ok(receipt)
}

/// Bound all untrusted receipt declarations before I/O and bind controls to the accepted completion identity.
fn validate_receipt(
    receipt: &FrozenReplayReceipt,
    record: &CompletionRecord,
) -> Result<(), String> {
    if receipt.build_configuration != "Release" {
        return Err("Saved receipt does not preserve the approved Release configuration.".into());
    }
    if receipt.version != replay_receipt::RECEIPT_VERSION
        || receipt.execution_run_id != record.run_id
        || receipt.canonical_project_root != record.canonical_project_root
        || receipt.build_revision != record.build_revision
        || receipt.dataset.id != record.dataset_id
        || receipt.settings.strategy != record.strategy
        || !receipt.settings.symbol.eq_ignore_ascii_case(&record.symbol)
        || receipt.settings.write_equity_csv != record.equity.is_some()
        || receipt.approved_runtime_sha256.len() != 3
        || !matches!(receipt.dataset.kind.as_str(), "ticks" | "bars")
        || receipt.files.len() > 4104
        || receipt.authorities.len() > 16
        || receipt.source_manifest.files.len() > 4096
    {
        return Err("Saved receipt differs from completion identity or exceeds its bounds.".into());
    }
    let total = receipt
        .files
        .iter()
        .chain(receipt.authorities.iter().map(|item| &item.frozen))
        .try_fold(0u64, |total, file| {
            total
                .checked_add(file.size_bytes)
                .ok_or("Saved frozen byte count overflowed.")
        })?;
    if total > MAX_FROZEN_BYTES {
        return Err("Saved frozen inputs exceed 1 GiB.".into());
    }
    for authority in &receipt.authorities {
        if authority.sha256 != authority.frozen.sha256
            || authority.size_bytes != authority.frozen.size_bytes
        {
            return Err("Saved authority differs from its captured copy.".into());
        }
    }
    Ok(())
}

/// Required original source/runtime/profile/data roles are fixed; no missing capture is reconstructed.
fn validate_required_files(receipt: &FrozenReplayReceipt) -> Result<(), String> {
    for (name, hash) in [
        (
            "binary/WorkspaceCompile.dll",
            &receipt.approved_artifact_sha256,
        ),
        ("market.csv", &receipt.dataset.sha256),
        ("profile.json", &receipt.profile.sha256),
    ] {
        let file = required_file(receipt, name)?;
        if file.sha256 != *hash {
            return Err("Saved frozen role has a different approved hash.".into());
        }
    }
    if required_file(receipt, "market.csv")?.size_bytes != receipt.dataset.size_bytes
        || required_file(receipt, "profile.json")?.size_bytes != receipt.profile.size_bytes
    {
        return Err("Saved dataset/profile size differs from its frozen copy.".into());
    }
    for name in [
        "BacktestEngine.CAlgoShim.dll",
        "WorkspaceCompile.deps.json",
        "WorkspaceCompile.runtimeconfig.json",
    ] {
        if receipt.approved_runtime_sha256.get(name)
            != Some(&required_file(receipt, &format!("binary/{name}"))?.sha256)
        {
            return Err("Saved runtime companion differs from approval.".into());
        }
    }
    for name in [
        "registration/provenance.json",
        "registration/dependencies.json",
        "runner/WorkspaceCompile.csproj",
        "runner/Directory.Build.props",
        "runner/Directory.Build.targets",
        "runner/NuGet.Config",
        "runner/revision.json",
    ] {
        required_file(receipt, name)?;
    }
    for source in receipt.source_manifest.files.values() {
        let file = required_file(receipt, &format!("runner/{}", source.relative_path))?;
        if file.sha256 != source.sha256 || file.size_bytes != source.size_bytes {
            return Err(
                "Saved source manifest differs from its locked frozen-file inventory.".into(),
            );
        }
    }
    Ok(())
}

/// Each fixed role occurs exactly once in the receipt's unique frozen path inventory.
fn required_file<'a>(
    receipt: &'a FrozenReplayReceipt,
    name: &str,
) -> Result<&'a FrozenFile, String> {
    receipt
        .files
        .iter()
        .find(|file| file.relative_path == name)
        .ok_or_else(|| format!("Saved receipt lacks required captured file {name}."))
}

/// Validate owned relative components before reading a declared frozen input under a retained readonly lock.
fn verify_frozen_file(
    root: &Path,
    file: &FrozenFile,
    locks: &mut Vec<fs::File>,
) -> Result<(), String> {
    let path = replay_receipt::owned_file(root, &file.relative_path)?;
    let expected = StoredFile {
        sha256: file.sha256.clone(),
        size_bytes: file.size_bytes,
    };
    if expected.size_bytes > market_data::MAX_IMPORT_BYTES || !valid_digest(&expected.sha256) {
        return Err("Saved frozen file hash or size is malformed.".into());
    }
    verify_locked(&path, &expected, market_data::MAX_IMPORT_BYTES, locks)
}

/// Compare the exact read from a retained handle, never one precheck followed by a mutable parser read.
fn verify_locked_bytes(
    path: &Path,
    expected: &StoredFile,
    limit: u64,
    locks: &mut Vec<fs::File>,
) -> Result<Vec<u8>, String> {
    let mut file = open_locked(path)?;
    let bytes = locked_bytes(&mut file, limit)?;
    if bytes.len() as u64 != expected.size_bytes || digest(&bytes) != expected.sha256 {
        return Err("Saved evidence differs from its completion hash or size.".into());
    }
    locks.push(file);
    Ok(bytes)
}

/// Verify non-parsed companions while retaining their read-only exclusion handles.
fn verify_locked(
    path: &Path,
    expected: &StoredFile,
    limit: u64,
    locks: &mut Vec<fs::File>,
) -> Result<(), String> {
    verify_locked_bytes(path, expected, limit, locks).map(|_| ())
}

/// Call only the host-selected strict parser, then verify its output identity and existing report verifier again.
fn parse_locked(
    prepared: &PreparedSavedRun,
    public_project: &str,
    parse: RestoreParser,
) -> Result<execution::ExecutionRunResult, String> {
    let identity = seed_result(prepared);
    let result = parse(
        &identity,
        &prepared.receipt,
        &prepared.folder.join("report.json"),
        &prepared.folder,
    )?;
    if !result.success
        || result.status != "completed"
        || !result.errors.is_empty()
        || !same_restored_identity(&result, &identity)
    {
        return Err("Saved report did not pass strict seeded restoration.".into());
    }
    crate::reports::frozen_report_bytes(
        prepared.folder.parent().ok_or("Saved run has no root.")?,
        public_project,
        &result,
    )?;
    Ok(result)
}

/// The parser may populate source statistics but cannot substitute provenance, paths or native process metadata.
fn same_restored_identity(
    result: &execution::ExecutionRunResult,
    seed: &execution::ExecutionRunResult,
) -> bool {
    result.run_id == seed.run_id
        && result.strategy == seed.strategy
        && result.symbol == seed.symbol
        && result.timeframe == seed.timeframe
        && result.build_revision == seed.build_revision
        && result.dataset_id == seed.dataset_id
        && result.build_artifact_path == seed.build_artifact_path
        && result.run_folder == seed.run_folder
        && result.report_json_path == seed.report_json_path
        && result.trades_csv_path == seed.trades_csv_path
        && result.open_positions_csv_path == seed.open_positions_csv_path
        && result.equity_csv_path == seed.equity_csv_path
        && result.started_at == seed.started_at
        && result.completed_at == seed.completed_at
        && result.duration_ms == seed.duration_ms
        && result.report_sha256 == seed.report_sha256
        && result.replay_receipt_sha256 == seed.replay_receipt_sha256
}

/// Seed only verified provenance; all financial sections stay unavailable until the strict parser supplies them.
fn seed_result(prepared: &PreparedSavedRun) -> execution::ExecutionRunResult {
    let record = &prepared.record;
    execution::ExecutionRunResult {
        run_id: record.run_id.clone(),
        success: true,
        status: "completed".into(),
        strategy: record.strategy.clone(),
        symbol: record.symbol.clone(),
        timeframe: record.timeframe.clone(),
        build_artifact_path: prepared
            .folder
            .join("replay-inputs/binary/WorkspaceCompile.dll")
            .to_string_lossy()
            .into_owned(),
        build_revision: record.build_revision.clone(),
        dataset_id: record.dataset_id.clone(),
        started_at: record.started_at.clone(),
        completed_at: record.completed_at.clone(),
        duration_ms: record.duration_ms,
        run_folder: prepared.folder.to_string_lossy().into_owned(),
        report_json_path: prepared
            .folder
            .join("report.json")
            .to_string_lossy()
            .into_owned(),
        trades_csv_path: prepared
            .folder
            .join("trades.csv")
            .to_string_lossy()
            .into_owned(),
        open_positions_csv_path: prepared
            .folder
            .join("open_positions.csv")
            .to_string_lossy()
            .into_owned(),
        equity_csv_path: record.equity.as_ref().map(|_| {
            prepared
                .folder
                .join("equity.csv")
                .to_string_lossy()
                .into_owned()
        }),
        account: None,
        replay: None,
        trade_statistics: None,
        native_report_drawdown: None,
        full_replay_drawdown: None,
        trades: Vec::new(),
        open_positions: Vec::new(),
        equity: Vec::new(),
        errors: Vec::new(),
        output: record.output.clone(),
        report_sha256: Some(record.report.sha256.clone()),
        replay_receipt_sha256: Some(record.receipt.sha256.clone()),
    }
}

/// Save the pointer before an infallible in-memory swap while holding the existing canonical project/result order.
fn publish_selection(
    state: &SavedRunState,
    execution: &execution::ExecutionState,
    workspace: &WorkspaceState,
    project: &ProjectRoot,
    snapshot: &SlotIdentity,
    prepared: &PreparedSavedRun,
    run: &execution::ExecutionRunResult,
) -> Result<(), String> {
    let next_project = prepared.record.canonical_project_root.clone();
    let next_run = run.clone();
    let selected = workspace
        .selected
        .lock()
        .map_err(|_| "Workspace state is busy.")?;
    if !selected.as_ref().is_some_and(|value| {
        value.matches_canonical_identity(&prepared.record.canonical_project_root)
    }) {
        return Err("Selected project changed while opening saved evidence.".into());
    }
    let running = execution
        .running
        .lock()
        .map_err(|_| "Execution state is busy.")?;
    if *running {
        return Err(
            "Execution started while saved evidence was opening. Retry after it finishes.".into(),
        );
    }
    let mut bound = execution
        .last_good_project
        .lock()
        .map_err(|_| "Execution state is busy.")?;
    let mut last = execution
        .last_good
        .lock()
        .map_err(|_| "Execution state is busy.")?;
    if slot_identity(&bound, last.as_ref()) != *snapshot {
        return Err(
            "Execution selection changed while saved evidence was opening. Refresh history.".into(),
        );
    }
    let pointer = SelectedPointer {
        version: VERSION,
        canonical_project_root: prepared.record.canonical_project_root.clone(),
        run_id: run.run_id.clone(),
        completion_sha256: prepared.completion_sha256.clone(),
    };
    write_pointer(state, project, &pointer)?;
    *bound = Some(next_project);
    *last = Some(next_run);
    Ok(())
}

/// A private project hash chooses the native pointer filename; no renderer string becomes a destination path.
fn pointer_path(state: &SavedRunState, project: &ProjectRoot) -> PathBuf {
    state.selections_directory.join(format!(
        "{}.json",
        digest(project.directory().to_string_lossy().as_bytes())
    ))
}

/// Atomic pointer replacement preserves old bytes on write/flush/rename failure, with no evidence deletion.
fn write_pointer(
    state: &SavedRunState,
    project: &ProjectRoot,
    pointer: &SelectedPointer,
) -> Result<(), String> {
    validate_pointer(pointer, project)?;
    let path = pointer_path(state, project);
    assert_plain_path(&path)?;
    fs::create_dir_all(&state.selections_directory).map_err(|error| error.to_string())?;
    assert_plain_path(&path)?;
    let bytes = serde_json::to_vec(pointer).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("Saved selection pointer exceeds its bound.".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(&state.selections_directory)
        .map_err(|error| error.to_string())?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    temporary
        .persist(path)
        .map_err(|error| format!("Saved selection was not changed ({error})."))?;
    Ok(())
}

/// Old/foreign/malformed selections produce visible errors instead of guessed defaults or history resets.
fn validate_pointer(pointer: &SelectedPointer, project: &ProjectRoot) -> Result<(), String> {
    validate_run_id(&pointer.run_id)?;
    if pointer.version != VERSION
        || !project.matches_canonical_identity(&pointer.canonical_project_root)
        || !valid_digest(&pointer.completion_sha256)
    {
        return Err("Saved selection belongs to a different project or unsupported record.".into());
    }
    Ok(())
}

/// Strip live source/authority paths while preserving actual captured invocation controls and evidence hashes.
fn public_inputs(receipt: FrozenReplayReceipt) -> SavedRunInputs {
    SavedRunInputs {
        settings: receipt.settings,
        commission_terms: receipt.commission_terms,
        dataset: SavedDataset {
            id: receipt.dataset.id,
            sha256: receipt.dataset.sha256,
            kind: receipt.dataset.kind,
            row_count: receipt.dataset.row_count,
            size_bytes: receipt.dataset.size_bytes,
        },
        profile: SavedProfile {
            id: receipt.profile.id,
            sha256: receipt.profile.sha256,
            schema_version: receipt.profile.schema_version,
        },
        approved_artifact_sha256: receipt.approved_artifact_sha256,
        approved_runtime_sha256: receipt.approved_runtime_sha256,
        source_manifest_sha256: receipt.source_manifest.sha256,
        source_file_count: receipt.source_manifest.files.len(),
        authorities: receipt
            .authorities
            .into_iter()
            .map(|authority| SavedAuthority {
                sha256: authority.sha256,
                size_bytes: authority.size_bytes,
            })
            .collect(),
    }
}
