//! Thin async IPC entry points; all bounded filesystem verification runs outside the UI/async worker thread.
use crate::{execution, saved_runs, WorkspaceState};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

/// Catalog requests contain only the current public project expectation and native enumeration capability.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavedRunsListRequest {
    project_root: String,
    cursor: Option<String>,
    limit: u16,
}

/// Explicit recovery restores only the durable pointer for the host-selected project, with no supplied file path.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavedRunRestoreRequest {
    project_root: String,
}

/// List bounded metadata pages on the blocking pool; no report statistics or engine execution occurs here.
#[tauri::command]
pub(crate) async fn saved_runs_list(
    app: AppHandle,
    request: SavedRunsListRequest,
) -> Result<saved_runs::SavedRunPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<saved_runs::SavedRunState>()
            .ok_or("Saved-run storage is unavailable.")?;
        let workspace = app
            .try_state::<WorkspaceState>()
            .ok_or("Workspace state is unavailable.")?;
        saved_runs::list_saved_runs(
            state.inner(),
            workspace.inner(),
            &request.project_root,
            request.cursor.as_deref(),
            usize::from(request.limit),
        )
    })
    .await
    .map_err(|_| "Saved-run catalog task stopped before returning a page.".to_string())?
}

/// Verify/reparse one native UUID/hash selection on the blocking pool, preserving prior state on any failure.
#[tauri::command]
pub(crate) async fn saved_runs_select(
    app: AppHandle,
    request: saved_runs::SavedRunRequest,
) -> Result<saved_runs::SavedRunSelection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<saved_runs::SavedRunState>()
            .ok_or("Saved-run storage is unavailable.")?;
        let execution = app
            .try_state::<execution::ExecutionState>()
            .ok_or("Execution state is unavailable.")?;
        let workspace = app
            .try_state::<WorkspaceState>()
            .ok_or("Workspace state is unavailable.")?;
        saved_runs::select_saved_run(
            state.inner(),
            execution.inner(),
            workspace.inner(),
            &request,
            execution::restore_frozen_execution,
        )
    })
    .await
    .map_err(|_| "Saved-run selection task stopped; refresh the current selection.".to_string())?
}

/// Reopen only the project's explicit saved pointer on the blocking pool; never choose a fallback run or rerun it.
#[tauri::command]
pub(crate) async fn saved_runs_restore_selected(
    app: AppHandle,
    request: SavedRunRestoreRequest,
) -> Result<Option<saved_runs::SavedRunSelection>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<saved_runs::SavedRunState>()
            .ok_or("Saved-run storage is unavailable.")?;
        let execution = app
            .try_state::<execution::ExecutionState>()
            .ok_or("Execution state is unavailable.")?;
        let workspace = app
            .try_state::<WorkspaceState>()
            .ok_or("Workspace state is unavailable.")?;
        saved_runs::restore_selected_run(
            state.inner(),
            execution.inner(),
            workspace.inner(),
            &request.project_root,
            execution::restore_frozen_execution,
        )
    })
    .await
    .map_err(|_| {
        "Saved-run recovery task stopped; existing evidence remains on disk.".to_string()
    })?
}
