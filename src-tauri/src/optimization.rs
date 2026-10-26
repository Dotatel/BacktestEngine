//! Real bounded optimization through the unchanged C# optimizer and a kernel-contained managed host.
use crate::{execution, market_data, workspace, workspace_build, WorkspaceState};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{Manager, State};
use tokio::sync::oneshot;

#[path = "optimization_binding.rs"]
mod binding;
#[path = "optimizer_capture.rs"]
mod capture;
#[path = "optimization_contract.rs"]
mod contract;
#[path = "optimization_parameters.rs"]
mod parameters;
#[path = "optimization_parse.rs"]
mod parse;
#[path = "optimization_process.rs"]
mod process;
pub use contract::{OptimizationRunRequest, OptimizationRunResult};

const OPTIMIZATION_TIMEOUT_SECONDS: u64 = 1800;

/// Session-local job ownership and completed evidence; saved original files remain durable in owned storage.
pub struct OptimizationState {
    pub directory: PathBuf,
    pub running: Mutex<bool>,
    pub cancel: Mutex<Option<oneshot::Sender<()>>>,
    pub last_good: Mutex<Option<OptimizationRunResult>>,
    pub(crate) retained_inputs: Mutex<Option<capture::FrozenOptimizerCapture>>,
}

/// Release both replay/optimization latches only after the owned optimizer future has settled.
struct OptimizationGuard<'a> {
    optimization: &'a OptimizationState,
    execution: &'a execution::ExecutionState,
    cleanup: Arc<AtomicBool>,
    inputs: Option<capture::FrozenOptimizerCapture>,
}
impl Drop for OptimizationGuard<'_> {
    /// Clear this job's cancel slot before allowing another native replay.
    fn drop(&mut self) {
        if let Ok(mut cancel) = self.optimization.cancel.lock() {
            cancel.take();
        }
        if !self.cleanup.load(Ordering::Acquire) {
            *self
                .optimization
                .retained_inputs
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = self.inputs.take();
            return;
        }
        if let Ok(mut running) = self.execution.running.lock() {
            *running = false;
        }
        if let Ok(mut running) = self.optimization.running.lock() {
            *running = false;
        }
    }
}

/// Prepared native paths and exact input identities, all derived after shared preflight.
struct PreparedOptimization {
    directory: PathBuf,
    config: PathBuf,
    config_sha256: String,
    dataset_sha256: String,
    symbol: String,
    run_id: String,
    symbol_spec_sha256: String,
    base_parameter_sha256: String,
    capture: Option<capture::FrozenOptimizerCapture>,
}

/// Verify selected host project/build, then launch the original optimizer with bounded typed settings.
#[tauri::command]
pub async fn optimization_run(
    app: tauri::AppHandle,
    request: OptimizationRunRequest,
    state: State<'_, OptimizationState>,
    execution_state: State<'_, execution::ExecutionState>,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<OptimizationRunResult, String> {
    let approved = selected_approval(workspace_state.inner())?;
    let host = resolve_optimizer_host(&app)?;
    let engine = workspace_build::resolve_engine_source(&app)?;
    let runtime = crate::build_process::resolve_runtime(&app)?;
    run_optimization(
        state.inner(),
        execution_state.inner(),
        &approved,
        request,
        &host,
        &engine,
        &runtime,
    )
    .await
}

/// Cancel only this app-owned optimizer job; its managed host's kernel job owns descendants.
#[tauri::command]
pub fn optimization_cancel(state: State<OptimizationState>) -> Result<(), String> {
    if let Some(sender) = state
        .cancel
        .lock()
        .map_err(|_| "Optimization state is busy.")?
        .take()
    {
        let _ = sender.send(());
    }
    Ok(())
}

/// Restore only completed evidence for the same current selected project and approved source revision.
#[tauri::command]
pub fn optimization_last_good_result(
    state: State<OptimizationState>,
    workspace_state: State<WorkspaceState>,
) -> Result<Option<OptimizationRunResult>, String> {
    last_good_optimization_result(state.inner(), workspace_state.inner())
}

/// Restore public result identity only through the selected project's private canonical approval.
fn last_good_optimization_result(
    state: &OptimizationState,
    workspace_state: &WorkspaceState,
) -> Result<Option<OptimizationRunResult>, String> {
    let approved = match selected_approval(workspace_state) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let result = state
        .last_good
        .lock()
        .map_err(|_| "Optimization state is busy.")?
        .clone();
    Ok(result.filter(|result| {
        result.project_root == workspace::public_project_identity(Path::new(&approved.project_root))
            && result.build_revision == approved.revision
            && result.approved_artifact_sha256 == approved.artifact_sha256
    }))
}

/// Read authoritative approval after checking host-selected project binding; renderer paths are never consulted.
fn selected_approval(workspace: &WorkspaceState) -> Result<workspace_build::ApprovedBuild, String> {
    let selected = workspace
        .selected
        .lock()
        .map_err(|_| "Workspace state is busy.")?;
    let root = selected
        .as_ref()
        .ok_or("Open a project before optimization.")?;
    let approved = workspace
        .last_successful_build
        .lock()
        .map_err(|_| "Workspace state is busy.")?
        .clone()
        .ok_or("Build a strategy successfully before optimization.")?;
    if !root.matches_canonical_identity(&approved.project_root) {
        return Err(
            "The selected project differs from the approved build. Rebuild and retry.".into(),
        );
    }
    Ok(approved)
}

/// Run a genuine optimizer attempt using a verified host capability and shared execution preflight.
async fn run_optimization(
    state: &OptimizationState,
    execution: &execution::ExecutionState,
    approved: &workspace_build::ApprovedBuild,
    request: OptimizationRunRequest,
    host: &Path,
    engine: &Path,
    runtime: &crate::build_process::BuildRuntime,
) -> Result<OptimizationRunResult, String> {
    validate_request(&request)?;
    let schema = approved
        .parameter_schemas
        .iter()
        .find(|schema| schema.strategy == request.strategy)
        .ok_or("The approved strategy schema is unavailable. Rebuild and retry.")?;
    let search = parameters::validate_search(&request, schema)?;
    let (replay, profile) = execution_request(execution, &request)?;
    let inputs = execution::preflight_execution_inputs(execution, &replay, approved)?;
    let mut guard = acquire_job(state, execution)?;
    let (sender, mut cancel) = oneshot::channel();
    *state
        .cancel
        .lock()
        .map_err(|_| "Optimization state is busy.")? = Some(sender);
    let started = Instant::now();
    let started_at = chrono::Utc::now().to_rfc3339();
    let compiler =
        workspace_build::require_compiler(runtime, &mut cancel, guard.cleanup.clone()).await?;
    let mut prepared =
        prepare_optimization(state, approved, &request, &inputs, &profile, search, engine)?;
    guard.inputs = prepared.capture.take();
    guard
        .inputs
        .as_mut()
        .ok_or("Optimizer capture is unavailable.")?
        .verify()?;
    let outcome = process::run_optimizer(
        &compiler.executable,
        host,
        &prepared.config,
        &prepared.directory,
        &mut cancel,
        OPTIMIZATION_TIMEOUT_SECONDS,
        guard.cleanup.clone(),
    )
    .await;
    if !guard.cleanup.load(Ordering::Acquire) {
        return Err(format!("{}: optimizer cleanup remains unconfirmed; inputs and busy state are retained until restart.",crate::engine_job::CLEANUP_UNCONFIRMED));
    }
    guard
        .inputs
        .as_mut()
        .ok_or("Optimizer capture was lost.")?
        .verify()?;
    prepared.capture = guard.inputs.take();
    finish_optimization(
        state,
        approved,
        &request,
        prepared,
        outcome,
        started_at,
        started.elapsed().as_millis() as u64,
    )
}

/// Bound unsupported fields and replay text; original engine/optimizer remain authoritative for actual execution.
fn validate_request(request: &OptimizationRunRequest) -> Result<(), String> {
    if request.slippage_pips != 0.0 {
        return Err("The retained optimizer cannot represent nonzero execution slippage. Set slippage to zero; no value is silently dropped.".into());
    }
    if request.timeframe.trim().is_empty() || request.timeframe.len() > 64 {
        return Err("Choose an explicit chart timeframe for optimization.".into());
    }
    if [
        &request.dataset_id,
        &request.symbol_spec_id,
        &request.strategy,
    ]
    .iter()
    .any(|value| value.is_empty() || value.len() > 256)
    {
        return Err(
            "Choose registered data, a registered profile and an approved strategy.".into(),
        );
    }
    if request
        .max_ticks
        .is_some_and(|value| value > i32::MAX as i64)
        || request
            .max_bars
            .is_some_and(|value| value > i32::MAX as i64)
    {
        return Err("Replay limits exceed the retained optimizer's 32-bit bounds.".into());
    }
    for value in [&request.start_utc, &request.end_utc].into_iter().flatten() {
        if !value.is_empty() && chrono::DateTime::parse_from_rfc3339(value).is_err() {
            return Err("Optimization dates must be UTC ISO-8601 timestamps.".into());
        }
    }
    Ok(())
}

/// Resolve catalog IDs on the host and reuse the ordinary replay request/preflight contract.
fn execution_request(
    state: &execution::ExecutionState,
    request: &OptimizationRunRequest,
) -> Result<
    (
        execution::ExecutionRunRequest,
        market_data::ImportedSymbolSpec,
    ),
    String,
> {
    let profile = market_data::list_symbol_specs(&state.market_data_directory)?
        .into_iter()
        .find(|profile| profile.id == request.symbol_spec_id)
        .ok_or("The selected economics profile is no longer registered.")?;
    let replay = execution::ExecutionRunRequest {
        build_artifact_path: None,
        strategy: request.strategy.clone(),
        dataset_id: request.dataset_id.clone(),
        symbol_spec_path: profile.stored_path.clone(),
        parameter_path: None,
        parameter_overrides: None,
        starting_balance: request.starting_balance,
        commission_usd_per_million: request.commission_usd_per_million,
        slippage_pips: request.slippage_pips,
        spread_pips: request.spread_pips,
        symbol: None,
        timeframe: Some(request.timeframe.clone()),
        bar_timeframe: request.bar_timeframe.clone(),
        bar_price_mode: request.bar_price_mode.clone(),
        start_utc: request.start_utc.clone(),
        end_utc: request.end_utc.clone(),
        max_ticks: request.max_ticks,
        max_bars: request.max_bars,
        write_equity_csv: true,
    };
    Ok((replay, profile))
}

/// Serialize a batch against ordinary replay so canceled or concurrent work cannot silently overlap.
fn acquire_job<'a>(
    optimization: &'a OptimizationState,
    execution: &'a execution::ExecutionState,
) -> Result<OptimizationGuard<'a>, String> {
    let mut own = optimization
        .running
        .lock()
        .map_err(|_| "Optimization state is busy.")?;
    let mut replay = execution
        .running
        .lock()
        .map_err(|_| "Execution state is busy.")?;
    if *own || *replay {
        return Err(
            "A replay or optimization is already running. Cancel it or wait for completion.".into(),
        );
    }
    *own = true;
    *replay = true;
    Ok(OptimizationGuard {
        optimization,
        execution,
        cleanup: Arc::new(AtomicBool::new(true)),
        inputs: None,
    })
}

/// Freeze fresh source/data/base settings and write the original optimizer's native JSON configuration.
fn prepare_optimization(
    state: &OptimizationState,
    approved: &workspace_build::ApprovedBuild,
    request: &OptimizationRunRequest,
    inputs: &execution::ExecutionInputs,
    profile: &market_data::ImportedSymbolSpec,
    search: parameters::ValidatedSearch,
    engine: &Path,
) -> Result<PreparedOptimization, String> {
    if inputs.dataset_record.kind == "bars"
        && (request.spread_pips.is_none()
            || request
                .bar_timeframe
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
            || !matches!(
                request.bar_price_mode.as_deref(),
                Some("ohlc" | "open" | "native-m1")
            ))
    {
        return Err("Bar optimization requires explicit source timeframe, non-negative spread and supported price mode.".into());
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    fs::create_dir_all(&state.directory).map_err(|error| error.to_string())?;
    let directory = crate::build_process::workflow_directory(&state.directory)?.join(&run_id);
    fs::create_dir(&directory).map_err(|error| error.to_string())?;
    let root = workspace::ProjectRoot::open(&approved.project_root)?;
    let fresh = workspace_build::assemble(&root, engine, &directory.join("source-stage"))?;
    let receipt: Value = serde_json::from_slice(&market_data::read_limited_bytes(
        &fresh.snapshot.join("revision.json"),
        1024 * 1024,
    )?)
    .map_err(|error| error.to_string())?;
    if receipt["revision"].as_str() != Some(approved.revision.as_str())
        || inputs.build_revision != approved.revision
    {
        return Err(
            "The fresh optimizer source differs from its approved build. Rebuild and retry.".into(),
        );
    }
    let runner = directory.join("runner");
    fs::rename(&fresh.snapshot, &runner).map_err(|error| error.to_string())?;
    let preset = directory.join("base.cbotset");
    fs::write(&preset,serde_json::to_vec_pretty(&json!({"Chart":{"Symbol":inputs.resolved_symbol,"Period":request.timeframe},"Parameters":search.base})).map_err(|error|error.to_string())?).map_err(|error|error.to_string())?;
    let base_parameter_sha256 =
        binding::digest(&fs::read(&preset).map_err(|error| error.to_string())?);
    let payload = optimizer_config(request, inputs, &directory, search.dimensions);
    let config_bytes = serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?;
    let config_sha256 = format!("{:x}", Sha256::digest(&config_bytes));
    let config = directory.join("optimizer.json");
    fs::write(&config, config_bytes).map_err(|error| error.to_string())?;
    let captured = capture::freeze_inputs(&directory, approved, &inputs.dataset_record, profile)?;
    let dataset_sha256 = captured.provenance.dataset_sha256.clone();
    let symbol_spec_sha256 = captured.provenance.profile_sha256.clone();
    Ok(PreparedOptimization {
        directory,
        config,
        config_sha256,
        dataset_sha256,
        symbol: inputs.resolved_symbol.clone(),
        run_id,
        symbol_spec_sha256,
        base_parameter_sha256,
        capture: Some(captured),
    })
}

/// Map supported explicit scenario fields directly to the retained original schema without generating candidates.
fn optimizer_config(
    request: &OptimizationRunRequest,
    inputs: &execution::ExecutionInputs,
    directory: &Path,
    dimensions: Value,
) -> Value {
    json!({"strategy":request.strategy,"runner_project":directory.join("runner/WorkspaceCompile.csproj"),"build_runner":true,"base_params":directory.join("base.cbotset"),
        "scenario":{"name":"frozen-replay","symbol":inputs.resolved_symbol,"timeframe":request.timeframe,"data_mode":inputs.dataset_record.kind,"data_file":directory.join("market.csv"),"symbol_spec":directory.join("profile.json"),"bar_period":request.bar_timeframe,"bar_price_mode":request.bar_price_mode,"balance":request.starting_balance,"spread_pips":request.spread_pips,"commission_usd_per_million":request.commission_usd_per_million,"start_utc":request.start_utc.clone().unwrap_or_default(),"end_utc":request.end_utc.clone().unwrap_or_default(),"max_ticks":request.max_ticks,"max_bars":request.max_bars,"skip_equity_csv":false},
        "search":{"method":request.method,"seed":request.seed,"max_runs":request.max_runs},"parameters":dimensions,"cpu":{"max_percent":50,"leave_cores_free":1,"max_workers":request.max_workers},
        "output":{"dir":directory.join("output"),"write_candidate_cbot_set":true,"write_html_report":true,"write_events_json":true,"write_combined_log":true}})
}

/// Preserve process errors and original failed candidates; only strict, complete source evidence becomes last-good.
fn finish_optimization(
    state: &OptimizationState,
    approved: &workspace_build::ApprovedBuild,
    request: &OptimizationRunRequest,
    prepared: PreparedOptimization,
    outcome: Result<std::process::Output, String>,
    started_at: String,
    duration_ms: u64,
) -> Result<OptimizationRunResult, String> {
    let mut errors = Vec::new();
    let mut status = "completed".to_string();
    let mut exit_code = None;
    let mut output = String::new();
    let mut candidates = Vec::new();
    let mut host_stdout = String::new();
    match outcome {
        Ok(value) => {
            host_stdout = String::from_utf8_lossy(&value.stdout).into_owned();
            exit_code = value.status.code();
            output = format!(
                "{}{}",
                String::from_utf8_lossy(&value.stdout),
                String::from_utf8_lossy(&value.stderr)
            );
            if ![Some(0), Some(2)].contains(&exit_code) {
                status = "failed".into();
                errors.push(format!("The optimizer exited with {}.", value.status));
            }
        }
        Err(error) => {
            status = process_error_status(&error).into();
            errors.push(error);
        }
    }
    let bindings = prepared
        .capture
        .as_ref()
        .ok_or_else(|| "The optimizer has no host-owned input capture.".to_string())
        .and_then(|captured| {
            binding::load(
                &prepared.directory,
                &host_stdout,
                binding::FrozenInputs {
                    config: &prepared.config_sha256,
                    base: &prepared.base_parameter_sha256,
                    data: &prepared.dataset_sha256,
                    profile: &prepared.symbol_spec_sha256,
                    capture: &captured.provenance.capture_sha256,
                    source: &captured.provenance.source_manifest_sha256,
                },
            )
        });
    if status == "completed" {
        match parse::read_candidates(
            &prepared.directory.join("output"),
            request.max_runs,
            &request.strategy,
            &prepared.symbol,
            bindings.as_ref().map_err(String::as_str),
        ) {
            Ok(value) => candidates = value,
            Err(error) => {
                status = "failed".into();
                errors.push(error);
            }
        }
    } else {
        match parse::read_partial_candidates(
            &prepared.directory.join("output"),
            request.max_runs,
            &request.strategy,
            &prepared.symbol,
            bindings.as_ref().map_err(String::as_str),
        ) {
            Ok(value) => candidates = value,
            Err(error) => errors.push(error),
        }
    }
    let success = status == "completed"
        && exit_code == Some(0)
        && candidates
            .iter()
            .all(|candidate| candidate.status == "completed");
    if status == "completed" && !success {
        errors.push("Optimization retained failed or unproven candidates. Their missing metrics are unavailable; no candidate is automatically recommended.".into());
    }
    let preserved = !success
        && state
            .last_good
            .lock()
            .map_err(|_| "Optimization state is busy.")?
            .is_some();
    let result = OptimizationRunResult {
        run_id: prepared.run_id,
        project_root: workspace::public_project_identity(Path::new(&approved.project_root)),
        build_revision: approved.revision.clone(),
        approved_artifact_sha256: approved.artifact_sha256.clone(),
        dataset_id: request.dataset_id.clone(),
        dataset_sha256: prepared.dataset_sha256,
        symbol_spec_id: request.symbol_spec_id.clone(),
        symbol_spec_sha256: prepared.symbol_spec_sha256,
        config_sha256: prepared.config_sha256,
        strategy: request.strategy.clone(),
        method: request.method.clone(),
        seed: request.seed,
        budget: request.max_runs,
        started_at,
        completed_at: chrono::Utc::now().to_rfc3339(),
        duration_ms,
        run_folder: prepared.directory.to_string_lossy().into_owned(),
        config_path: prepared.config.to_string_lossy().into_owned(),
        status,
        success,
        exit_code,
        candidates,
        errors,
        output: output.chars().take(12000).collect(),
        last_good_preserved: preserved,
        input_provenance: prepared
            .capture
            .as_ref()
            .map(|captured| captured.provenance.clone()),
        compiled_runner: bindings
            .as_ref()
            .ok()
            .and_then(|receipt| receipt.compiled_provenance()),
    };
    if success {
        *state
            .last_good
            .lock()
            .map_err(|_| "Optimization state is busy.")? = Some(result.clone());
    }
    Ok(result)
}

/// Distinguish cancellation/timeout from actual optimizer failures without changing their diagnostics.
fn process_error_status(error: &str) -> &'static str {
    if error.contains("was canceled") {
        return "cancelled";
    }
    if error.contains("exceeded") && error.contains("seconds") {
        return "timeout";
    }
    "failed"
}

/// Trusted resource manifest records only known runtime loading companions, never arbitrary renderer paths.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostManifest {
    files: std::collections::BTreeMap<String, String>,
    app_source_sha256: std::collections::BTreeMap<String, String>,
}

/// Require a staged host and exact companion bytes before launching any optimizer work.
fn resolve_optimizer_host(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("optimizer");
    #[cfg(debug_assertions)]
    let resource = if resource.join("OptimizationHost.dll").is_file() {
        resource
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/optimizer")
    };
    verify_optimizer_host(&resource)
}

/// Verify fixed host filenames and hash-bound companions, rejecting links and unsupported payload records.
fn verify_optimizer_host(directory: &Path) -> Result<PathBuf, String> {
    let directory = directory.canonicalize().map_err(|_| {
        "The original optimizer resource is unavailable. Prepare/reinstall the optimization engine."
    })?;
    let manifest: HostManifest = serde_json::from_slice(&market_data::read_limited_bytes(
        &directory.join("manifest.json"),
        1024 * 1024,
    )?)
    .map_err(|_| "The optimizer resource manifest is malformed.")?;
    for (name, bytes) in [
        (
            "OptimizationHost.cs",
            include_bytes!("../optimizer-host/OptimizationHost.cs").as_slice(),
        ),
        (
            "CandidateBindings.cs",
            include_bytes!("../optimizer-host/CandidateBindings.cs").as_slice(),
        ),
        (
            "process_job.cs",
            include_bytes!("../optimizer-host/process_job.cs").as_slice(),
        ),
    ] {
        if manifest.app_source_sha256.get(name) != Some(&crate::replay_receipt::digest(bytes)) {
            return Err(format!("Optimizer host source {name} differs from this application. Restage/rebuild the managed host."));
        }
    }
    for name in [
        "OptimizationHost.dll",
        "OptimizationHost.deps.json",
        "OptimizationHost.runtimeconfig.json",
    ] {
        let expected = directory.join(name);
        let path = expected
            .canonicalize()
            .map_err(|_| format!("Optimizer companion {name} is missing."))?;
        if path != expected {
            return Err("The optimizer host is redirected outside its resource folder.".into());
        }
        let bytes = market_data::read_limited_bytes(&path, 64 * 1024 * 1024)?;
        let hash = format!("{:x}", Sha256::digest(bytes));
        if manifest.files.get(name) != Some(&hash) {
            return Err(format!(
                "Optimizer companion {name} differs from its staged manifest."
            ));
        }
    }
    Ok(directory.join("OptimizationHost.dll"))
}

#[cfg(test)]
#[path = "optimization_tests.rs"]
mod tests;
