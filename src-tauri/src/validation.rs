//! Report-only validation through the unchanged Python ValidationEngine, using frozen host evidence.
//! Full engine stress and walk-forward reruns remain unproven; this module never executes them.
use crate::{execution, reports, workspace::ProjectRoot, WorkspaceState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Instant,
};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

#[path = "validation_process.rs"]
mod process;

pub const VALIDATION_TIMEOUT_SECONDS: u64 = 600;
const MAX_REPORT_BYTES: u64 = 64 * 1024 * 1024;
const PYTHON_BOOTSTRAP: &str = crate::validation_output::PYTHON_BOOTSTRAP;

/// Bounded report-only settings; input/output paths are always chosen by the host.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRunRequest {
    pub run_id: String,
    pub monte_carlo_runs: Option<i64>,
    pub seed: Option<i64>,
    pub gates: Option<ValidationGates>,
}

/// Optional gate overrides passed unchanged to the retained Python algorithm.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationGates {
    pub min_trades: Option<i64>,
    pub min_profit_factor: Option<f64>,
    pub max_drawdown_pct: Option<f64>,
    pub max_daily_drawdown_pct: Option<f64>,
    pub min_survivability: Option<f64>,
}

/// One active subprocess and the last completed validation evidence, scoped to project and run.
pub struct ValidationState {
    pub validations_directory: PathBuf,
    pub running: std::sync::Mutex<bool>,
    pub cancel: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    pub last_good: std::sync::Mutex<Option<ValidationRunResult>>,
    pub last_good_project: std::sync::Mutex<Option<String>>,
    pub last_good_execution_run_id: std::sync::Mutex<Option<String>>,
}

/// Process completion is separate from the retained engine's PASS/FAIL/UNPROVEN verdict.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRunResult {
    pub validation_run_id: String,
    pub execution_run_id: String,
    pub source_report_sha256: String,
    pub mode: String,
    pub success: bool,
    pub status: String,
    pub verdict: String,
    pub project_root: String,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    pub validation_dir: String,
    pub config_path: String,
    pub final_verdict_path: String,
    pub final_report_path: String,
    pub missing_evidence: Vec<String>,
    pub errors: Vec<String>,
    pub output: String,
    pub last_good_preserved: bool,
    #[serde(default)]
    pub output_provenance: Option<ValidationOutputProvenance>,
}

/// Strict adapter transport identity; original numerical files and verdicts remain unchanged.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationOutputProvenance {
    pub original_sha256: String,
    pub envelope_sha256: String,
    pub adapter_json_path: String,
    pub non_finite: Vec<crate::validation_output::NonFiniteAnnotation>,
}

/// Accepted report-only verdict plus the verified transport from the same captured subprocess.
struct ParsedValidationOutputs {
    verdict: String,
    missing_evidence: Vec<String>,
    transport: crate::validation_output::VerifiedOutput,
}

/// App-owned staged paths and exact source identity for one validation process.
struct ValidationInput {
    run: execution::ExecutionRunResult,
    project: ProjectRoot,
    directory: PathBuf,
    config: PathBuf,
    validation_run_id: String,
}

/// Clear the job latch and cancel sender on every exit, including errors and dropped futures.
struct ActiveValidation<'a>(&'a ValidationState);

impl Drop for ActiveValidation<'_> {
    /// Release only this single-flight job; result files remain available for diagnosis.
    fn drop(&mut self) {
        if let Ok(mut cancel) = self.0.cancel.lock() {
            cancel.take();
        }
        if let Ok(mut running) = self.0.running.lock() {
            *running = false;
        }
    }
}

/// Reject invalid or excessive settings before acquiring the subprocess latch.
pub fn validate_request(request: &ValidationRunRequest) -> Result<(), String> {
    if request.run_id.is_empty() || request.run_id.len() > 128 {
        return Err("Select a valid saved execution run.".into());
    }
    if !request.monte_carlo_runs.unwrap_or(1000).is_positive()
        || request.monte_carlo_runs.unwrap_or(1000) > 100_000
    {
        return Err("Monte Carlo runs must be between 1 and 100000.".into());
    }
    if !(0..=2_147_483_647).contains(&request.seed.unwrap_or(42)) {
        return Err("The Monte Carlo seed must be between 0 and 2147483647.".into());
    }
    let gates = request.gates.clone().unwrap_or_default();
    if !(0..=1_000_000).contains(&gates.min_trades.unwrap_or(30)) {
        return Err("Minimum trades must be between 0 and 1000000.".into());
    }
    for (name, value, maximum) in [
        (
            "Minimum profit factor",
            gates.min_profit_factor.unwrap_or(1.15),
            100.0,
        ),
        (
            "Maximum drawdown",
            gates.max_drawdown_pct.unwrap_or(10.0),
            100.0,
        ),
        (
            "Maximum daily drawdown",
            gates.max_daily_drawdown_pct.unwrap_or(3.0),
            100.0,
        ),
        (
            "Minimum survivability",
            gates.min_survivability.unwrap_or(0.8),
            1.0,
        ),
    ] {
        if !value.is_finite() || !(0.0..=maximum).contains(&value) {
            return Err(format!(
                "{name} must be finite and between 0 and {maximum}."
            ));
        }
    }
    Ok(())
}

/// Prefer the packaged Python runtime; explicit developer overrides never become a production path.
pub async fn resolve_python(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("runtimes/python/python.exe"));
    }
    #[cfg(debug_assertions)]
    {
        if let Some(path) = std::env::var_os("BACKTEST_PYTHON") {
            candidates.push(PathBuf::from(path));
        }
        candidates.extend([PathBuf::from("python"), PathBuf::from("python3")]);
    }
    for candidate in candidates {
        if python_is_usable(&candidate).await {
            return Ok(candidate);
        }
    }
    Err("The validation Python runtime is unavailable. Reinstall the desktop runtime; development builds can set BACKTEST_PYTHON.".into())
}

/// Probe a candidate with the same bounded hidden-process behavior as actual validation.
async fn python_is_usable(candidate: &Path) -> bool {
    let (_sender, mut cancel) = oneshot::channel();
    let working = std::env::temp_dir();
    process::run_python(candidate, &["--version"], &working, &mut cancel, 10)
        .await
        .is_ok_and(|output| output.status.success())
}

/// Resolve the preserved package root with development fallback restricted to debug builds.
pub fn resolve_validation_source(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("validation"));
    }
    #[cfg(debug_assertions)]
    {
        if let Some(path) = std::env::var_os("BACKTEST_VALIDATION_SRC") {
            candidates.push(PathBuf::from(path));
        }
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engines/validation"));
    }
    candidates
        .into_iter()
        .find(|path| path.join("ValidationEngine/Cli.py").is_file())
        .ok_or("The preserved Python validation package is missing from this installation.".into())
}

/// Resolve native capabilities and validate one frozen saved report, without any backtest rerun.
pub async fn run_validation(
    app: AppHandle,
    state: &ValidationState,
    request: ValidationRunRequest,
    execution_state: &execution::ExecutionState,
    workspace: &WorkspaceState,
) -> Result<ValidationRunResult, String> {
    validate_request(&request)?;
    let python = resolve_python(&app).await?;
    let source = resolve_validation_source(&app)?;
    run_validation_with_runtime(state, request, execution_state, workspace, python, source).await
}

/// Run the preserved CLI with explicit host-owned capabilities; also supports genuine subprocess tests.
pub async fn run_validation_with_runtime(
    state: &ValidationState,
    request: ValidationRunRequest,
    execution_state: &execution::ExecutionState,
    workspace: &WorkspaceState,
    python: PathBuf,
    source: PathBuf,
) -> Result<ValidationRunResult, String> {
    validate_request(&request)?;
    let _active = acquire_running(state)?;
    let started = Instant::now();
    let started_at = chrono::Utc::now().to_rfc3339();
    let (sender, mut cancel) = oneshot::channel();
    *state
        .cancel
        .lock()
        .map_err(|_| "Validation state is busy.")? = Some(sender);
    let input = prepare_input(state, &request, execution_state, workspace)?;
    let config = input.config.to_string_lossy();
    let source_text = source.to_string_lossy();
    let output_directory = input.directory.join("validation");
    let output_text = output_directory.to_string_lossy();
    let output = process::run_python(
        &python,
        &[
            "-I",
            "-B",
            "-X",
            "utf8",
            "-c",
            PYTHON_BOOTSTRAP,
            &source_text,
            &output_text,
            "--config",
            &config,
        ],
        &source,
        &mut cancel,
        VALIDATION_TIMEOUT_SECONDS,
    )
    .await;
    let result = finish_validation(
        input,
        output,
        started_at,
        started.elapsed().as_millis() as u64,
        state,
    )?;
    Ok(result)
}

/// Acquire a single-flight guard before staging any work; duplicate jobs never replace its cancel slot.
fn acquire_running(state: &ValidationState) -> Result<ActiveValidation<'_>, String> {
    let mut running = state
        .running
        .lock()
        .map_err(|_| "Validation state is busy.")?;
    if *running {
        return Err("A validation is already running. Cancel it or wait for it to finish.".into());
    }
    *running = true;
    Ok(ActiveValidation(state))
}

/// Select the project on the host and copy verified bytes to isolate validation from later source edits.
fn prepare_input(
    state: &ValidationState,
    request: &ValidationRunRequest,
    execution_state: &execution::ExecutionState,
    workspace: &WorkspaceState,
) -> Result<ValidationInput, String> {
    let project =
        selected_project(workspace)?.ok_or("Open a project before validating a saved report.")?;
    let run = selected_run(execution_state, &project)?
        .ok_or("No successful execution is available for this project.")?;
    if run.run_id != request.run_id {
        return Err("The selected execution run changed. Refresh before validating.".into());
    }
    let bytes =
        reports::frozen_report_bytes(&execution_state.runs_directory, project.display(), &run)?;
    let validation_run_id = uuid::Uuid::new_v4().to_string();
    fs::create_dir_all(&state.validations_directory)
        .map_err(|error| format!("Cannot create validation storage ({error})."))?;
    let directory = state
        .validations_directory
        .canonicalize()
        .map_err(|error| error.to_string())?
        .join(&validation_run_id);
    fs::create_dir(&directory).map_err(|error| format!("Cannot stage validation ({error})."))?;
    let report = directory.join("source-report.json");
    fs::write(&report, bytes)
        .map_err(|error| format!("Cannot freeze validation source ({error})."))?;
    let parameters = directory.join("parameters.cbotset");
    fs::write(&parameters, "").map_err(|error| error.to_string())?;
    let config = directory.join("validation-config.json");
    let payload = build_config(&directory, &report, &parameters, &run, request)?;
    fs::write(
        &config,
        serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Cannot save validation configuration ({error})."))?;
    Ok(ValidationInput {
        run,
        project,
        directory,
        config,
        validation_run_id,
    })
}

/// Preserve the retained report-only configuration schema; no symbol, stress or walk-forward rerun is enabled.
fn build_config(
    directory: &Path,
    report: &Path,
    parameters: &Path,
    run: &execution::ExecutionRunResult,
    request: &ValidationRunRequest,
) -> Result<Value, String> {
    let gates = request.gates.clone().unwrap_or_default();
    let balance = run
        .account
        .as_ref()
        .map(|account| account.starting_capital)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or("The saved run lacks a valid starting capital for Monte Carlo validation.")?;
    let replay_start = run
        .replay
        .as_ref()
        .map(|replay| replay.first_time_utc.as_str())
        .ok_or("The saved run lacks its historical replay period.")?;
    chrono::DateTime::parse_from_rfc3339(replay_start)
        .map_err(|_| "The saved replay start time is malformed.")?;
    Ok(json!({
        "RunName":"validation", "Strategy":run.strategy, "ParameterFile":parameters,
        "ParameterOverrides":{}, "OutputRoot":directory, "RunBacktests":false,
        "Backtest":{"Project":directory.join("reruns-disabled.csproj"),"Timeframe":run.timeframe,"MaxTicks":0,"MaxWorkers":1},
        "Symbols":[],"Windows":[],"CostStress":{"SpreadMultipliers":[],"CommissionMultipliers":[]},
        "LatencyStress":{"LatencyTicks":[]},
        "WalkForward":{"StartUtc":replay_start,"EndUtc":replay_start},
        "MonteCarlo":{"Runs":request.monte_carlo_runs.unwrap_or(1000),"Seed":request.seed.unwrap_or(42),"Balance":balance,"SkipMin":0.05,"SkipMax":0.20,"SlippagePips":2.0,"PnlNoiseFraction":0.10},
        "Gates":{"MinTrades":gates.min_trades.unwrap_or(30),"MinProfitFactor":gates.min_profit_factor.unwrap_or(1.15),"MaxDrawdownPct":gates.max_drawdown_pct.unwrap_or(10.0),"MaxDailyDrawdownPct":gates.max_daily_drawdown_pct.unwrap_or(3.0),"MinSurvivability":gates.min_survivability.unwrap_or(0.8)},
        "ExistingReports":[report]
    }))
}

/// Parse genuine output files and preserve a prior good result when this process fails or is canceled.
fn finish_validation(
    input: ValidationInput,
    output: Result<std::process::Output, String>,
    started_at: String,
    duration_ms: u64,
    state: &ValidationState,
) -> Result<ValidationRunResult, String> {
    let verdict_path = input.directory.join("validation/FinalVerdict.json");
    let report_path = input.directory.join("validation/FinalReport.md");
    let mut errors = Vec::new();
    let mut status = "completed".to_string();
    let mut log = String::new();
    let mut captured_stdout = String::new();
    match output {
        Ok(output) => {
            captured_stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            log = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            if !output.status.success() {
                errors.push(format!(
                    "The validation process exited with {}.",
                    output.status
                ));
            }
        }
        Err(error) => {
            status = process_failure_status(&error).into();
            errors.push(error);
        }
    }
    let parsed =
        read_validation_outputs(&verdict_path, &report_path, &captured_stdout, &mut errors);
    let verdict = parsed
        .as_ref()
        .map(|value| value.verdict.clone())
        .unwrap_or_else(|| "UNPROVEN".into());
    let missing_evidence = parsed
        .as_ref()
        .map(|value| value.missing_evidence.clone())
        .unwrap_or_default();
    if let Err(error) = verify_staged_source(&input) {
        errors.push(error);
    }
    if status == "completed" && !errors.is_empty() {
        status = "failed".into();
    }
    let success = status == "completed";
    let preserved = !success
        && state
            .last_good
            .lock()
            .map_err(|_| "Validation state is busy.")?
            .is_some();
    let result = ValidationRunResult {
        validation_run_id: input.validation_run_id,
        execution_run_id: input.run.run_id,
        source_report_sha256: input.run.report_sha256.unwrap_or_default(),
        mode: "savedReport".into(),
        success,
        status,
        verdict,
        project_root: input.project.display().to_string(),
        started_at,
        completed_at: chrono::Utc::now().to_rfc3339(),
        duration_ms,
        validation_dir: input.directory.to_string_lossy().into(),
        config_path: input.config.to_string_lossy().into(),
        final_verdict_path: verdict_path.to_string_lossy().into(),
        final_report_path: report_path.to_string_lossy().into(),
        missing_evidence,
        errors,
        output: log.chars().take(12_000).collect(),
        last_good_preserved: preserved,
        output_provenance: parsed.map(|value| ValidationOutputProvenance {
            original_sha256: value.transport.original_sha256,
            envelope_sha256: value.transport.envelope_sha256,
            adapter_json_path: verdict_path
                .with_file_name("FinalVerdict.adapter.json")
                .to_string_lossy()
                .into_owned(),
            non_finite: value.transport.non_finite,
        }),
    };
    if success {
        store_good_result(state, &result, &input.project)?;
    }
    Ok(result)
}

/// Detect any staged-source edit during Python execution before accepting its validation output.
fn verify_staged_source(input: &ValidationInput) -> Result<(), String> {
    let bytes = read_bounded_file(&input.directory.join("source-report.json"))?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if input.run.report_sha256.as_deref() != Some(actual.as_str()) {
        return Err("The frozen validation source changed during processing. Discard this output and retry.".into());
    }
    Ok(())
}

/// Keep cancel, timeout and normal process failure visible as distinct lifecycle outcomes.
fn process_failure_status(error: &str) -> &'static str {
    if error == crate::workspace_build::CANCELLATION_MESSAGE {
        return "cancelled";
    }
    if error.contains("did not respond within") {
        return "timeout";
    }
    "failed"
}

/// Read original Markdown and authenticated strict transport, requiring report-only missing layers to remain explicit.
fn read_validation_outputs(
    verdict_path: &Path,
    report_path: &Path,
    captured_stdout: &str,
    errors: &mut Vec<String>,
) -> Option<ParsedValidationOutputs> {
    let parsed = parse_validation_outputs(verdict_path, report_path, captured_stdout);
    match parsed {
        Ok(value) => Some(value),
        Err(error) => {
            errors.push(error);
            None
        }
    }
}

/// Validate the engine's actual verdict vocabulary and evidence list without upgrading its verdict.
fn parse_validation_outputs(
    verdict_path: &Path,
    report_path: &Path,
    captured_stdout: &str,
) -> Result<ParsedValidationOutputs, String> {
    let report = read_bounded_file(report_path)?;
    if std::str::from_utf8(&report)
        .map_err(|_| "Validation Markdown is not valid UTF-8.")?
        .trim()
        .is_empty()
    {
        return Err("The validation Markdown report is empty.".into());
    }
    let original = read_bounded_file(verdict_path)?;
    let sidecar = read_bounded_file(&verdict_path.with_file_name("FinalVerdict.adapter.json"))?;
    let transport = crate::validation_output::verify(&original, &sidecar, captured_stdout)?;
    let raw = &transport.payload;
    let verdict = raw
        .pointer("/verdict/status")
        .and_then(Value::as_str)
        .ok_or("Validation verdict status is missing.")?;
    if !["PASS", "FAIL", "UNPROVEN"].contains(&verdict) {
        return Err("Validation verdict status is unrecognized.".into());
    }
    let missing: Vec<String> = serde_json::from_value(
        raw.pointer("/verdict/unproven")
            .cloned()
            .ok_or("Validation missing-evidence list is absent.")?,
    )
    .map_err(|_| "Validation missing-evidence list is malformed.")?;
    if !missing
        .iter()
        .any(|item| item == "engine_level_latency_stress")
        || !missing
            .iter()
            .any(|item| item == "walk_forward_embargo_backtests")
    {
        return Err("Report-only validation did not disclose its missing engine stress and walk-forward evidence.".into());
    }
    if verdict == "PASS" {
        return Err(
            "Report-only validation cannot establish PASS while engine rerun evidence is missing."
                .into(),
        );
    }
    Ok(ParsedValidationOutputs {
        verdict: verdict.into(),
        missing_evidence: missing,
        transport,
    })
}

/// Bound allocation before parsing potentially damaged validation output.
fn read_bounded_file(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| format!("Cannot read {} ({error}).", path.display()))?
        .take(MAX_REPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_REPORT_BYTES {
        return Err("Validation output is empty or exceeds 64 MiB.".into());
    }
    Ok(bytes)
}

/// Persist session-local result identity only after output verification succeeds.
fn store_good_result(
    state: &ValidationState,
    result: &ValidationRunResult,
    project: &ProjectRoot,
) -> Result<(), String> {
    // Global validation slot order: canonical project, execution run id, then full result.
    let mut bound_project = state
        .last_good_project
        .lock()
        .map_err(|_| "Validation state is busy.")?;
    let mut bound_run = state
        .last_good_execution_run_id
        .lock()
        .map_err(|_| "Validation state is busy.")?;
    let mut last = state
        .last_good
        .lock()
        .map_err(|_| "Validation state is busy.")?;
    *bound_project = Some(project.directory().to_string_lossy().into_owned());
    *bound_run = Some(result.execution_run_id.clone());
    *last = Some(result.clone());
    Ok(())
}

/// Signal cancellation of the active direct Python process; report-only mode spawns no engine children.
pub fn cancel_validation(state: &ValidationState) -> Result<(), String> {
    if let Some(sender) = state
        .cancel
        .lock()
        .map_err(|_| "Validation state is busy.")?
        .take()
    {
        let _ = sender.send(());
    }
    Ok(())
}

/// Return the last completed evidence only when project, successful run and source hash still match.
pub fn last_good_validation_result(
    state: &ValidationState,
    workspace: &WorkspaceState,
    execution_state: &execution::ExecutionState,
) -> Result<Option<ValidationRunResult>, String> {
    let Some(project) = selected_project(workspace)? else {
        return Ok(None);
    };
    let Some(run) = selected_run(execution_state, &project)? else {
        return Ok(None);
    };
    selected_validation_result(state, &project, &run)
}

/// Snapshot the validation's private project/run binding and public result under the same publisher lock order.
fn selected_validation_result(
    state: &ValidationState,
    project: &ProjectRoot,
    run: &execution::ExecutionRunResult,
) -> Result<Option<ValidationRunResult>, String> {
    let bound_project = state
        .last_good_project
        .lock()
        .map_err(|_| "Validation state is busy.")?;
    let bound_run = state
        .last_good_execution_run_id
        .lock()
        .map_err(|_| "Validation state is busy.")?;
    let result = state
        .last_good
        .lock()
        .map_err(|_| "Validation state is busy.")?
        .clone();
    if !bound_project
        .as_deref()
        .is_some_and(|identity| project.matches_canonical_identity(identity))
        || bound_run.as_deref() != Some(run.run_id.as_str())
    {
        return Ok(None);
    }
    Ok(result.filter(|result| {
        result.project_root == project.display()
            && result.execution_run_id == run.run_id
            && Some(result.source_report_sha256.as_str()) == run.report_sha256.as_deref()
    }))
}

/// Read the canonical project identity selected on the host.
fn selected_project(workspace: &WorkspaceState) -> Result<Option<ProjectRoot>, String> {
    Ok(workspace
        .selected
        .lock()
        .map_err(|_| "Workspace state is busy.")?
        .as_ref()
        .cloned())
}

/// Read a successful execution only for its matching host-selected project.
fn selected_run(
    state: &execution::ExecutionState,
    project: &ProjectRoot,
) -> Result<Option<execution::ExecutionRunResult>, String> {
    execution::last_good_execution_for_project(state, project)
}

#[cfg(test)]
#[path = "validation_tests.rs"]
mod tests;
