//! Narrow native optimizer requests and genuine saved candidate evidence.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// One finite, typed search dimension; the retained optimizer generates the actual candidates.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OptimizationDimension {
    pub name: String,
    pub values: Vec<Value>,
}

/// User draft with catalog identities and explicit economics, never executable/input/output paths.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OptimizationRunRequest {
    pub strategy: String,
    pub dataset_id: String,
    pub symbol_spec_id: String,
    pub timeframe: String,
    pub bar_timeframe: Option<String>,
    pub bar_price_mode: Option<String>,
    pub starting_balance: f64,
    pub commission_usd_per_million: f64,
    #[serde(default)]
    pub slippage_pips: f64,
    pub spread_pips: Option<f64>,
    pub start_utc: Option<String>,
    pub end_utc: Option<String>,
    pub max_ticks: Option<i64>,
    pub max_bars: Option<i64>,
    pub base_parameters: BTreeMap<String, Value>,
    pub dimensions: Vec<OptimizationDimension>,
    pub method: String,
    pub seed: i32,
    pub max_runs: usize,
    pub max_workers: usize,
}

/// Direct source metrics plus the original optimizer's separate score inputs; no numerical recomputation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationMetrics {
    pub currency: Option<String>,
    pub net_profit: Option<f64>,
    pub marked_to_market_net_profit: Option<f64>,
    pub profit_factor: Option<f64>,
    pub optimizer_profit_factor: Option<f64>,
    pub closed_trades: Option<u64>,
    pub native_drawdown_percent: Option<f64>,
    pub native_drawdown_method: Option<String>,
    pub full_replay_drawdown_percent: Option<f64>,
    pub fitness_score: f64,
}

/// Candidate identity/status comes from actual original artifacts; failed/unproven metrics remain unavailable.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationCandidate {
    pub id: String,
    pub hash: String,
    pub status: String,
    pub error: Option<String>,
    pub parameters: BTreeMap<String, String>,
    pub metrics: Option<OptimizationMetrics>,
    pub report_json_path: Option<String>,
    pub report_sha256: Option<String>,
    pub parameter_file_path: Option<String>,
    pub elapsed_ms: Option<f64>,
}

/// Actual optimizer lifecycle result, scoped to the host project/build and its unique output directory.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationRunResult {
    pub run_id: String,
    pub project_root: String,
    pub build_revision: String,
    pub approved_artifact_sha256: String,
    pub dataset_id: String,
    pub dataset_sha256: String,
    pub symbol_spec_id: String,
    pub symbol_spec_sha256: String,
    pub config_sha256: String,
    pub strategy: String,
    pub method: String,
    pub seed: i32,
    pub budget: usize,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    pub run_folder: String,
    pub config_path: String,
    pub status: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub candidates: Vec<OptimizationCandidate>,
    pub errors: Vec<String>,
    pub output: String,
    pub last_good_preserved: bool,
    #[serde(default)]
    pub(crate) input_provenance: Option<super::capture::OptimizerCaptureProvenance>,
    #[serde(default)]
    pub(crate) compiled_runner: Option<super::capture::CompiledRunnerProvenance>,
}
