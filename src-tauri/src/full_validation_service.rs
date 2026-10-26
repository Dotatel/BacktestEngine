//! Selected-run full validation lifecycle; process completion and the original numerical verdict remain separate.
use super::{
    accept_full_outputs, prepare_full_validation, BaselineEvidence, FullValidationEvidence,
};
use crate::{
    execution,
    full_validation_contract::{FullValidationRequest, FULL_VALIDATION_TIMEOUT_SECONDS},
    reports, validation,
    workspace::ProjectRoot,
    workspace_build, WorkspaceState,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tokio::sync::oneshot;

/// One coherent last-good full result and an independently owned cancellation sender.
pub(crate) struct FullValidationState {
    pub directory: PathBuf,
    cancel: Mutex<Option<oneshot::Sender<()>>>,
    last_good: Mutex<Option<FullValidationRunResult>>,
    blocked_inputs: Mutex<Option<super::PreparedFullValidation>>,
}

impl FullValidationState {
    /// Store only app-owned validation outputs; no background work is started by initialization.
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            cancel: Mutex::new(None),
            last_good: Mutex::new(None),
            blocked_inputs: Mutex::new(None),
        }
    }
}

/// The full result binds exact baseline/receipt/config/adapter/scenario evidence and original verdict.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FullValidationRunResult {
    pub validation_run_id: String,
    pub execution_run_id: String,
    pub project_root: String,
    #[serde(skip)]
    canonical_project_root: String,
    pub replay_receipt_sha256: String,
    pub source_report_sha256: String,
    pub source_manifest_sha256: String,
    pub config_sha256: String,
    pub generated_entry_sha256: String,
    pub host_sha256: String,
    pub producer_sha256: String,
    pub producer: crate::validation_package::ValidationProducerProvenance,
    pub success: bool,
    pub status: String,
    pub verdict: String,
    pub mode: String,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    pub validation_directory: String,
    pub config_path: String,
    pub planned_scenarios: usize,
    pub generated_walk_forward_windows: usize,
    pub excluded_walk_forward_windows: usize,
    pub evidence: Option<FullValidationEvidence>,
    pub errors: Vec<String>,
    pub output: String,
    pub last_good_preserved: bool,
}

/// Release only this full workflow's sender; the existing shared validation guard releases its global latch.
struct FullGuard<'a> {
    state: &'a FullValidationState,
    cleanup: Arc<AtomicBool>,
    prepared: Option<super::PreparedFullValidation>,
}
impl Drop for FullGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut sender) = self.state.cancel.lock() {
            sender.take();
        }
        if !self.cleanup.load(Ordering::Acquire) {
            // Retention owns handles even after mutex poisoning; unknown cleanup must never release authority locks.
            *self
                .state
                .blocked_inputs
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = self.prepared.take();
        }
    }
}

/// Release both engine/validation latches together in the same global order used by acquisition.
pub(super) struct EngineValidationGuard<'a> {
    validation: &'a validation::ValidationState,
    execution: &'a execution::ExecutionState,
    cleanup: Arc<AtomicBool>,
}
impl Drop for EngineValidationGuard<'_> {
    fn drop(&mut self) {
        if !self.cleanup.load(Ordering::Acquire) {
            return;
        }
        if let (Ok(mut validation), Ok(mut execution)) = (
            self.validation.running.lock(),
            self.execution.running.lock(),
        ) {
            *validation = false;
            *execution = false;
        }
    }
}

impl EngineValidationGuard<'_> {
    /// Share only the termination confirmation bit; neither caller nor renderer receives a job handle.
    pub(super) fn cleanup_marker(&self) -> Arc<AtomicBool> {
        self.cleanup.clone()
    }
}

/// Serialize full reruns with report validation, ordinary replay and optimizer jobs; no mutex survives this call.
pub(super) fn acquire_engine_job<'a>(
    validation: &'a validation::ValidationState,
    execution: &'a execution::ExecutionState,
) -> Result<EngineValidationGuard<'a>, String> {
    let mut own = validation
        .running
        .lock()
        .map_err(|_| "Validation state is busy.")?;
    let mut replay = execution
        .running
        .lock()
        .map_err(|_| "Execution state is busy.")?;
    if *own || *replay {
        return Err("A validation, replay or optimization is already running. Cancel it or wait for completion.".into());
    }
    *own = true;
    *replay = true;
    Ok(EngineValidationGuard {
        validation,
        execution,
        cleanup: Arc::new(AtomicBool::new(true)),
    })
}

/// Execute only the coherently selected successful baseline with a host-captured input receipt.
pub(crate) async fn full_validation_run(
    app: tauri::AppHandle,
    state: &FullValidationState,
    shared: &validation::ValidationState,
    executions: &execution::ExecutionState,
    workspace: &WorkspaceState,
    request: FullValidationRequest,
) -> Result<FullValidationRunResult, String> {
    crate::full_validation_contract::validate_request(&request)?;
    let (project, baseline) = selected_baseline(executions, workspace)?;
    let receipt_sha=baseline.replay_receipt_sha256.clone().ok_or("This saved execution has no frozen replay receipt. Run a new baseline before requesting full engine validation.")?;
    let report_sha = baseline
        .report_sha256
        .clone()
        .ok_or("The successful baseline lacks its completion report hash.")?;
    if baseline.run_id != request.execution_run_id || receipt_sha != request.replay_receipt_sha256 {
        return Err("The selected baseline/receipt changed before full validation started.".into());
    }
    reports::frozen_report_bytes(&executions.runs_directory, project.display(), &baseline)?;
    let engine_guard = acquire_engine_job(shared, executions)?;
    let (sender, mut cancel) = oneshot::channel();
    *state
        .cancel
        .lock()
        .map_err(|_| "Full validation is busy.")? = Some(sender);
    let mut guard = FullGuard {
        state,
        cleanup: engine_guard.cleanup_marker(),
        prepared: None,
    };
    let started = Instant::now();
    let started_at = chrono::Utc::now().to_rfc3339();
    let build_runtime = crate::build_process::resolve_runtime(&app)?;
    let compiler = workspace_build::require_compiler(
        &build_runtime,
        &mut cancel,
        engine_guard.cleanup_marker(),
    )
    .await?;
    let source = validation::resolve_validation_source(&app)?;
    let host = super::runtime::resolve_host(&app)?;
    let host_sha = crate::replay_receipt::digest(&crate::market_data::read_limited_bytes(
        &host,
        crate::market_data::MAX_IMPORT_BYTES,
    )?);
    crate::replay_receipt::ensure_plain_path(&state.directory)?;
    fs::create_dir_all(&state.directory).map_err(|error| error.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let directory = crate::build_process::workflow_directory(&state.directory)?.join(&id);
    guard.prepared = Some(prepare_full_validation(
        &PathBuf::from(&baseline.run_folder).join("replay-inputs"),
        BaselineEvidence {
            canonical_project_root: &project.directory().to_string_lossy(),
            execution_run_id: &baseline.run_id,
            replay_receipt_sha256: &receipt_sha,
            source_report_sha256: &report_sha,
        },
        &request,
        &directory,
    )?);
    let cleanup = guard.cleanup.clone();
    let prepared = guard
        .prepared
        .as_mut()
        .ok_or("Full validation preparation is missing.")?;
    let python = build_runtime
        .bootstrap
        .parent()
        .and_then(|dotnet| dotnet.parent())
        .ok_or("The verified packaged runtime layout has no Python sibling.")?
        .join("python/python.exe");
    prepared.producer = Some(crate::validation_package::freeze_validation_package(
        &source,
        &prepared.directory.join("python-package"),
        &python,
    )?);
    let producer = prepared
        .producer
        .as_ref()
        .ok_or("The frozen validation producer is missing.")?;
    let producer_provenance = producer.provenance.clone();
    let producer_sha256 = producer.provenance_sha256.clone();
    let remaining = FULL_VALIDATION_TIMEOUT_SECONDS
        .checked_sub(started.elapsed().as_secs())
        .filter(|value| *value > 0)
        .ok_or("Full validation exhausted its budget during preparation.")?;
    let outcome = super::process::run_full_validation(
        super::process::ValidationRuntime {
            compiler: &compiler.executable,
            host: &host,
            python: &producer.python,
            source: &producer.root,
        },
        prepared,
        &mut cancel,
        remaining,
        cleanup,
    )
    .await;
    let mut errors = Vec::new();
    let mut status = "completed".to_string();
    let mut output = String::new();
    let mut evidence = None;
    match outcome {
        Ok(process) => {
            output = format!(
                "{}{}",
                String::from_utf8_lossy(&process.stdout),
                String::from_utf8_lossy(&process.stderr)
            );
            match accept_full_outputs(prepared, &process) {
                Ok(value) => evidence = Some(value),
                Err(error) => errors.push(error),
            }
        }
        Err(error) => {
            status = if error.contains(super::job::CLEANUP_UNCONFIRMED) {
                "cleanupUnconfirmed".into()
            } else if error.contains("canceled") {
                "cancelled".into()
            } else if error.contains("exceeded 600 seconds") {
                "timeout".into()
            } else {
                "failed".into()
            };
            errors.push(error);
        }
    }
    let success = evidence.is_some() && errors.is_empty();
    if !success && status == "completed" {
        status = "failed".into();
    }
    let preserved = state
        .last_good
        .lock()
        .map_err(|_| "Full validation is busy.")?
        .is_some();
    let result = FullValidationRunResult {
        validation_run_id: id,
        execution_run_id: baseline.run_id.clone(),
        project_root: project.display().into(),
        canonical_project_root: project.directory().to_string_lossy().into(),
        replay_receipt_sha256: receipt_sha,
        source_report_sha256: prepared.source_report_sha256.clone(),
        source_manifest_sha256: prepared.receipt.source_manifest.sha256.clone(),
        config_sha256: prepared.config_sha256.clone(),
        generated_entry_sha256: prepared.generated_entry_sha256.clone(),
        host_sha256: host_sha,
        producer_sha256,
        producer: producer_provenance,
        success,
        status,
        verdict: evidence
            .as_ref()
            .map(|value| value.verdict.clone())
            .unwrap_or_else(|| "UNPROVEN".into()),
        mode: "fullRerun".into(),
        started_at,
        completed_at: chrono::Utc::now().to_rfc3339(),
        duration_ms: started.elapsed().as_millis() as u64,
        validation_directory: directory.to_string_lossy().into(),
        config_path: prepared.config_path.to_string_lossy().into(),
        planned_scenarios: prepared.plan.scenarios.len(),
        generated_walk_forward_windows: prepared.plan.generated_walk_forward_windows,
        excluded_walk_forward_windows: prepared.plan.excluded_walk_forward_windows,
        evidence,
        errors,
        output,
        last_good_preserved: preserved,
    };
    if result.success {
        *state
            .last_good
            .lock()
            .map_err(|_| "Full validation is busy.")? = Some(result.clone());
    }
    Ok(result)
}

/// Cancel only this lane's owned host; an unrelated report-only validation sender is never touched.
pub(crate) fn full_validation_cancel(state: &FullValidationState) -> Result<(), String> {
    if let Some(sender) = state
        .cancel
        .lock()
        .map_err(|_| "Full validation is busy.")?
        .take()
    {
        let _ = sender.send(());
    }
    Ok(())
}

/// Return completed evidence only for the same current canonical project and exact baseline hashes.
pub(crate) fn full_validation_last_good_result(
    state: &FullValidationState,
    executions: &execution::ExecutionState,
    workspace: &WorkspaceState,
) -> Result<Option<FullValidationRunResult>, String> {
    let Some(project) = workspace
        .selected
        .lock()
        .map_err(|_| "Workspace is busy.")?
        .clone()
    else {
        return Ok(None);
    };
    let Some(run) = execution::last_good_execution_for_project(executions, &project)? else {
        return Ok(None);
    };
    let last = state
        .last_good
        .lock()
        .map_err(|_| "Full validation is busy.")?;
    Ok(last
        .as_ref()
        .filter(|result| {
            result.success
                && project.matches_canonical_identity(&result.canonical_project_root)
                && result.project_root == project.display()
                && result.execution_run_id == run.run_id
                && run.report_sha256.as_deref() == Some(result.source_report_sha256.as_str())
                && run.replay_receipt_sha256.as_deref()
                    == Some(result.replay_receipt_sha256.as_str())
        })
        .cloned())
}

/// Snapshot canonical selected identity through the existing coherent execution publication helper.
fn selected_baseline(
    executions: &execution::ExecutionState,
    workspace: &WorkspaceState,
) -> Result<(ProjectRoot, execution::ExecutionRunResult), String> {
    let project = workspace
        .selected
        .lock()
        .map_err(|_| "Workspace is busy.")?
        .clone()
        .ok_or("Open the baseline project before full validation.")?;
    let run = execution::last_good_execution_for_project(executions, &project)?
        .ok_or("No successful baseline is available for this project.")?;
    Ok((project, run))
}
