//! Synthetic adapter/subprocess evidence only; these tests do not execute the C# engine.
use super::*;
use sha2::{Digest, Sha256};

/// Require the staged embeddable Python runtime; missing capability is an explicit test failure.
fn python() -> PathBuf {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtimes/python/python.exe");
    assert!(
        path.is_file(),
        "Stage the official Python runtime before native validation tests."
    );
    path
}

/// Require the unchanged staged validation package rather than silently skipping integration.
fn source() -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/validation");
    assert!(
        path.join("ValidationEngine/Cli.py").is_file(),
        "Run scripts/prepare-validation.ps1 first."
    );
    path
}

/// Build host-selected synthetic report evidence and isolated app-owned storage.
fn fixture() -> (
    tempfile::TempDir,
    ValidationState,
    execution::ExecutionState,
    WorkspaceState,
    ValidationRunRequest,
) {
    let base = tempfile::tempdir().unwrap();
    let project = base.path().join("project");
    fs::create_dir(&project).unwrap();
    let project = crate::workspace::ProjectRoot::open(project.to_str().unwrap()).unwrap();
    let identity = project.directory().to_string_lossy().into_owned();
    let runs = base.path().join("runs");
    let folder = runs.join("synthetic-run");
    fs::create_dir_all(&folder).unwrap();
    let report = folder.join("report.json");
    let trades: Vec<Value> = (0..20).map(|index| {
        let profit = if index % 2 == 0 { 100.0 } else { -50.0 };
        json!({"symbol":"EURUSD","side":"Buy","net_profit":profit,"gross_profit":profit,"pips":profit,"close_time_utc":format!("2026-06-02T{index:02}:00:00Z"),"entry_time_utc":format!("2026-06-01T{index:02}:00:00Z"),"label":format!("synthetic-{index}")})
    }).collect();
    let raw = json!({"strategy":"Synthetic","symbol":"EURUSD","timeframe":"M1","account":{"currency":"USD","starting_capital":10000.0},"trade_statistics":{"net_profit":500.0,"gross_profit":1000.0,"gross_loss":500.0,"profit_factor":2.0,"total_trades":20},"trades":trades});
    let bytes = serde_json::to_vec_pretty(&raw).unwrap();
    fs::write(&report, &bytes).unwrap();
    let mut run: execution::ExecutionRunResult = serde_json::from_value(json!({"runId":"synthetic-run","success":true,"status":"completed","strategy":"Synthetic","symbol":"EURUSD","timeframe":"M1","buildArtifactPath":"","buildRevision":"synthetic","datasetId":"synthetic","startedAt":"","completedAt":"","durationMs":0,"runFolder":folder,"reportJsonPath":report,"reportSha256":format!("{:x}",Sha256::digest(&bytes)),"tradesCsvPath":"","openPositionsCsvPath":"","equityCsvPath":null,"account":{"currency":"USD","currencyDigits":2,"startingCapital":10000.0,"balance":10500.0,"equity":10500.0,"closedNetProfit":500.0,"openNetProfit":0.0,"markedToMarketNetProfit":500.0,"markedToMarketReturnPercent":5.0},"replay":null,"tradeStatistics":null,"nativeReportDrawdown":null,"fullReplayDrawdown":null,"trades":[],"openPositions":[],"equity":[],"errors":[],"output":""})).unwrap();
    run.replay = Some(execution::ExecutionReplaySummary {
        mode: "ticks".into(),
        bar_price_mode: None,
        input_count: 20,
        ticks_or_synthetic_ticks: 20,
        on_bar_count: 0,
        chart_bar_count: 0,
        hour_bar_count: 0,
        elapsed_ms: 1.0,
        ticks_per_second: 20.0,
        first_time_utc: "2026-06-01T00:00:00Z".into(),
        last_time_utc: "2026-06-02T00:00:00Z".into(),
    });
    let execution = execution::ExecutionState {
        runs_directory: runs,
        market_data_directory: base.path().join("data"),
        builds_directory: base.path().join("builds"),
        running: false.into(),
        cancel: None.into(),
        last_good: Some(run).into(),
        last_good_project: Some(identity).into(),
        retained_inputs: None.into(),
    };
    let workspace = WorkspaceState {
        session: crate::workspace::SessionStore {
            path: base.path().join("session.json"),
        },
        projects_directory: base.path().join("projects"),
        builds_directory: base.path().join("builds"),
        selected: Some(project).into(),
        build_running: false.into(),
        build_cancel: None.into(),
        build_flight: None.into(),
        last_successful_build: None.into(),
    };
    let state = ValidationState {
        validations_directory: base.path().join("validations"),
        running: false.into(),
        cancel: None.into(),
        last_good: None.into(),
        last_good_project: None.into(),
        last_good_execution_run_id: None.into(),
    };
    let request = ValidationRunRequest {
        run_id: "synthetic-run".into(),
        monte_carlo_runs: Some(5),
        seed: Some(42),
        gates: None,
    };
    (base, state, execution, workspace, request)
}

#[test]
fn invalid_bounds_and_concurrent_jobs_are_rejected_and_latch_recovers() {
    let (_temporary, state, _, _, mut request) = fixture();
    request.monte_carlo_runs = Some(0);
    assert!(validate_request(&request).is_err());
    request.monte_carlo_runs = Some(10);
    request.seed = Some(-1);
    assert!(validate_request(&request).is_err());
    request.seed = Some(1);
    request.gates = Some(ValidationGates {
        min_profit_factor: Some(f64::NAN),
        ..Default::default()
    });
    assert!(validate_request(&request).is_err());
    let active = acquire_running(&state).unwrap();
    assert!(acquire_running(&state).is_err());
    drop(active);
    assert!(acquire_running(&state).is_ok());
}

#[test]
fn host_rejects_mismatch_tamper_and_absent_report_without_staging_work() {
    let (_temporary, state, execution, workspace, mut request) = fixture();
    request.run_id = "foreign".into();
    assert!(prepare_input(&state, &request, &execution, &workspace).is_err());
    request.run_id = "synthetic-run".into();
    let report = execution
        .last_good
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .report_json_path
        .clone();
    fs::write(&report, "{}").unwrap();
    assert!(prepare_input(&state, &request, &execution, &workspace).is_err());
    fs::remove_file(report).unwrap();
    assert!(prepare_input(&state, &request, &execution, &workspace).is_err());
    assert!(!state.validations_directory.exists());
}

#[test]
fn staged_source_is_an_exact_snapshot_and_never_reruns_a_backtest() {
    let (_temporary, state, execution, workspace, request) = fixture();
    let input = prepare_input(&state, &request, &execution, &workspace).unwrap();
    assert_eq!(
        fs::read(input.directory.join("source-report.json")).unwrap(),
        fs::read(&input.run.report_json_path).unwrap()
    );
    let config: Value = serde_json::from_slice(&fs::read(input.config).unwrap()).unwrap();
    assert_eq!(config["RunBacktests"], false);
    assert_eq!(config["Symbols"], json!([]));
    assert_eq!(
        config["ExistingReports"][0],
        json!(input.directory.join("source-report.json"))
    );
}

#[test]
fn malformed_unknown_and_false_pass_verdicts_are_rejected() {
    let base = tempfile::tempdir().unwrap();
    let verdict = base.path().join("FinalVerdict.json");
    let report = base.path().join("FinalReport.md");
    fs::write(&report, "# Synthetic report").unwrap();
    for raw in [
        "{}",
        "{malformed",
        "{\"verdict\":{\"status\":\"PASSED\"}}",
        "{\"verdict\":{\"status\":\"PASS\",\"unproven\":[]}}",
        "{\"value\":1e999}",
    ] {
        let stdout = synthetic_transport(&verdict, raw);
        assert!(parse_validation_outputs(&verdict, &report, &stdout).is_err());
    }
}

/// Inject an explicitly synthetic finite wrapper receipt to exercise downstream verdict rules independently.
fn synthetic_transport(verdict: &Path, original: &str) -> String {
    fs::write(verdict, original).unwrap();
    let Ok(payload) = serde_json::from_str::<Value>(original) else {
        return String::new();
    };
    let envelope = json!({"version":1,"originalSha256":format!("{:x}",Sha256::digest(original.as_bytes())),"payload":payload,"nonFinite":[]});
    let bytes = serde_json::to_vec(&envelope).unwrap();
    fs::write(verdict.with_file_name("FinalVerdict.adapter.json"), &bytes).unwrap();
    format!(
        "BACKTESTENGINE_VALIDATION_OUTPUT_SHA256 {:x}\n",
        Sha256::digest(&bytes)
    )
}

#[tokio::test]
async fn staged_embeddable_python_computes_genuine_report_from_synthetic_source() {
    let (_temporary, state, execution, workspace, request) = fixture();
    let result =
        run_validation_with_runtime(&state, request, &execution, &workspace, python(), source())
            .await
            .unwrap();
    if !result.success {
        let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/validation-native-synthetic");
        fs::create_dir_all(&evidence).unwrap();
        for (original, name) in [
            (&result.final_verdict_path, "FinalVerdict-original.json"),
            (&result.final_report_path, "FinalReport-original.md"),
            (&result.config_path, "validation-config.json"),
        ] {
            if Path::new(original).is_file() {
                fs::copy(original, evidence.join(name)).unwrap();
            }
        }
        fs::write(
            evidence.join("adapter-result.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
    }
    assert_eq!(
        result.status, "completed",
        "errors={:?}; output={}",
        result.errors, result.output
    );
    assert!(result.success);
    let project = workspace.selected.lock().unwrap().as_ref().unwrap().clone();
    let public = crate::workspace::refresh_project(&project).unwrap();
    assert_eq!(result.project_root, public.root);
    assert_eq!(
        state.last_good_project.lock().unwrap().as_deref(),
        Some(project.directory().to_string_lossy().as_ref())
    );
    #[cfg(windows)]
    assert_ne!(result.project_root, project.directory().to_string_lossy());
    let foreign_directory = _temporary.path().join("project-foreign");
    fs::create_dir(&foreign_directory).unwrap();
    let foreign = ProjectRoot::open(foreign_directory.to_str().unwrap()).unwrap();
    *workspace.selected.lock().unwrap() = Some(foreign.clone());
    assert!(last_good_validation_result(&state, &workspace, &execution)
        .unwrap()
        .is_none());
    *workspace.selected.lock().unwrap() = Some(ProjectRoot::open(&public.root).unwrap());
    assert_eq!(
        last_good_validation_result(&state, &workspace, &execution)
            .unwrap()
            .unwrap()
            .project_root,
        public.root
    );
    *state.last_good_project.lock().unwrap() =
        Some(foreign.directory().to_string_lossy().into_owned());
    assert!(last_good_validation_result(&state, &workspace, &execution)
        .unwrap()
        .is_none());
    *state.last_good_project.lock().unwrap() =
        Some(project.directory().to_string_lossy().into_owned());
    assert_ne!(result.verdict, "PASS");
    assert!(result
        .missing_evidence
        .contains(&"engine_level_latency_stress".into()));
    assert!(result
        .missing_evidence
        .contains(&"walk_forward_embargo_backtests".into()));
    assert!(Path::new(&result.final_report_path).is_file());
    let payload: Value =
        serde_json::from_slice(&fs::read(&result.final_verdict_path).unwrap()).unwrap();
    assert!(payload.get("monte_carlo").is_some());
    assert!(last_good_validation_result(&state, &workspace, &execution)
        .unwrap()
        .is_some());
    assert!(!*state.running.lock().unwrap());
    let request = ValidationRunRequest {
        run_id: "synthetic-run".into(),
        monte_carlo_runs: Some(5),
        seed: Some(42),
        gates: None,
    };
    let failed = run_validation_with_runtime(
        &state,
        request,
        &execution,
        &workspace,
        PathBuf::from("missing-python-executable"),
        source(),
    )
    .await
    .unwrap();
    assert!(!failed.success);
    assert!(failed.last_good_preserved);
    assert_eq!(
        last_good_validation_result(&state, &workspace, &execution)
            .unwrap()
            .unwrap()
            .validation_run_id,
        result.validation_run_id
    );
}

#[tokio::test]
async fn actual_unbounded_profit_factor_output_is_preserved_with_authenticated_annotations() {
    let (_temporary, state, execution, workspace, request) = fixture();
    {
        let mut slot = execution.last_good.lock().unwrap();
        let run = slot.as_mut().unwrap();
        let mut raw: Value =
            serde_json::from_slice(&fs::read(&run.report_json_path).unwrap()).unwrap();
        for trade in raw["trades"].as_array_mut().unwrap() {
            trade["entry_time_utc"] = json!("2026-06-01T00:00:00Z");
        }
        let bytes = serde_json::to_vec_pretty(&raw).unwrap();
        fs::write(&run.report_json_path, &bytes).unwrap();
        run.report_sha256 = Some(format!("{:x}", Sha256::digest(&bytes)));
    }
    let result =
        run_validation_with_runtime(&state, request, &execution, &workspace, python(), source())
            .await
            .unwrap();
    assert!(result.success, "{:?}", result.errors);
    assert_eq!(result.status, "completed");
    assert_eq!(result.verdict, "FAIL");
    let provenance = result.output_provenance.as_ref().unwrap();
    assert_eq!(provenance.non_finite.len(), 23);
    let original = fs::read_to_string(&result.final_verdict_path).unwrap();
    assert!(original.contains("\"pf\": Infinity"));
    assert!(serde_json::from_str::<Value>(&original).is_err());
    assert_eq!(
        provenance.original_sha256,
        format!("{:x}", Sha256::digest(original.as_bytes()))
    );
    assert!(state.last_good.lock().unwrap().is_some());
    assert!(!*state.running.lock().unwrap());
    let evidence =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../artifacts/validation-native-synthetic");
    fs::create_dir_all(&evidence).unwrap();
    fs::write(
        evidence.join("FinalVerdict-nonfinite-accepted-original.json"),
        original,
    )
    .unwrap();
    fs::write(
        evidence.join("adapter-nonfinite-accepted-result.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
    let sidecar = fs::read(&provenance.adapter_json_path).unwrap();
    assert_eq!(
        provenance.envelope_sha256,
        format!("{:x}", Sha256::digest(&sidecar))
    );
    fs::write(
        evidence.join("FinalVerdict-nonfinite-accepted-adapter.json"),
        sidecar,
    )
    .unwrap();
}

#[tokio::test]
async fn python_output_limit_cancellation_timeout_and_missing_runtime_are_honest() {
    let (_sender, mut cancel) = oneshot::channel();
    let result = process::run_python(
        &python(),
        &["-c", "print('x'*70000)"],
        &source(),
        &mut cancel,
        10,
    )
    .await;
    assert!(result.unwrap_err().contains("stream limit"));
    let (sender, mut cancel) = oneshot::channel();
    sender.send(()).unwrap();
    let result = process::run_python(
        &python(),
        &["-c", "import time;time.sleep(5)"],
        &source(),
        &mut cancel,
        10,
    )
    .await;
    assert_eq!(
        result.unwrap_err(),
        crate::workspace_build::CANCELLATION_MESSAGE
    );
    let (_sender, mut cancel) = oneshot::channel();
    let result = process::run_python(
        &python(),
        &["-c", "import time;time.sleep(5)"],
        &source(),
        &mut cancel,
        1,
    )
    .await;
    assert!(result.unwrap_err().contains("did not respond within"));
    let (_sender, mut cancel) = oneshot::channel();
    assert!(process::run_python(
        Path::new("missing-python-executable"),
        &["--version"],
        &source(),
        &mut cancel,
        1
    )
    .await
    .is_err());
}

/// Construct only metadata for concurrent publication; no Python verdict or economics computation occurs.
fn publication_result(
    project: &ProjectRoot,
    run: &execution::ExecutionRunResult,
    id: &str,
) -> ValidationRunResult {
    ValidationRunResult {
        validation_run_id: id.into(),
        execution_run_id: run.run_id.clone(),
        source_report_sha256: run.report_sha256.clone().unwrap(),
        mode: "savedReport".into(),
        success: true,
        status: "completed".into(),
        verdict: "UNPROVEN".into(),
        project_root: project.display().into(),
        started_at: String::new(),
        completed_at: String::new(),
        duration_ms: 0,
        validation_dir: String::new(),
        config_path: String::new(),
        final_verdict_path: String::new(),
        final_report_path: String::new(),
        missing_evidence: Vec::new(),
        errors: Vec::new(),
        output: "Synthetic publication metadata only.".into(),
        last_good_preserved: false,
        output_provenance: None,
    }
}

/// A returned triple must bind the exact project, execution id and immutable source hash.
fn assert_validation_snapshot(
    state: &ValidationState,
    project: &ProjectRoot,
    run: &execution::ExecutionRunResult,
    id: &str,
) {
    if let Some(result) = selected_validation_result(state, project, run).unwrap() {
        assert_eq!(result.validation_run_id, id);
        assert_eq!(result.project_root, project.display());
        assert_eq!(result.execution_run_id, run.run_id);
        assert_eq!(
            Some(result.source_report_sha256.as_str()),
            run.report_sha256.as_deref()
        );
    }
}

/// Shared readers and writers use one bounded project/run/result order under actual concurrent access.
#[test]
fn validation_binding_publication_is_coherent_and_makes_bounded_progress() {
    let (directory, state, execution, workspace, _) = fixture();
    let first = workspace.selected.lock().unwrap().as_ref().unwrap().clone();
    let foreign = directory.path().join("project-foreign");
    fs::create_dir(&foreign).unwrap();
    let second = ProjectRoot::open(foreign.to_str().unwrap()).unwrap();
    let a = execution.last_good.lock().unwrap().clone().unwrap();
    let mut b = a.clone();
    b.run_id = "foreign-execution".into();
    let result_a = publication_result(&first, &a, "first-validation");
    let result_b = publication_result(&second, &b, "second-validation");
    let state = std::sync::Arc::new(state);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let (done, completed) = std::sync::mpsc::channel();
    let writer_state = state.clone();
    let writer_barrier = barrier.clone();
    let writer_done = done.clone();
    let writer_first = first.clone();
    let writer_second = second.clone();
    let writer = std::thread::spawn(move || {
        writer_barrier.wait();
        for _ in 0..1000 {
            store_good_result(&writer_state, &result_a, &writer_first).unwrap();
            std::thread::yield_now();
            store_good_result(&writer_state, &result_b, &writer_second).unwrap();
        }
        writer_done.send(()).unwrap();
    });
    let reader = std::thread::spawn(move || {
        barrier.wait();
        for _ in 0..2000 {
            assert_validation_snapshot(&state, &first, &a, "first-validation");
            assert_validation_snapshot(&state, &second, &b, "second-validation");
        }
        done.send(()).unwrap();
    });
    for _ in 0..2 {
        completed
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("Validation lock order deadlocked or publication stopped progressing.");
    }
    writer.join().unwrap();
    reader.join().unwrap();
}
