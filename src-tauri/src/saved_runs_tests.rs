//! Synthetic storage/parser-injection evidence only; these fixtures never execute or qualify an engine.
use super::*;
use crate::{
    replay_receipt::{FrozenFile, FrozenReplayReceipt},
    WorkspaceState,
};
use serde_json::{json, Value};
use std::sync::Arc;

/// Retain the temporary root for the entire test; source and binary placeholders are never executed.
struct Fixture {
    _temporary: tempfile::TempDir,
    state: Arc<SavedRunState>,
    execution: Arc<execution::ExecutionState>,
    workspace: Arc<WorkspaceState>,
    project: ProjectRoot,
    run: execution::ExecutionRunResult,
}

/// Construct explicit metadata, captured copies and source manifests; no authentic economic input is invented.
fn fixture(equity: bool) -> Fixture {
    let temporary = tempfile::tempdir().unwrap();
    let project_path = temporary.path().join("project");
    fs::create_dir(&project_path).unwrap();
    let project = ProjectRoot::open(project_path.to_str().unwrap()).unwrap();
    let runs = temporary.path().join("runs");
    let id = uuid::Uuid::new_v4().to_string();
    let folder = runs.join(&id);
    fs::create_dir_all(&folder).unwrap();
    let capture = folder.join("replay-inputs");
    let receipt = synthetic_capture(&capture, &id, &project, equity);
    fs::write(
        capture.join("receipt.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
    let report = json!({"strategy":"Synthetic","symbol":"QA","timeframe":"Minute","account":{"currency":"EUR","balance":1000.0},"trades":[]});
    fs::write(
        folder.join("report.json"),
        serde_json::to_vec(&report).unwrap(),
    )
    .unwrap();
    fs::write(folder.join("trades.csv"), b"id,net_profit\n").unwrap();
    fs::write(folder.join("open_positions.csv"), b"id,net_profit\n").unwrap();
    if equity {
        fs::write(
            folder.join("equity.csv"),
            b"time_utc,balance,equity\n2026-01-01T00:00:00Z,1000,1000\n",
        )
        .unwrap();
    }
    let run = synthetic_result(&folder, &id, equity);
    let execution = execution::ExecutionState {
        runs_directory: runs.clone(),
        market_data_directory: temporary.path().join("data"),
        builds_directory: temporary.path().join("builds"),
        running: false.into(),
        cancel: None.into(),
        last_good: None.into(),
        last_good_project: None.into(),
        retained_inputs: None.into(),
    };
    let workspace = WorkspaceState {
        session: crate::workspace::SessionStore {
            path: temporary.path().join("workspace.json"),
        },
        projects_directory: temporary.path().join("projects"),
        builds_directory: temporary.path().join("builds"),
        selected: Some(project.clone()).into(),
        build_running: false.into(),
        build_cancel: None.into(),
        build_flight: None.into(),
        last_successful_build: None.into(),
    };
    let state = SavedRunState::new(runs, temporary.path().join("selections"));
    Fixture {
        _temporary: temporary,
        state: Arc::new(state),
        execution: Arc::new(execution),
        workspace: Arc::new(workspace),
        project,
        run,
    }
}

/// Write one synthetic captured file and describe its actual bytes using the production fixed-file contract.
fn captured(root: &Path, relative: &str, bytes: &[u8]) -> FrozenFile {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
    FrozenFile {
        relative_path: relative.into(),
        sha256: digest(bytes),
        size_bytes: bytes.len() as u64,
    }
}

/// Create a typed fixture receipt whose original paths intentionally do not exist; reopening must use captured copies.
fn synthetic_capture(
    root: &Path,
    id: &str,
    project: &ProjectRoot,
    equity: bool,
) -> FrozenReplayReceipt {
    for name in ["engine", "strategies", "entry"] {
        fs::create_dir_all(root.join("runner").join(name)).unwrap();
    }
    let mut files = Vec::new();
    for name in [
        "WorkspaceCompile.csproj",
        "Directory.Build.props",
        "Directory.Build.targets",
        "NuGet.Config",
        "revision.json",
    ] {
        files.push(captured(
            root,
            &format!("runner/{name}"),
            b"synthetic source metadata",
        ));
    }
    files.push(captured(root, "runner/engine/empty.cs", b""));
    for name in [
        "WorkspaceCompile.dll",
        "BacktestEngine.CAlgoShim.dll",
        "WorkspaceCompile.deps.json",
        "WorkspaceCompile.runtimeconfig.json",
    ] {
        files.push(captured(
            root,
            &format!("binary/{name}"),
            b"synthetic unexecuted binary",
        ));
    }
    let market = captured(
        root,
        "market.csv",
        b"time,bid,ask\n2026-01-01T00:00:00Z,1,2\n",
    );
    let profile = captured(root, "profile.json", b"{}");
    files.extend([market.clone(), profile.clone()]);
    files.push(captured(root, "registration/provenance.json", b"{}"));
    files.push(captured(root, "registration/dependencies.json", b"{}"));
    let authority = captured(root, "authorities/00.bin", b"synthetic captured authority");
    let runtime: std::collections::BTreeMap<_, _> = [
        "BacktestEngine.CAlgoShim.dll",
        "WorkspaceCompile.deps.json",
        "WorkspaceCompile.runtimeconfig.json",
    ]
    .into_iter()
    .map(|name| (name, digest(b"synthetic unexecuted binary")))
    .collect();
    serde_json::from_value(json!({
        "version":1,"executionRunId":id,"canonicalProjectRoot":project.directory().to_string_lossy(),"buildRevision":"synthetic-revision","buildConfiguration":"Release","approvedArtifactSha256":digest(b"synthetic unexecuted binary"),"approvedRuntimeSha256":runtime,"sourceManifest":replay_receipt::source_manifest(&root.join("runner")).unwrap(),
        "settings":{"strategy":"Synthetic","symbol":"QA","timeframe":"m1","startingBalance":1000.0,"commissionUsdPerMillion":-1.0,"effectiveCommissionUsdPerMillion":0.0,"slippagePips":0.0,"spreadPips":null,"startUtc":null,"endUtc":null,"maxTicks":null,"maxBars":null,"barTimeframe":null,"barPriceMode":null,"writeEquityCsv":equity,"parameterOverrides":{"Label":"original frozen value"},"parameterMode":"noFile"},
        "commissionTerms":{"model":"synthetic","rateCurrency":"USD","sideSemantics":"synthetic","profileRate":0.0,"minimumCommission":0.0,"minimumCurrency":"USD","roundingMode":"synthetic","nativeEndUtc":null},
        "dataset":{"id":"synthetic-data","originalPath":"Z:/absent-private-market.csv","storedPath":"Z:/absent-private-store.csv","sha256":market.sha256,"sizeBytes":market.size_bytes,"kind":"ticks","rowCount":1,"importedAt":"2026-01-01T00:00:00Z"},
        "profile":{"id":"synthetic-profile","originalPath":"Z:/absent-private-profile.json","storedPath":"Z:/absent-private-profile-store.json","sha256":profile.sha256,"sizeBytes":profile.size_bytes,"schemaVersion":"synthetic","importedAt":"2026-01-01T00:00:00Z"},
        "files":files,"authorities":[{"originalPath":"Z:/absent-private-authority.json","sha256":authority.sha256,"sizeBytes":authority.size_bytes,"frozen":authority}]
    })).unwrap()
}

#[path = "saved_runs_parser_tests.rs"]
mod parser_tests;

/// The fixture claims storage preconditions only, with no account, trade statistics or numerical engine evidence.
fn synthetic_result(folder: &Path, id: &str, equity: bool) -> execution::ExecutionRunResult {
    serde_json::from_value(json!({"runId":id,"success":true,"status":"completed","strategy":"Synthetic","symbol":"QA","timeframe":"Minute","buildArtifactPath":"synthetic-unexecuted-original.dll","buildRevision":"synthetic-revision","datasetId":"synthetic-data","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:01:00Z","durationMs":1000,"runFolder":folder,"reportJsonPath":folder.join("report.json"),"reportSha256":digest(&fs::read(folder.join("report.json")).unwrap()),"tradesCsvPath":folder.join("trades.csv"),"openPositionsCsvPath":folder.join("open_positions.csv"),"equityCsvPath":equity.then(||folder.join("equity.csv")),"account":null,"replay":null,"tradeStatistics":null,"nativeReportDrawdown":null,"fullReplayDrawdown":null,"trades":[],"openPositions":[],"equity":[],"errors":[],"output":"Synthetic storage fixture; no engine executed.","replayReceiptSha256":digest(&fs::read(folder.join("replay-inputs/receipt.json")).unwrap())})).unwrap()
}

/// Explicit injected parser proves storage/publication ordering only and supplies no fabricated numerical metrics.
fn injected_parser(
    seed: &execution::ExecutionRunResult,
    _receipt: &FrozenReplayReceipt,
    report: &Path,
    folder: &Path,
) -> Result<execution::ExecutionRunResult, String> {
    assert_eq!(report, folder.join("report.json"));
    assert!(
        seed.account.is_none()
            && seed.trade_statistics.is_none()
            && seed.trades.is_empty()
            && seed.equity.is_empty()
    );
    assert!(fs::write(report, b"must be denied by retained readonly lock").is_err());
    assert!(fs::rename(folder, folder.with_extension("must-not-move")).is_err());
    Ok(seed.clone())
}

/// Build only the exact native-issued list capability for a stored fixture.
fn selection(fixture: &Fixture, row: &SavedRunSummary) -> SavedRunRequest {
    SavedRunRequest {
        project_root: fixture.project.display().into(),
        run_id: row.run_id.clone(),
        completion_sha256: row.completion_sha256.clone(),
    }
}

#[test]
fn completion_is_create_only_and_contains_no_serialized_numerical_results() {
    let fixture = fixture(true);
    let row = commit_successful_run(&fixture.state, &fixture.project, &fixture.run).unwrap();
    assert_eq!(row.verification, "recordedNotOpened");
    let path = Path::new(&fixture.run.run_folder).join("completion.json");
    let original = fs::read(&path).unwrap();
    let raw: Value = serde_json::from_slice(&original).unwrap();
    for key in [
        "account",
        "tradeStatistics",
        "metrics",
        "tradesData",
        "equityData",
    ] {
        assert!(raw.get(key).is_none());
    }
    let error = commit_successful_run(&fixture.state, &fixture.project, &fixture.run)
        .unwrap_err()
        .to_string();
    assert!(error.starts_with("Engine completed; saved-run record could not be committed"));
    assert_eq!(fs::read(path).unwrap(), original);
    assert!(fixture.execution.last_good.lock().unwrap().is_none());
}

#[test]
fn incomplete_failure_hash_mismatch_and_missing_companions_cannot_be_committed() {
    for mutation in ["failure", "hash", "trades", "receipt", "unexpected-equity"] {
        let mut fixture = fixture(false);
        match mutation {
            "failure" => fixture.run.success = false,
            "hash" => fixture.run.report_sha256 = Some("a".repeat(64)),
            "trades" => fs::remove_file(&fixture.run.trades_csv_path).unwrap(),
            "receipt" => fixture.run.replay_receipt_sha256 = None,
            _ => fs::write(
                Path::new(&fixture.run.run_folder).join("equity.csv"),
                b"unrequested",
            )
            .unwrap(),
        }
        assert!(
            commit_successful_run(&fixture.state, &fixture.project, &fixture.run).is_err(),
            "{mutation}"
        );
        assert!(!Path::new(&fixture.run.run_folder)
            .join("completion.json")
            .exists());
    }
}

#[test]
fn catalog_pages_are_bounded_real_metadata_and_reject_stale_or_foreign_expectations() {
    let fixture = fixture(false);
    commit_successful_run(&fixture.state, &fixture.project, &fixture.run).unwrap();
    let page = list_saved_runs(
        &fixture.state,
        &fixture.workspace,
        fixture.project.display(),
        None,
        1,
    )
    .unwrap();
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.rows[0].project_root, fixture.project.display());
    assert!(page.examined_entries <= 1024);
    let next = page.next_cursor.unwrap();
    let page = list_saved_runs(
        &fixture.state,
        &fixture.workspace,
        fixture.project.display(),
        Some(&next),
        1,
    )
    .unwrap();
    assert!(page.rows.is_empty() && page.next_cursor.is_none());
    assert!(list_saved_runs(
        &fixture.state,
        &fixture.workspace,
        fixture.project.display(),
        Some(&next),
        1
    )
    .is_err());
    assert!(list_saved_runs(&fixture.state, &fixture.workspace, "foreign", None, 1).is_err());
    assert!(list_saved_runs(
        &fixture.state,
        &fixture.workspace,
        fixture.project.display(),
        None,
        101
    )
    .is_err());
}

#[test]
fn selecting_and_reopening_uses_captured_copies_and_strips_private_paths() {
    let fixture = fixture(true);
    let row = commit_successful_run(&fixture.state, &fixture.project, &fixture.run).unwrap();
    let result = select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &selection(&fixture, &row),
        injected_parser,
    )
    .unwrap();
    assert_eq!(result.run.run_id, fixture.run.run_id);
    let raw = serde_json::to_value(&result.inputs).unwrap();
    assert_eq!(
        raw["settings"]["parameterOverrides"]["Label"],
        "original frozen value"
    );
    assert!(!raw.to_string().contains("absent-private"));
    assert!(!raw.to_string().contains("canonicalProjectRoot"));
    *fixture.execution.last_good.lock().unwrap() = None;
    *fixture.execution.last_good_project.lock().unwrap() = None;
    let restored = restore_selected_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        fixture.project.display(),
        injected_parser,
    )
    .unwrap()
    .unwrap();
    assert_eq!(restored.run.run_id, fixture.run.run_id);
    assert!(restored.run.account.is_none());
}

#[test]
fn output_receipt_and_frozen_input_tamper_never_reaches_parser_or_replaces_selection() {
    for relative in [
        "report.json",
        "equity.csv",
        "trades.csv",
        "open_positions.csv",
        "replay-inputs/receipt.json",
        "replay-inputs/market.csv",
        "replay-inputs/authorities/00.bin",
        "replay-inputs/runner/revision.json",
    ] {
        let fixture = fixture(true);
        let row = commit_successful_run(&fixture.state, &fixture.project, &fixture.run).unwrap();
        select_saved_run(
            &fixture.state,
            &fixture.execution,
            &fixture.workspace,
            &selection(&fixture, &row),
            injected_parser,
        )
        .unwrap();
        let pointer = fs::read_dir(&fixture.state.selections_directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let previous = fs::read(&pointer).unwrap();
        fs::write(
            Path::new(&fixture.run.run_folder).join(relative),
            b"tampered finite-looking evidence",
        )
        .unwrap();
        assert!(
            select_saved_run(
                &fixture.state,
                &fixture.execution,
                &fixture.workspace,
                &selection(&fixture, &row),
                parser_must_not_run
            )
            .is_err(),
            "{relative}"
        );
        assert_eq!(fs::read(&pointer).unwrap(), previous);
        assert_eq!(
            fixture
                .execution
                .last_good
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .run_id,
            fixture.run.run_id
        );
    }
}

/// Any invocation indicates that a pre-parser authenticity or bounds check regressed.
fn parser_must_not_run(
    _seed: &execution::ExecutionRunResult,
    _receipt: &FrozenReplayReceipt,
    _report: &Path,
    _folder: &Path,
) -> Result<execution::ExecutionRunResult, String> {
    panic!("Unverified evidence reached the parser.")
}

#[test]
fn invalid_uuid_hash_project_busy_and_pointer_write_failure_preserve_last_good_and_pointer() {
    let fixture = fixture(false);
    let row = commit_successful_run(&fixture.state, &fixture.project, &fixture.run).unwrap();
    select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &selection(&fixture, &row),
        injected_parser,
    )
    .unwrap();
    let pointer = fs::read_dir(&fixture.state.selections_directory)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let previous = fs::read(&pointer).unwrap();
    let mut request = selection(&fixture, &row);
    request.run_id = "../escape".into();
    assert!(select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &request,
        parser_must_not_run
    )
    .is_err());
    request = selection(&fixture, &row);
    request.project_root = "foreign".into();
    assert!(select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &request,
        parser_must_not_run
    )
    .is_err());
    request = selection(&fixture, &row);
    request.completion_sha256 = "f".repeat(64);
    assert!(select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &request,
        parser_must_not_run
    )
    .is_err());
    request = selection(&fixture, &row);
    *fixture.execution.running.lock().unwrap() = true;
    assert!(select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &request,
        parser_must_not_run
    )
    .is_err());
    *fixture.execution.running.lock().unwrap() = false;
    let _locked_pointer = open_locked(&pointer).unwrap();
    assert!(select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &request,
        injected_parser
    )
    .is_err());
    assert_eq!(fs::read(&pointer).unwrap(), previous);
    assert_eq!(
        fixture
            .execution
            .last_good
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .run_id,
        fixture.run.run_id
    );
}

#[test]
fn unknown_record_fields_missing_inputs_and_unrecorded_equity_are_not_repaired_or_hidden() {
    let fixture = fixture(false);
    let row = commit_successful_run(&fixture.state, &fixture.project, &fixture.run).unwrap();
    let path = Path::new(&fixture.run.run_folder).join("completion.json");
    let original = fs::read(&path).unwrap();
    let mut record: Value = serde_json::from_slice(&original).unwrap();
    record["metrics"] = json!({"netProfit":12345});
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let page = list_saved_runs(
        &fixture.state,
        &fixture.workspace,
        fixture.project.display(),
        None,
        100,
    )
    .unwrap();
    assert!(page.rows.is_empty());
    assert_eq!(page.unassigned_entries, 1);
    assert_eq!(page.issues.len(), 1);
    fs::write(&path, original).unwrap();
    fs::write(
        Path::new(&fixture.run.run_folder).join("equity.csv"),
        b"unrecorded",
    )
    .unwrap();
    assert!(select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &selection(&fixture, &row),
        parser_must_not_run
    )
    .is_err());
    fs::remove_file(Path::new(&fixture.run.run_folder).join("equity.csv")).unwrap();
    fs::remove_file(Path::new(&fixture.run.run_folder).join("replay-inputs/profile.json")).unwrap();
    assert!(select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &selection(&fixture, &row),
        parser_must_not_run
    )
    .is_err());
    assert!(!fixture.state.selections_directory.exists());
}

/// Metadata boundary tests are deterministic and do not modify Windows ACLs or depend on inherited permissions.
#[test]
fn only_not_found_is_absence_and_other_metadata_failures_are_errors() {
    assert!(
        metadata_boundary(Err(std::io::Error::from(std::io::ErrorKind::NotFound)))
            .unwrap()
            .is_none()
    );
    for kind in [
        std::io::ErrorKind::PermissionDenied,
        std::io::ErrorKind::Other,
        std::io::ErrorKind::NotADirectory,
    ] {
        assert!(metadata_boundary(Err(std::io::Error::from(kind))).is_err());
    }
    let temporary = tempfile::tempdir().unwrap();
    let file = temporary.path().join("present");
    fs::write(&file, b"original").unwrap();
    assert!(assert_absent(&file).is_err());
    assert!(assert_absent(&temporary.path().join("genuinely-missing")).is_ok());
    assert!(optional_metadata(&file.join("not-a-directory")).is_err());
}

/// Test-owned context allows a synchronous parser callback to attempt nested native operations without unsafe pointers.
struct ReentrantContext {
    state: Arc<SavedRunState>,
    execution: Arc<execution::ExecutionState>,
    workspace: Arc<WorkspaceState>,
    project: String,
    run_id: String,
    completion_sha256: String,
}

thread_local! { static REENTRANT: std::cell::RefCell<Option<ReentrantContext>> = const { std::cell::RefCell::new(None) }; }

/// A second selection and recovery must fail at the latch before any second parser invocation or disk verification.
fn nested_opening_parser(
    seed: &execution::ExecutionRunResult,
    receipt: &FrozenReplayReceipt,
    report: &Path,
    folder: &Path,
) -> Result<execution::ExecutionRunResult, String> {
    REENTRANT.with(|context| {
        let context = context.borrow();
        let context = context.as_ref().unwrap();
        let request = SavedRunRequest {
            project_root: context.project.clone(),
            run_id: context.run_id.clone(),
            completion_sha256: context.completion_sha256.clone(),
        };
        assert!(select_saved_run(
            &context.state,
            &context.execution,
            &context.workspace,
            &request,
            parser_must_not_run
        )
        .err()
        .unwrap()
        .contains("already opening"));
        assert!(restore_selected_run(
            &context.state,
            &context.execution,
            &context.workspace,
            &context.project,
            parser_must_not_run
        )
        .err()
        .unwrap()
        .contains("already opening"));
    });
    injected_parser(seed, receipt, report, folder)
}

#[test]
fn opening_single_flight_blocks_nested_select_and_restore_and_releases_afterward() {
    let fixture = fixture(false);
    let row = commit_successful_run(&fixture.state, &fixture.project, &fixture.run).unwrap();
    REENTRANT.with(|context| {
        *context.borrow_mut() = Some(ReentrantContext {
            state: fixture.state.clone(),
            execution: fixture.execution.clone(),
            workspace: fixture.workspace.clone(),
            project: fixture.project.display().into(),
            run_id: row.run_id.clone(),
            completion_sha256: row.completion_sha256.clone(),
        });
    });
    select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &selection(&fixture, &row),
        nested_opening_parser,
    )
    .unwrap();
    REENTRANT.with(|context| {
        context.borrow_mut().take();
    });
    assert!(restore_selected_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        fixture.project.display(),
        injected_parser
    )
    .unwrap()
    .is_some());
    let mut request = selection(&fixture, &row);
    request.completion_sha256 = "f".repeat(64);
    assert!(select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &request,
        parser_must_not_run
    )
    .is_err());
    assert!(select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &selection(&fixture, &row),
        injected_parser
    )
    .is_ok());
}
