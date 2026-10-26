//! Strict production parser/storage integration over explicit synthetic schemas; no engine run or economic qualification is claimed.
use super::*;

/// Complete finite ReportWriter-shaped fixture, deliberately zero-trade and unrelated to genuine trading evidence.
fn schema_report() -> Value {
    json!({
        "strategy":"Synthetic","symbol":"QA","timeframe":"Minute","parameter_file":"","parameter_defaults":0,"parameter_overrides":1,"parameter_unknown":[],"commission_usd_per_million":0.0,"execution_slippage_pips_per_fill":0.0,
        "economic_contract":{"commission_model":"synthetic","commission_side_semantics":"synthetic","commission_rounding_mode":"synthetic","commission_rate":0.0,"commission_rate_currency":"USD","minimum_commission":0.0,"minimum_commission_currency":"USD"},
        "account":{"currency":"USD","currency_digits":2,"starting_capital":1000.0,"balance":1000.0,"equity":1000.0,"closed_net_profit":0.0,"open_net_profit":0.0,"marked_to_market_net_profit":0.0,"marked_to_market_return_percent":0.0},
        "replay":{"mode":"ticks","bar_price_mode":null,"input_count":1,"ticks_or_synthetic_ticks":1,"on_bar_count":0,"chart_bar_count":0,"hour_bar_count":0,"elapsed_ms":1.0,"ticks_or_synthetic_ticks_per_second":1000.0,"first_time_utc":"2026-01-01T00:00:00Z","last_time_utc":"2026-01-01T00:00:00Z"},
        "drawdown":{"equity_points":1,"max_balance_drawdown":0.0,"max_balance_drawdown_percent":0.0,"max_balance_drawdown_peak_time_utc":"2026-01-01T00:00:00Z","max_balance_drawdown_trough_time_utc":"2026-01-01T00:00:00Z","max_balance_drawdown_peak":1000.0,"max_balance_drawdown_trough":1000.0,"max_equity_drawdown":0.0,"max_equity_drawdown_percent":0.0,"max_equity_drawdown_peak_time_utc":"2026-01-01T00:00:00Z","max_equity_drawdown_trough_time_utc":"2026-01-01T00:00:00Z","max_equity_drawdown_peak":1000.0,"max_equity_drawdown_trough":1000.0},
        "native_report_drawdown":null,
        "trade_statistics":{"total_trades":0,"winning_trades":0,"losing_trades":0,"long_trades":0,"short_trades":0,"gross_profit":0.0,"gross_loss":0.0,"commissions":0.0,"swaps":0.0,"net_profit":0.0,"profit_factor":null,"total_pips":0.0,"average_net_profit":0.0,"largest_win":0.0,"largest_loss":0.0},
        "trades":[],"open_positions":[]
    })
}

/// Storage placeholders remain unexecuted; only this test's raw JSON is replaced with a strict-parser fixture.
fn strict_fixture(equity: bool) -> Fixture {
    let mut fixture = fixture(equity);
    let folder = Path::new(&fixture.run.run_folder);
    fs::write(
        folder.join("report.json"),
        serde_json::to_vec(&schema_report()).unwrap(),
    )
    .unwrap();
    fixture.run = synthetic_result(folder, &fixture.run.run_id, equity);
    fixture
}

/// Historical opening uses real apply_report and captured controls, succeeds without live originals, and recovers the exact pointer.
#[test]
fn strict_parser_restores_captured_schema_values_and_exact_selection_after_restart() {
    let fixture = strict_fixture(true);
    let row = commit_successful_run(&fixture.state, &fixture.project, &fixture.run).unwrap();
    let selected = select_saved_run(
        &fixture.state,
        &fixture.execution,
        &fixture.workspace,
        &selection(&fixture, &row),
        execution::restore_frozen_execution,
    )
    .unwrap();
    assert_eq!(selected.run.account.as_ref().unwrap().balance, 1000.0);
    assert_eq!(
        selected.run.trade_statistics.as_ref().unwrap().total_trades,
        0
    );
    assert_eq!(selected.run.equity.len(), 1);
    assert_eq!(selected.run.report_sha256, fixture.run.report_sha256);
    assert_eq!(
        selected.run.replay_receipt_sha256,
        fixture.run.replay_receipt_sha256
    );
    let public = serde_json::to_string(&selected.inputs).unwrap();
    assert!(!public.contains("absent-private"));
    *fixture.execution.last_good.lock().unwrap() = None;
    *fixture.execution.last_good_project.lock().unwrap() = None;
    let restarted = SavedRunState::new(
        fixture.state.runs_directory.clone(),
        fixture.state.selections_directory.clone(),
    );
    let restored = restore_selected_run(
        &restarted,
        &fixture.execution,
        &fixture.workspace,
        fixture.project.display(),
        execution::restore_frozen_execution,
    )
    .unwrap()
    .unwrap();
    assert_eq!(restored.run.run_id, fixture.run.run_id);
    assert_eq!(
        restored.run.account.as_ref().unwrap().starting_capital,
        1000.0
    );
}

/// Drive parser/control rejection after storage hashes are valid; this explicitly synthetic metadata is never engine proof.
#[test]
fn strict_parser_errors_preserve_previous_pointer_and_last_good() {
    for (path, value) in [
        ("/account/balance", Value::Null),
        ("/parameter_unknown", json!(["Unapproved"])),
        ("/parameter_defaults", json!(3)),
        ("/commission_usd_per_million", json!(10.0)),
    ] {
        let fixture = strict_fixture(false);
        let row = commit_successful_run(&fixture.state, &fixture.project, &fixture.run).unwrap();
        select_saved_run(
            &fixture.state,
            &fixture.execution,
            &fixture.workspace,
            &selection(&fixture, &row),
            execution::restore_frozen_execution,
        )
        .unwrap();
        let pointer = fs::read_dir(&fixture.state.selections_directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let prior_pointer = fs::read(&pointer).unwrap();
        let folder = Path::new(&fixture.run.run_folder);
        let mut report = schema_report();
        *report.pointer_mut(path).unwrap() = value;
        let bytes = serde_json::to_vec(&report).unwrap();
        fs::write(folder.join("report.json"), &bytes).unwrap();
        let completion = folder.join("completion.json");
        let mut record: Value = serde_json::from_slice(&fs::read(&completion).unwrap()).unwrap();
        record["report"] = json!({"sha256":digest(&bytes),"sizeBytes":bytes.len()});
        let record = serde_json::to_vec(&record).unwrap();
        fs::write(completion, &record).unwrap();
        let mut request = selection(&fixture, &row);
        request.completion_sha256 = digest(&record);
        assert!(
            select_saved_run(
                &fixture.state,
                &fixture.execution,
                &fixture.workspace,
                &request,
                execution::restore_frozen_execution
            )
            .is_err(),
            "{path}"
        );
        assert_eq!(fs::read(&pointer).unwrap(), prior_pointer);
        assert_eq!(
            fixture
                .execution
                .last_good
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .report_sha256,
            fixture.run.report_sha256
        );
        assert_eq!(
            fixture
                .execution
                .last_good
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .account
                .as_ref()
                .unwrap()
                .balance,
            1000.0
        );
    }
}

/// A manifest entry without matching receipt inventory cannot be read as accepted source evidence without a retained lock.
#[test]
fn source_manifest_entries_and_compile_policy_roles_require_locked_inventory() {
    for relative in [
        "runner/engine/empty.cs",
        "runner/Directory.Build.props",
        "runner/Directory.Build.targets",
    ] {
        let fixture = fixture(false);
        let folder = Path::new(&fixture.run.run_folder);
        let receipt_path = folder.join("replay-inputs/receipt.json");
        let mut receipt: FrozenReplayReceipt =
            serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        receipt.files.retain(|file| file.relative_path != relative);
        fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        let run = synthetic_result(folder, &fixture.run.run_id, false);
        let error = commit_successful_run(&fixture.state, &fixture.project, &run)
            .unwrap_err()
            .to_string();
        assert!(error.contains("captured file"), "{relative}: {error}");
        assert!(fixture.execution.last_good.lock().unwrap().is_none());
    }
}

/// Storage accepts the producer's full published log bound, including truncation-marker headroom, and rejects one extra character.
#[test]
fn saved_completion_log_bound_matches_execution_producer() {
    let mut fixture = super::fixture(false);
    fixture.run.output = "x".repeat(execution::MAX_OUTPUT_CHARS + 32);
    assert!(commit_successful_run(&fixture.state, &fixture.project, &fixture.run).is_ok());
    let mut fixture = super::fixture(false);
    fixture.run.output = "x".repeat(execution::MAX_OUTPUT_CHARS + 33);
    assert!(commit_successful_run(&fixture.state, &fixture.project, &fixture.run).is_err());
}

/// Historical records cannot silently substitute Debug or unknown configuration for the captured approved Release build.
#[test]
fn saved_receipt_rejects_unapproved_build_configuration() {
    for configuration in ["Debug", ""] {
        let fixture = fixture(false);
        let folder = Path::new(&fixture.run.run_folder);
        let receipt_path = folder.join("replay-inputs/receipt.json");
        let mut receipt: FrozenReplayReceipt =
            serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        receipt.build_configuration = configuration.into();
        fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        let run = synthetic_result(folder, &fixture.run.run_id, false);
        let error = commit_successful_run(&fixture.state, &fixture.project, &run)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("Release configuration"),
            "{configuration}: {error}"
        );
        assert!(fixture.execution.last_good.lock().unwrap().is_none());
    }
}
