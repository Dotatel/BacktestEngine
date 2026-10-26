//! Read and export a host-selected, hash-frozen engine report without running an engine.

use crate::{execution, WorkspaceState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

const MAX_REPORT_BYTES: u64 = 64 * 1024 * 1024;

/// One reported statistic; absent source values remain absent, never synthesized as zero.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportMetric {
    pub label: String,
    pub value: Option<f64>,
    pub unit: String,
}

/// Verified saved-run identity and source statistics displayed by the Reports stage.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedReport {
    pub project_root: String,
    pub run_id: String,
    pub report_sha256: String,
    pub report_json_path: String,
    pub build_revision: String,
    pub dataset_id: String,
    pub completed_at: String,
    pub strategy: String,
    pub symbol: String,
    pub timeframe: String,
    pub account_currency: Option<String>,
    pub native_drawdown_method: Option<String>,
    pub metrics: Vec<ReportMetric>,
    pub closed_trade_count: usize,
}

/// Only supported saved-source export representations, with no renderer-supplied destination.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReportFormat {
    Html,
    Json,
    TradesCsv,
}

/// Completed export receipt; cancellation is represented by the command's null result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportExportReceipt {
    pub path: String,
    pub run_id: String,
    pub report_sha256: String,
}

/// Reviewed host-run identity shared by the two real report-export entry points.
pub(crate) struct SavedReportExport {
    pub project_root: String,
    pub run_id: String,
    pub report_sha256: String,
    pub format: ReportFormat,
}

/// Source retained in memory after boundary validation; JSON exports preserve every original byte.
#[derive(Debug)]
struct VerifiedReport {
    view: SelectedReport,
    bytes: Vec<u8>,
    raw: Value,
}

/// Share exact verified source bytes with native report-only validation, never renderer file paths.
pub(crate) fn frozen_report_bytes(
    runs: &Path,
    project: &str,
    run: &execution::ExecutionRunResult,
) -> Result<Vec<u8>, String> {
    verify_report(runs, project, run).map(|report| report.bytes)
}

/// Read the selected project's last successful saved report; another project's result stays hidden.
#[tauri::command]
pub fn reports_selected(
    project_root: String,
    execution_state: State<execution::ExecutionState>,
    workspace_state: State<WorkspaceState>,
) -> Result<Option<SelectedReport>, String> {
    selected_report(
        execution_state.inner(),
        workspace_state.inner(),
        &project_root,
    )
}

/// Issue report metadata only after public expectation and private canonical run binding agree.
fn selected_report(
    execution_state: &execution::ExecutionState,
    workspace_state: &WorkspaceState,
    project_root: &str,
) -> Result<Option<SelectedReport>, String> {
    let selected = select_host_run(execution_state, workspace_state, project_root)?;
    selected
        .map(|run| {
            verify_report(&execution_state.runs_directory, project_root, &run)
                .map(|report| report.view)
        })
        .transpose()
}

/// Export only the currently selected, unchanged saved run through the owner's native save dialog.
#[tauri::command]
pub async fn reports_export(
    app: tauri::AppHandle,
    project_root: String,
    run_id: String,
    report_sha256: String,
    format: ReportFormat,
    execution_state: State<'_, execution::ExecutionState>,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Option<ReportExportReceipt>, String> {
    let settings = app
        .state::<crate::app_settings::AppSettingsState>()
        .inner()
        .clone();
    let directory = crate::app_settings::default_export_directory(&settings)?;
    export_saved_with_guard(
        app,
        SavedReportExport {
            project_root,
            run_id,
            report_sha256,
            format,
        },
        execution_state.inner(),
        workspace_state.inner(),
        directory,
        || Ok(()),
    )
    .await
}

/// Recheck host-run/source evidence and the caller's additional authorization around the native dialog.
pub(crate) async fn export_saved_with_guard(
    app: tauri::AppHandle,
    request: SavedReportExport,
    execution_state: &execution::ExecutionState,
    workspace_state: &WorkspaceState,
    directory: Option<PathBuf>,
    guard: impl Fn() -> Result<(), String> + Send + Sync,
) -> Result<Option<ReportExportReceipt>, String> {
    let SavedReportExport {
        project_root,
        run_id,
        report_sha256,
        format,
    } = request;
    guard()?;
    let report = selected_for_export(
        execution_state,
        workspace_state,
        &project_root,
        &run_id,
        &report_sha256,
    )?;
    let extension = format.extension();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export saved run — choose a new file")
        .set_file_name(format!("{}-report.{extension}", report.view.run_id))
        .add_filter("Report", &[extension]);
    if let Some(directory) = directory {
        dialog = dialog.set_directory(directory);
    }
    dialog.save_file(move |file| {
        let _ = sender.send(file);
    });
    let destination = receiver
        .await
        .map_err(|_| "The save dialog closed unexpectedly.".to_string())?;
    let Some(tauri_plugin_dialog::FilePath::Path(destination)) = destination else {
        return Ok(None);
    };
    guard()?;
    // Recheck selection and source after the dialog: the project/run may have changed while it was open.
    let report = selected_for_export(
        execution_state,
        workspace_state,
        &project_root,
        &run_id,
        &report_sha256,
    )?;
    let bytes = render_export(&report, format)?;
    write_new_export(&destination, &execution_state.runs_directory, &bytes)?;
    Ok(Some(ReportExportReceipt {
        path: destination.to_string_lossy().into_owned(),
        run_id,
        report_sha256,
    }))
}

/// Compare renderer expectations against the host's selected project and successful result.
fn select_host_run(
    state: &execution::ExecutionState,
    workspace: &WorkspaceState,
    expected_project: &str,
) -> Result<Option<execution::ExecutionRunResult>, String> {
    let selected = workspace
        .selected
        .lock()
        .map_err(|_| "Workspace state is busy.")?;
    let selected = selected
        .as_ref()
        .ok_or("Open a project before reading reports.")?;
    if selected.display() != expected_project {
        return Err("The selected project changed. Refresh Reports.".into());
    }
    execution::last_good_execution_for_project(state, selected)
}

/// Require the exact run and digest the owner reviewed, then revalidate original source bytes.
fn selected_for_export(
    state: &execution::ExecutionState,
    workspace: &WorkspaceState,
    project: &str,
    run_id: &str,
    hash: &str,
) -> Result<VerifiedReport, String> {
    let run = select_host_run(state, workspace, project)?
        .ok_or("No successful saved run is selected.")?;
    if run.run_id != run_id {
        return Err("The selected run changed. Refresh Reports before exporting.".into());
    }
    let report = verify_report(&state.runs_directory, project, &run)?;
    if report.view.report_sha256 != hash {
        return Err("The report changed. Refresh Reports before exporting.".into());
    }
    Ok(report)
}

/// Bound reads, reject path escapes and confirm the engine JSON still matches its completion hash.
fn verify_report(
    runs: &Path,
    project: &str,
    run: &execution::ExecutionRunResult,
) -> Result<VerifiedReport, String> {
    if !run.success || run.status != "completed" || !run.errors.is_empty() {
        return Err("Only a successful completed run can produce a report.".into());
    }
    let path = report_source_path(runs, run)?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| format!("Cannot open saved report ({error})."))?
        .take(MAX_REPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read saved report ({error})."))?;
    if bytes.len() as u64 > MAX_REPORT_BYTES {
        return Err("The saved report exceeds the 64 MiB limit.".into());
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if run.report_sha256.as_deref() != Some(hash.as_str()) {
        return Err("The saved report differs from the successful run snapshot. Run again to obtain verified source evidence.".into());
    }
    let raw: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Saved report JSON is malformed ({error})."))?;
    validate_source(&raw, run)?;
    let view = make_view(project, run, hash, &raw);
    Ok(VerifiedReport { view, bytes, raw })
}

/// Restrict the run identity to one directory and report.json to that exact app-owned run.
fn report_source_path(runs: &Path, run: &execution::ExecutionRunResult) -> Result<PathBuf, String> {
    let mut components = Path::new(&run.run_id).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("Invalid saved run identity.".into());
    }
    let root = runs
        .canonicalize()
        .map_err(|error| format!("Cannot locate saved runs ({error})."))?;
    let folder = Path::new(&run.run_folder)
        .canonicalize()
        .map_err(|error| format!("Cannot locate saved run ({error})."))?;
    if folder.parent() != Some(root.as_path())
        || folder.file_name() != Some(std::ffi::OsStr::new(&run.run_id))
    {
        return Err("The saved run is outside app-owned run storage.".into());
    }
    let path = Path::new(&run.report_json_path)
        .canonicalize()
        .map_err(|error| format!("Cannot locate saved report ({error})."))?;
    if path.parent() != Some(folder.as_path())
        || path.file_name() != Some(std::ffi::OsStr::new("report.json"))
    {
        return Err("The report path does not belong to the selected saved run.".into());
    }
    Ok(path)
}

/// Reject foreign, incomplete or nonnumeric report values before exposing reported statistics.
fn validate_source(raw: &Value, run: &execution::ExecutionRunResult) -> Result<(), String> {
    for (key, expected) in [
        ("strategy", &run.strategy),
        ("symbol", &run.symbol),
        ("timeframe", &run.timeframe),
    ] {
        if raw.get(key).and_then(Value::as_str) != Some(expected) {
            return Err(format!(
                "Saved report {key} does not match the successful run."
            ));
        }
    }
    if !raw.get("account").is_some_and(Value::is_object)
        || !raw.get("trades").is_some_and(Value::is_array)
    {
        return Err("Saved report is missing its account or closed-trade source.".into());
    }
    for (section, fields) in metric_fields() {
        validate_metric_section(raw.get(section), &fields)?;
    }
    Ok(())
}

/// Reject non-finite numbers and strings masquerading as statistics; null remains undefined.
fn validate_metric_section(
    section: Option<&Value>,
    fields: &[(&str, &str, &str)],
) -> Result<(), String> {
    let Some(section) = section else {
        return Ok(());
    };
    if !section.is_null() && !section.is_object() {
        return Err("Saved report statistics section is malformed.".into());
    }
    for (key, _, _) in fields {
        let value = section.get(key).unwrap_or(&Value::Null);
        if !value.is_null() && !value.as_f64().is_some_and(f64::is_finite) {
            return Err(format!(
                "Saved report statistic {key} is not a finite number."
            ));
        }
    }
    Ok(())
}

/// One original report key, readable label and display unit.
type MetricField = (&'static str, &'static str, &'static str);

/// One original report section with its explicitly mapped statistic fields.
type MetricSection = (&'static str, Vec<MetricField>);

/// Source field mapping deliberately distinguishes full replay and native price-extremes methods.
fn metric_fields() -> Vec<MetricSection> {
    vec![
        (
            "account",
            vec![
                ("starting_capital", "Starting capital", "money"),
                ("balance", "Closing balance", "money"),
                ("equity", "Closing equity", "money"),
                ("closed_net_profit", "Closed net profit", "money"),
                ("open_net_profit", "Open net profit", "money"),
                (
                    "marked_to_market_return_percent",
                    "Marked-to-market return",
                    "%",
                ),
            ],
        ),
        (
            "trade_statistics",
            vec![
                ("total_trades", "Closed trades", "count"),
                ("winning_trades", "Winning trades", "count"),
                ("losing_trades", "Losing trades", "count"),
                ("profit_factor", "Profit factor", "ratio"),
                ("commissions", "Closed-trade commissions", "money"),
                ("swaps", "Closed-trade swaps", "money"),
            ],
        ),
        (
            "drawdown",
            vec![
                (
                    "max_equity_drawdown_percent",
                    "Full replay equity drawdown",
                    "%",
                ),
                (
                    "max_balance_drawdown_percent",
                    "Full replay balance drawdown",
                    "%",
                ),
            ],
        ),
        (
            "native_report_drawdown",
            vec![
                (
                    "max_equity_drawdown_percent",
                    "Native price-extremes equity drawdown",
                    "%",
                ),
                (
                    "max_balance_drawdown_percent",
                    "Native price-extremes balance drawdown",
                    "%",
                ),
            ],
        ),
    ]
}

/// Project source fields directly into a compact display contract; no economic recalculation occurs.
fn make_view(
    project: &str,
    run: &execution::ExecutionRunResult,
    hash: String,
    raw: &Value,
) -> SelectedReport {
    let currency = raw
        .pointer("/account/currency")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let mut metrics = Vec::new();
    for (section, fields) in metric_fields() {
        metrics.extend(fields.into_iter().map(|(key, label, unit)| {
            ReportMetric {
                label: label.into(),
                value: raw
                    .get(section)
                    .and_then(|item| item.get(key))
                    .and_then(Value::as_f64),
                unit: unit.into(),
            }
        }));
    }
    SelectedReport {
        project_root: project.into(),
        run_id: run.run_id.clone(),
        report_sha256: hash,
        report_json_path: run.report_json_path.clone(),
        build_revision: run.build_revision.clone(),
        dataset_id: run.dataset_id.clone(),
        completed_at: run.completed_at.clone(),
        strategy: run.strategy.clone(),
        symbol: run.symbol.clone(),
        timeframe: run.timeframe.clone(),
        account_currency: currency,
        native_drawdown_method: raw
            .pointer("/native_report_drawdown/method")
            .and_then(Value::as_str)
            .map(str::to_owned),
        metrics,
        closed_trade_count: raw["trades"].as_array().map_or(0, Vec::len),
    }
}

impl ReportFormat {
    /// Associate each representation with its native save-dialog extension.
    fn extension(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Json => "json",
            Self::TradesCsv => "csv",
        }
    }
}

/// Render source JSON byte-for-byte, closed trades as CSV, or an offline escaped HTML summary.
fn render_export(report: &VerifiedReport, format: ReportFormat) -> Result<Vec<u8>, String> {
    match format {
        ReportFormat::Json => Ok(report.bytes.clone()),
        ReportFormat::Html => Ok(render_html(&report.view).into_bytes()),
        ReportFormat::TradesCsv => {
            render_trades_csv(&report.raw, &report.view).map(String::into_bytes)
        }
    }
}

/// Escape all source-derived text before placing it in HTML text or attribute content.
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Format a source value with its actual account currency or an explicit unavailable currency.
fn metric_text(metric: &ReportMetric, currency: Option<&str>) -> String {
    let Some(value) = metric.value else {
        return "n/a".into();
    };
    match metric.unit.as_str() {
        "money" => format!("{value} {}", currency.unwrap_or("(currency n/a)")),
        "%" => format!("{value}%"),
        _ => value.to_string(),
    }
}

/// Build a self-contained human-readable report with provenance and no scripts or remote assets.
fn render_html(view: &SelectedReport) -> String {
    let mut html = String::from("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Saved backtest report</title><style>body{font:14px system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 24px;color:#080d0a}h1{font-size:24px}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #bdcbb9;padding:8px;overflow-wrap:anywhere}td{font-variant-numeric:tabular-nums}dt{font-weight:600;margin-top:12px}dd{margin:4px 0;overflow-wrap:anywhere}</style><body><h1>Saved backtest report</h1><p>Presentation of original engine output. No backtest was rerun. Missing values are n/a.</p><dl>");
    for (label, value) in [
        ("Project", &view.project_root),
        ("Run", &view.run_id),
        ("Report SHA-256", &view.report_sha256),
        ("Build revision", &view.build_revision),
        ("Dataset", &view.dataset_id),
        ("Completed UTC", &view.completed_at),
        ("Strategy", &view.strategy),
        ("Symbol", &view.symbol),
        ("Timeframe", &view.timeframe),
        ("Original report", &view.report_json_path),
    ] {
        html.push_str(&format!("<dt>{label}</dt><dd>{}</dd>", escape_html(value)));
    }
    html.push_str("</dl><h2>Reported statistics</h2><table><thead><tr><th scope=\"col\">Statistic</th><th scope=\"col\">Value</th></tr></thead><tbody>");
    for metric in &view.metrics {
        html.push_str(&format!(
            "<tr><th scope=\"row\">{}</th><td>{}</td></tr>",
            escape_html(&metric.label),
            escape_html(&metric_text(metric, view.account_currency.as_deref()))
        ));
    }
    html.push_str("</tbody></table><p>Full replay drawdown and native price-extremes/deals drawdown use different source methods and must not be treated as interchangeable. Export original JSON for complete engine fields, positions and provenance. This presentation does not establish broker trading parity.</p></body></html>");
    let method = escape_html(view.native_drawdown_method.as_deref().unwrap_or("n/a"));
    html = html.replace(
        "</body>",
        &format!("<p>Reported native drawdown method: {method}</p></body>"),
    );
    html
}

/// Serialize every source trade field with RFC-style quoting and spreadsheet formula protection.
fn render_trades_csv(raw: &Value, view: &SelectedReport) -> Result<String, String> {
    let trades = raw["trades"]
        .as_array()
        .ok_or("Saved report closed trades are malformed.")?;
    let columns = [
        "id",
        "symbol",
        "label",
        "side",
        "volume_in_units",
        "entry_time_utc",
        "entry_price",
        "entry_bid",
        "entry_ask",
        "entry_spread",
        "close_time_utc",
        "close_price",
        "close_bid",
        "close_ask",
        "close_spread",
        "close_reason",
        "pips",
        "gross_profit",
        "pnl_conversion_fees",
        "commissions",
        "swaps",
        "net_profit",
        "intended_risk_money",
        "mae_net_profit",
        "mfe_net_profit",
        "net_r",
        "economic_specification_hash",
    ];
    let mut csv = format!(
        "source_run_id,source_report_sha256,account_currency,{}\r\n",
        columns.join(",")
    );
    for trade in trades {
        if !trade.is_object() {
            return Err("Saved report contains a malformed closed trade.".into());
        }
        csv.push_str(
            &[
                csv_cell(&Value::String(view.run_id.clone())),
                csv_cell(&Value::String(view.report_sha256.clone())),
                csv_cell(
                    &view
                        .account_currency
                        .clone()
                        .map_or(Value::Null, Value::String),
                ),
            ]
            .join(","),
        );
        csv.push(',');
        csv.push_str(
            &columns
                .iter()
                .map(|key| csv_cell(trade.get(key).unwrap_or(&Value::Null)))
                .collect::<Vec<_>>()
                .join(","),
        );
        csv.push_str("\r\n");
    }
    Ok(csv)
}

/// Preserve numeric signs; neutralize formula-like source strings and quote delimiter/newline content.
fn csv_cell(value: &Value) -> String {
    let text = match value {
        Value::Null => "n/a".into(),
        Value::String(text) => protect_formula(text),
        _ => value.to_string(),
    };
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// Prevent untrusted labels from becoming active spreadsheet formulas on CSV import.
fn protect_formula(text: &str) -> String {
    if text.trim_start().starts_with(['=', '+', '-', '@']) || text.starts_with(['\t', '\r', '\n']) {
        return format!("'{text}");
    }
    text.into()
}

/// Atomically create a new destination and refuse overwrites and writes inside saved-run storage.
fn write_new_export(destination: &Path, runs: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or("Choose a file in an existing folder.")?
        .canonicalize()
        .map_err(|error| format!("Cannot access export folder ({error})."))?;
    let root = runs
        .canonicalize()
        .map_err(|error| format!("Cannot verify saved-run storage ({error})."))?;
    if parent.starts_with(root) {
        return Err("Choose an export destination outside saved-run storage.".into());
    }
    let name = destination
        .file_name()
        .ok_or("Choose a valid export filename.")?;
    let path = parent.join(name);
    if path.exists() {
        return Err(
            "The destination already exists. Choose a new filename; exports never overwrite files."
                .into(),
        );
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Cannot stage export ({error})."))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Cannot write export ({error})."))?;
    temporary.persist_noclobber(path).map_err(|error| {
        format!("Cannot save export; choose a new writable filename ({error}).")
    })?;
    Ok(())
}

#[cfg(test)]
#[path = "reports_tests.rs"]
mod tests;
