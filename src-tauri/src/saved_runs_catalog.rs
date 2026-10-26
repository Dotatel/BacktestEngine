//! Bounded filesystem enumeration of immutable run records; there is no global rewritten index or history eviction.
use super::*;
use crate::WorkspaceState;
use std::time::{Duration, Instant};

const MAX_PAGE_ROWS: usize = 100;
const MAX_EXAMINED: usize = 1024;
const CURSOR_LIFETIME: Duration = Duration::from_secs(300);

/// One specific native enumeration handle; a new scan explicitly invalidates the previous ephemeral cursor.
pub(super) struct CatalogScan {
    id: String,
    canonical_project: String,
    created: Instant,
    entries: fs::ReadDir,
}

/// Broken or unassigned artifacts stay on disk and are disclosed separately from successful recorded rows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedRunIssue {
    run_id: Option<String>,
    message: String,
}

/// Pages contain no financial values and do not claim selected evidence has been revalidated.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedRunPage {
    pub rows: Vec<SavedRunSummary>,
    pub next_cursor: Option<String>,
    pub examined_entries: usize,
    pub unassigned_entries: usize,
    pub issues: Vec<SavedRunIssue>,
    pub additional_issue_count: usize,
}

/// Enumerate at most 1024 native entries/100 rows per call; selection later verifies all actual source bytes.
pub(crate) fn list_saved_runs(
    state: &SavedRunState,
    workspace: &WorkspaceState,
    expected_project: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<SavedRunPage, String> {
    if !(1..=MAX_PAGE_ROWS).contains(&limit) {
        return Err("Saved-run page size must be between 1 and 100.".into());
    }
    let project = restore::selected_project(workspace, expected_project)?;
    let mut active = state
        .scan
        .lock()
        .map_err(|_| "Saved-run catalog is busy.")?;
    if cursor.is_none() {
        *active = begin_scan(state, &project)?;
    }
    let Some(scan) = active.as_mut() else {
        if cursor.is_some() {
            return Err("Saved-run cursor expired. Refresh history.".into());
        }
        selected_project_unchanged(workspace, &project)?;
        return Ok(empty_page());
    };
    if let Err(error) = validate_cursor(scan, &project, cursor) {
        *active = None;
        return Err(error);
    }
    let (mut page, exhausted) = collect_page(state, &project, scan, limit);
    if exhausted {
        *active = None;
    } else {
        page.next_cursor = Some(scan.id.clone());
    }
    selected_project_unchanged(workspace, &project)?;
    Ok(page)
}

/// Discard a late page if the project changed during filesystem reads; a refresh never guesses ownership.
fn selected_project_unchanged(
    workspace: &WorkspaceState,
    project: &ProjectRoot,
) -> Result<(), String> {
    let selected = workspace
        .selected
        .lock()
        .map_err(|_| "Workspace state is busy.")?;
    if !selected.as_ref().is_some_and(|value| {
        value.matches_canonical_identity(&project.directory().to_string_lossy())
    }) {
        return Err("Selected project changed while reading saved history.".into());
    }
    Ok(())
}

/// A first installation has no run root; reading history never creates directories or fabricates entries.
fn begin_scan(state: &SavedRunState, project: &ProjectRoot) -> Result<Option<CatalogScan>, String> {
    if optional_metadata(&state.runs_directory)?.is_none() {
        return Ok(None);
    }
    Ok(Some(CatalogScan {
        id: uuid::Uuid::new_v4().to_string(),
        canonical_project: project.directory().to_string_lossy().into_owned(),
        created: Instant::now(),
        entries: fs::read_dir(&state.runs_directory).map_err(|error| error.to_string())?,
    }))
}

/// Cursor IDs are native opaque capabilities bound to the current selected project and a short lifetime.
fn validate_cursor(
    scan: &CatalogScan,
    project: &ProjectRoot,
    cursor: Option<&str>,
) -> Result<(), String> {
    if !project.matches_canonical_identity(&scan.canonical_project)
        || scan.created.elapsed() > CURSOR_LIFETIME
        || cursor.is_some_and(|value| value != scan.id)
    {
        return Err(
            "Saved-run cursor expired or belongs to a different project. Refresh history.".into(),
        );
    }
    Ok(())
}

/// Consume only this page's bounded enumeration budget, preserving a native handle for the following page.
fn collect_page(
    state: &SavedRunState,
    project: &ProjectRoot,
    scan: &mut CatalogScan,
    limit: usize,
) -> (SavedRunPage, bool) {
    let mut page = empty_page();
    while page.examined_entries < MAX_EXAMINED && page.rows.len() < limit {
        let Some(entry) = scan.entries.next() else {
            return (page, true);
        };
        page.examined_entries += 1;
        append_entry(state, project, entry, &mut page);
    }
    (page, false)
}

/// Foreign projects remain hidden; malformed/unindexed evidence is reported without guessing its project identity.
fn append_entry(
    state: &SavedRunState,
    project: &ProjectRoot,
    entry: Result<fs::DirEntry, std::io::Error>,
    page: &mut SavedRunPage,
) {
    let entry = match entry {
        Ok(value) => value,
        Err(error) => {
            add_issue(page, None, error.to_string());
            return;
        }
    };
    let id = entry.file_name().to_string_lossy().into_owned();
    if validate_run_id(&id).is_err() {
        page.unassigned_entries += 1;
        return;
    }
    match read_record(state, &id) {
        Ok((record, hash)) => {
            if project.matches_canonical_identity(&record.canonical_project_root) {
                page.rows.push(summary(&record, hash, project));
            }
        }
        Err(error) => {
            page.unassigned_entries += 1;
            add_issue(page, Some(id), error);
        }
    }
}

/// Keep diagnostics bounded while exposing the number omitted from this page, without deleting any evidence.
fn add_issue(page: &mut SavedRunPage, run_id: Option<String>, message: String) {
    if page.issues.len() >= MAX_PAGE_ROWS {
        page.additional_issue_count += 1;
        return;
    }
    page.issues.push(SavedRunIssue {
        run_id,
        message: message.chars().take(512).collect(),
    });
}

/// Empty real history has no synthetic rows and no continuation token.
fn empty_page() -> SavedRunPage {
    SavedRunPage {
        rows: Vec::new(),
        next_cursor: None,
        examined_entries: 0,
        unassigned_entries: 0,
        issues: Vec::new(),
        additional_issue_count: 0,
    }
}
