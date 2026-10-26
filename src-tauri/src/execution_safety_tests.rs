//! Synthetic parser and host-boundary regressions; these do not establish economics parity.
use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

/// Complete schema-only ReportWriter sample, deliberately independent of real execution evidence.
pub(super) fn complete_report() -> Value {
    json!({
        "strategy":"ExampleStrategy", "symbol":"QA", "timeframe":"Minute", "parameter_unknown":[],
        "account":{"currency":"USD","currency_digits":2,"starting_capital":1000.0,"balance":1000.0,"equity":1000.0,"closed_net_profit":0.0,"open_net_profit":0.0,"marked_to_market_net_profit":0.0,"marked_to_market_return_percent":0.0},
        "replay":{"mode":"ticks","bar_price_mode":null,"input_count":1,"ticks_or_synthetic_ticks":1,"on_bar_count":0,"chart_bar_count":0,"hour_bar_count":0,"elapsed_ms":1.0,"ticks_or_synthetic_ticks_per_second":1000.0,"first_time_utc":"2026-01-01T00:00:00Z","last_time_utc":"2026-01-01T00:00:00Z"},
        "drawdown":{"equity_points":1,"max_balance_drawdown":0.0,"max_balance_drawdown_percent":0.0,"max_balance_drawdown_peak_time_utc":"2026-01-01T00:00:00Z","max_balance_drawdown_trough_time_utc":"2026-01-01T00:00:00Z","max_balance_drawdown_peak":1000.0,"max_balance_drawdown_trough":1000.0,"max_equity_drawdown":0.0,"max_equity_drawdown_percent":0.0,"max_equity_drawdown_peak_time_utc":"2026-01-01T00:00:00Z","max_equity_drawdown_trough_time_utc":"2026-01-01T00:00:00Z","max_equity_drawdown_peak":1000.0,"max_equity_drawdown_trough":1000.0},
        "native_report_drawdown":null,
        "trade_statistics":{"total_trades":0,"winning_trades":0,"losing_trades":0,"long_trades":0,"short_trades":0,"gross_profit":0.0,"gross_loss":0.0,"commissions":0.0,"swaps":0.0,"net_profit":0.0,"profit_factor":null,"total_pips":0.0,"average_net_profit":0.0,"largest_win":0.0,"largest_loss":0.0},
        "trades":[], "open_positions":[]
    })
}

/// Read one isolated JSON document through the same parser used by actual execution.
fn parse_value(document: &Value) -> (ExecutionRunResult, Vec<String>) {
    let directory = TempDir::new().unwrap();
    let report = directory.path().join("report.json");
    fs::write(&report, serde_json::to_vec(document).unwrap()).unwrap();
    parse_report(&report).unwrap()
}

#[test]
fn required_sections_metrics_and_nulls_fail_closed() {
    let (valid, errors) = parse_value(&complete_report());
    assert!(valid.success, "{errors:?}");
    let expected = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&complete_report()).unwrap())
    );
    assert_eq!(valid.report_sha256.as_deref(), Some(expected.as_str()));
    for field in [
        "account",
        "replay",
        "drawdown",
        "trade_statistics",
        "trades",
        "open_positions",
        "parameter_unknown",
    ] {
        let mut document = complete_report();
        document.as_object_mut().unwrap().remove(field);
        let (result, errors) = parse_value(&document);
        assert!(
            !result.success && !errors.is_empty(),
            "{field} was silently accepted"
        );
        assert!(result.report_sha256.is_none());
    }
    let mut document = complete_report();
    document["account"]["balance"] = Value::Null;
    assert!(!parse_value(&document).0.success);
    document = complete_report();
    document["trade_statistics"]
        .as_object_mut()
        .unwrap()
        .remove("net_profit");
    assert!(!parse_value(&document).0.success);
}

/// Unknown source parameters cannot be promoted merely because the original runner exits successfully.
#[test]
fn unknown_missing_null_or_malformed_parameter_acceptance_records_fail_closed() {
    for unknown in [json!(["HoldTickz"]), Value::Null, json!({}), json!([42])] {
        let mut document = complete_report();
        document["parameter_unknown"] = unknown;
        let (result, errors) = parse_value(&document);
        assert!(!result.success && !errors.is_empty());
        assert!(result.report_sha256.is_none());
        assert!(result.account.is_none());
    }
}

/// Only approved reflected properties/aliases enter dispatch, with bounded values and no duplicate targets.
#[test]
fn ordinary_overrides_reject_unknown_environment_alias_duplicates_and_oversized_values() {
    let schema: workspace_build::CompiledStrategy = serde_json::from_value(json!({"strategy":"Synthetic","strategyType":"Synthetic","parameters":[{"name":"HoldTicks","displayName":"Hold ticks","valueType":"integer","default":10}]})).unwrap();
    let valid = BTreeMap::from([("holdticks".to_string(), "10".to_string())]);
    assert!(inputs::validate_parameter_overrides(Some(&valid), &schema).is_ok());
    let alias = BTreeMap::from([("Hold ticks".to_string(), "10".to_string())]);
    assert!(inputs::validate_parameter_overrides(Some(&alias), &schema).is_ok());
    for name in ["HoldTickz", "Balance", "TimeFrame"] {
        let values = BTreeMap::from([(name.to_string(), "10".to_string())]);
        assert!(inputs::validate_parameter_overrides(Some(&values), &schema)
            .unwrap_err()
            .contains("approved strategy schema"));
    }
    let duplicate = BTreeMap::from([
        ("HoldTicks".into(), "10".into()),
        ("Hold ticks".into(), "20".into()),
    ]);
    assert!(
        inputs::validate_parameter_overrides(Some(&duplicate), &schema)
            .unwrap_err()
            .contains("more than once")
    );
    for value in ["x".repeat(2049), "value\0".to_string()] {
        let values = BTreeMap::from([("HoldTicks".to_string(), value)]);
        assert!(inputs::validate_parameter_overrides(Some(&values), &schema).is_err());
    }
    let excessive = (0..257)
        .map(|index| (format!("unknown{index}"), "1".to_string()))
        .collect();
    assert!(
        inputs::validate_parameter_overrides(Some(&excessive), &schema)
            .unwrap_err()
            .contains("256")
    );
}

/// A missing opposite endpoint must not bypass validation, and replay limits retain the original Int32 CLI domain.
#[test]
fn single_endpoint_dates_and_runner_count_limits_are_validated_before_dispatch() {
    for (start, end) in [
        (Some("invalid"), None),
        (None, Some("invalid")),
        (Some("invalid"), Some("")),
        (Some(""), Some("invalid")),
    ] {
        assert!(validate_request_dates(start, end).is_err());
    }
    assert!(validate_request_dates(Some("2026-01-01"), None).is_ok());
    assert!(validate_request_dates(None, Some("2026-01-02T00:00:00Z")).is_ok());
    assert!(validate_request_dates(Some("2026-01-01"), Some("2026-01-01T00:00:00Z")).is_err());
    let mut request: ExecutionRunRequest = serde_json::from_value(json!({"strategy":"Synthetic","datasetId":"synthetic","symbolSpecPath":"synthetic","startingBalance":1000,"commissionUsdPerMillion":-42})).unwrap();
    assert!(
        validate_request(&request).is_ok(),
        "Original negative commission sentinel must remain supported."
    );
    for limit in [-1, i32::MAX as i64 + 1] {
        request.max_ticks = Some(limit);
        request.max_bars = None;
        assert!(validate_request(&request).is_err());
        request.max_ticks = None;
        request.max_bars = Some(limit);
        assert!(validate_request(&request).is_err());
    }
    request.max_ticks = Some(0);
    request.max_bars = Some(i32::MAX as i64);
    assert!(validate_request(&request).is_ok());
}

#[test]
fn parser_rejects_inconsistent_counts_and_incomplete_equity() {
    let mut document = complete_report();
    document["trade_statistics"]["total_trades"] = json!(1);
    assert!(!parse_value(&document).0.success);
    let directory = TempDir::new().unwrap();
    let report = directory.path().join("report.json");
    fs::write(&report, serde_json::to_vec(&complete_report()).unwrap()).unwrap();
    fs::write(
        directory.path().join("equity.csv"),
        "time_utc,balance,equity\n2026-01-01T00:00:00Z,1000,1000\n2026-01-01T00:01:00Z,NaN,1000\n",
    )
    .unwrap();
    let (result, errors) = parse_report(&report).unwrap();
    assert!(!result.success);
    assert!(errors.iter().any(|error| error.contains("non-finite")));
    assert!(result.report_sha256.is_none());
}

#[test]
fn win_and_loss_rates_are_percentages_from_retained_counts() {
    let stats: ReportTradeStats =
        serde_json::from_value(complete_report()["trade_statistics"].clone()).unwrap();
    let mut stats = stats;
    stats.total_trades = Some(4);
    stats.winning_trades = Some(3);
    stats.losing_trades = Some(1);
    // Retained writer has no win_rate or loss_rate properties.
    let mapped = stats_from_report(&stats);
    assert_eq!(mapped.win_rate, 75.0);
    assert_eq!(mapped.loss_rate, 25.0);
}

#[test]
fn cleanup_guard_releases_running_and_cancel_even_on_early_exit() {
    let directory = TempDir::new().unwrap();
    let (sender, _receiver) = oneshot::channel();
    let state = ExecutionState {
        runs_directory: directory.path().join("runs"),
        market_data_directory: directory.path().join("data"),
        builds_directory: directory.path().join("builds"),
        running: std::sync::Mutex::new(true),
        cancel: std::sync::Mutex::new(Some(sender)),
        last_good: std::sync::Mutex::new(None),
        last_good_project: std::sync::Mutex::new(None),
        retained_inputs: std::sync::Mutex::new(None),
    };
    {
        let _guard = ExecutionGuard::new(&state);
    }
    assert!(!*state.running.lock().unwrap());
    assert!(state.cancel.lock().unwrap().is_none());
}

#[cfg(windows)]
#[test]
fn unconfirmed_cleanup_retains_baseline_authority_locks_and_busy_state() {
    let fixture = crate::replay_receipt::tests::fixture(false);
    let frozen = crate::replay_receipt::tests::capture(&fixture).unwrap();
    let state = ExecutionState {
        runs_directory: fixture.home.path().join("runs"),
        market_data_directory: fixture.home.path().join("market"),
        builds_directory: fixture.home.path().join("builds"),
        running: true.into(),
        cancel: None.into(),
        last_good: None.into(),
        last_good_project: None.into(),
        retained_inputs: None.into(),
    };
    let mut guard = ExecutionGuard::new(&state);
    guard.inputs = Some(frozen);
    guard.cleanup.store(false, Ordering::Release);
    drop(guard);
    assert!(*state.running.lock().unwrap());
    assert!(state.retained_inputs.lock().unwrap().is_some());
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(&fixture.authority)
            .is_err(),
        "Unknown child cleanup released the real Windows authority lock."
    );
    assert!(state.last_good.lock().unwrap().is_none());
}

/// Import a deliberately incomplete registration fixture with one real source file.
fn registration_fixture() -> (TempDir, PathBuf, PathBuf) {
    let directory = TempDir::new().unwrap();
    let source = directory.path().join("source.json");
    fs::write(&source, b"synthetic non-authority source").unwrap();
    let profile = directory.path().join("profile.json");
    fs::write(&profile, serde_json::to_vec(&json!({"schema_version":"backtestengine.economic-symbol/v2","specification_source_path":"source.json"})).unwrap()).unwrap();
    let registered = market_data::import_symbol_spec(
        &directory.path().join("storage"),
        profile.to_str().unwrap(),
    )
    .unwrap();
    (directory, PathBuf::from(registered.stored_path), source)
}

/// Validate a registered profile after deliberately changing its isolated fixture files.
fn verify_fixture(profile: &Path) -> Result<PathBuf, String> {
    verify_registered_manifest(profile.to_path_buf(), fs::read(profile).unwrap())
}

#[test]
fn registration_detects_changed_missing_dependencies_and_deleted_manifest_entry() {
    let (_directory, profile, source) = registration_fixture();
    assert!(verify_fixture(&profile).is_ok());
    let original = fs::read(&source).unwrap();
    fs::write(&source, b"changed").unwrap();
    assert!(verify_fixture(&profile)
        .unwrap_err()
        .contains("hash changed"));
    fs::remove_file(&source).unwrap();
    assert!(verify_fixture(&profile)
        .unwrap_err()
        .contains("dependency is missing"));
    fs::write(&source, original).unwrap();
    let manifest = profile.parent().unwrap().join("dependencies.json");
    let mut document: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    document["dependencies"] = json!([]);
    fs::write(&manifest, serde_json::to_vec(&document).unwrap()).unwrap();
    assert!(verify_fixture(&profile)
        .unwrap_err()
        .contains("references do not match"));
}

/// Retained C# normalizes symbols with Trim and ToUpperInvariant before writing its report.
#[test]
fn requested_symbol_identity_matches_trimmed_case_insensitive_csharp_semantics() {
    let document = complete_report();
    let report: ReportRoot = serde_json::from_value(document.clone()).unwrap();
    let (mut result, errors) = parse_value(&document);
    assert!(errors.is_empty());
    result.symbol = " qa ".to_string();
    assert!(validate_report_identity(&result, &report).is_ok());
    result.symbol = "different".to_string();
    assert!(validate_report_identity(&result, &report)
        .unwrap_err()
        .contains("symbol"));
}

/// The original writer's resolved period owns saved result metadata, not a draft CLI alias.
#[test]
fn mapped_report_timeframe_replaces_request_alias_with_original_writer_value() {
    let document = complete_report();
    let report: ReportRoot = serde_json::from_value(document.clone()).unwrap();
    let (mut result, errors) = parse_value(&document);
    assert!(errors.is_empty());
    result.timeframe = "m1".to_string();
    map_report(&mut result, &report);
    assert_eq!(result.timeframe, "Minute");
    assert_eq!(result.symbol, "QA");
}

/// Sparse oversized files must fail before allocation and cannot become hashed successful evidence.
#[test]
fn oversized_report_and_equity_files_fail_with_no_report_hash() {
    let directory = TempDir::new().unwrap();
    let report = directory.path().join("report.json");
    fs::File::create(&report)
        .unwrap()
        .set_len(MAX_REPORT_BYTES + 1)
        .unwrap();
    let (result, errors) = parse_report(&report).unwrap();
    assert!(!result.success);
    assert!(result.report_sha256.is_none());
    assert!(errors.iter().any(|error| error.contains("too large")));
    fs::write(&report, serde_json::to_vec(&complete_report()).unwrap()).unwrap();
    fs::File::create(directory.path().join("equity.csv"))
        .unwrap()
        .set_len(MAX_REPORT_BYTES + 1)
        .unwrap();
    let (result, errors) = parse_report(&report).unwrap();
    assert!(!result.success);
    assert!(result.report_sha256.is_none());
    assert!(errors
        .iter()
        .any(|error| error.contains("equity file") && error.contains("too large")));
}

/// The actual final builder feeds run_process unchanged, with exactly one assembly before CLI options.
#[test]
fn final_dispatch_vector_contains_one_dll_and_preserves_original_runner_options() {
    let request: ExecutionRunRequest = serde_json::from_value(json!({
        "strategy":"ExampleStrategy","datasetId":"dataset-fixture","symbolSpecPath":"profile.json","startingBalance":1000,
        "commissionUsdPerMillion":-1,"slippagePips":0,"timeframe":"m1","writeEquityCsv":false,
        "parameterOverrides":{"HoldTicks":"10"}
    })).unwrap();
    let artifact = Path::new("owned build/WorkspaceCompile.dll");
    let args = execution_arguments(
        artifact,
        &request,
        Path::new("ticks.csv"),
        Path::new("profile.json"),
        "QA",
        "ticks",
        Path::new("report.json"),
    )
    .unwrap();
    assert_eq!(
        args,
        vec![
            "owned build/WorkspaceCompile.dll",
            "--symbol",
            "QA",
            "--strategy",
            "ExampleStrategy",
            "--ticks",
            "ticks.csv",
            "--symbol-spec",
            "profile.json",
            "--balance",
            "1000",
            "--commission-usd-per-million",
            "-1",
            "--slippage-pips",
            "0",
            "--period",
            "m1",
            "--param",
            "HoldTicks=10",
            "--report-json",
            "report.json",
            "--skip-equity-csv"
        ]
    );
    assert_eq!(
        args.iter()
            .filter(|argument| argument.as_str() == artifact.to_str().unwrap())
            .count(),
        1
    );
}

/// Every known companion is part of the host approval, not merely the main assembly hash.
#[test]
fn runtime_shim_dependencies_and_configuration_cannot_change_after_approval() {
    let directory = TempDir::new().unwrap();
    let artifact = directory.path().join("WorkspaceCompile.dll");
    fs::write(&artifact, b"synthetic assembly placeholder").unwrap();
    for name in RUNTIME_COMPANIONS {
        fs::write(directory.path().join(name), name).unwrap();
    }
    let hashes = runtime_companion_hashes(&artifact).unwrap();
    assert_eq!(hashes.len(), 3);
    assert!(validate_runtime_companions(&artifact, &hashes).is_ok());
    for name in RUNTIME_COMPANIONS {
        let file = directory.path().join(name);
        fs::write(&file, b"changed").unwrap();
        assert!(validate_runtime_companions(&artifact, &hashes)
            .unwrap_err()
            .contains("companions changed"));
        fs::remove_file(&file).unwrap();
        assert!(validate_runtime_companions(&artifact, &hashes)
            .unwrap_err()
            .contains("runtime companion"));
        fs::write(file, name).unwrap();
    }
}

/// Valid report bytes never become accepted report evidence after failed, canceled or timed-out work.
#[test]
fn unsuccessful_completion_always_clears_report_hash_even_when_report_schema_is_valid() {
    for (status, exit_success) in [("completed", false), ("cancelled", true), ("timeout", true)] {
        let (mut result, mut errors) = parse_value(&complete_report());
        assert!(result.report_sha256.is_some());
        result.status = status.to_string();
        finalize_report(&mut result, &mut errors, exit_success);
        assert!(!result.success);
        assert!(result.report_sha256.is_none());
    }
}

/// Shared preflight rejects malformed standalone optimizer/replay requests without creating work.
#[test]
fn shared_preflight_has_no_process_or_run_folder_side_effects_for_invalid_inputs() {
    let directory = TempDir::new().unwrap();
    let state = ExecutionState {
        runs_directory: directory.path().join("runs"),
        market_data_directory: directory.path().join("market_data"),
        builds_directory: directory.path().join("builds"),
        running: std::sync::Mutex::new(false),
        cancel: std::sync::Mutex::new(None),
        last_good: std::sync::Mutex::new(None),
        last_good_project: std::sync::Mutex::new(None),
        retained_inputs: std::sync::Mutex::new(None),
    };
    let request: ExecutionRunRequest = serde_json::from_value(json!({"strategy":"ExampleStrategy","datasetId":"dataset-invalid","symbolSpecPath":"missing.json","startingBalance":0})).unwrap();
    // Deliberately invalid approval: no assembly, receipt or economics authority is fabricated.
    let approved = workspace_build::ApprovedBuild {
        project_root: String::new(),
        artifact_path: String::new(),
        revision: String::new(),
        artifact_sha256: String::new(),
        runtime_sha256: BTreeMap::new(),
        strategies: Vec::new(),
        parameter_schemas: Vec::new(),
        source_manifest: crate::replay_receipt::ApprovedSourceManifest {
            files: BTreeMap::new(),
            sha256: String::new(),
        },
    };
    assert!(preflight_execution_inputs(&state, &request, &approved)
        .unwrap_err()
        .contains("Starting balance"));
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    assert!(!*state.running.lock().unwrap());
    assert!(state.cancel.lock().unwrap().is_none());
}

/// Assert that a coherent snapshot can never borrow another real project's result slot.
fn assert_execution_snapshot(
    state: &ExecutionState,
    project: &crate::workspace::ProjectRoot,
    expected: &str,
) {
    if let Some(result) = last_good_execution_for_project(state, project).unwrap() {
        assert_eq!(result.run_id, expected);
    }
}

/// Concurrent publication and reads must neither mix projects nor deadlock under opposing schedules.
#[test]
fn execution_project_result_publication_is_coherent_and_makes_bounded_progress() {
    let directory = TempDir::new().unwrap();
    let first = directory.path().join("first");
    let second = directory.path().join("second");
    fs::create_dir(&first).unwrap();
    fs::create_dir(&second).unwrap();
    let first = crate::workspace::ProjectRoot::open(first.to_str().unwrap()).unwrap();
    let second = crate::workspace::ProjectRoot::open(second.to_str().unwrap()).unwrap();
    let state = std::sync::Arc::new(ExecutionState {
        runs_directory: directory.path().join("runs"),
        market_data_directory: directory.path().join("data"),
        builds_directory: directory.path().join("builds"),
        running: false.into(),
        cancel: None.into(),
        last_good: None.into(),
        last_good_project: None.into(),
        retained_inputs: None.into(),
    });
    let (mut a, errors) = parse_value(&complete_report());
    assert!(errors.is_empty());
    a.run_id = "first-result".into();
    let mut b = a.clone();
    b.run_id = "second-result".into();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let (done, completed) = std::sync::mpsc::channel();
    let writer_state = state.clone();
    let writer_barrier = barrier.clone();
    let writer_done = done.clone();
    let first_id = first.directory().to_string_lossy().into_owned();
    let second_id = second.directory().to_string_lossy().into_owned();
    let writer = std::thread::spawn(move || {
        writer_barrier.wait();
        for _ in 0..1000 {
            store_last_good_execution(&writer_state, &first_id, &a).unwrap();
            std::thread::yield_now();
            store_last_good_execution(&writer_state, &second_id, &b).unwrap();
        }
        writer_done.send(()).unwrap();
    });
    let reader = std::thread::spawn(move || {
        barrier.wait();
        for _ in 0..2000 {
            assert_execution_snapshot(&state, &first, "first-result");
            assert_execution_snapshot(&state, &second, "second-result");
        }
        done.send(()).unwrap();
    });
    for _ in 0..2 {
        completed
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("Project/result lock ordering deadlocked or publication stopped progressing.");
    }
    writer.join().unwrap();
    reader.join().unwrap();
}
