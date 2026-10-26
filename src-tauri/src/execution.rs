//! Real execution of approved saved-source builds through the original engine.
//!
//! The host validates the approved build artifact, imports stay in app-owned storage, runs the
//! original `BacktestEngine.Run` entry point as a bounded cancelable subprocess, and parses the
//! actual ReportWriter JSON/trades/equity output. Last good results are preserved separately.

use crate::market_data::{self, read_limited_bytes};
use crate::workspace_build;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use tauri::Emitter;
use tokio::sync::oneshot;

#[path = "execution_inputs.rs"]
mod inputs;
pub(crate) use inputs::{preflight_execution_inputs, ExecutionInputs};

/// Maximum seconds one execution run may take before the process is canceled.
pub const EXECUTION_TIMEOUT_SECONDS: u64 = 600;

/// Maximum bytes one report JSON may contribute.
const MAX_REPORT_BYTES: u64 = 64 * 1024 * 1024;

/// Maximum captured process-output characters passed back to the UI.
pub(crate) const MAX_OUTPUT_CHARS: usize = 12_000;

/// Run request matching the TypeScript execution contract.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRunRequest {
    #[serde(default)]
    #[allow(dead_code)]
    pub build_artifact_path: Option<String>,
    pub strategy: String,
    pub dataset_id: String,
    pub symbol_spec_path: String,
    #[serde(default)]
    pub parameter_path: Option<String>,
    #[serde(default)]
    pub parameter_overrides: Option<BTreeMap<String, String>>,
    pub starting_balance: f64,
    #[serde(default = "default_commission")]
    pub commission_usd_per_million: f64,
    #[serde(default)]
    pub slippage_pips: f64,
    #[serde(default)]
    pub spread_pips: Option<f64>,
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub timeframe: Option<String>,
    #[serde(default)]
    pub bar_timeframe: Option<String>,
    #[serde(default)]
    pub bar_price_mode: Option<String>,
    #[serde(default)]
    pub start_utc: Option<String>,
    #[serde(default)]
    pub end_utc: Option<String>,
    #[serde(default)]
    pub max_ticks: Option<i64>,
    #[serde(default)]
    pub max_bars: Option<i64>,
    #[serde(default = "default_write_equity")]
    pub write_equity_csv: bool,
}

/// Use the retained profile commission rate unless the user explicitly overrides it.
fn default_commission() -> f64 {
    -1.0
}
/// Write actual equity samples by default for honest result inspection.
fn default_write_equity() -> bool {
    true
}

/// Execution host state.
pub struct ExecutionState {
    pub runs_directory: PathBuf,
    pub market_data_directory: PathBuf,
    pub builds_directory: PathBuf,
    pub running: std::sync::Mutex<bool>,
    pub cancel: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    pub last_good: std::sync::Mutex<Option<ExecutionRunResult>>,
    pub last_good_project: std::sync::Mutex<Option<String>>,
    pub(crate) retained_inputs: std::sync::Mutex<Option<crate::replay_receipt::FrozenReplayInputs>>,
}

/// Releases execution and cancellation state on every return path, including errors.
struct ExecutionGuard<'a> {
    state: &'a ExecutionState,
    cleanup: Arc<AtomicBool>,
    inputs: Option<crate::replay_receipt::FrozenReplayInputs>,
}

impl<'a> ExecutionGuard<'a> {
    /// Before dispatch no child exists; only the bounded native process helper may reconfirm cleanup afterward.
    fn new(state: &'a ExecutionState) -> Self {
        Self {
            state,
            cleanup: Arc::new(AtomicBool::new(true)),
            inputs: None,
        }
    }
}

impl Drop for ExecutionGuard<'_> {
    /// Restore the host to an idle state when the current run leaves scope.
    fn drop(&mut self) {
        clear_cancel(self.state);
        if !self.cleanup.load(Ordering::Acquire) {
            *self
                .state
                .retained_inputs
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = self.inputs.take();
            return;
        }
        release_running(self.state);
    }
}

// ===== Result types =====

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionAccountSummary {
    pub currency: String,
    pub currency_digits: i64,
    pub starting_capital: f64,
    pub balance: f64,
    pub equity: f64,
    pub closed_net_profit: f64,
    pub open_net_profit: f64,
    pub marked_to_market_net_profit: f64,
    pub marked_to_market_return_percent: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionReplaySummary {
    pub mode: String,
    pub bar_price_mode: Option<String>,
    pub input_count: i64,
    pub ticks_or_synthetic_ticks: i64,
    pub on_bar_count: i64,
    pub chart_bar_count: i64,
    pub hour_bar_count: i64,
    pub elapsed_ms: f64,
    pub ticks_per_second: f64,
    pub first_time_utc: String,
    pub last_time_utc: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionTradeStatistics {
    pub total_trades: i64,
    pub winning_trades: i64,
    pub losing_trades: i64,
    pub long_trades: i64,
    pub short_trades: i64,
    pub gross_profit: f64,
    pub gross_loss: f64,
    pub commissions: f64,
    pub swaps: f64,
    pub net_profit: f64,
    pub profit_factor: Option<f64>,
    pub total_pips: f64,
    pub average_net_profit: f64,
    pub largest_win: f64,
    pub largest_loss: f64,
    pub win_rate: f64,
    pub loss_rate: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeReportDrawdown {
    pub method: String,
    pub equity_points: i64,
    pub max_equity_drawdown: f64,
    pub max_equity_drawdown_percent: f64,
    pub max_balance_drawdown: f64,
    pub max_balance_drawdown_percent: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullReplayDrawdown {
    pub equity_points: i64,
    pub max_balance_drawdown: f64,
    pub max_balance_drawdown_percent: f64,
    pub max_balance_drawdown_peak_time_utc: String,
    pub max_balance_drawdown_trough_time_utc: String,
    pub max_balance_drawdown_peak: f64,
    pub max_balance_drawdown_trough: f64,
    pub max_equity_drawdown: f64,
    pub max_equity_drawdown_percent: f64,
    pub max_equity_drawdown_peak_time_utc: String,
    pub max_equity_drawdown_trough_time_utc: String,
    pub max_equity_drawdown_peak: f64,
    pub max_equity_drawdown_trough: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionTrade {
    pub id: String,
    pub symbol: String,
    pub label: String,
    pub side: String,
    pub volume_in_units: f64,
    pub entry_time_utc: String,
    pub entry_price: f64,
    pub entry_bid: f64,
    pub entry_ask: f64,
    pub entry_spread: f64,
    pub close_time_utc: String,
    pub close_price: f64,
    pub close_bid: f64,
    pub close_ask: f64,
    pub close_spread: f64,
    pub close_reason: String,
    pub pips: f64,
    pub gross_profit: f64,
    pub pnl_conversion_fees: f64,
    pub commissions: f64,
    pub swaps: f64,
    pub net_profit: f64,
    pub intended_risk_money: f64,
    pub mae_net_profit: f64,
    pub mfe_net_profit: f64,
    pub net_r: Option<f64>,
    pub economic_specification_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOpenPosition {
    pub id: String,
    pub symbol: String,
    pub label: String,
    pub side: String,
    pub volume_in_units: f64,
    pub entry_time_utc: String,
    pub entry_price: f64,
    pub valuation_time_utc: String,
    pub valuation_price: f64,
    pub age_hours: f64,
    pub pips: f64,
    pub gross_profit: f64,
    pub pnl_conversion_fees: f64,
    pub commissions: f64,
    pub swaps: f64,
    pub net_profit: f64,
    pub intended_risk_money: f64,
    pub mae_net_profit: f64,
    pub mfe_net_profit: f64,
    pub net_r: Option<f64>,
    pub economic_specification_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEquityPoint {
    pub time_utc: String,
    pub balance: f64,
    pub equity: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRunResult {
    pub run_id: String,
    pub success: bool,
    pub status: String,
    pub strategy: String,
    pub symbol: String,
    pub timeframe: String,
    pub build_artifact_path: String,
    pub build_revision: String,
    pub dataset_id: String,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    pub run_folder: String,
    pub report_json_path: String,
    pub trades_csv_path: String,
    pub open_positions_csv_path: String,
    pub equity_csv_path: Option<String>,
    pub account: Option<ExecutionAccountSummary>,
    pub replay: Option<ExecutionReplaySummary>,
    pub trade_statistics: Option<ExecutionTradeStatistics>,
    pub native_report_drawdown: Option<NativeReportDrawdown>,
    pub full_replay_drawdown: Option<FullReplayDrawdown>,
    pub trades: Vec<ExecutionTrade>,
    pub open_positions: Vec<ExecutionOpenPosition>,
    pub equity: Vec<ExecutionEquityPoint>,
    pub errors: Vec<String>,
    pub output: String,
    pub report_sha256: Option<String>,
    /// Host-frozen baseline inputs; absent for failures, old runs and presentation fixtures.
    #[serde(default)]
    pub replay_receipt_sha256: Option<String>,
}

// ===== Report parsing (ReportWriter schema) =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReportRoot {
    #[serde(deserialize_with = "required_report_value")]
    parameter_unknown: Option<Vec<String>>,
    #[serde(deserialize_with = "required_report_value")]
    strategy: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    symbol: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    timeframe: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    account: Option<ReportAccount>,
    #[serde(deserialize_with = "required_report_value")]
    replay: Option<ReportReplay>,
    #[serde(deserialize_with = "required_report_value")]
    drawdown: Option<ReportDrawdown>,
    #[serde(default)]
    native_report_drawdown: Option<ReportNativeDrawdown>,
    #[serde(deserialize_with = "required_report_value")]
    trade_statistics: Option<ReportTradeStats>,
    #[serde(deserialize_with = "required_report_value")]
    trades: Option<Vec<ReportTrade>>,
    #[serde(deserialize_with = "required_report_value")]
    open_positions: Option<Vec<ReportOpenPosition>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReportAccount {
    #[serde(deserialize_with = "required_report_value")]
    currency: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    currency_digits: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    starting_capital: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    balance: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    equity: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    closed_net_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    open_net_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    marked_to_market_net_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    marked_to_market_return_percent: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReportReplay {
    #[serde(deserialize_with = "required_report_value")]
    mode: Option<String>,
    #[serde(default)]
    bar_price_mode: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    input_count: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    ticks_or_synthetic_ticks: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    on_bar_count: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    chart_bar_count: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    hour_bar_count: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    elapsed_ms: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    ticks_or_synthetic_ticks_per_second: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    first_time_utc: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    last_time_utc: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReportDrawdown {
    #[serde(deserialize_with = "required_report_value")]
    equity_points: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    max_balance_drawdown: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    max_balance_drawdown_percent: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    max_balance_drawdown_peak_time_utc: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    max_balance_drawdown_trough_time_utc: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    max_balance_drawdown_peak: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    max_balance_drawdown_trough: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    max_equity_drawdown: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    max_equity_drawdown_percent: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    max_equity_drawdown_peak_time_utc: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    max_equity_drawdown_trough_time_utc: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    max_equity_drawdown_peak: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    max_equity_drawdown_trough: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReportNativeDrawdown {
    #[serde(deserialize_with = "required_report_value")]
    method: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    equity_points: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    max_equity_drawdown: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    max_equity_drawdown_percent: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    max_balance_drawdown: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    max_balance_drawdown_percent: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReportTradeStats {
    #[serde(deserialize_with = "required_report_value")]
    total_trades: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    winning_trades: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    losing_trades: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    long_trades: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    short_trades: Option<i64>,
    #[serde(deserialize_with = "required_report_value")]
    gross_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    gross_loss: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    commissions: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    swaps: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    net_profit: Option<f64>,
    #[serde(default)]
    profit_factor: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    total_pips: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    average_net_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    largest_win: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    largest_loss: Option<f64>,
    #[serde(default)]
    win_rate: Option<f64>,
    #[serde(default)]
    loss_rate: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReportTrade {
    #[serde(deserialize_with = "required_report_value")]
    id: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    symbol: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    label: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    side: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    volume_in_units: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    entry_time_utc: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    entry_price: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    entry_bid: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    entry_ask: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    entry_spread: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    close_time_utc: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    close_price: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    close_bid: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    close_ask: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    close_spread: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    close_reason: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    pips: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    gross_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    pnl_conversion_fees: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    commissions: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    swaps: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    net_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    intended_risk_money: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    mae_net_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    mfe_net_profit: Option<f64>,
    #[serde(default)]
    net_r: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    economic_specification_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ReportOpenPosition {
    #[serde(deserialize_with = "required_report_value")]
    id: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    symbol: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    label: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    side: Option<String>,
    #[serde(deserialize_with = "required_report_value")]
    volume_in_units: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    entry_time_utc: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    entry_price: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    valuation_time_utc: Option<serde_json::Value>,
    #[serde(deserialize_with = "required_report_value")]
    valuation_price: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    age_hours: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    pips: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    gross_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    pnl_conversion_fees: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    commissions: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    swaps: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    net_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    intended_risk_money: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    mae_net_profit: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    mfe_net_profit: Option<f64>,
    #[serde(default)]
    net_r: Option<f64>,
    #[serde(deserialize_with = "required_report_value")]
    economic_specification_hash: Option<String>,
}

/// Deserialize a required report field, rejecting both absent and null values.
fn required_report_value<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("A required ReportWriter field is null."))
}

/// Preserve report ids and timestamps in their original scalar representation.
fn value_to_string(value: &Option<serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// Check a group of numeric report values for NaN or infinity.
fn all_finite(values: &[f64]) -> bool {
    values.iter().all(|value| value.is_finite())
}

/// Parses a UTC instant from an ISO-8601 or date-only string.
fn parse_utc_instant(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(dt.with_timezone(&chrono::Utc));
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc());
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S") {
        return Some(dt.and_utc());
    }
    None
}

/// Computes the current source revision for a project, matching the build receipt.
fn current_source_revision(root: &crate::workspace::ProjectRoot) -> Result<String, String> {
    let ids = crate::workspace::collect_source_files(root)?;
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    for id in &ids {
        let mut path = root.directory().to_path_buf();
        for part in id.split('/') {
            path.push(part);
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("Source file could not be read ({error})."))?;
        hasher.update(b"c:");
        hasher.update(id.as_bytes());
        hasher.update(b"=");
        hasher.update(crate::workspace::content_revision(&bytes).as_bytes());
        hasher.update(b"\n");
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Validates a symbol specification path and requires app-owned storage containment.
fn validate_symbol_spec(state: &ExecutionState, path: &str) -> Result<std::path::PathBuf, String> {
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("The symbol specification could not be resolved ({error})."))?;
    if !canonical.is_file() {
        return Err("The symbol specification is not a file.".to_string());
    }
    let specs_dir = state.market_data_directory.join("symbol_specs");
    let specs_canonical = specs_dir.canonicalize().map_err(|error| {
        format!("The symbol specification storage could not be resolved ({error}).")
    })?;
    if !canonical.starts_with(&specs_canonical) {
        return Err("The symbol specification is outside app-owned storage.".to_string());
    }
    let bytes = read_bounded_file(&canonical)?;
    let document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The symbol specification is not valid JSON.".to_string())?;
    let schema_version = document
        .get("schema_version")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if schema_version != "backtestengine.economic-symbol/v2" {
        return Err("Unsupported symbol specification schema_version.".to_string());
    }
    verify_registered_manifest(canonical, bytes)
}

/// Verifies the derived profile against its typed manifest and dependencies.
fn verify_registered_manifest(
    canonical: std::path::PathBuf,
    profile_bytes: Vec<u8>,
) -> Result<std::path::PathBuf, String> {
    let bundle_dir = canonical
        .parent()
        .ok_or_else(|| "The symbol specification path is invalid.".to_string())?;
    let manifest_path = bundle_dir.join("dependencies.json");
    let provenance_path = bundle_dir.join("provenance.json");
    if !manifest_path.is_file() || !provenance_path.is_file() {
        return Err("The symbol specification registration is missing.".to_string());
    }

    let manifest_bytes = read_bounded_file(&manifest_path)?;
    let manifest: market_data::SymbolSpecDependencyManifest =
        serde_json::from_slice(&manifest_bytes)
            .map_err(|_| "The dependency manifest is damaged.".to_string())?;
    let provenance_bytes = read_bounded_file(&provenance_path)?;
    let provenance: market_data::ImportedSymbolSpec = serde_json::from_slice(&provenance_bytes)
        .map_err(|_| "The provenance record is damaged.".to_string())?;

    let current_hash = sha256_hex(&profile_bytes);
    if manifest.derived_sha256 != current_hash {
        return Err("The derived profile hash does not match its manifest.".to_string());
    }

    let profile_canonical = canonical
        .canonicalize()
        .map_err(|error| format!("The symbol specification could not be resolved ({error})."))?;
    let provenance_canonical = Path::new(&provenance.stored_path)
        .canonicalize()
        .map_err(|error| format!("The provenance record could not be resolved ({error})."))?;
    let manifest_canonical = Path::new(&manifest.stored_path)
        .canonicalize()
        .map_err(|_| "The manifest profile path is missing.".to_string())?;
    if manifest_canonical != profile_canonical {
        return Err("The manifest does not match the profile path.".to_string());
    }
    if provenance.size_bytes != profile_bytes.len() as u64
        || provenance.schema_version != "backtestengine.economic-symbol/v2"
        || provenance.original_path != manifest.original_path
    {
        return Err("The provenance record does not match the registered profile.".to_string());
    }
    if provenance_canonical != profile_canonical {
        return Err("The provenance record does not match the profile path.".to_string());
    }
    if provenance.id != manifest.id {
        return Err("The provenance and manifest identifiers differ.".to_string());
    }
    if provenance.sha256 != manifest.derived_sha256 {
        return Err("The provenance and manifest hashes differ.".to_string());
    }

    // Verify every registered dependency exists and still has the recorded bytes.
    for dependency in &manifest.dependencies {
        let dependency_path = Path::new(&dependency.absolute);
        let dependency_canonical = dependency_path
            .canonicalize()
            .map_err(|_| "A registered dependency is missing.".to_string())?;
        let dependency_bytes = read_bounded_file(&dependency_canonical)?;
        if sha256_hex(&dependency_bytes) != dependency.sha256 {
            return Err("A registered dependency hash changed.".to_string());
        }
    }

    // Bind the profile's active references to the registered dependency set.
    let document: serde_json::Value = serde_json::from_slice(&profile_bytes)
        .map_err(|_| "The derived profile is damaged.".to_string())?;
    let active_refs = market_data::active_symbol_spec_references(&document)?;
    let mut expected: Vec<(String, String)> = Vec::new();
    for (field, raw_path) in active_refs {
        let dependency_canonical = Path::new(&raw_path)
            .canonicalize()
            .map_err(|_| "An active dependency is missing.".to_string())?;
        expected.push((field, dependency_canonical.to_string_lossy().to_string()));
    }
    expected.sort();

    let mut registered: Vec<(String, String)> = manifest
        .dependencies
        .iter()
        .map(|dependency| {
            let canonical_path = Path::new(&dependency.absolute)
                .canonicalize()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|_| dependency.absolute.clone());
            (dependency.field.clone(), canonical_path)
        })
        .collect();
    registered.sort();

    if expected != registered {
        return Err("The registered dependency references do not match the profile.".to_string());
    }

    Ok(profile_canonical)
}

/// Read one registration file only within the configured import size limit.
fn read_bounded_file(path: &Path) -> Result<Vec<u8>, String> {
    read_limited_bytes(path, market_data::MAX_IMPORT_BYTES)
}

/// Compute the exact lowercase SHA-256 of imported or generated bytes.
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}
/// Reject external parameter files until host-owned import is supported.
fn validate_parameter_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Ok(());
    }
    Err("Parameter files are not supported; use parameter overrides instead.".to_string())
}

/// Validates request fields before running.
pub fn validate_request(request: &ExecutionRunRequest) -> Result<(), String> {
    if request.strategy.trim().is_empty() {
        return Err("A compiled strategy is required.".to_string());
    }
    if request.dataset_id.trim().is_empty() {
        return Err("A historical dataset is required.".to_string());
    }
    if request.symbol_spec_path.trim().is_empty() {
        return Err("A symbol specification is required.".to_string());
    }
    if !request.starting_balance.is_finite() || request.starting_balance <= 0.0 {
        return Err("Starting balance must be a positive finite number.".to_string());
    }
    if !request.commission_usd_per_million.is_finite() {
        return Err("Commission must be finite.".to_string());
    }
    if !request.slippage_pips.is_finite() || request.slippage_pips < 0.0 {
        return Err("Slippage must be a non-negative finite number.".to_string());
    }
    if let Some(spread) = request.spread_pips {
        if !spread.is_finite() || spread < 0.0 {
            return Err("Spread must be a non-negative finite number.".to_string());
        }
    }
    validate_request_dates(request.start_utc.as_deref(), request.end_utc.as_deref())?;
    for (name, count) in [
        ("Max ticks", request.max_ticks),
        ("Max bars", request.max_bars),
    ] {
        if count.is_some_and(|value| !(0..=i32::MAX as i64).contains(&value)) {
            return Err(format!(
                "{name} must be between zero (unlimited) and {}.",
                i32::MAX
            ));
        }
    }
    Ok(())
}

/// Parse each provided endpoint independently; a valid pair retains the original exclusive-end ordering.
fn validate_request_dates(start: Option<&str>, end: Option<&str>) -> Result<(), String> {
    let start = requested_utc_endpoint(start)?;
    let end = requested_utc_endpoint(end)?;
    if start.zip(end).is_some_and(|(start, end)| start >= end) {
        return Err("The start date must be before the end date.".into());
    }
    Ok(())
}

/// Blank optional dates remain absent; nonblank dates use the established UTC parser without calendar rewriting.
fn requested_utc_endpoint(
    value: Option<&str>,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            parse_utc_instant(value).ok_or_else(|| {
                "The replay date range must use valid UTC ISO-8601 dates.".to_string()
            })
        })
        .transpose()
}

/// Validates an approved build artifact path and returns its revision.
pub fn validate_artifact(
    builds_directory: &Path,
    artifact_path: &str,
) -> Result<(PathBuf, String), String> {
    let candidate = Path::new(artifact_path);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("The build artifact could not be resolved ({error})."))?;
    let builds_canonical = builds_directory
        .canonicalize()
        .map_err(|error| format!("The builds directory could not be resolved ({error})."))?;
    if !canonical.starts_with(&builds_canonical) {
        return Err("The build artifact is outside app-owned storage.".to_string());
    }
    if canonical.file_name().and_then(|name| name.to_str()) != Some("WorkspaceCompile.dll") {
        return Err("The build artifact is not an approved workspace build.".to_string());
    }
    // The build receipt is written at the snapshot root, not next to the DLL.
    // Walk ancestors (up to the builds root) to find it.
    let mut receipt_path = None;
    for ancestor in canonical.ancestors() {
        let candidate = ancestor.join("revision.json");
        if candidate.is_file() {
            receipt_path = Some(candidate);
            break;
        }
        if ancestor == builds_canonical {
            break;
        }
    }
    let receipt_path =
        receipt_path.ok_or_else(|| "The build artifact has no approval receipt.".to_string())?;
    let receipt_bytes = fs::read(&receipt_path)
        .map_err(|error| format!("The build receipt could not be read ({error})."))?;
    let receipt: serde_json::Value = serde_json::from_slice(&receipt_bytes)
        .map_err(|_| "The build receipt is damaged.".to_string())?;
    let revision = receipt
        .get("revision")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "The build receipt is missing its revision.".to_string())?
        .to_string();
    if revision.trim().is_empty() {
        return Err("The build receipt is missing its revision.".to_string());
    }
    Ok((canonical, revision))
}

/// Clamps captured process output.
fn clamp_output(text: &str) -> String {
    if text.chars().count() <= MAX_OUTPUT_CHARS + 32 {
        return text.to_string();
    }
    let head: String = text.chars().take(MAX_OUTPUT_CHARS / 2).collect();
    let tail: String = text
        .chars()
        .skip(text.chars().count() - MAX_OUTPUT_CHARS / 2)
        .collect();
    format!("{head}\n(output truncated)\n{tail}")
}

/// Create a UTC timestamp for an actual native run lifecycle event.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Runs one execution.
pub async fn run_execution(
    app: tauri::AppHandle,
    state: &ExecutionState,
    request: ExecutionRunRequest,
    approved: workspace_build::ApprovedBuild,
    project: crate::workspace::ProjectRoot,
) -> Result<ExecutionRunResult, String> {
    if !project.matches_canonical_identity(&approved.project_root) {
        return Err("The execution project differs from its approved build.".into());
    }
    // Reject cheap malformed requests before the latch; shared preflight also validates standalone callers.
    validate_request(&request)?;

    // Acquire running latch.
    {
        let mut running = state
            .running
            .lock()
            .map_err(|_| "Execution state is busy. Retry.".to_string())?;
        if *running {
            return Err(
                "An execution is already running. Cancel it or wait for it to finish.".to_string(),
            );
        }
        *running = true;
    }

    let mut guard = ExecutionGuard::new(state);
    let started = Instant::now();
    let started_at = now_iso();
    let run_id = uuid::Uuid::new_v4().to_string();
    let run_folder = state.runs_directory.join(&run_id);
    if let Err(error) = fs::create_dir_all(&run_folder) {
        return Err(format!("The run folder could not be created ({error})."));
    }

    // cancel channel
    let (sender, mut cancel) = oneshot::channel::<()>();
    {
        let mut slot = state
            .cancel
            .lock()
            .map_err(|_| "Execution state is busy. Retry.".to_string())?;
        if let Some(previous) = slot.replace(sender) {
            let _ = previous.send(());
        }
    }

    let inputs = match preflight_execution_inputs(state, &request, &approved) {
        Ok(inputs) => inputs,
        Err(error) => {
            cleanup_run(&run_folder);
            return Err(error);
        }
    };
    let ExecutionInputs {
        artifact_path: artifact_canonical,

        dataset_record,
        symbol_spec_path: symbol_spec_canonical,
        resolved_symbol,
        build_revision,
    } = inputs;

    // resolve dotnet host
    let build_runtime = crate::build_process::resolve_runtime(&app)?;
    let compiler =
        match workspace_build::require_compiler(&build_runtime, &mut cancel, guard.cleanup.clone())
            .await
        {
            Ok(value) => value,
            Err(error) => {
                if guard.cleanup.load(Ordering::Acquire) {
                    cleanup_run(&run_folder);
                }
                if error == workspace_build::CANCELLATION_MESSAGE {
                    let completed_at = now_iso();
                    let result = ExecutionRunResult {
                        run_id: run_id.clone(),
                        success: false,
                        status: "cancelled".to_string(),
                        strategy: request.strategy.clone(),
                        symbol: String::new(),
                        timeframe: String::new(),
                        build_artifact_path: artifact_canonical.to_string_lossy().to_string(),
                        build_revision: build_revision.clone(),
                        dataset_id: request.dataset_id.clone(),
                        started_at: started_at.clone(),
                        completed_at,
                        duration_ms: started.elapsed().as_millis() as u64,
                        run_folder: run_folder.to_string_lossy().to_string(),
                        report_json_path: String::new(),
                        trades_csv_path: String::new(),
                        open_positions_csv_path: String::new(),
                        equity_csv_path: None,
                        account: None,
                        replay: None,
                        trade_statistics: None,
                        native_report_drawdown: None,
                        full_replay_drawdown: None,
                        trades: Vec::new(),
                        open_positions: Vec::new(),
                        equity: Vec::new(),
                        errors: vec![error],
                        output: String::new(),
                        report_sha256: None,
                        replay_receipt_sha256: None,
                    };
                    return Ok(result);
                }
                return Err(error);
            }
        };

    guard.inputs = Some(
        match capture_baseline_inputs(
            &app,
            state,
            BaselineCapture {
                run_id: &run_id,
                directory: &run_folder,
                request: &request,
                approved: &approved,
                profile_path: &symbol_spec_canonical,
                symbol: &resolved_symbol,
                dataset: &dataset_record,
            },
        ) {
            Ok(value) => value,
            Err(error) => {
                cleanup_run(&run_folder);
                return Err(error);
            }
        },
    );
    let cleanup = guard.cleanup.clone();
    let frozen = guard
        .inputs
        .as_mut()
        .ok_or("The frozen replay inputs are missing.")?;
    let frozen_dataset = frozen.directory.join("market.csv");
    let frozen_profile = frozen.directory.join("profile.json");
    let frozen_artifact = frozen.directory.join("binary/WorkspaceCompile.dll");
    let report_path = run_folder.join("report.json");

    let arguments = match execution_arguments(
        &frozen_artifact,
        &request,
        &frozen_dataset,
        &frozen_profile,
        &resolved_symbol,
        &dataset_record.kind,
        &report_path,
    ) {
        Ok(arguments) => arguments,
        Err(error) => {
            cleanup_run(&run_folder);
            return Err(error);
        }
    };

    let working = frozen_artifact
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf();

    let _ = app.emit(
        "execution-progress",
        serde_json::json!({
            "runId": run_id,
            "stage": "running",
        }),
    );

    let host = crate::full_validation::resolve_engine_host(&app)?;
    let process_result = crate::execution_process::run_replay(
        crate::execution_process::ReplayRuntime {
            compiler: &compiler.executable,
            host: &host,
        },
        &arguments,
        &working,
        &mut cancel,
        EXECUTION_TIMEOUT_SECONDS,
        cleanup,
    )
    .await;

    let completed_at = now_iso();
    let duration_ms = started.elapsed().as_millis() as u64;

    // Determine status
    let mut output = String::new();
    let mut errors: Vec<String> = Vec::new();
    let mut cancelled = false;
    let mut timed_out = false;

    let exit_success = match &process_result {
        Ok(output_value) => {
            output = format!(
                "{}{}",
                String::from_utf8_lossy(&output_value.stdout),
                String::from_utf8_lossy(&output_value.stderr)
            );
            output_value.status.success()
        }
        Err(error) => {
            if error == workspace_build::CANCELLATION_MESSAGE {
                cancelled = true;
            } else if error.contains("did not respond within") {
                timed_out = true;
            }
            errors.push(error.clone());
            false
        }
    };

    // Parse report if exists
    let mut result = ExecutionRunResult {
        run_id: run_id.clone(),
        success: false,
        status: if cancelled {
            "cancelled".to_string()
        } else if timed_out {
            "timeout".to_string()
        } else if exit_success {
            "completed".to_string()
        } else {
            "failed".to_string()
        },
        strategy: request.strategy.clone(),
        symbol: resolved_symbol.clone(),
        timeframe: request.timeframe.clone().unwrap_or_default(),
        build_artifact_path: artifact_canonical.to_string_lossy().to_string(),
        build_revision: build_revision.clone(),
        dataset_id: request.dataset_id.clone(),
        started_at: started_at.clone(),
        completed_at: completed_at.clone(),
        duration_ms,
        run_folder: run_folder.to_string_lossy().to_string(),
        report_json_path: report_path.to_string_lossy().to_string(),
        trades_csv_path: run_folder.join("trades.csv").to_string_lossy().to_string(),
        open_positions_csv_path: run_folder
            .join("open_positions.csv")
            .to_string_lossy()
            .to_string(),
        equity_csv_path: if request.write_equity_csv {
            Some(run_folder.join("equity.csv").to_string_lossy().to_string())
        } else {
            None
        },
        account: None,
        replay: None,
        trade_statistics: None,
        native_report_drawdown: None,
        full_replay_drawdown: None,
        trades: Vec::new(),
        open_positions: Vec::new(),
        equity: Vec::new(),
        errors: errors.clone(),
        output: clamp_output(&output),
        report_sha256: None,
        replay_receipt_sha256: None,
    };

    apply_report(
        &mut result,
        &report_path,
        &run_folder,
        &mut errors,
        exit_success,
    );

    if cancelled {
        result.status = "cancelled".to_string();
        result.success = false;
    }
    if timed_out {
        result.status = "timeout".to_string();
        result.success = false;
    }

    if result.success {
        match crate::replay_receipt::verify_baseline_completion(
            frozen,
            &report_path,
            result.report_sha256.as_deref().unwrap_or_default(),
        ) {
            Ok(()) => result.replay_receipt_sha256 = Some(frozen.receipt_sha256.clone()),
            Err(error) => {
                errors.push(error);
                result.success = false;
                result.status = "failed".into();
                result.report_sha256 = None;
            }
        }
    }

    result.errors = errors;
    result.output = clamp_output(&output);

    if !result.success {
        return Ok(result);
    }
    let result = commit_completed_execution(&app, project.clone(), result).await?;
    store_last_good_execution(state, &project.directory().to_string_lossy(), &result)?;
    Ok(result)
}

/// Move the accepted result through off-thread durable commit; no large financial vectors are cloned merely for inspection.
async fn commit_completed_execution(
    app: &tauri::AppHandle,
    project: crate::workspace::ProjectRoot,
    result: ExecutionRunResult,
) -> Result<ExecutionRunResult, String> {
    use tauri::Manager;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<crate::saved_runs::SavedRunState>()
            .ok_or_else(|| {
                crate::saved_runs::SavedRunCommitError(
                    "Native saved-run storage is unavailable.".into(),
                )
            })?;
        crate::saved_runs::commit_successful_run(state.inner(), &project, &result)?;
        Ok::<_, crate::saved_runs::SavedRunCommitError>(result)
    })
    .await
    .map_err(|_| {
        crate::saved_runs::SavedRunCommitError(
            "Durable completion acknowledgement was interrupted; artifacts were preserved.".into(),
        )
        .to_string()
    })?
    .map_err(|error| error.to_string())
}

/// Verified original invocation inputs, captured only after SDK probing and before replay dispatch.
struct BaselineCapture<'a> {
    run_id: &'a str,
    directory: &'a Path,
    request: &'a ExecutionRunRequest,
    approved: &'a workspace_build::ApprovedBuild,
    profile_path: &'a Path,
    symbol: &'a str,
    dataset: &'a market_data::ImportedDataset,
}

/// Assemble current source afresh and freeze dataset/profile bytes without trusting an old mutable snapshot.
fn capture_baseline_inputs(
    app: &tauri::AppHandle,
    state: &ExecutionState,
    input: BaselineCapture<'_>,
) -> Result<crate::replay_receipt::FrozenReplayInputs, String> {
    let profile = market_data::list_symbol_specs(&state.market_data_directory)?
        .into_iter()
        .find(|profile| {
            Path::new(&profile.stored_path)
                .canonicalize()
                .ok()
                .as_deref()
                == Some(input.profile_path)
        })
        .ok_or("The baseline profile catalog identity disappeared before capture.")?;
    let bytes = market_data::read_limited_bytes(input.profile_path, market_data::MAX_IMPORT_BYTES)?;
    let raw: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let profile_rate = raw["commission_rate"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or("The registered profile lacks a finite original commission rate.")?;
    let request = input.request;
    let settings = crate::replay_receipt::ReplaySettings {
        strategy: request.strategy.clone(),
        symbol: input.symbol.into(),
        timeframe: request.timeframe.clone().unwrap_or_default(),
        starting_balance: request.starting_balance,
        commission_usd_per_million: request.commission_usd_per_million,
        effective_commission_usd_per_million: if request.commission_usd_per_million < 0.0 {
            profile_rate
        } else {
            request.commission_usd_per_million
        },
        slippage_pips: request.slippage_pips,
        spread_pips: request.spread_pips,
        start_utc: request.start_utc.clone(),
        end_utc: request.end_utc.clone(),
        max_ticks: request.max_ticks,
        max_bars: request.max_bars,
        bar_timeframe: request.bar_timeframe.clone(),
        bar_price_mode: request.bar_price_mode.clone(),
        write_equity_csv: request.write_equity_csv,
        parameter_overrides: request.parameter_overrides.clone().unwrap_or_default(),
        parameter_mode: crate::replay_receipt::ParameterMode::NoFile,
    };
    let root = crate::workspace::ProjectRoot::open(&input.approved.project_root)?;
    let engine = workspace_build::resolve_engine_source(app)?;
    let fresh = workspace_build::assemble(&root, &engine, &input.directory.join("fresh-source"))?;
    crate::replay_receipt::capture_replay_inputs(crate::replay_receipt::CaptureReplayInputs {
        run_id: input.run_id,
        run_directory: input.directory,
        fresh_source: &fresh.snapshot,
        approved: input.approved,
        settings,
        dataset: input.dataset,
        profile: &profile,
    })
}

/// Publish canonical project and successful result together; lock project before result everywhere.
fn store_last_good_execution(
    state: &ExecutionState,
    project: &str,
    result: &ExecutionRunResult,
) -> Result<(), String> {
    let mut bound_project = state
        .last_good_project
        .lock()
        .map_err(|_| "Execution state is busy. Retry.")?;
    let mut last = state
        .last_good
        .lock()
        .map_err(|_| "Execution state is busy. Retry.")?;
    *bound_project = Some(project.to_string());
    *last = Some(result.clone());
    Ok(())
}

/// Read one coherent host-bound result snapshot; no renderer paths or filesystem normalization enter here.
/// Both producer and consumers hold project then result, with no await while either guard is alive.
pub(crate) fn last_good_execution_for_project(
    state: &ExecutionState,
    project: &crate::workspace::ProjectRoot,
) -> Result<Option<ExecutionRunResult>, String> {
    let bound_project = state
        .last_good_project
        .lock()
        .map_err(|_| "Execution state is busy. Retry.")?;
    let last = state
        .last_good
        .lock()
        .map_err(|_| "Execution state is busy. Retry.")?;
    if !bound_project
        .as_deref()
        .is_some_and(|identity| project.matches_canonical_identity(identity))
    {
        return Ok(None);
    }
    Ok(last
        .clone()
        .filter(|run| run.success && run.status == "completed"))
}

/// Build the complete immutable dotnet dispatch vector; the approved DLL occurs once before CLI options.
/// Returns an error for bar replay without a source timeframe and performs no I/O or launch.
fn execution_arguments(
    artifact: &Path,
    request: &ExecutionRunRequest,
    dataset_path: &Path,
    symbol_spec: &Path,
    symbol: &str,
    dataset_kind: &str,
    report_path: &Path,
) -> Result<Vec<String>, String> {
    let mut arguments = vec![
        artifact.to_string_lossy().to_string(),
        "--symbol".to_string(),
        symbol.to_string(),
    ];
    arguments.push("--strategy".to_string());
    arguments.push(request.strategy.clone());
    // dataset kind: require provenance sidecar; reject unknown datasets.
    if dataset_kind == "bars" {
        arguments.push("--bars".to_string());
    } else {
        arguments.push("--ticks".to_string());
    }
    arguments.push(dataset_path.to_string_lossy().to_string());
    arguments.push("--symbol-spec".to_string());
    arguments.push(symbol_spec.to_string_lossy().to_string());
    arguments.push("--balance".to_string());
    arguments.push(request.starting_balance.to_string());
    arguments.push("--commission-usd-per-million".to_string());
    arguments.push(request.commission_usd_per_million.to_string());
    arguments.push("--slippage-pips".to_string());
    arguments.push(request.slippage_pips.to_string());
    if let Some(spread) = request.spread_pips {
        if spread >= 0.0 {
            arguments.push("--spread-pips".to_string());
            arguments.push(spread.to_string());
        }
    }
    if dataset_kind == "bars" {
        let source_timeframe = request
            .bar_timeframe
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                request
                    .timeframe
                    .as_ref()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            });
        let Some(source_timeframe) = source_timeframe else {
            return Err("Bar source timeframe is required for bar replay.".to_string());
        };
        arguments.push("--bar-period".to_string());
        arguments.push(source_timeframe);
    }
    if let Some(tf) = &request.timeframe {
        if !tf.trim().is_empty() {
            arguments.push("--period".to_string());
            arguments.push(tf.trim().to_string());
        }
    }
    if let Some(mode) = &request.bar_price_mode {
        if !mode.trim().is_empty() {
            arguments.push("--bar-price-mode".to_string());
            arguments.push(mode.trim().to_string());
        }
    }
    if let Some(start) = &request.start_utc {
        if !start.trim().is_empty() {
            arguments.push("--start-utc".to_string());
            arguments.push(start.trim().to_string());
        }
    }
    if let Some(end) = &request.end_utc {
        if !end.trim().is_empty() {
            arguments.push("--end-utc".to_string());
            arguments.push(end.trim().to_string());
        }
    }
    if let Some(max_ticks) = request.max_ticks {
        if max_ticks > 0 {
            arguments.push("--max-ticks".to_string());
            arguments.push(max_ticks.to_string());
        }
    }
    if let Some(max_bars) = request.max_bars {
        if max_bars > 0 {
            arguments.push("--max-bars".to_string());
            arguments.push(max_bars.to_string());
        }
    }
    if let Some(param_path) = &request.parameter_path {
        if !param_path.trim().is_empty() {
            arguments.push("--params".to_string());
            arguments.push(param_path.trim().to_string());
        }
    }
    if let Some(overrides) = &request.parameter_overrides {
        for (name, value) in overrides {
            arguments.push("--param".to_string());
            arguments.push(format!("{name}={value}"));
        }
    }
    arguments.push("--report-json".to_string());
    arguments.push(report_path.to_string_lossy().to_string());
    if !request.write_equity_csv {
        arguments.push("--skip-equity-csv".to_string());
    }

    Ok(arguments)
}

/// Known CLR loading companions emitted beside every source-linked build.
const RUNTIME_COMPANIONS: [&str; 3] = [
    "BacktestEngine.CAlgoShim.dll",
    "WorkspaceCompile.deps.json",
    "WorkspaceCompile.runtimeconfig.json",
];

/// Capture exact hashes for the numerical shim and CLR dependency/configuration inputs.
/// Every file must remain beside the approved artifact, including after canonical resolution.
pub(crate) fn runtime_companion_hashes(
    artifact: &Path,
) -> Result<BTreeMap<String, String>, String> {
    let parent = artifact
        .parent()
        .ok_or("The build artifact has no runtime folder.")?
        .canonicalize()
        .map_err(|error| format!("The build runtime folder could not be resolved ({error})."))?;
    let mut hashes = BTreeMap::new();
    for name in RUNTIME_COMPANIONS {
        let expected = parent.join(name);
        let resolved = expected.canonicalize().map_err(|error| {
            format!("The approved runtime companion '{name}' could not be resolved ({error}).")
        })?;
        if resolved != expected {
            return Err(format!(
                "The approved runtime companion '{name}' is outside its build location."
            ));
        }
        let bytes = read_bounded_file(&resolved)?;
        hashes.insert(name.to_string(), sha256_hex(&bytes));
    }
    Ok(hashes)
}

/// Reject changed, removed or redirected companions before SDK probing or engine launch.
fn validate_runtime_companions(
    artifact: &Path,
    approved: &BTreeMap<String, String>,
) -> Result<(), String> {
    if &runtime_companion_hashes(artifact)? != approved {
        return Err(
            "The approved build runtime companions changed on disk. Rebuild and retry.".to_string(),
        );
    }
    Ok(())
}

/// Release the single-run latch after execution leaves scope.
fn release_running(state: &ExecutionState) {
    if let Ok(mut running) = state.running.lock() {
        *running = false;
    }
}

/// Remove the cancellation sender after the owning run leaves scope.
fn clear_cancel(state: &ExecutionState) {
    if let Ok(mut slot) = state.cancel.lock() {
        slot.take();
    }
}

/// Remove only a UUID run directory created beneath app-owned run storage.
fn cleanup_run(run_folder: &Path) {
    let _ = fs::remove_dir_all(run_folder);
}

/// Parse complete finite equity rows; malformed data must fail the entire report.
fn parse_equity_csv(path: &Path) -> Result<Vec<ExecutionEquityPoint>, String> {
    let bytes = read_limited_bytes(path, MAX_REPORT_BYTES)
        .map_err(|error| format!("The equity file could not be read ({error})."))?;
    let content =
        String::from_utf8(bytes).map_err(|_| "The equity file is not valid UTF-8.".to_string())?;
    let mut points = Vec::new();
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("time_utc,balance,equity") {
        return Err("The equity file header is malformed.".to_string());
    }
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() != 3 {
            return Err("The equity file is malformed.".to_string());
        }
        let time = parts[0].trim().to_string();
        if parse_utc_instant(&time).is_none() {
            return Err("The equity file is malformed.".to_string());
        }
        let balance: f64 = parts[1]
            .trim()
            .parse()
            .map_err(|_| "The equity file is malformed.".to_string())?;
        let equity: f64 = parts[2]
            .trim()
            .parse()
            .map_err(|_| "The equity file is malformed.".to_string())?;
        if !balance.is_finite() || !equity.is_finite() {
            return Err("The equity file contains non-finite values.".to_string());
        }
        points.push(ExecutionEquityPoint {
            time_utc: time,
            balance,
            equity,
        });
    }
    Ok(points)
}

/// Cancel the running execution.
pub fn cancel_execution(state: &ExecutionState) -> Result<(), String> {
    let mut slot = state
        .cancel
        .lock()
        .map_err(|_| "Execution state is busy. Retry.".to_string())?;
    if let Some(sender) = slot.take() {
        let _ = sender.send(());
    }
    Ok(())
}

/// Import market data through the host.
pub fn import_market_data(
    state: &ExecutionState,
    original_path: &str,
    kind: &str,
) -> Result<market_data::ImportedDataset, String> {
    market_data::import_market_data(&state.market_data_directory, original_path, kind)
}

/// Parses a ReportWriter JSON file into an execution result with metrics and validation errors.
#[allow(dead_code)]
pub fn parse_report(
    report_path: &std::path::Path,
) -> Result<(ExecutionRunResult, Vec<String>), String> {
    let mut result = ExecutionRunResult {
        run_id: String::new(),
        success: false,
        status: "parsed".to_string(),
        strategy: String::new(),
        symbol: String::new(),
        timeframe: String::new(),
        build_artifact_path: String::new(),
        build_revision: String::new(),
        dataset_id: String::new(),
        started_at: String::new(),
        completed_at: String::new(),
        duration_ms: 0,
        run_folder: report_path
            .parent()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        report_json_path: report_path.to_string_lossy().to_string(),
        trades_csv_path: String::new(),
        open_positions_csv_path: String::new(),
        equity_csv_path: None,
        account: None,
        replay: None,
        trade_statistics: None,
        native_report_drawdown: None,
        full_replay_drawdown: None,
        trades: Vec::new(),
        open_positions: Vec::new(),
        equity: Vec::new(),
        errors: Vec::new(),
        output: String::new(),
        report_sha256: None,
        replay_receipt_sha256: None,
    };
    let mut errors = Vec::new();
    if !report_path.is_file() {
        errors.push("The report file does not exist.".to_string());
        return Ok((result, errors));
    }
    apply_report(
        &mut result,
        report_path,
        std::path::Path::new(""),
        &mut errors,
        true,
    );
    result.success = errors.is_empty();
    result.status = if result.success {
        "completed".to_string()
    } else {
        "failed".to_string()
    };
    Ok((result, errors))
}

/// Restore numerical sections only through the strict original-report parser while the saved-run caller holds all evidence locks.
/// This historical path checks captured controls and bytes without opening live source/catalog/authority paths or dispatching an engine.
pub(crate) fn restore_frozen_execution(
    seed: &ExecutionRunResult,
    receipt: &crate::replay_receipt::FrozenReplayReceipt,
    report: &Path,
    folder: &Path,
) -> Result<ExecutionRunResult, String> {
    let mut result = seed.clone();
    result.account = None;
    result.replay = None;
    result.trade_statistics = None;
    result.native_report_drawdown = None;
    result.full_replay_drawdown = None;
    result.trades.clear();
    result.open_positions.clear();
    result.equity.clear();
    let mut errors = Vec::new();
    apply_report(&mut result, report, folder, &mut errors, true);
    if !errors.is_empty() || !result.success || result.status != "completed" {
        return Err(format!(
            "The saved report failed strict parsing: {}",
            errors.join(" ")
        ));
    }
    if result.report_sha256 != seed.report_sha256 || seed.report_sha256.is_none() {
        return Err("The saved report differs from its accepted completion hash.".into());
    }
    let raw: serde_json::Value =
        serde_json::from_slice(&read_limited_bytes(report, MAX_REPORT_BYTES)?)
            .map_err(|error| error.to_string())?;
    crate::replay_receipt::verify_baseline_report_controls(receipt, &raw)?;
    result.errors.clear();
    Ok(result)
}

/// Parses and validates the ReportWriter JSON into the run result.
///
/// All numeric sections are checked for finite values; malformed or non-finite data
/// marks the run as failed instead of being coerced to zero.
fn apply_report(
    result: &mut ExecutionRunResult,
    report_path: &std::path::Path,
    run_folder: &std::path::Path,
    errors: &mut Vec<String>,
    exit_success: bool,
) {
    if !report_path.is_file() {
        errors.push("The engine did not produce a report.".to_string());
        finalize_report(result, errors, exit_success);
        return;
    }

    let bytes = match read_limited_bytes(report_path, MAX_REPORT_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => {
            errors.push(format!("The report could not be read ({error})."));
            finalize_report(result, errors, exit_success);
            return;
        }
    };

    let report: ReportRoot = match serde_json::from_slice(&bytes) {
        Ok(report) => report,
        Err(error) => {
            errors.push(format!("The report could not be parsed ({error})."));
            finalize_report(result, errors, exit_success);
            return;
        }
    };

    let report_hash = sha256_hex(&bytes);
    if let Err(error) = validate_report_identity(result, &report) {
        errors.push(error);
    }

    match read_report_equity(report_path, run_folder) {
        Ok(points) => result.equity = points,
        Err(error) => errors.push(error),
    }

    if report_has_nonfinite(&report, &result.equity) {
        errors.push("The report contains non-finite numeric values.".to_string());
    }
    if report.account.is_none() {
        errors.push("The report is missing its account summary.".to_string());
    }
    if report.trade_statistics.is_none() {
        errors.push("The report is missing its trade statistics.".to_string());
    }

    if errors.is_empty() {
        map_report(result, &report);
        result.report_sha256 = Some(report_hash);
    } else {
        result.report_sha256 = None;
    }

    finalize_report(result, errors, exit_success);
}

/// Read the optional original equity file beside its report, rejecting every malformed row.
fn read_report_equity(
    report_path: &Path,
    run_folder: &Path,
) -> Result<Vec<ExecutionEquityPoint>, String> {
    let equity = report_path
        .parent()
        .unwrap_or(run_folder)
        .join("equity.csv");
    if !equity.is_file() {
        return Ok(Vec::new());
    }
    parse_equity_csv(&equity)
}

/// Require source identity and consistent trade counts before promoting a report to last-good.
fn validate_report_identity(
    result: &ExecutionRunResult,
    report: &ReportRoot,
) -> Result<(), String> {
    if report
        .parameter_unknown
        .as_ref()
        .is_none_or(|names| !names.is_empty())
    {
        return Err("The engine reported unknown parameters. Review the approved strategy parameters and run again.".to_string());
    }
    let strategy = report.strategy.as_deref().unwrap_or_default();
    let symbol = report.symbol.as_deref().unwrap_or_default();
    let timeframe = report.timeframe.as_deref().unwrap_or_default();
    if strategy.trim().is_empty() || symbol.trim().is_empty() || timeframe.trim().is_empty() {
        return Err(
            "The report is missing its strategy, symbol or timeframe identity.".to_string(),
        );
    }
    if !result.strategy.is_empty() && result.strategy != strategy {
        return Err("The report strategy does not match the requested strategy.".to_string());
    }
    if !result.symbol.is_empty() && !result.symbol.trim().eq_ignore_ascii_case(symbol.trim()) {
        return Err("The report symbol does not match the requested symbol.".to_string());
    }
    let stats = report
        .trade_statistics
        .as_ref()
        .ok_or("The report is missing its trade statistics.")?;
    let trades = report
        .trades
        .as_ref()
        .ok_or("The report is missing its trades.")?;
    let total = stats.total_trades.unwrap_or(-1);
    let wins = stats.winning_trades.unwrap_or(-1);
    let losses = stats.losing_trades.unwrap_or(-1);
    let longs = stats.long_trades.unwrap_or(-1);
    let shorts = stats.short_trades.unwrap_or(-1);
    if [total, wins, losses, longs, shorts]
        .iter()
        .any(|value| *value < 0)
        || total as usize != trades.len()
        || wins.checked_add(losses).is_none_or(|sum| sum > total)
        || longs.checked_add(shorts) != Some(total)
    {
        return Err("The report trade counts are inconsistent.".to_string());
    }
    Ok(())
}

/// Map only a fully validated original ReportWriter document to the frontend contract.
fn map_report(result: &mut ExecutionRunResult, report: &ReportRoot) {
    result.symbol = report.symbol.clone().unwrap_or_default();
    if result.strategy.is_empty() {
        result.strategy = report.strategy.clone().unwrap_or_default();
    }
    result.timeframe = report.timeframe.clone().unwrap_or_default();
    result.account = report.account.as_ref().map(account_from_report);
    result.replay = report.replay.as_ref().map(replay_from_report);
    result.trade_statistics = report.trade_statistics.as_ref().map(stats_from_report);
    result.native_report_drawdown = report
        .native_report_drawdown
        .as_ref()
        .map(native_dd_from_report);
    result.full_replay_drawdown = report.drawdown.as_ref().map(full_dd_from_report);
    result.trades = report
        .trades
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(trade_from_report)
        .collect();
    result.open_positions = report
        .open_positions
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(open_from_report)
        .collect();
}

/// Map required account metrics from a validated ReportWriter document.
fn account_from_report(account: &ReportAccount) -> ExecutionAccountSummary {
    ExecutionAccountSummary {
        currency: account.currency.clone().unwrap_or_default(),
        currency_digits: account.currency_digits.unwrap_or(0),
        starting_capital: account.starting_capital.unwrap_or(0.0),
        balance: account.balance.unwrap_or(0.0),
        equity: account.equity.unwrap_or(0.0),
        closed_net_profit: account.closed_net_profit.unwrap_or(0.0),
        open_net_profit: account.open_net_profit.unwrap_or(0.0),
        marked_to_market_net_profit: account.marked_to_market_net_profit.unwrap_or(0.0),
        marked_to_market_return_percent: account.marked_to_market_return_percent.unwrap_or(0.0),
    }
}

/// Map required replay metrics without recomputing retained engine results.
fn replay_from_report(replay: &ReportReplay) -> ExecutionReplaySummary {
    ExecutionReplaySummary {
        mode: replay.mode.clone().unwrap_or_default(),
        bar_price_mode: replay.bar_price_mode.clone(),
        input_count: replay.input_count.unwrap_or(0),
        ticks_or_synthetic_ticks: replay.ticks_or_synthetic_ticks.unwrap_or(0),
        on_bar_count: replay.on_bar_count.unwrap_or(0),
        chart_bar_count: replay.chart_bar_count.unwrap_or(0),
        hour_bar_count: replay.hour_bar_count.unwrap_or(0),
        elapsed_ms: replay.elapsed_ms.unwrap_or(0.0),
        ticks_per_second: replay.ticks_or_synthetic_ticks_per_second.unwrap_or(0.0),
        first_time_utc: value_to_string(&replay.first_time_utc),
        last_time_utc: value_to_string(&replay.last_time_utc),
    }
}

/// Map retained trade counts and derive win/loss percentages from those counts.
fn stats_from_report(stats: &ReportTradeStats) -> ExecutionTradeStatistics {
    let total_trades = stats.total_trades.unwrap_or(0);
    let winning_trades = stats.winning_trades.unwrap_or(0);
    let losing_trades = stats.losing_trades.unwrap_or(0);
    let win_rate = if total_trades > 0 {
        winning_trades as f64 / total_trades as f64 * 100.0
    } else {
        0.0
    };
    let loss_rate = if total_trades > 0 {
        losing_trades as f64 / total_trades as f64 * 100.0
    } else {
        0.0
    };
    ExecutionTradeStatistics {
        total_trades,
        winning_trades,
        losing_trades,
        long_trades: stats.long_trades.unwrap_or(0),
        short_trades: stats.short_trades.unwrap_or(0),
        gross_profit: stats.gross_profit.unwrap_or(0.0),
        gross_loss: stats.gross_loss.unwrap_or(0.0),
        commissions: stats.commissions.unwrap_or(0.0),
        swaps: stats.swaps.unwrap_or(0.0),
        net_profit: stats.net_profit.unwrap_or(0.0),
        profit_factor: stats.profit_factor,
        total_pips: stats.total_pips.unwrap_or(0.0),
        average_net_profit: stats.average_net_profit.unwrap_or(0.0),
        largest_win: stats.largest_win.unwrap_or(0.0),
        largest_loss: stats.largest_loss.unwrap_or(0.0),
        win_rate,
        loss_rate,
    }
}

/// Preserve optional native-reference drawdown metrics from the original report.
fn native_dd_from_report(native: &ReportNativeDrawdown) -> NativeReportDrawdown {
    NativeReportDrawdown {
        method: native.method.clone().unwrap_or_default(),
        equity_points: native.equity_points.unwrap_or(0),
        max_equity_drawdown: native.max_equity_drawdown.unwrap_or(0.0),
        max_equity_drawdown_percent: native.max_equity_drawdown_percent.unwrap_or(0.0),
        max_balance_drawdown: native.max_balance_drawdown.unwrap_or(0.0),
        max_balance_drawdown_percent: native.max_balance_drawdown_percent.unwrap_or(0.0),
    }
}

/// Preserve complete replay drawdown values and source timestamps.
fn full_dd_from_report(drawdown: &ReportDrawdown) -> FullReplayDrawdown {
    FullReplayDrawdown {
        equity_points: drawdown.equity_points.unwrap_or(0),
        max_balance_drawdown: drawdown.max_balance_drawdown.unwrap_or(0.0),
        max_balance_drawdown_percent: drawdown.max_balance_drawdown_percent.unwrap_or(0.0),
        max_balance_drawdown_peak_time_utc: value_to_string(
            &drawdown.max_balance_drawdown_peak_time_utc,
        ),
        max_balance_drawdown_trough_time_utc: value_to_string(
            &drawdown.max_balance_drawdown_trough_time_utc,
        ),
        max_balance_drawdown_peak: drawdown.max_balance_drawdown_peak.unwrap_or(0.0),
        max_balance_drawdown_trough: drawdown.max_balance_drawdown_trough.unwrap_or(0.0),
        max_equity_drawdown: drawdown.max_equity_drawdown.unwrap_or(0.0),
        max_equity_drawdown_percent: drawdown.max_equity_drawdown_percent.unwrap_or(0.0),
        max_equity_drawdown_peak_time_utc: value_to_string(
            &drawdown.max_equity_drawdown_peak_time_utc,
        ),
        max_equity_drawdown_trough_time_utc: value_to_string(
            &drawdown.max_equity_drawdown_trough_time_utc,
        ),
        max_equity_drawdown_peak: drawdown.max_equity_drawdown_peak.unwrap_or(0.0),
        max_equity_drawdown_trough: drawdown.max_equity_drawdown_trough.unwrap_or(0.0),
    }
}

/// Map one validated closed trade using the original writer fields.
fn trade_from_report(trade: ReportTrade) -> ExecutionTrade {
    ExecutionTrade {
        id: value_to_string(&trade.id),
        symbol: trade.symbol.unwrap_or_default(),
        label: trade.label.unwrap_or_default(),
        side: trade.side.unwrap_or_default(),
        volume_in_units: trade.volume_in_units.unwrap_or(0.0),
        entry_time_utc: value_to_string(&trade.entry_time_utc),
        entry_price: trade.entry_price.unwrap_or(0.0),
        entry_bid: trade.entry_bid.unwrap_or(0.0),
        entry_ask: trade.entry_ask.unwrap_or(0.0),
        entry_spread: trade.entry_spread.unwrap_or(0.0),
        close_time_utc: value_to_string(&trade.close_time_utc),
        close_price: trade.close_price.unwrap_or(0.0),
        close_bid: trade.close_bid.unwrap_or(0.0),
        close_ask: trade.close_ask.unwrap_or(0.0),
        close_spread: trade.close_spread.unwrap_or(0.0),
        close_reason: trade.close_reason.unwrap_or_default(),
        pips: trade.pips.unwrap_or(0.0),
        gross_profit: trade.gross_profit.unwrap_or(0.0),
        pnl_conversion_fees: trade.pnl_conversion_fees.unwrap_or(0.0),
        commissions: trade.commissions.unwrap_or(0.0),
        swaps: trade.swaps.unwrap_or(0.0),
        net_profit: trade.net_profit.unwrap_or(0.0),
        intended_risk_money: trade.intended_risk_money.unwrap_or(0.0),
        mae_net_profit: trade.mae_net_profit.unwrap_or(0.0),
        mfe_net_profit: trade.mfe_net_profit.unwrap_or(0.0),
        net_r: trade.net_r,
        economic_specification_hash: trade.economic_specification_hash.unwrap_or_default(),
    }
}

/// Map one validated open position using original valuation and economics.
fn open_from_report(position: ReportOpenPosition) -> ExecutionOpenPosition {
    ExecutionOpenPosition {
        id: value_to_string(&position.id),
        symbol: position.symbol.unwrap_or_default(),
        label: position.label.unwrap_or_default(),
        side: position.side.unwrap_or_default(),
        volume_in_units: position.volume_in_units.unwrap_or(0.0),
        entry_time_utc: value_to_string(&position.entry_time_utc),
        entry_price: position.entry_price.unwrap_or(0.0),
        valuation_time_utc: value_to_string(&position.valuation_time_utc),
        valuation_price: position.valuation_price.unwrap_or(0.0),
        age_hours: position.age_hours.unwrap_or(0.0),
        pips: position.pips.unwrap_or(0.0),
        gross_profit: position.gross_profit.unwrap_or(0.0),
        pnl_conversion_fees: position.pnl_conversion_fees.unwrap_or(0.0),
        commissions: position.commissions.unwrap_or(0.0),
        swaps: position.swaps.unwrap_or(0.0),
        net_profit: position.net_profit.unwrap_or(0.0),
        intended_risk_money: position.intended_risk_money.unwrap_or(0.0),
        mae_net_profit: position.mae_net_profit.unwrap_or(0.0),
        mfe_net_profit: position.mfe_net_profit.unwrap_or(0.0),
        net_r: position.net_r,
        economic_specification_hash: position.economic_specification_hash.unwrap_or_default(),
    }
}

/// Reject non-finite metrics across every report section and the parsed equity path.
fn report_has_nonfinite(report: &ReportRoot, equity: &[ExecutionEquityPoint]) -> bool {
    report.account.as_ref().is_some_and(account_has_nonfinite)
        || report.replay.as_ref().is_some_and(replay_has_nonfinite)
        || report
            .trade_statistics
            .as_ref()
            .is_some_and(trade_statistics_has_nonfinite)
        || report.drawdown.as_ref().is_some_and(drawdown_has_nonfinite)
        || report
            .native_report_drawdown
            .as_ref()
            .is_some_and(native_report_drawdown_has_nonfinite)
        || report
            .trades
            .as_ref()
            .is_some_and(|values| values.iter().any(trades_has_nonfinite))
        || report
            .open_positions
            .as_ref()
            .is_some_and(|values| values.iter().any(open_positions_has_nonfinite))
        || equity
            .iter()
            .any(|point| !point.balance.is_finite() || !point.equity.is_finite())
}

/// Check every floating-point account metric without defaulting an invalid value.
fn account_has_nonfinite(value: &ReportAccount) -> bool {
    !all_finite(&[
        value.starting_capital.unwrap_or(0.0),
        value.balance.unwrap_or(0.0),
        value.equity.unwrap_or(0.0),
        value.closed_net_profit.unwrap_or(0.0),
        value.open_net_profit.unwrap_or(0.0),
        value.marked_to_market_net_profit.unwrap_or(0.0),
        value.marked_to_market_return_percent.unwrap_or(0.0),
    ])
}

/// Check every floating-point replay metric without defaulting an invalid value.
fn replay_has_nonfinite(value: &ReportReplay) -> bool {
    !all_finite(&[
        value.elapsed_ms.unwrap_or(0.0),
        value.ticks_or_synthetic_ticks_per_second.unwrap_or(0.0),
    ])
}

/// Check every floating-point trade statistics metric without defaulting an invalid value.
fn trade_statistics_has_nonfinite(value: &ReportTradeStats) -> bool {
    !all_finite(&[
        value.gross_profit.unwrap_or(0.0),
        value.gross_loss.unwrap_or(0.0),
        value.commissions.unwrap_or(0.0),
        value.swaps.unwrap_or(0.0),
        value.net_profit.unwrap_or(0.0),
        value.profit_factor.unwrap_or(0.0),
        value.total_pips.unwrap_or(0.0),
        value.average_net_profit.unwrap_or(0.0),
        value.largest_win.unwrap_or(0.0),
        value.largest_loss.unwrap_or(0.0),
        value.win_rate.unwrap_or(0.0),
        value.loss_rate.unwrap_or(0.0),
    ])
}

/// Check every floating-point drawdown metric without defaulting an invalid value.
fn drawdown_has_nonfinite(value: &ReportDrawdown) -> bool {
    !all_finite(&[
        value.max_balance_drawdown.unwrap_or(0.0),
        value.max_balance_drawdown_percent.unwrap_or(0.0),
        value.max_balance_drawdown_peak.unwrap_or(0.0),
        value.max_balance_drawdown_trough.unwrap_or(0.0),
        value.max_equity_drawdown.unwrap_or(0.0),
        value.max_equity_drawdown_percent.unwrap_or(0.0),
        value.max_equity_drawdown_peak.unwrap_or(0.0),
        value.max_equity_drawdown_trough.unwrap_or(0.0),
    ])
}

/// Check every floating-point native report drawdown metric without defaulting an invalid value.
fn native_report_drawdown_has_nonfinite(value: &ReportNativeDrawdown) -> bool {
    !all_finite(&[
        value.max_equity_drawdown.unwrap_or(0.0),
        value.max_equity_drawdown_percent.unwrap_or(0.0),
        value.max_balance_drawdown.unwrap_or(0.0),
        value.max_balance_drawdown_percent.unwrap_or(0.0),
    ])
}

/// Check every floating-point trades metric without defaulting an invalid value.
fn trades_has_nonfinite(value: &ReportTrade) -> bool {
    !all_finite(&[
        value.volume_in_units.unwrap_or(0.0),
        value.entry_price.unwrap_or(0.0),
        value.entry_bid.unwrap_or(0.0),
        value.entry_ask.unwrap_or(0.0),
        value.entry_spread.unwrap_or(0.0),
        value.close_price.unwrap_or(0.0),
        value.close_bid.unwrap_or(0.0),
        value.close_ask.unwrap_or(0.0),
        value.close_spread.unwrap_or(0.0),
        value.pips.unwrap_or(0.0),
        value.gross_profit.unwrap_or(0.0),
        value.pnl_conversion_fees.unwrap_or(0.0),
        value.commissions.unwrap_or(0.0),
        value.swaps.unwrap_or(0.0),
        value.net_profit.unwrap_or(0.0),
        value.intended_risk_money.unwrap_or(0.0),
        value.mae_net_profit.unwrap_or(0.0),
        value.mfe_net_profit.unwrap_or(0.0),
        value.net_r.unwrap_or(0.0),
    ])
}

/// Check every floating-point open positions metric without defaulting an invalid value.
fn open_positions_has_nonfinite(value: &ReportOpenPosition) -> bool {
    !all_finite(&[
        value.volume_in_units.unwrap_or(0.0),
        value.entry_price.unwrap_or(0.0),
        value.valuation_price.unwrap_or(0.0),
        value.age_hours.unwrap_or(0.0),
        value.pips.unwrap_or(0.0),
        value.gross_profit.unwrap_or(0.0),
        value.pnl_conversion_fees.unwrap_or(0.0),
        value.commissions.unwrap_or(0.0),
        value.swaps.unwrap_or(0.0),
        value.net_profit.unwrap_or(0.0),
        value.intended_risk_money.unwrap_or(0.0),
        value.mae_net_profit.unwrap_or(0.0),
        value.mfe_net_profit.unwrap_or(0.0),
        value.net_r.unwrap_or(0.0),
    ])
}

/// Promote a run only after both the engine exit and complete report validation succeed.
fn finalize_report(result: &mut ExecutionRunResult, errors: &mut [String], exit_success: bool) {
    result.errors = errors.to_vec();
    result.success = exit_success
        && errors.is_empty()
        && !matches!(result.status.as_str(), "cancelled" | "timeout" | "failed");
    if !result.success {
        result.report_sha256 = None;
        result.replay_receipt_sha256 = None;
    }
    if !result.success && result.status == "completed" {
        result.status = "failed".to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn validate_request_rejects_empty_and_nonfinite() {
        let mut request = ExecutionRunRequest {
            build_artifact_path: None,
            strategy: "".to_string(),
            dataset_id: "d".to_string(),
            symbol_spec_path: "spec.json".to_string(),
            parameter_path: None,
            parameter_overrides: None,
            starting_balance: 1000.0,
            commission_usd_per_million: -1.0,
            slippage_pips: 0.0,
            spread_pips: None,
            symbol: None,
            timeframe: None,
            bar_timeframe: None,
            bar_price_mode: None,
            start_utc: None,
            end_utc: None,
            max_ticks: None,
            max_bars: None,
            write_equity_csv: true,
        };
        assert!(validate_request(&request).is_err());
        request.build_artifact_path = Some("a.dll".to_string());
        request.starting_balance = f64::NAN;
        assert!(validate_request(&request).is_err());
        request.starting_balance = 1000.0;
        request.slippage_pips = -1.0;
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn validate_artifact_rejects_outside_and_missing_receipt() {
        let base = TempDir::new().unwrap();
        let builds = base.path().join("builds");
        fs::create_dir_all(&builds).unwrap();
        let artifact = builds.join("WorkspaceCompile.dll");
        fs::write(&artifact, b"dll").unwrap();
        let error = validate_artifact(&builds, artifact.to_str().unwrap()).unwrap_err();
        assert!(error.contains("approval receipt"));
    }

    #[test]
    fn validate_artifact_accepts_valid_receipt() {
        let base = TempDir::new().unwrap();
        let builds = base.path().join("builds");
        let snap = builds.join("snap");
        fs::create_dir_all(&snap).unwrap();
        let artifact = snap.join("WorkspaceCompile.dll");
        fs::write(&artifact, b"dll").unwrap();
        fs::write(snap.join("revision.json"), r#"{"revision":"abc123"}"#).unwrap();
        let (path, revision) = validate_artifact(&builds, artifact.to_str().unwrap()).unwrap();
        assert_eq!(revision, "abc123");
        assert!(path.ends_with("WorkspaceCompile.dll"));
    }

    #[test]
    fn import_round_trip_passes_verifier() {
        let base = TempDir::new().unwrap();
        let storage = base.path().join("storage");
        let original_dir = base.path().join("original");
        fs::create_dir_all(&original_dir).unwrap();
        let source_path = original_dir.join("source.txt");
        fs::write(&source_path, b"source bytes").unwrap();
        let profile_path = original_dir.join("profile.json");
        let profile = serde_json::json!({
            "schema_version": "backtestengine.economic-symbol/v2",
            "symbol": "XAUUSD",
            "specification_source_path": "source.txt",
        });
        fs::write(
            &profile_path,
            serde_json::to_string_pretty(&profile).unwrap(),
        )
        .unwrap();

        let record =
            market_data::import_symbol_spec(&storage, profile_path.to_str().unwrap()).unwrap();
        let derived_path = std::path::PathBuf::from(&record.stored_path);
        let derived_bytes = fs::read(&derived_path).unwrap();
        let result = verify_registered_manifest(derived_path, derived_bytes);
        assert!(result.is_ok(), "{:?}", result.err());
    }

    #[test]
    fn validate_symbol_spec_requires_manifest() {
        let base = TempDir::new().unwrap();
        let storage = base.path().join("storage");
        let bundle = storage.join("symbol_specs").join("bundle-x");
        fs::create_dir_all(&bundle).unwrap();
        let profile = bundle.join("profile.json");
        fs::write(
            &profile,
            r#"{"schema_version":"backtestengine.economic-symbol/v2","symbol":"X"}"#,
        )
        .unwrap();
        // no manifest/provenance -> reject
        let result = verify_registered_manifest(profile.clone(), fs::read(&profile).unwrap());
        assert!(result.is_err());
    }

    #[test]
    fn validate_artifact_finds_receipt_at_snapshot_root() {
        // Real layout: revision.json at snapshot root, DLL under bin/Release/net10.0.
        let base = TempDir::new().unwrap();
        let builds = base.path().join("builds");
        let snap = builds.join("snap");
        let bin_dir = snap.join("bin").join("Release").join("net10.0");
        fs::create_dir_all(&bin_dir).unwrap();
        let artifact = bin_dir.join("WorkspaceCompile.dll");
        fs::write(&artifact, b"dll").unwrap();
        fs::write(snap.join("revision.json"), r#"{"revision":"real123"}"#).unwrap();
        let (path, revision) = validate_artifact(&builds, artifact.to_str().unwrap()).unwrap();
        assert_eq!(revision, "real123");
        assert!(path.ends_with("WorkspaceCompile.dll"));
    }

    #[test]
    fn parse_equity_csv_rejects_bad_rows() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("equity.csv");
        fs::write(&path, "time_utc,balance,equity\n2026-01-01T00:00:00Z,100,101\nbad,row\n2026-01-02T00:00:00Z,102,103\n").unwrap();
        assert!(parse_equity_csv(&path).is_err());
    }

    #[test]
    fn clamp_output_bounds() {
        let huge = "x".repeat(MAX_OUTPUT_CHARS * 4);
        let clamped = clamp_output(&huge);
        assert!(clamped.chars().count() < MAX_OUTPUT_CHARS + 64);
        assert!(clamped.contains("(output truncated)"));
    }

    #[test]
    fn parse_report_rejects_partial_retained_comparator_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("engines")
            .join("csharp")
            .join("tests")
            .join("fixtures")
            .join("report_comparator")
            .join("engine_one_trade.report.json");
        assert!(path.is_file(), "fixture must exist");
        let (result, errors) = parse_report(&path).unwrap();
        assert!(!result.success);
        assert!(
            !errors.is_empty(),
            "Partial comparator input must not become successful execution evidence."
        );
    }

    #[test]
    fn parse_report_accepts_zero_trade_report() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("zero.report.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&super::safety_tests::complete_report()).unwrap(),
        )
        .unwrap();
        let (result, errors) = parse_report(&path).unwrap();
        assert!(errors.is_empty(), "{errors:?}");
        assert!(result.success);
        assert_eq!(result.trades.len(), 0);
        assert_eq!(
            result.trade_statistics.as_ref().unwrap().profit_factor,
            None
        );
    }

    #[test]
    fn parse_report_rejects_nonfinite_metrics() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("bad.report.json");
        let json = r#"{
            "account": {"starting_capital":1000.0,"balance":null,"equity":1000.0},
            "trade_statistics": {"net_profit":"NaN"}
        }"#;
        // invalid because net_profit string; should fail parse or validation
        std::fs::write(&path, json).unwrap();
        let (result, errors) = parse_report(&path).unwrap();
        // either parse errors or non-finite; result not successful
        assert!(!result.success || !errors.is_empty());
    }
}

#[cfg(test)]
#[path = "execution_safety_tests.rs"]
mod safety_tests;

#[cfg(test)]
#[path = "execution_lifecycle_tests.rs"]
mod lifecycle_tests;
