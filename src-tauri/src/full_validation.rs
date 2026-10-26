//! Full-workflow preparation and strict evidence acceptance; process/IPC activation is separate.
use crate::{
    execution,
    full_validation_contract::{
        self as contract, ExpectedScenario, FullValidationPlan, FullValidationRequest,
    },
    market_data,
    replay_receipt::{self, AuthorityLocks, FrozenReplayReceipt},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use crate::engine_job as job;
#[path = "full_validation_process.rs"]
mod process;
#[path = "full_validation_runtime.rs"]
mod runtime;
pub(crate) use runtime::resolve_host as resolve_engine_host;
pub(crate) use runtime::verify_host as verify_engine_host;
#[path = "full_validation_service.rs"]
mod service;
pub(crate) use service::{
    full_validation_cancel, full_validation_last_good_result, full_validation_run,
    FullValidationRunResult, FullValidationState,
};

const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;

/// Caller-owned successful execution identity, obtained coherently from private selected-project state.
pub(crate) struct BaselineEvidence<'a> {
    pub canonical_project_root: &'a str,
    pub execution_run_id: &'a str,
    pub replay_receipt_sha256: &'a str,
    pub source_report_sha256: &'a str,
}

/// All host-owned paths/settings/locks needed for one workflow; no process is spawned during preparation.
pub(crate) struct PreparedFullValidation {
    pub receipt: FrozenReplayReceipt,
    pub plan: FullValidationPlan,
    pub directory: PathBuf,
    pub config_path: PathBuf,
    pub config_sha256: String,
    pub generated_entry_sha256: String,
    pub source_report_sha256: String,
    pub authority_locks: AuthorityLocks,
    _input_locks: crate::replay_receipt::SourceLocks,
    producer: Option<crate::validation_package::FrozenValidationPackage>,
}

/// Completed original scenario evidence, kept distinct from the Python numerical verdict.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FullValidationEvidence {
    pub verdict: String,
    pub missing_evidence: Vec<String>,
    pub final_verdict_sha256: String,
    pub final_report_sha256: String,
    pub output_envelope_sha256: String,
    pub non_finite: Vec<crate::validation_output::NonFiniteAnnotation>,
    pub scenario_reports: Vec<ScenarioEvidence>,
}

/// Exact original ReportWriter bytes accepted for a single planned replay, without recomputed metrics.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScenarioEvidence {
    pub name: String,
    pub relative_path: String,
    pub sha256: String,
}

/// Verify a host-held receipt/source identity, reacquire original locks and create a fresh owned config.
pub(crate) fn prepare_full_validation(
    receipt_directory: &Path,
    baseline: BaselineEvidence<'_>,
    request: &FullValidationRequest,
    directory: &Path,
) -> Result<PreparedFullValidation, String> {
    if request.replay_receipt_sha256 != baseline.replay_receipt_sha256
        || request.execution_run_id != baseline.execution_run_id
    {
        return Err("Full validation no longer matches the selected successful execution.".into());
    }
    let receipt =
        replay_receipt::verify_frozen_replay(receipt_directory, baseline.replay_receipt_sha256)?;
    if receipt.canonical_project_root != baseline.canonical_project_root
        || receipt.execution_run_id != baseline.execution_run_id
    {
        return Err("The replay receipt belongs to a different project or execution.".into());
    }
    if baseline.source_report_sha256.len() != 64 {
        return Err("The successful baseline report hash is missing.".into());
    }
    let plan = contract::plan_validation(request, &receipt)?;
    let authority_locks = replay_receipt::lock_receipt_authorities(&receipt)?;
    replay_receipt::ensure_plain_path(directory)?;
    let parent = crate::build_process::workflow_directory(
        directory
            .parent()
            .ok_or("Full validation has no owned parent directory.")?,
    )?;
    let name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("The full workflow directory name is invalid.")?;
    let destination = replay_receipt::owned_file(&parent, name)?;
    let directory = destination.as_path();
    fs::create_dir(directory)
        .map_err(|error| format!("Cannot create fresh full-validation storage ({error})."))?;
    copy_inputs(receipt_directory, directory, &receipt)?;
    let placeholder = directory.join("parameters-placeholder.json");
    replay_receipt::write_frozen(
        directory,
        "parameters-placeholder.json",
        b"{\"hostPlaceholderOnly\":true}",
    )?;
    let entry = generated_entry(&placeholder, &receipt)?;
    let entry_path = directory.join("runner/entry/WorkspaceStrategyEntry.cs");
    fs::write(&entry_path, entry.as_bytes()).map_err(|error| error.to_string())?;
    let payload = python_config(directory, &placeholder, &receipt, request, &plan);
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?;
    replay_receipt::write_frozen(directory, "validation-config.json", &bytes)?;
    let input_locks = lock_prepared_inputs(directory, &receipt, &entry, &bytes)?;
    Ok(PreparedFullValidation {
        receipt,
        plan,
        directory: directory.into(),
        config_path: directory.join("validation-config.json"),
        config_sha256: replay_receipt::digest(&bytes),
        generated_entry_sha256: replay_receipt::digest(entry.as_bytes()),
        source_report_sha256: baseline.source_report_sha256.into(),
        authority_locks,
        _input_locks: input_locks,
        producer: None,
    })
}

/// Keep all replay source/data/config copies immutable throughout compilation and scenario execution.
fn lock_prepared_inputs(
    directory: &Path,
    receipt: &FrozenReplayReceipt,
    entry: &str,
    config: &[u8],
) -> Result<crate::replay_receipt::SourceLocks, String> {
    let mut files: std::collections::BTreeMap<_, _> = receipt
        .files
        .iter()
        .map(|file| (file.relative_path.clone(), file.clone()))
        .collect();
    for (path, bytes) in [
        ("runner/entry/WorkspaceStrategyEntry.cs", entry.as_bytes()),
        ("validation-config.json", config),
        (
            "parameters-placeholder.json",
            &b"{\"hostPlaceholderOnly\":true}"[..],
        ),
    ] {
        files.insert(path.into(), replay_receipt::file_record(path, bytes));
    }
    replay_receipt::lock_source_manifest(
        directory,
        &replay_receipt::ApprovedSourceManifest {
            files,
            sha256: String::new(),
        },
    )
}

/// Copy verified owned source/data/profile without changing the baseline receipt or original authority JSON.
fn copy_inputs(
    source: &Path,
    destination: &Path,
    receipt: &FrozenReplayReceipt,
) -> Result<(), String> {
    for file in &receipt.files {
        let bytes = market_data::read_limited_bytes(
            &replay_receipt::owned_file(source, &file.relative_path)?,
            market_data::MAX_IMPORT_BYTES,
        )?;
        if replay_receipt::digest(&bytes) != file.sha256 || bytes.len() as u64 != file.size_bytes {
            return Err("Frozen baseline inputs changed while validation was being staged.".into());
        }
        replay_receipt::write_frozen(destination, &file.relative_path, &bytes)?;
    }
    Ok(())
}

/// Map explicit controls onto the unchanged Python schema; no report cache or extra symbol is introduced.
fn python_config(
    directory: &Path,
    placeholder: &Path,
    receipt: &FrozenReplayReceipt,
    request: &FullValidationRequest,
    plan: &FullValidationPlan,
) -> Value {
    let settings = &receipt.settings;
    let gates = request.gates.clone().unwrap_or_default();
    json!({"RunName":"validation","Strategy":settings.strategy,"ParameterFile":placeholder,"ParameterOverrides":settings.parameter_overrides,"OutputRoot":directory,"RunBacktests":true,"ReuseExistingReports":false,
        "Backtest":{"Project":directory.join("runner/WorkspaceCompile.csproj"),"Timeframe":settings.timeframe,"MaxTicks":settings.max_ticks.unwrap_or(0),"MaxWorkers":1},
        "Symbols":[{"Name":settings.symbol,"TickFiles":[directory.join("market.csv")],"SymbolSpec":directory.join("profile.json")}],
        "Windows":[{"Name":"baseline","StartUtc":plan.start_utc,"EndUtc":plan.end_utc}],
        "CostStress":{"SpreadMultipliers":request.spread_multipliers,"CommissionMultipliers":request.commission_multipliers,"BaseCommissionUsdPerMillion":settings.effective_commission_usd_per_million,"BaseSpreadPips":settings.spread_pips},
        "LatencyStress":{"LatencyTicks":request.latency_ticks},
        "WalkForward":{"StartUtc":plan.start_utc,"EndUtc":plan.end_utc,"TrainDays":request.walk_forward.train_days,"ValidationDays":request.walk_forward.validation_days,"TestDays":request.walk_forward.test_days,"EmbargoDays":request.walk_forward.embargo_days},
        "MonteCarlo":{"Runs":request.monte_carlo_runs,"Seed":request.seed,"Balance":settings.starting_balance,"SkipMin":0.05,"SkipMax":0.20,"SlippagePips":2.0,"PnlNoiseFraction":0.10},
        "Gates":{"MinTrades":gates.min_trades.unwrap_or(30),"MinProfitFactor":gates.min_profit_factor.unwrap_or(1.15),"MaxDrawdownPct":gates.max_drawdown_pct.unwrap_or(10.0),"MaxDailyDrawdownPct":gates.max_daily_drawdown_pct.unwrap_or(3.0),"MinSurvivability":gates.min_survivability.unwrap_or(0.8)},"ExistingReports":[]})
}

/// Adapt invocation mechanics only: remove the exact placeholder and append original balance/slippage.
fn generated_entry(placeholder: &Path, receipt: &FrozenReplayReceipt) -> Result<String, String> {
    let literal =
        serde_json::to_string(&placeholder.to_string_lossy()).map_err(|error| error.to_string())?;
    let balance = serde_json::to_string(&receipt.settings.starting_balance.to_string())
        .map_err(|error| error.to_string())?;
    let slippage = serde_json::to_string(&receipt.settings.slippage_pips.to_string())
        .map_err(|error| error.to_string())?;
    let original_commission =
        serde_json::to_string(&receipt.settings.commission_usd_per_million.to_string())
            .map_err(|error| error.to_string())?;
    let effective_commission = serde_json::to_string(
        &receipt
            .settings
            .effective_commission_usd_per_million
            .to_string(),
    )
    .map_err(|error| error.to_string())?;
    Ok(format!(
        r#"// Generated validation invocation adapter. Original engine/strategy sources are unchanged.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
internal static class WorkspaceStrategyEntry
{{
    /// <summary>Preserve original no-file parameter loading and replay economics for Python scenarios.</summary>
    private static int Main(string[] args)
    {{
        try
        {{
            if (!CapturedReleaseCompilation()) throw new InvalidOperationException("Full validation must preserve the baseline Release compilation semantics.");
            var values = new List<string>(args);
            int index = values.IndexOf("--params");
            if (index < 0 || index + 1 >= values.Count || values[index + 1] != {literal})
                throw new InvalidOperationException("The validation placeholder path changed.");
            values.RemoveRange(index, 2);
            if (values.Contains("--params") || values.Contains("--parameter-file") || values.Contains("--balance") || values.Contains("--starting-balance") || values.Contains("--slippage-pips"))
                throw new InvalidOperationException("The validation invocation contains duplicate baseline controls.");
            PreserveBaselineCommission(values);
            values.AddRange(new[] {{ "--balance", {balance}, "--slippage-pips", {slippage} }});
            Type program = typeof(WorkspaceStrategyEntry).Assembly.GetType("BacktestEngine.Run.Program")
                ?? throw new InvalidOperationException("The original runner entry is missing.");
            MethodInfo entry = program.GetMethod("Main", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)
                ?? throw new InvalidOperationException("The original runner entry is invalid.");
            return (int)entry.Invoke(null, new object[] {{ values.ToArray() }});
        }}
        catch (Exception error)
        {{
            Console.Error.WriteLine("BACKTESTENGINE_VALIDATION_ENTRY_ERROR " + error.GetBaseException().Message);
            return 1;
        }}
    }}

    /// <summary>Guard the original baseline's conditional compilation instead of silently running DEBUG strategy branches.</summary>
    private static bool CapturedReleaseCompilation()
    {{
#if DEBUG
        return false;
#else
        return true;
#endif
    }}

    /// <summary>Keep original sentinel semantics at 1x; other rates remain original CLI overrides.</summary>
    private static void PreserveBaselineCommission(List<string> values)
    {{
        int index = values.IndexOf("--commission-usd-per-million");
        if (index < 0 || index + 1 >= values.Count || values.LastIndexOf("--commission-usd-per-million") != index)
            throw new InvalidOperationException("The validation commission control is missing or duplicated.");
        double rate = double.Parse(values[index + 1], CultureInfo.InvariantCulture);
        double baseline = double.Parse({effective_commission}, CultureInfo.InvariantCulture);
        if (rate == baseline)
            values[index + 1] = {original_commission};
    }}
}}
"#
    ))
}

/// Accept only the complete expected successful original scenario set and strict finite final output.
pub(crate) fn accept_full_outputs(
    prepared: &mut PreparedFullValidation,
    process: &std::process::Output,
) -> Result<FullValidationEvidence, String> {
    if !process.status.success()
        || !String::from_utf8_lossy(&process.stdout)
            .lines()
            .any(|line| line == "BACKTESTENGINE_VALIDATION_HOST_READY")
    {
        return Err(
            "The contained original validation process did not complete successfully.".into(),
        );
    }
    verify_prepared_inputs(prepared)?;
    let final_json = output_bytes(prepared, "validation/FinalVerdict.json")?;
    let sidecar = output_bytes(prepared, "validation/FinalVerdict.adapter.json")?;
    let verified = crate::validation_output::verify(
        &final_json,
        &sidecar,
        &String::from_utf8_lossy(&process.stdout),
    )?;
    let raw = &verified.payload;
    let markdown = output_bytes(prepared, "validation/FinalReport.md")?;
    if std::str::from_utf8(&markdown)
        .map_err(|_| "Validation Markdown is not UTF-8.")?
        .trim()
        .is_empty()
    {
        return Err("The original validation report is empty.".into());
    }
    if raw["run_name"].as_str() != Some("validation")
        || raw["strategy"].as_str() != Some(&prepared.receipt.settings.strategy)
    {
        return Err("The original final payload has a foreign workflow identity.".into());
    }
    let verdict = raw
        .pointer("/verdict/status")
        .and_then(Value::as_str)
        .filter(|value| ["PASS", "FAIL", "UNPROVEN"].contains(value))
        .ok_or("Original validation verdict vocabulary is invalid.")?
        .to_string();
    let missing: Vec<String> = serde_json::from_value(
        raw.pointer("/verdict/unproven")
            .cloned()
            .ok_or("Original validation evidence list is missing.")?,
    )
    .map_err(|_| "Original validation evidence list is invalid.")?;
    let mut reports = Vec::new();
    for (key, layer) in [
        ("run_results", "Reports"),
        ("latency_results", "LatencyStress"),
        ("walk_forward_results", "WalkForward"),
    ] {
        reports.extend(accept_layer(prepared, raw, key, layer)?);
    }
    if verdict == "PASS" && !missing.is_empty() {
        return Err("Original PASS has contradictory missing evidence.".into());
    }
    verify_prepared_inputs(prepared)?;
    Ok(FullValidationEvidence {
        verdict,
        missing_evidence: missing,
        final_verdict_sha256: verified.original_sha256,
        final_report_sha256: replay_receipt::digest(&markdown),
        output_envelope_sha256: verified.envelope_sha256,
        non_finite: verified.non_finite,
        scenario_reports: reports,
    })
}

/// Read only fixed owned final-output locations, rejecting redirected files before allocation/parsing.
fn output_bytes(prepared: &PreparedFullValidation, relative: &str) -> Result<Vec<u8>, String> {
    market_data::read_limited_bytes(
        &replay_receipt::owned_file(&prepared.directory, relative)?,
        MAX_OUTPUT_BYTES,
    )
}

/// Verify all consumed input copies, generated entry/config and still-held original authorities.
fn verify_prepared_inputs(prepared: &mut PreparedFullValidation) -> Result<(), String> {
    for file in &prepared.receipt.files {
        if file.relative_path != "runner/entry/WorkspaceStrategyEntry.cs" {
            replay_receipt::verify_file(&prepared.directory, file)?;
        }
    }
    let entry = market_data::read_limited_bytes(
        &prepared
            .directory
            .join("runner/entry/WorkspaceStrategyEntry.cs"),
        1024 * 1024,
    )?;
    let config = market_data::read_limited_bytes(&prepared.config_path, 1024 * 1024)?;
    if replay_receipt::digest(&entry) != prepared.generated_entry_sha256
        || replay_receipt::digest(&config) != prepared.config_sha256
    {
        return Err("The generated validation entry/config changed.".into());
    }
    prepared.authority_locks.verify()
}

/// Require one exact successful original result row for each planned scenario in this layer.
fn accept_layer(
    prepared: &PreparedFullValidation,
    payload: &Value,
    key: &str,
    layer: &str,
) -> Result<Vec<ScenarioEvidence>, String> {
    let rows = payload[key]
        .as_array()
        .ok_or("The original validation scenario layer is missing.")?;
    let expected: Vec<_> = prepared
        .plan
        .scenarios
        .iter()
        .filter(|item| item.layer == layer)
        .collect();
    if rows.len() != expected.len() {
        return Err("The original scenario count differs from the complete frozen plan.".into());
    }
    let mut names = BTreeSet::new();
    let mut accepted = Vec::new();
    for row in rows {
        let name = row["name"]
            .as_str()
            .ok_or("Original scenario name is missing.")?;
        if !names.insert(name) {
            return Err("Original scenario names are duplicated.".into());
        }
        let scenario = expected
            .iter()
            .find(|item| item.name == name)
            .ok_or("An original scenario is foreign to the frozen plan.")?;
        accepted.push(accept_scenario(prepared, scenario, row)?);
    }
    Ok(accepted)
}

/// Refuse leftover reports from failed subprocesses and bind actual original report bytes/economics.
fn accept_scenario(
    prepared: &PreparedFullValidation,
    scenario: &ExpectedScenario,
    row: &Value,
) -> Result<ScenarioEvidence, String> {
    if row["status"].as_str() != Some("completed") || row["exit_code"].as_i64() != Some(0) {
        return Err(format!("Original scenario {} did not complete successfully; any leftover report remains unaccepted.", scenario.name));
    }
    let command: Vec<String> = serde_json::from_value(row["command"].clone())
        .map_err(|_| "Original scenario command tokens are missing or malformed.")?;
    if command != expected_command(prepared, scenario) {
        return Err("Original scenario command differs from the frozen plan.".into());
    }
    let path = replay_receipt::owned_file(&prepared.directory, &scenario.relative_report_path)?;
    if row["report_path"].as_str() != Some(path.to_string_lossy().as_ref()) {
        return Err("Original scenario report path differs from its exact owned path.".into());
    }
    let bytes = market_data::read_limited_bytes(&path, MAX_OUTPUT_BYTES)?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let (parsed, errors) = execution::parse_report(&path)?;
    if !parsed.success
        || !errors.is_empty()
        || parsed.strategy != prepared.receipt.settings.strategy
        || !parsed
            .symbol
            .eq_ignore_ascii_case(&prepared.receipt.settings.symbol)
    {
        return Err(format!(
            "Original scenario {} failed strict ReportWriter identity/shape validation.",
            scenario.name
        ));
    }
    let hash = replay_receipt::digest(&bytes);
    if parsed.report_sha256.as_deref() != Some(&hash) {
        return Err("Original scenario report changed during acceptance.".into());
    }
    if raw["account"]["starting_capital"].as_f64()
        != Some(prepared.receipt.settings.starting_balance)
        || raw["execution_slippage_pips_per_fill"].as_f64()
            != Some(prepared.receipt.settings.slippage_pips)
        || raw["commission_usd_per_million"].as_f64() != Some(scenario.commission_usd_per_million)
        || raw["parameter_file"].as_str() != Some("")
        || raw["parameter_defaults"].as_i64() != Some(0)
        || raw["parameter_overrides"].as_u64()
            != Some(prepared.receipt.settings.parameter_overrides.len() as u64)
    {
        return Err("Original scenario baseline economics/parameter-loading semantics differ from the receipt.".into());
    }
    replay_receipt::verify_report_commission(
        &raw,
        &prepared.receipt,
        scenario.commission_usd_per_million,
    )?;
    Ok(ScenarioEvidence {
        name: scenario.name.clone(),
        relative_path: scenario.relative_report_path.clone(),
        sha256: hash,
    })
}

/// Reproduce the preserved command builder solely to verify dispatched identities; no simulation logic lives here.
fn expected_command(prepared: &PreparedFullValidation, scenario: &ExpectedScenario) -> Vec<String> {
    let settings = &prepared.receipt.settings;
    let path = |relative: &str| {
        Path::new(relative)
            .components()
            .fold(prepared.directory.clone(), |mut path, component| {
                path.push(component.as_os_str());
                path
            })
            .to_string_lossy()
            .into_owned()
    };
    let mut command = vec![
        "dotnet".into(),
        "run".into(),
        "--project".into(),
        path("runner/WorkspaceCompile.csproj"),
        "--".into(),
        "--strategy".into(),
        settings.strategy.clone(),
        "--params".into(),
        path("parameters-placeholder.json"),
        "--symbol".into(),
        settings.symbol.clone(),
        "--timeframe".into(),
        settings.timeframe.clone(),
        "--ticks".into(),
        path("market.csv"),
        "--symbol-spec".into(),
        path("profile.json"),
        "--start-utc".into(),
        scenario.start_utc.clone(),
        "--end-utc".into(),
        scenario.end_utc.clone(),
        "--commission-usd-per-million".into(),
        python_number(scenario.commission_usd_per_million),
        "--report-json".into(),
        path(&scenario.relative_report_path),
        "--skip-equity-csv".into(),
    ];
    if let Some(spread) = settings.spread_pips {
        command.extend([
            "--spread-pips".into(),
            python_number(spread * scenario.spread_multiplier),
        ]);
    } else {
        command.extend([
            "--spread-multiplier".into(),
            python_number(scenario.spread_multiplier),
        ]);
    }
    if let Some(limit) = settings.max_ticks.filter(|value| *value > 0) {
        command.extend(["--max-ticks".into(), limit.to_string()]);
    }
    if scenario.latency_ticks > 0 {
        command.extend([
            "--execution-latency-ticks".into(),
            scenario.latency_ticks.to_string(),
        ]);
    }
    for (name, value) in &settings.parameter_overrides {
        command.extend(["--param".into(), format!("{name}={value}")]);
    }
    command
}

/// Original Python stringifies every parsed cost as a float, retaining `.0` for integral values.
fn python_number(value: f64) -> String {
    let text = value.to_string();
    if text.contains('.') || text.contains('e') {
        text
    } else {
        format!("{text}.0")
    }
}

#[cfg(test)]
#[path = "full_validation_tests.rs"]
pub(super) mod tests;
