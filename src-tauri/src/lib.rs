mod agents;
mod app_extensions;
mod app_settings;
mod app_updates;
mod assistant;
mod build_process;
mod engine;
#[path = "full_validation_job.rs"]
mod engine_job;
mod execution;
mod execution_process;
mod full_validation;
mod full_validation_contract;
mod market_data;
mod market_preview;
mod optimization;
mod preferences;
mod replay_receipt;
mod reports;
mod saved_runs;
mod saved_runs_commands;
mod validation;
mod validation_output;
mod validation_package;
mod workspace;
mod workspace_build;

use preferences::{AgentProvider, PreferenceStore, Preferences};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use workspace::EntryKind;

/// App-owned settings storage and verified connection state, serialized across IPC calls.
struct AppState {
    store: Mutex<PreferenceStore>,
    verified_agent: Mutex<bool>,
    connection_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

/// Workspace host state: the durable session file, app-managed project and build homes,
/// the selected project root, and the single-slot build latch with its cancel sender.
pub struct WorkspaceState {
    session: workspace::SessionStore,
    projects_directory: PathBuf,
    builds_directory: PathBuf,
    selected: Mutex<Option<workspace::ProjectRoot>>,
    build_running: Mutex<bool>,
    build_cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    build_flight: Mutex<Option<std::sync::Arc<build_process::BuildFlight>>>,
    last_successful_build: Mutex<Option<workspace_build::ApprovedBuild>>,
}

/// Read durable setup; a previous connection must be verified again before being displayed as live.
#[tauri::command]
fn load_preferences(state: State<AppState>) -> Result<Preferences, String> {
    let mut value = state
        .store
        .lock()
        .map_err(|_| "Settings are busy. Restart the app and retry.".to_string())?
        .load()?;
    value.agent_verified = false;
    Ok(value)
}

/// Persist validated choices, refusing renderer-supplied connection claims without a host-side probe.
#[tauri::command]
fn save_preferences(preferences: Preferences, state: State<AppState>) -> Result<(), String> {
    if preferences.agent_verified
        && !*state
            .verified_agent
            .lock()
            .map_err(|_| "Agent status is busy. Retry.".to_string())?
    {
        return Err("Verify the agent connection before saving it as connected.".into());
    }
    state
        .store
        .lock()
        .map_err(|_| "Settings are busy. Retry saving.".to_string())?
        .save(&preferences)
}

/// Recover damaged setup only after an explicit user action, retaining its backup and all project files.
#[tauri::command]
fn reset_preferences(state: State<AppState>) -> Result<Preferences, String> {
    state
        .store
        .lock()
        .map_err(|_| "Settings are busy. Retry.".to_string())?
        .reset()
}

/// Verify an existing local service without creating an agent task or sending any project data.
#[tauri::command]
async fn connect_agent(
    provider: AgentProvider,
    state: State<'_, AppState>,
) -> Result<agents::AgentConnection, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if let Some(previous) = state
        .connection_cancel
        .lock()
        .map_err(|_| "Agent connection is busy. Retry.".to_string())?
        .replace(sender)
    {
        let _ = previous.send(());
    }
    *state
        .verified_agent
        .lock()
        .map_err(|_| "Agent status is busy. Retry.".to_string())? = false;
    let connection = agents::connect(provider, receiver).await?;
    *state
        .verified_agent
        .lock()
        .map_err(|_| "Agent status is busy. Retry.".to_string())? = true;
    Ok(connection)
}

/// Stop an in-flight optional service probe; dropping its process future terminates the spawned CLI.
#[tauri::command]
fn cancel_agent_connection(state: State<AppState>) -> Result<(), String> {
    if let Some(sender) = state
        .connection_cancel
        .lock()
        .map_err(|_| "Agent connection is busy. Retry.".to_string())?
        .take()
    {
        let _ = sender.send(());
    }
    Ok(())
}

/// Read actual bundled C# strategy metadata through the Rust process boundary; this does not run a backtest.
#[tauri::command]
async fn engine_metadata(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let executable = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("engine/BacktestEngine.Run.exe");
    engine::metadata(executable).await
}

/// Load the durable workspace session: last project, open files and named presets.
#[tauri::command]
fn workspace_load_session(
    state: State<WorkspaceState>,
) -> Result<workspace::WorkspaceSession, String> {
    state.session.load()
}

/// Save validated session state; open-file ids stay project-relative and limits apply.
#[tauri::command]
fn workspace_save_session(
    session: workspace::WorkspaceSession,
    state: State<WorkspaceState>,
) -> Result<(), String> {
    state.session.save(&session)
}

/// Store and canonicalize a user-selected project folder and return its real tree.
#[tauri::command]
fn workspace_open_project(
    root: String,
    state: State<WorkspaceState>,
) -> Result<workspace::WorkspaceProject, String> {
    let opened = workspace::ProjectRoot::open(&root)?;
    let project = workspace::refresh_project(&opened)?;
    *state
        .selected
        .lock()
        .map_err(|_| "The workspace is busy. Retry opening the project.".to_string())? =
        Some(opened);
    Ok(project)
}

/// Refresh the real tree of the currently selected project explicitly.
#[tauri::command]
fn workspace_refresh_project(
    state: State<WorkspaceState>,
) -> Result<workspace::WorkspaceProject, String> {
    let root = selected_project(&state)?;
    workspace::refresh_project(&root)
}

/// Read an editable text document of the selected project with its host content revision.
#[tauri::command]
fn workspace_read_document(
    path: String,
    state: State<WorkspaceState>,
) -> Result<workspace::WorkspaceDocument, String> {
    let root = selected_project(&state)?;
    workspace::read_document(&root, &path)
}

/// Save an edited document, rejecting the write when the file changed outside the editor.
#[tauri::command]
fn workspace_save_document(
    path: String,
    content: String,
    revision: String,
    state: State<WorkspaceState>,
) -> Result<workspace::WorkspaceDocument, String> {
    let root = selected_project(&state)?;
    workspace::save_document(&root, &path, &content, &revision)
}

/// Create a new empty file or folder inside the selected project.
#[tauri::command]
fn workspace_create_entry(
    parent: String,
    name: String,
    kind: EntryKind,
    state: State<WorkspaceState>,
) -> Result<workspace::WorkspaceProject, String> {
    let root = selected_project(&state)?;
    workspace::create_entry(&root, &parent, &name, kind)
}

/// Rename an existing entry inside its current folder.
#[tauri::command]
fn workspace_rename_entry(
    path: String,
    name: String,
    state: State<WorkspaceState>,
) -> Result<workspace::WorkspaceProject, String> {
    let root = selected_project(&state)?;
    workspace::rename_entry(&root, &path, &name)
}

/// Move an existing entry into another folder of the same project.
#[tauri::command]
fn workspace_move_entry(
    path: String,
    parent: String,
    state: State<WorkspaceState>,
) -> Result<workspace::WorkspaceProject, String> {
    let root = selected_project(&state)?;
    workspace::move_entry(&root, &path, &parent)
}

/// Pick an existing project folder through the official dialog plugin and open it.
#[tauri::command]
async fn workspace_pick_project(
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<Option<workspace::WorkspaceProject>, String> {
    let chosen = choose_folder(&app, "Select the project folder").await?;
    let Some(folder) = chosen else {
        return Ok(None);
    };
    let opened = workspace::ProjectRoot::open(&folder)?;
    let project = workspace::refresh_project(&opened)?;
    *state
        .selected
        .lock()
        .map_err(|_| "The workspace is busy. Retry opening the project.".to_string())? =
        Some(opened);
    Ok(Some(project))
}

/// Create a new app-managed project folder with the seeded ExampleStrategy source.
///
/// New projects live under the app-owned `Projects` directory inside the isolated data home
/// (`BACKTEST_DATA_DIR` in developer builds) so user files are never claimed; the seeded
/// strategy is the retained engine's example content. Only pick_project uses the native
/// folder picker.
#[tauri::command]
fn workspace_create_project(
    state: State<WorkspaceState>,
) -> Result<workspace::WorkspaceProject, String> {
    create_seeded_project(&state)
}

/// Creates a unique app-managed project directory and seeds it; opens it as the selected root.
fn create_seeded_project(
    state: &State<WorkspaceState>,
) -> Result<workspace::WorkspaceProject, String> {
    let base = state.projects_directory.clone();
    std::fs::create_dir_all(&base)
        .map_err(|error| format!("The app projects folder could not be created ({error})."))?;
    let staging_directory = tempfile::Builder::new()
        .prefix("project-")
        .tempdir_in(&base)
        .map_err(|error| format!("A new project folder could not be created ({error})."))?;
    let folder = staging_directory.path().to_path_buf();
    // The unique folder is adopted by the project, so the auto-delete guard must not fire.
    std::mem::forget(staging_directory);
    seed_project_assets(&folder)?;
    let opened = workspace::ProjectRoot::open(&folder.to_string_lossy());
    match opened {
        Ok(root) => {
            let project = workspace::refresh_project(&root)?;
            *state
                .selected
                .lock()
                .map_err(|_| "The workspace is busy. Retry opening the project.".to_string())? =
                Some(root);
            Ok(project)
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&folder);
            Err(error)
        }
    }
}

/// Writes the seeded example strategy and readme of a new app-managed project.
fn seed_project_assets(folder: &std::path::Path) -> Result<(), String> {
    let source_directory = folder.join("Source");
    std::fs::create_dir_all(&source_directory)
        .map_err(|error| format!("The seeded project folder could not be prepared ({error})."))?;
    std::fs::write(
        source_directory.join("ExampleStrategy.cs"),
        workspace::EXAMPLE_STRATEGY_TEMPLATE,
    )
    .map_err(|error| format!("The seeded strategy could not be written ({error})."))?;
    std::fs::write(folder.join("README.md"), workspace::EXAMPLE_PROJECT_README)
        .map_err(|error| format!("The seeded readme could not be written ({error})."))?;
    Ok(())
}

/// Pick an arbitrary folder path (no extension semantics) through the dialog plugin.
async fn choose_folder(app: &tauri::AppHandle, title: &str) -> Result<Option<String>, String> {
    let (sender, receiver) =
        tokio::sync::oneshot::channel::<Option<tauri_plugin_dialog::FilePath>>();
    let builder = app.dialog().file();
    let builder = match title.is_empty() {
        true => builder,
        false => builder.set_title(title),
    };
    builder.pick_folder(move |file| {
        let _ = sender.send(file);
    });
    receiver
        .await
        .map(|file| file.and_then(into_path_string))
        .map_err(|_| "The folder picker closed unexpectedly.".to_string())
}

/// Converts a dialog plugin result to a displayable local path.
fn into_path_string(file: tauri_plugin_dialog::FilePath) -> Option<String> {
    match file {
        tauri_plugin_dialog::FilePath::Path(path) => Some(path.to_string_lossy().to_string()),
        tauri_plugin_dialog::FilePath::Url(_) => None,
    }
}

/// Returns the selected project root or an actionable "no project" error.
fn selected_project(state: &State<WorkspaceState>) -> Result<workspace::ProjectRoot, String> {
    let selected = state
        .selected
        .lock()
        .map_err(|_| "The workspace is busy. Retry.".to_string())?;
    selected
        .as_ref()
        .ok_or_else(|| "No project is open. Open a project first.".to_string())
        .cloned()
}

/// Runs one real saved-source build: snapshot, official .NET compile, SARIF diagnostics, strategies.
///
/// Overlapping builds are rejected; cancellation and the bounded timeout terminate the child
/// compiler process itself. The build latch is always released, including on preparation errors.
#[tauri::command]
async fn workspace_build(
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<workspace_build::WorkspaceBuild, String> {
    let (root, mut cancel) = begin_build(&state)?;
    let flight = std::sync::Arc::new(build_process::BuildFlight::new());
    let _guard = WorkspaceBuildGuard {
        state: state.inner(),
        flight: flight.clone(),
    };
    *state
        .build_flight
        .lock()
        .map_err(|_| "Build input ownership is busy.")? = Some(flight.clone());
    let outcome = async {
        let engine_source = workspace_build::resolve_engine_source(&app)?;
        let runtime = build_process::resolve_runtime(&app)?;
        let compiler =
            workspace_build::require_compiler(&runtime, &mut cancel, flight.cleanup.clone())
                .await?;
        workspace_build::run_build(
            &root,
            &engine_source,
            &state.builds_directory,
            &compiler,
            &runtime,
            &flight,
            &mut cancel,
        )
        .await
    }
    .await;
    if let Ok(build) = &outcome {
        if build.success && build.artifact_path.is_some() {
            approve_successful_build(state.inner(), &root, build)?;
        }
    }
    outcome
}

/// Retain build ownership through approval publication and clear its cancel sender before exposing idle.
struct WorkspaceBuildGuard<'a> {
    state: &'a WorkspaceState,
    flight: std::sync::Arc<build_process::BuildFlight>,
}

#[cfg(test)]
#[path = "workspace_build_lifecycle_tests.rs"]
mod workspace_build_lifecycle_tests;

impl Drop for WorkspaceBuildGuard<'_> {
    /// Release the old cancellation slot while a new build is still forbidden, including preparation/approval failures.
    fn drop(&mut self) {
        if let Ok(mut cancel) = self.state.build_cancel.lock() {
            cancel.take();
        }
        if !self.flight.release_sources() {
            return;
        }
        self.state
            .build_flight
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        if let Ok(mut running) = self.state.build_running.lock() {
            *running = false;
        }
    }
}

/// Records an approved build only when its snapshot receipt and DLL hash are verifiable.
///
/// The source revision comes from `execution::validate_artifact`, which walks to the
/// snapshot-root `revision.json`; an empty or unreadable receipt keeps the slot empty.
fn approve_successful_build(
    state: &WorkspaceState,
    root: &workspace::ProjectRoot,
    build: &workspace_build::WorkspaceBuild,
) -> Result<(), String> {
    let artifact = build
        .artifact_path
        .as_ref()
        .ok_or_else(|| "The successful build has no artifact path.".to_string())?;
    let artifact_path = std::path::PathBuf::from(artifact);
    let bytes = std::fs::read(&artifact_path)
        .map_err(|error| format!("The build artifact could not be read ({error})."))?;
    let (_canonical, revision) = execution::validate_artifact(&state.builds_directory, artifact)?;
    if revision.trim().is_empty() {
        return Err("The build receipt is missing its revision.".to_string());
    }
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let artifact_sha256 = format!("{:x}", hasher.finalize());
    let strategies: Vec<String> = build
        .strategies
        .iter()
        .map(|strategy| strategy.strategy.clone())
        .collect();
    let approved = workspace_build::ApprovedBuild {
        project_root: root.directory().to_string_lossy().to_string(),
        artifact_path: artifact.clone(),
        revision,
        artifact_sha256,
        runtime_sha256: execution::runtime_companion_hashes(&artifact_path)?,
        strategies,
        parameter_schemas: build.strategies.clone(),
        source_manifest: build.source_manifest.clone().ok_or(
            "The successful build lacks private locked-source evidence. Rebuild and retry.",
        )?,
    };
    let mut slot = state
        .last_successful_build
        .lock()
        .map_err(|_| "Workspace state is busy. Retry.".to_string())?;
    *slot = Some(approved);
    Ok(())
}

/// Latches a single build, resolving the selected root and wire-up of cancellation.
fn begin_build(
    state: &State<WorkspaceState>,
) -> Result<(workspace::ProjectRoot, tokio::sync::oneshot::Receiver<()>), String> {
    {
        let mut running = state
            .build_running
            .lock()
            .map_err(|_| "The workspace is busy. Retry.".to_string())?;
        if *running {
            return Err("A build is already running. Cancel it or wait for it to finish.".into());
        }
        *running = true;
    }
    let root = {
        let selected = state
            .selected
            .lock()
            .map_err(|_| "The workspace is busy. Retry.".to_string())?;
        match selected.as_ref() {
            Some(root) => root.clone(),
            None => {
                *state
                    .build_running
                    .lock()
                    .map_err(|_| "The workspace is busy. Retry.".to_string())? = false;
                return Err("No project is open. Open a project first.".into());
            }
        }
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if let Some(previous) = state
        .build_cancel
        .lock()
        .map_err(|_| "The workspace is busy. Retry.".to_string())?
        .replace(sender)
    {
        let _ = previous.send(());
    }
    Ok((root, receiver))
}

/// Cancels the running build by signaling its cancel slot; the child process is killed.
/// Cancel when no build runs is a deliberate idempotent no-op per the bridge contract.
#[tauri::command]
fn workspace_cancel_build(state: State<WorkspaceState>) -> Result<(), String> {
    let running = *state
        .build_running
        .lock()
        .map_err(|_| "The workspace is busy. Retry.".to_string())?;
    if !running {
        return Ok(());
    }
    if let Some(sender) = state
        .build_cancel
        .lock()
        .map_err(|_| "The workspace is busy. Retry.".to_string())?
        .take()
    {
        let _ = sender.send(());
    }
    Ok(())
}

/// Import one historical CSV into app-owned storage with provenance and validation.
#[tauri::command]
fn execution_import_market_data(
    path: String,
    kind: String,
    state: State<execution::ExecutionState>,
) -> Result<market_data::ImportedDataset, String> {
    execution::import_market_data(state.inner(), &path, &kind)
}

/// List durable imported market datasets.
#[tauri::command]
fn execution_list_market_data(
    state: State<execution::ExecutionState>,
) -> Result<Vec<market_data::ImportedDataset>, String> {
    market_data::list_datasets(&state.inner().market_data_directory)
}

/// Stream bounded verified prices without requiring an approved strategy or economic profile.
#[tauri::command]
async fn market_preview(
    request: market_preview::MarketPreviewRequest,
    state: State<'_, execution::ExecutionState>,
) -> Result<market_preview::MarketPreview, String> {
    let directory = state.inner().market_data_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        market_preview::preview_market_data(&directory, request)
    })
    .await
    .map_err(|error| format!("Price preview could not finish ({error})."))?
}

/// Import and validate one symbol specification JSON into app-owned storage.
#[tauri::command]
fn execution_import_symbol_spec(
    path: String,
    state: State<execution::ExecutionState>,
) -> Result<market_data::ImportedSymbolSpec, String> {
    market_data::import_symbol_spec(&state.inner().market_data_directory, &path)
}

/// List durable imported symbol specifications.
#[tauri::command]
fn execution_list_symbol_specs(
    state: State<execution::ExecutionState>,
) -> Result<Vec<market_data::ImportedSymbolSpec>, String> {
    market_data::list_symbol_specs(&state.inner().market_data_directory)
}

/// Run one approved build artifact against imported historical data through the original engine.
#[tauri::command]
async fn execution_run(
    app: tauri::AppHandle,
    request: execution::ExecutionRunRequest,
    execution_state: State<'_, execution::ExecutionState>,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<execution::ExecutionRunResult, String> {
    let approved = {
        let guard = workspace_state
            .last_successful_build
            .lock()
            .map_err(|_| "Workspace state is busy. Retry.".to_string())?;
        guard
            .clone()
            .ok_or_else(|| "Run a successful build before executing a strategy.".to_string())?
    };
    let project = selected_project(&workspace_state)?;
    if !project.matches_canonical_identity(&approved.project_root) {
        return Err(
            "The selected project does not match the approved build. Rebuild and retry.".into(),
        );
    }
    execution::run_execution(app, execution_state.inner(), request, approved, project).await
}

/// Cancel the currently running execution, if any.
#[tauri::command]
fn execution_cancel(state: State<execution::ExecutionState>) -> Result<(), String> {
    execution::cancel_execution(state.inner())
}

/// Return the last successful run result, if any.
#[tauri::command]
fn execution_last_good_result(
    execution_state: State<execution::ExecutionState>,
    workspace_state: State<WorkspaceState>,
) -> Result<Option<execution::ExecutionRunResult>, String> {
    let selected = workspace_state
        .selected
        .lock()
        .map_err(|_| "Workspace state is busy. Retry.")?;
    let Some(project) = selected.as_ref() else {
        return Ok(None);
    };
    execution::last_good_execution_for_project(execution_state.inner(), project)
}

/// Run preserved Python validation against the host-selected last successful execution report.
#[tauri::command]
async fn validation_run(
    app: tauri::AppHandle,
    request: validation::ValidationRunRequest,
    validation_state: State<'_, validation::ValidationState>,
    execution_state: State<'_, execution::ExecutionState>,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<validation::ValidationRunResult, String> {
    validation::run_validation(
        app,
        validation_state.inner(),
        request,
        execution_state.inner(),
        workspace_state.inner(),
    )
    .await
}

/// Cancel the currently running validation, if any.
#[tauri::command]
fn validation_cancel(state: State<validation::ValidationState>) -> Result<(), String> {
    validation::cancel_validation(state.inner())
}

/// Return the last successful validation result for the selected project and execution run.
#[tauri::command]
fn validation_last_good_result(
    validation_state: State<validation::ValidationState>,
    execution_state: State<execution::ExecutionState>,
    workspace_state: State<WorkspaceState>,
) -> Result<Option<validation::ValidationRunResult>, String> {
    validation::last_good_validation_result(
        validation_state.inner(),
        workspace_state.inner(),
        execution_state.inner(),
    )
}

/// Run original engine cost/latency/fixed-parameter walk-forward validation from a captured baseline receipt.
#[tauri::command]
async fn full_validation_run(
    app: tauri::AppHandle,
    request: full_validation_contract::FullValidationRequest,
    full: State<'_, full_validation::FullValidationState>,
    validation_state: State<'_, validation::ValidationState>,
    execution_state: State<'_, execution::ExecutionState>,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<full_validation::FullValidationRunResult, String> {
    full_validation::full_validation_run(
        app,
        full.inner(),
        validation_state.inner(),
        execution_state.inner(),
        workspace_state.inner(),
        request,
    )
    .await
}

/// Cancel only the owned full-validation process tree, preserving prior completed evidence.
#[tauri::command]
fn full_validation_cancel(full: State<full_validation::FullValidationState>) -> Result<(), String> {
    full_validation::full_validation_cancel(full.inner())
}

/// Restore full evidence only for the exact current project/baseline/receipt/report identities.
#[tauri::command]
fn full_validation_last_good_result(
    full: State<full_validation::FullValidationState>,
    execution_state: State<execution::ExecutionState>,
    workspace_state: State<WorkspaceState>,
) -> Result<Option<full_validation::FullValidationRunResult>, String> {
    full_validation::full_validation_last_good_result(
        full.inner(),
        execution_state.inner(),
        workspace_state.inner(),
    )
}

/// Reveal a correctly sized native window after preferences load; expand setup without changing display settings.
#[tauri::command]
fn present_window(expanded: bool, window: WebviewWindow) -> Result<(), String> {
    window.unminimize().map_err(|error| error.to_string())?;
    if expanded {
        window.unmaximize().map_err(|error| error.to_string())?;
        window
            .set_min_size(Some(tauri::LogicalSize::new(800.0, 640.0)))
            .map_err(|error| error.to_string())?;
        // Windows retains the pre-maximize rectangle; give setup its own restore size.
        window
            .set_size(tauri::LogicalSize::new(1024.0, 720.0))
            .map_err(|error| error.to_string())?;
        window.maximize().map_err(|error| error.to_string())?;
    } else {
        window.unmaximize().map_err(|error| error.to_string())?;
        window
            .set_min_size(Some(tauri::LogicalSize::new(600.0, 440.0)))
            .map_err(|error| error.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(660.0, 470.0))
            .map_err(|error| error.to_string())?;
        window.center().map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())
}

/// Start the native caption move on the window thread, avoiding a second asynchronous plugin dispatch during pointer input.
#[tauri::command]
fn start_window_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

/// Launch the standalone Tauri host with scoped IPC and local settings; no Electron or Node runtime is used.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            let data_dir = std::env::var_os("BACKTEST_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(data_dir);
            app.manage(AppState {
                store: Mutex::new(PreferenceStore {
                    path: data_dir.join("onboarding.json"),
                }),
                verified_agent: Mutex::new(false),
                connection_cancel: Mutex::new(None),
            });
            app.manage(app_settings::AppSettingsState {
                store: std::sync::Arc::new(Mutex::new(app_settings::AppSettingsStore {
                    path: data_dir.join("app-settings.json"),
                })),
                update_check_running: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
                    false,
                )),
                extensions_directory: data_dir.join("extensions"),
                runs_directory: data_dir.join("workspace").join("runs"),
                resources_directory: app.path().resource_dir()?,
                app_version: app.package_info().version.to_string(),
            });
            app.manage(WorkspaceState {
                session: workspace::SessionStore {
                    path: data_dir.join("workspace").join("session.json"),
                },
                projects_directory: data_dir.join("Projects"),
                builds_directory: data_dir.join("workspace").join("builds"),
                selected: Mutex::new(None),
                build_running: Mutex::new(false),
                build_cancel: Mutex::new(None),
                build_flight: Mutex::new(None),
                last_successful_build: Mutex::new(None),
            });
            app.manage(execution::ExecutionState {
                runs_directory: data_dir.join("workspace").join("runs"),
                market_data_directory: data_dir.join("workspace").join("market_data"),
                builds_directory: data_dir.join("workspace").join("builds"),
                running: Mutex::new(false),
                cancel: Mutex::new(None),
                last_good: Mutex::new(None),
                last_good_project: Mutex::new(None),
                retained_inputs: Mutex::new(None),
            });
            app.manage(saved_runs::SavedRunState::new(
                data_dir.join("workspace/runs"),
                data_dir.join("workspace/run-history"),
            ));
            app.manage(validation::ValidationState {
                validations_directory: data_dir.join("workspace").join("validations"),
                running: Mutex::new(false),
                cancel: Mutex::new(None),
                last_good: Mutex::new(None),
                last_good_project: Mutex::new(None),
                last_good_execution_run_id: Mutex::new(None),
            });
            app.manage(full_validation::FullValidationState::new(
                data_dir.join("workspace").join("full-validations"),
            ));
            app.manage(optimization::OptimizationState {
                directory: data_dir.join("workspace").join("optimizations"),
                running: Mutex::new(false),
                cancel: Mutex::new(None),
                last_good: Mutex::new(None),
                retained_inputs: Mutex::new(None),
            });
            app.manage(assistant::AssistantState::new(
                data_dir.join("assistant"),
                agents::find_opencode,
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_settings::app_settings_load,
            app_settings::app_settings_set_updates,
            app_settings::app_settings_choose_export_directory,
            app_settings::app_settings_clear_export_directory,
            app_settings::app_settings_recover,
            app_extensions::app_extensions_list,
            app_extensions::app_extensions_import,
            app_extensions::app_extensions_set_enabled,
            app_extensions::app_extensions_export,
            app_updates::app_updates_check,
            app_updates::app_updates_dismiss,
            app_updates::app_updates_open_release,
            load_preferences,
            save_preferences,
            reset_preferences,
            connect_agent,
            cancel_agent_connection,
            assistant::assistant_status,
            assistant::assistant_load,
            assistant::assistant_new_conversation,
            assistant::assistant_save_draft,
            assistant::assistant_send,
            assistant::assistant_cancel,
            engine_metadata,
            workspace_load_session,
            workspace_save_session,
            workspace_open_project,
            workspace_refresh_project,
            workspace_read_document,
            workspace_save_document,
            workspace_create_entry,
            workspace_rename_entry,
            workspace_move_entry,
            workspace_pick_project,
            workspace_create_project,
            workspace_build,
            workspace_cancel_build,
            execution_import_market_data,
            execution_list_market_data,
            market_preview,
            execution_import_symbol_spec,
            execution_list_symbol_specs,
            execution_run,
            execution_cancel,
            execution_last_good_result,
            saved_runs_commands::saved_runs_list,
            saved_runs_commands::saved_runs_select,
            saved_runs_commands::saved_runs_restore_selected,
            reports::reports_selected,
            reports::reports_export,
            validation_run,
            validation_cancel,
            validation_last_good_result,
            full_validation_run,
            full_validation_cancel,
            full_validation_last_good_result,
            optimization::optimization_run,
            optimization::optimization_cancel,
            optimization::optimization_last_good_result,
            present_window,
            start_window_drag
        ])
        .run(tauri::generate_context!())
        .expect("The desktop application could not start");
}
