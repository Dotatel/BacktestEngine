//! Synthetic source/export boundary checks; these do not establish a genuine backtest result.
use super::*;
use serde_json::json;

/// Create a synthetic saved-run source and host result without invoking an engine.
fn fixture() -> (tempfile::TempDir, execution::ExecutionRunResult) {
    let home = tempfile::tempdir().unwrap();
    let folder = home.path().join("run-1");
    fs::create_dir(&folder).unwrap();
    let path = folder.join("report.json");
    let raw = json!({"strategy":"Example<script>","symbol":"EURUSD","timeframe":"M1","account":{"currency":"EUR","balance":12.5},"trade_statistics":{"total_trades":1,"profit_factor":null},"trades":[{"id":1,"label":"=WEBSERVICE(\"https://invalid\")","net_profit":-2.5}],"native_report_drawdown":{"max_equity_drawdown_percent":3},"drawdown":{"max_equity_drawdown_percent":4}});
    let bytes = serde_json::to_vec_pretty(&raw).unwrap();
    fs::write(&path, &bytes).unwrap();
    let run = serde_json::from_value(json!({"runId":"run-1","success":true,"status":"completed","strategy":"Example<script>","symbol":"EURUSD","timeframe":"M1","buildArtifactPath":"build.dll","buildRevision":"revision-1","datasetId":"dataset-1","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:01:00Z","durationMs":1000,"runFolder":folder.to_string_lossy(),"reportJsonPath":path.to_string_lossy(),"reportSha256":format!("{:x}",Sha256::digest(&bytes)),"tradesCsvPath":"","openPositionsCsvPath":"","equityCsvPath":null,"account":null,"replay":null,"tradeStatistics":null,"nativeReportDrawdown":null,"fullReplayDrawdown":null,"trades":[],"openPositions":[],"equity":[],"errors":[],"output":""})).unwrap();
    (home, run)
}

#[test]
fn source_bytes_are_preserved_and_missing_metrics_stay_undefined() {
    let (home, run) = fixture();
    let report = verify_report(home.path(), "project", &run).unwrap();
    assert_eq!(
        render_export(&report, ReportFormat::Json).unwrap(),
        fs::read(&run.report_json_path).unwrap()
    );
    assert_eq!(report.view.account_currency.as_deref(), Some("EUR"));
    assert_eq!(
        report
            .view
            .metrics
            .iter()
            .find(|row| row.label == "Starting capital")
            .unwrap()
            .value,
        None
    );
    assert_eq!(
        report
            .view
            .metrics
            .iter()
            .find(|row| row.label == "Profit factor")
            .unwrap()
            .value,
        None
    );
}

#[test]
fn tampered_bytes_foreign_identity_and_path_escape_are_rejected() {
    let (home, mut run) = fixture();
    fs::write(&run.report_json_path, b"{}").unwrap();
    assert!(verify_report(home.path(), "project", &run)
        .unwrap_err()
        .contains("snapshot"));
    run.run_id = "../escape".into();
    assert!(report_source_path(home.path(), &run)
        .unwrap_err()
        .contains("identity"));
    let (home, mut run) = fixture();
    run.report_json_path = home.path().join("foreign.json").to_string_lossy().into();
    fs::write(&run.report_json_path, b"{}").unwrap();
    assert!(report_source_path(home.path(), &run)
        .unwrap_err()
        .contains("selected saved run"));
}

#[test]
fn malformed_missing_or_overflowing_source_is_rejected() {
    let (_, run) = fixture();
    assert!(validate_source(&json!({}), &run).is_err());
    assert!(serde_json::from_str::<Value>("{\"balance\":1e999}").is_err());
    assert!(validate_source(&json!({"strategy":run.strategy,"symbol":run.symbol,"timeframe":run.timeframe,"account":{"balance":"NaN"},"trades":[]}), &run).is_err());
    let (home, run) = fixture();
    let report = verify_report(home.path(), "project", &run).unwrap();
    assert!(render_trades_csv(&json!({"trades":[null]}), &report.view).is_err());
}

#[test]
fn html_is_offline_escaped_and_distinguishes_drawdown_methods() {
    let (home, run) = fixture();
    let report = verify_report(home.path(), "project", &run).unwrap();
    let html = render_html(&report.view);
    assert!(html.contains("Example&lt;script&gt;"));
    assert!(!html.contains("<script"));
    assert!(!html.contains("src="));
    assert!(html.contains("12.5 EUR"));
    assert!(html.contains("n/a"));
    assert!(html.contains("Full replay equity drawdown</th><td>4%"));
    assert!(html.contains("Native price-extremes equity drawdown</th><td>3%"));
    assert!(html.contains(&report.view.report_sha256));
}

#[test]
fn csv_quotes_text_neutralizes_formulas_and_preserves_negative_numbers() {
    assert_eq!(csv_cell(&json!("=1+1")), "\"'=1+1\"");
    assert_eq!(csv_cell(&json!(-2.5)), "\"-2.5\"");
    assert_eq!(csv_cell(&json!("a,\"b\"\nc")), "\"a,\"\"b\"\"\nc\"");
    assert_eq!(csv_cell(&Value::Null), "\"n/a\"");
}

#[test]
fn atomic_export_never_overwrites_or_writes_into_runs() {
    let (runs, _) = fixture();
    let destination = tempfile::tempdir().unwrap();
    let path = destination.path().join("report.html");
    write_new_export(&path, runs.path(), b"new").unwrap();
    assert!(write_new_export(&path, runs.path(), b"replacement").is_err());
    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert!(write_new_export(&runs.path().join("run-1/export.html"), runs.path(), b"new").is_err());
}

#[test]
fn oversized_source_and_missing_completion_hash_are_rejected() {
    let (home, mut run) = fixture();
    run.report_sha256 = None;
    assert!(verify_report(home.path(), "project", &run)
        .unwrap_err()
        .contains("snapshot"));
    fs::File::create(&run.report_json_path)
        .unwrap()
        .set_len(MAX_REPORT_BYTES + 1)
        .unwrap();
    assert!(verify_report(home.path(), "project", &run)
        .unwrap_err()
        .contains("64 MiB"));
}

/// Bind a real temporary selected project to the synthetic report without faking a Windows path.
fn selected_project_fixture() -> (
    tempfile::TempDir,
    execution::ExecutionState,
    WorkspaceState,
    crate::workspace::WorkspaceProject,
) {
    let (home, run) = fixture();
    let directory = home.path().join("project");
    fs::create_dir(&directory).unwrap();
    let project = crate::workspace::ProjectRoot::open(directory.to_str().unwrap()).unwrap();
    let public = crate::workspace::refresh_project(&project).unwrap();
    #[cfg(windows)]
    assert_ne!(project.directory().to_string_lossy(), public.root);
    let canonical = project.directory().to_string_lossy().into_owned();
    let state = execution::ExecutionState {
        runs_directory: home.path().to_path_buf(),
        market_data_directory: home.path().join("data"),
        builds_directory: home.path().join("builds"),
        running: false.into(),
        cancel: None.into(),
        last_good: Some(run).into(),
        last_good_project: Some(canonical).into(),
        retained_inputs: None.into(),
    };
    let workspace = WorkspaceState {
        session: crate::workspace::SessionStore {
            path: home.path().join("session.json"),
        },
        projects_directory: home.path().join("projects"),
        builds_directory: home.path().join("builds"),
        selected: Some(project).into(),
        build_running: false.into(),
        build_cancel: None.into(),
        build_flight: None.into(),
        last_successful_build: None.into(),
    };
    (home, state, workspace, public)
}

/// Public requests use the actual workspace response, while private run state remains canonical.
#[test]
fn real_project_report_selection_matches_public_root_and_restores_after_reopen() {
    let (_home, state, workspace, public) = selected_project_fixture();
    let selected = selected_report(&state, &workspace, &public.root)
        .unwrap()
        .unwrap();
    assert_eq!(selected.project_root, public.root);
    assert!(selected_for_export(
        &state,
        &workspace,
        &public.root,
        &selected.run_id,
        &selected.report_sha256
    )
    .is_ok());
    let reopened = crate::workspace::ProjectRoot::open(&public.root).unwrap();
    *workspace.selected.lock().unwrap() = Some(reopened);
    assert_eq!(
        selected_report(&state, &workspace, &public.root)
            .unwrap()
            .unwrap()
            .project_root,
        public.root
    );
    *state.last_good.lock().unwrap() = None;
    assert!(selected_report(&state, &workspace, &public.root)
        .unwrap()
        .is_none());
}

/// Foreign renderer expectations and private canonical run bindings cannot select another project's report.
#[test]
fn real_project_report_selection_rejects_foreign_sibling_and_canonical_renderer_alias() {
    let (home, state, workspace, public) = selected_project_fixture();
    let foreign = home.path().join("project-foreign");
    fs::create_dir(&foreign).unwrap();
    let foreign = crate::workspace::ProjectRoot::open(foreign.to_str().unwrap()).unwrap();
    assert!(foreign.display().starts_with(&public.root));
    assert!(selected_report(&state, &workspace, foreign.display())
        .unwrap_err()
        .contains("selected project changed"));
    *state.last_good_project.lock().unwrap() =
        Some(foreign.directory().to_string_lossy().into_owned());
    assert!(selected_report(&state, &workspace, &public.root)
        .unwrap()
        .is_none());
    #[cfg(windows)]
    {
        let canonical = workspace
            .selected
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .directory()
            .to_string_lossy()
            .into_owned();
        assert!(selected_report(&state, &workspace, &canonical).is_err());
    }
}
