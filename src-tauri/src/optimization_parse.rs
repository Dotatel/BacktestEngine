//! Adapt genuine original optimizer artifacts; never score candidates or invent missing source metrics.
use super::binding;
use super::contract::{OptimizationCandidate, OptimizationMetrics};
use crate::{execution, market_data::read_limited_bytes};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;

/// The retained optimizer's result collection; missing records are not defaulted into successful candidates.
#[derive(Deserialize)]
struct OptimizerResults {
    results: Vec<RawCandidate>,
}

/// Minimal original candidate schema required to bind saved output and parameters to its actual source folder.
#[derive(Deserialize, PartialEq)]
struct RawCandidate {
    id: String,
    hash: String,
    status: String,
    error: String,
    parameters: BTreeMap<String, String>,
    report_path: String,
    parameter_file_path: String,
    fitness_score: f64,
    elapsed_ms: f64,
    metrics: Value,
}

/// Read bounded results only from this unique job output, rejecting duplicate or excessive candidate identities.
pub(super) fn read_candidates(
    output: &Path,
    budget: usize,
    strategy: &str,
    symbol: &str,
    bindings: Result<&binding::Receipt, &str>,
) -> Result<Vec<OptimizationCandidate>, String> {
    let output = owned_output(output)?;
    let path = owned_file(
        &output,
        &output.join("results.json").to_string_lossy(),
        "results.json",
    )?;
    let bytes = read_limited_bytes(&path, MAX_ARTIFACT_BYTES)?;
    if let Ok(receipt) = bindings {
        binding::verify_results(&bytes, receipt)?;
    }
    let raw: OptimizerResults = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Optimizer results are malformed ({error})."))?;
    if raw.results.is_empty() || raw.results.len() > budget {
        return Err("Optimizer candidate count is empty or exceeds the frozen budget.".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut candidates = Vec::new();
    for item in raw.results {
        if !seen.insert(item.id.clone()) {
            return Err("Optimizer results contain duplicate candidate identities.".into());
        }
        candidates.push(adapt_candidate(&output, item, strategy, symbol, bindings)?);
    }
    Ok(candidates)
}

/// Read only genuine persisted candidate states after interruption; unstarted work has no invented rows.
pub(super) fn read_partial_candidates(
    output: &Path,
    budget: usize,
    strategy: &str,
    symbol: &str,
    bindings: Result<&binding::Receipt, &str>,
) -> Result<Vec<OptimizationCandidate>, String> {
    if !output.exists() {
        return Ok(Vec::new());
    }
    let output = owned_output(output)?;
    if let Ok(receipt) = bindings {
        binding::verify_results_presence(&output, receipt)?;
        binding::verify_candidate_presence(&output, receipt)?;
    }
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(&output).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if !path.is_dir() || !path.join("candidate_result.json").exists() {
            continue;
        }
        if candidates.len() >= budget {
            return Err("Partial candidate records exceed the frozen budget.".into());
        }
        let folder = path.canonicalize().map_err(|error| error.to_string())?;
        if folder != path {
            return Err("Partial candidate folder is redirected.".into());
        }
        let source = owned_file(
            &folder,
            &folder.join("candidate_result.json").to_string_lossy(),
            "candidate_result.json",
        )?;
        let bytes = partial_result_bytes(&output, &folder, &source, bindings)?;
        let item: RawCandidate = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Partial optimizer candidate is malformed ({error})."))?;
        if folder != output.join(format!("{}_{}", item.id, item.hash)) {
            return Err("Partial candidate record does not match its folder identity.".into());
        }
        candidates.push(adapt_candidate(&output, item, strategy, symbol, bindings)?);
    }
    candidates.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(candidates)
}

/// Authenticate a partial record from its directory identity before parsing; absent authentication grants no numeric trust.
fn partial_result_bytes(
    output: &Path,
    folder: &Path,
    source: &Path,
    bindings: Result<&binding::Receipt, &str>,
) -> Result<Vec<u8>, String> {
    let Some(receipt) = bindings.ok() else {
        return read_limited_bytes(source, MAX_ARTIFACT_BYTES);
    };
    let name = folder
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Partial candidate folder has no valid name.")?;
    let (id, hash) = name
        .rsplit_once('_')
        .ok_or("Partial candidate folder identity is malformed.")?;
    if !valid_candidate_id(id)
        || hash.len() != 16
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Partial candidate folder identity is malformed.".into());
    }
    binding::candidate_result(output, receipt, id, hash)
}

/// Keep the top-level output in its exact native parent, rejecting reparse redirection before JSON reads.
fn owned_output(output: &Path) -> Result<PathBuf, String> {
    let canonical = output.canonicalize().map_err(|error| error.to_string())?;
    let parent = output
        .parent()
        .ok_or("Optimizer output has no native parent.")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let name = output.file_name().ok_or("Optimizer output has no name.")?;
    if canonical != parent.join(name) {
        return Err("Optimizer output folder is redirected.".into());
    }
    Ok(canonical)
}

/// Keep genuine failures, and mark unverifiable completed artifacts unproven without exposing zero placeholders.
fn adapt_candidate(
    output: &Path,
    item: RawCandidate,
    strategy: &str,
    symbol: &str,
    bindings: Result<&binding::Receipt, &str>,
) -> Result<OptimizationCandidate, String> {
    if !valid_candidate_id(&item.id)
        || item.hash.len() != 16
        || !item.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Optimizer candidate identity is malformed.".into());
    }
    if !item.fitness_score.is_finite() || !item.elapsed_ms.is_finite() || item.elapsed_ms < 0.0 {
        return Err("Optimizer candidate contains non-finite or invalid process metrics.".into());
    }
    if item.parameters.len() > 256
        || item
            .parameters
            .iter()
            .any(|(name, value)| name.len() > 256 || value.len() > 2048)
    {
        return Err("Optimizer candidate parameters exceed their bounds.".into());
    }
    let mut candidate = OptimizationCandidate {
        id: item.id.clone(),
        hash: item.hash.clone(),
        status: "unproven".into(),
        error: None,
        parameters: BTreeMap::new(),
        metrics: None,
        report_json_path: None,
        report_sha256: None,
        parameter_file_path: None,
        elapsed_ms: None,
    };
    let receipt = match authenticate_record(output, &item, bindings) {
        Ok(receipt) => receipt,
        Err(error) => {
            candidate.error = Some(error);
            return Ok(candidate);
        }
    };
    candidate.parameters = item.parameters.clone();
    candidate.elapsed_ms = Some(item.elapsed_ms);
    if item.status == "failed" {
        candidate.status = "failed".into();
        candidate.error = Some(item.error);
        return Ok(candidate);
    }
    if item.status != "completed" {
        candidate.status = "unproven".into();
        candidate.error = Some("The original candidate has no completed acceptance record.".into());
        return Ok(candidate);
    }
    let accepted = accept_candidate_source(output, &item, strategy, symbol, receipt);
    match accepted {
        Ok((metrics, report, hash, preset)) => {
            candidate.status = "completed".into();
            candidate.metrics = Some(metrics);
            candidate.report_json_path = Some(report);
            candidate.report_sha256 = Some(hash);
            candidate.parameter_file_path = Some(preset);
        }
        Err(error) => {
            candidate.status = "unproven".into();
            candidate.error = Some(error);
        }
    }
    Ok(candidate)
}

/// Aggregate and per-candidate state must both be host-authenticated and agree before any original numeric value is exposed.
fn authenticate_record<'a>(
    output: &Path,
    item: &RawCandidate,
    bindings: Result<&'a binding::Receipt, &str>,
) -> Result<&'a binding::Receipt, String> {
    let receipt = bindings.map_err(str::to_owned)?;
    let bytes = binding::candidate_result(output, receipt, &item.id, &item.hash)?;
    let recorded: RawCandidate = serde_json::from_slice(&bytes)
        .map_err(|_| "The authenticated candidate result is malformed.")?;
    let bound = binding::candidate(receipt, &item.id, &item.hash)?;
    if recorded != *item || item.parameters != bound.parameters {
        return Err("Candidate result differs from its authenticated aggregate or original generator receipt.".into());
    }
    Ok(receipt)
}

/// Require the original report, preset and strict execution parser before accepting any completed metrics.
fn accept_candidate_source(
    output: &Path,
    item: &RawCandidate,
    strategy: &str,
    symbol: &str,
    bindings: &binding::Receipt,
) -> Result<(OptimizationMetrics, String, String, String), String> {
    let output = output.canonicalize().map_err(|error| error.to_string())?;
    let folder = output.join(format!("{}_{}", item.id, item.hash));
    let canonical = folder
        .canonicalize()
        .map_err(|error| format!("Candidate source folder is missing ({error})."))?;
    if canonical != folder {
        return Err("Candidate source folder is redirected.".into());
    }
    let report = owned_file(&canonical, &item.report_path, "report.json")?;
    let preset = owned_file(&canonical, &item.parameter_file_path, "candidate.cbotset")?;
    let bound = binding::candidate(bindings, &item.id, &item.hash)?;
    if item.parameters != bound.parameters {
        return Err("Candidate parameters differ from the original generator receipt.".into());
    }
    let preset_bytes = read_limited_bytes(&preset, binding::PRESET_LIMIT)?;
    binding::verify_bytes(&preset_bytes, bound.preset_sha256.as_deref(), "preset")?;
    let applied = binding::validate_preset(&preset_bytes, bindings, bound)?;
    let replay_preset = owned_file(
        &canonical,
        &canonical.join("parameters.cbotset").to_string_lossy(),
        "parameters.cbotset",
    )?;
    let replay_bytes = read_limited_bytes(&replay_preset, binding::PRESET_LIMIT)?;
    binding::verify_bytes(
        &replay_bytes,
        bound.replay_preset_sha256.as_deref(),
        "replay preset",
    )?;
    binding::validate_preset(&replay_bytes, bindings, bound)?;
    let bytes = read_limited_bytes(&report, MAX_ARTIFACT_BYTES)?;
    binding::verify_bytes(&bytes, bound.report_sha256.as_deref(), "report")?;
    let source: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let source_preset = source
        .get("parameter_file")
        .and_then(Value::as_str)
        .ok_or("Candidate report lacks its actual parameter-file identity.")?;
    if owned_file(&canonical, source_preset, "parameters.cbotset")? != replay_preset
        || source.get("parameter_overrides").and_then(Value::as_u64)
            != Some((applied + bound.parameters.len()) as u64)
    {
        return Err("Candidate report parameter source/applied count does not match the original preset and CLI overrides.".into());
    }
    if !source
        .get("parameter_unknown")
        .and_then(Value::as_array)
        .is_some_and(|values| values.is_empty())
    {
        return Err("The source report lacks an empty accepted-parameter record.".into());
    }
    let (parsed, errors) = execution::parse_report(&report)?;
    if !parsed.success || !errors.is_empty() {
        return Err(format!(
            "Candidate report did not pass strict source validation: {}",
            errors.join(" ")
        ));
    }
    if parsed.strategy != strategy || !parsed.symbol.eq_ignore_ascii_case(symbol) {
        return Err("Candidate report does not match the frozen strategy or symbol.".into());
    }
    let hash = format!("{:x}", Sha256::digest(bytes));
    if parsed.report_sha256.as_deref() != Some(hash.as_str()) {
        return Err("Candidate report changed while it was being read.".into());
    }
    let metrics = metrics_from_source(&source, &item.metrics, item.fitness_score)?;
    Ok((
        metrics,
        report.to_string_lossy().into_owned(),
        hash,
        preset.to_string_lossy().into_owned(),
    ))
}

/// Keep an artifact path in the exact candidate folder and reject canonical redirection.
fn owned_file(folder: &Path, value: &str, name: &str) -> Result<PathBuf, String> {
    let path = Path::new(value)
        .canonicalize()
        .map_err(|error| format!("Candidate {name} is missing ({error})."))?;
    if path != folder.join(name) {
        return Err(format!("Candidate {name} is outside its owned folder."));
    }
    Ok(path)
}

/// Associate direct source fields with the separate original scoring inputs without recomputation.
fn metrics_from_source(
    source: &Value,
    optimizer: &Value,
    score: f64,
) -> Result<OptimizationMetrics, String> {
    Ok(OptimizationMetrics {
        currency: source
            .pointer("/account/currency")
            .and_then(Value::as_str)
            .map(str::to_owned),
        net_profit: source_number(source, "/trade_statistics/net_profit")?,
        marked_to_market_net_profit: source_number(source, "/account/marked_to_market_net_profit")?,
        profit_factor: source_number(source, "/trade_statistics/profit_factor")?,
        optimizer_profit_factor: source_number(optimizer, "/profit_factor")?,
        closed_trades: source
            .pointer("/trade_statistics/total_trades")
            .and_then(Value::as_u64),
        native_drawdown_percent: source_number(
            source,
            "/native_report_drawdown/max_equity_drawdown_percent",
        )?,
        native_drawdown_method: source
            .pointer("/native_report_drawdown/method")
            .and_then(Value::as_str)
            .map(str::to_owned),
        full_replay_drawdown_percent: source_number(
            source,
            "/drawdown/max_equity_drawdown_percent",
        )?,
        fitness_score: score,
    })
}

/// Preserve undefined numeric source values; reject values that would be silently coerced into a number.
fn source_number(source: &Value, path: &str) -> Result<Option<f64>, String> {
    let value = source.pointer(path).unwrap_or(&Value::Null);
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_f64()
        .filter(|number| number.is_finite())
        .map(Some)
        .ok_or_else(|| format!("Candidate metric {path} is not finite numeric source data."))
}

/// Require the original bounded generated candidate naming convention before using directory identities.
fn valid_candidate_id(value: &str) -> bool {
    value
        .strip_prefix("candidate_")
        .is_some_and(|suffix| suffix.len() == 6 && suffix.bytes().all(|byte| byte.is_ascii_digit()))
}
