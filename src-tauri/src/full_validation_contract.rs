//! Bounded full-validation drafts and original Python scenario planning, with no filesystem paths from IPC.
use crate::{
    replay_receipt::FrozenReplayReceipt,
    validation::{self, ValidationGates, ValidationRunRequest},
};
use chrono::{DateTime, Duration, SecondsFormat, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub(crate) const MAX_SCENARIOS: usize = 64;
pub(crate) const FULL_VALIDATION_TIMEOUT_SECONDS: u64 = 600;

/// Typed user controls; every source/input/output/runtime path is selected by the native host.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FullValidationRequest {
    pub execution_run_id: String,
    pub replay_receipt_sha256: String,
    pub spread_multipliers: Vec<f64>,
    pub commission_multipliers: Vec<f64>,
    pub latency_ticks: Vec<u32>,
    pub walk_forward: WalkForwardRequest,
    pub monte_carlo_runs: u32,
    pub seed: i32,
    pub gates: Option<ValidationGates>,
}

/// Original fixed-parameter train/validation/test geometry; only test splits are backtested.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WalkForwardRequest {
    pub train_days: u32,
    pub validation_days: u32,
    pub test_days: u32,
    pub embargo_days: u32,
}

/// One expected original scenario and its exact output identity; aggregate metrics are never invented.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExpectedScenario {
    pub name: String,
    pub layer: String,
    pub relative_report_path: String,
    pub start_utc: String,
    pub end_utc: String,
    pub spread_multiplier: f64,
    pub commission_usd_per_million: f64,
    pub latency_ticks: u32,
}

/// A finite explicit plan using the retained Python expansion, not a replacement validation algorithm.
pub(crate) struct FullValidationPlan {
    pub start_utc: String,
    pub end_utc: String,
    pub scenarios: Vec<ExpectedScenario>,
    pub generated_walk_forward_windows: usize,
    pub excluded_walk_forward_windows: usize,
}

/// Check trusted baseline identity/capabilities and bound every expansion before process launch.
pub(crate) fn plan_validation(
    request: &FullValidationRequest,
    receipt: &FrozenReplayReceipt,
) -> Result<FullValidationPlan, String> {
    validate_request(request)?;
    if request.execution_run_id != receipt.execution_run_id {
        return Err("Full validation selected a different execution run.".into());
    }
    if receipt.dataset.kind != "ticks" {
        return Err("The retained full-validation latency and walk-forward workflow supports tick replay only.".into());
    }
    if receipt.build_configuration != "Release" {
        return Err(
            "Full validation cannot change the captured baseline compilation configuration.".into(),
        );
    }
    if receipt.settings.strategy.is_empty() || !safe_symbol(&receipt.settings.symbol) {
        return Err(
            "The frozen strategy/symbol identity is invalid for original scenario names.".into(),
        );
    }
    if receipt.settings.timeframe.is_empty() {
        return Err("The frozen replay lacks an explicit strategy timeframe.".into());
    }
    validate_baseline_numbers(receipt)?;
    let start = parse_boundary(receipt.settings.start_utc.as_deref())?;
    let end = parse_boundary(receipt.settings.end_utc.as_deref())?;
    if end <= start {
        return Err("The frozen replay date range is not increasing.".into());
    }
    let mut scenarios = cost_scenarios(request, receipt, start, end);
    scenarios.extend(latency_scenarios(request, receipt, start, end));
    let (walk_forward, generated) = walk_forward_scenarios(request, receipt, start, end)?;
    if walk_forward.is_empty() {
        return Err("The frozen date range contains no original walk-forward test split. No split was invented.".into());
    }
    let excluded = generated - walk_forward.len();
    scenarios.extend(walk_forward);
    if scenarios.len() > MAX_SCENARIOS {
        return Err(format!(
            "Full validation exceeds its {MAX_SCENARIOS}-scenario limit."
        ));
    }
    validate_commission_stress(request, receipt, &scenarios)?;
    Ok(FullValidationPlan {
        start_utc: utc_text(start),
        end_utc: utc_text(end),
        scenarios,
        generated_walk_forward_windows: generated,
        excluded_walk_forward_windows: excluded,
    })
}

/// Use only original rate-override semantics; minimum and rounded fees are never advertised as multiplied.
fn validate_commission_stress(
    request: &FullValidationRequest,
    receipt: &FrozenReplayReceipt,
    scenarios: &[ExpectedScenario],
) -> Result<(), String> {
    let terms = &receipt.commission_terms;
    if !original_enum(&terms.model, "UsdPerMillionUsdVolume")
        || terms.rate_currency != "USD"
        || !original_enum(&terms.side_semantics, "PerFill")
    {
        return Err("The frozen commission model/currency/side cannot map faithfully to the original Python rate-stress CLI.".into());
    }
    let changes_rate = request
        .commission_multipliers
        .iter()
        .any(|value| *value != 1.0);
    if changes_rate && receipt.settings.effective_commission_usd_per_million == 0.0 {
        return Err("Commission rate stress cannot change a zero base rate; unchanged fees are not multiplied evidence.".into());
    }
    if scenarios
        .iter()
        .any(|scenario| !scenario.commission_usd_per_million.is_finite())
        || request.commission_multipliers.iter().any(|multiplier| {
            *multiplier != 1.0
                && receipt.settings.effective_commission_usd_per_million * multiplier
                    == receipt.settings.effective_commission_usd_per_million
        })
    {
        return Err(
            "The requested commission rate multiplier is non-finite or produces no rate change."
                .into(),
        );
    }
    if terms.native_end_utc.is_some() && changes_rate {
        return Err("The native commission authority binds its original rate; rate stress requires new authentic authority.".into());
    }
    if let Some(end) = &terms.native_end_utc {
        let end = DateTime::parse_from_rfc3339(end)
            .map_err(|_| "The captured native commission end date is malformed.")?
            .with_timezone(&Utc)
            .date_naive()
            .succ_opt()
            .ok_or("The captured native commission end date overflowed.")?;
        let exclusive = DateTime::<Utc>::from_naive_utc_and_offset(
            end.and_hms_opt(0, 0, 0)
                .ok_or("The native commission end date is invalid.")?,
            Utc,
        );
        if scenarios
            .iter()
            .any(|scenario| scenario.end_utc != utc_text(exclusive))
        {
            return Err("A planned walk-forward/end boundary differs from the authentic commission capture's required exclusive end date.".into());
        }
    }
    Ok(())
}

/// Match the retained enum parser's underscore/case normalization without inventing model aliases.
fn original_enum(actual: &str, expected: &str) -> bool {
    actual.replace('_', "").eq_ignore_ascii_case(expected)
}

/// Reject malformed identity, duplicated axis values and excessive Monte Carlo/scenario requests.
pub(crate) fn validate_request(request: &FullValidationRequest) -> Result<(), String> {
    if request.execution_run_id.is_empty() || request.execution_run_id.len() > 128 {
        return Err("Full validation execution identity is invalid.".into());
    }
    if request.replay_receipt_sha256.len() != 64
        || !request
            .replay_receipt_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Full validation requires a host-captured lowercase receipt SHA-256.".into());
    }
    validate_axis(&request.spread_multipliers)?;
    validate_axis(&request.commission_multipliers)?;
    let latency: BTreeSet<_> = request.latency_ticks.iter().copied().collect();
    if latency.is_empty()
        || latency.len() != request.latency_ticks.len()
        || latency.len() > 8
        || latency.iter().any(|value| !(1..=1000).contains(value))
    {
        return Err("Latency requires 1–8 distinct delays of 1–1000 ticks.".into());
    }
    if !(1..=10000).contains(&request.monte_carlo_runs) || request.seed < 0 {
        return Err("Full validation Monte Carlo count/seed exceeds its limits.".into());
    }
    let wf = &request.walk_forward;
    if [wf.train_days, wf.validation_days, wf.test_days]
        .iter()
        .any(|value| !(1..=3650).contains(value))
        || wf.embargo_days > 365
    {
        return Err("Walk-forward day counts exceed their positive bounded contract.".into());
    }
    validation::validate_request(&ValidationRunRequest {
        run_id: request.execution_run_id.clone(),
        monte_carlo_runs: Some(i64::from(request.monte_carlo_runs)),
        seed: Some(i64::from(request.seed)),
        gates: request.gates.clone(),
    })
}

/// Limit floating axes to a safe finite range with collision-free original Python scenario identifiers.
fn validate_axis(values: &[f64]) -> Result<(), String> {
    let unique: BTreeSet<_> = values.iter().map(|value| value.to_bits()).collect();
    if values.is_empty()
        || values.len() > 8
        || unique.len() != values.len()
        || values
            .iter()
            .any(|value| !value.is_finite() || !(0.1..=10.0).contains(value))
    {
        return Err("Cost axes require 1–8 distinct finite multipliers between 0.1 and 10.".into());
    }
    Ok(())
}

/// Reject absent economics instead of replacing them with Python's unrelated default balance/costs.
fn validate_baseline_numbers(receipt: &FrozenReplayReceipt) -> Result<(), String> {
    let settings = &receipt.settings;
    if !settings.starting_balance.is_finite()
        || settings.starting_balance <= 0.0
        || !settings.slippage_pips.is_finite()
        || settings.slippage_pips < 0.0
        || !settings.effective_commission_usd_per_million.is_finite()
        || settings.effective_commission_usd_per_million < 0.0
    {
        return Err(
            "The frozen replay lacks valid effective balance/slippage/commission settings.".into(),
        );
    }
    if settings
        .spread_pips
        .is_some_and(|value| !value.is_finite() || value < 0.0)
    {
        return Err("The frozen replay fixed spread is invalid.".into());
    }
    if settings
        .max_ticks
        .is_some_and(|value| value < 0 || value > i64::from(i32::MAX))
    {
        return Err("The frozen max-tick limit is outside the original CLI integer range.".into());
    }
    Ok(())
}

/// Require captured explicit whole-second dates; current report timestamps cannot reconstruct a request.
fn parse_boundary(value: Option<&str>) -> Result<DateTime<Utc>, String> {
    let parsed = DateTime::parse_from_rfc3339(value.ok_or("Full validation requires explicit original start/end dates captured in its replay receipt.")?).map_err(|_| "The frozen replay date is malformed.")?.with_timezone(&Utc);
    if parsed.nanosecond() != 0 {
        return Err(
            "Full validation currently requires original whole-second date boundaries.".into(),
        );
    }
    Ok(parsed)
}

/// Keep original names filesystem-safe without weakening canonical selected-project authority.
fn safe_symbol(symbol: &str) -> bool {
    !symbol.is_empty()
        && symbol.len() <= 64
        && symbol
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        && symbol != "."
        && symbol != ".."
}

/// Match Python float names within the finite bounded axes, including its `.0` suffix for integral floats.
fn python_float_name(value: f64) -> String {
    let text = value.to_string();
    let text = if text.contains('.') {
        text
    } else {
        format!("{text}.0")
    };
    text.replace('.', "_")
}

/// Expand the original cost Cartesian product for one captured symbol and data window.
fn cost_scenarios(
    request: &FullValidationRequest,
    receipt: &FrozenReplayReceipt,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Vec<ExpectedScenario> {
    let mut scenarios = Vec::new();
    for spread in &request.spread_multipliers {
        scenarios.extend(request.commission_multipliers.iter().map(|commission| {
            scenario(
                format!(
                    "{}_baseline_spread{}x_commission{}x",
                    receipt.settings.symbol,
                    python_float_name(*spread),
                    python_float_name(*commission)
                ),
                "Reports",
                start,
                end,
                *spread,
                receipt.settings.effective_commission_usd_per_million * commission,
                0,
            )
        }));
    }
    scenarios
}

/// Expand one original engine latency scenario per requested positive delay.
fn latency_scenarios(
    request: &FullValidationRequest,
    receipt: &FrozenReplayReceipt,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Vec<ExpectedScenario> {
    request
        .latency_ticks
        .iter()
        .map(|ticks| {
            scenario(
                format!("{}_baseline_latency{ticks}ticks", receipt.settings.symbol),
                "LatencyStress",
                start,
                end,
                1.0,
                receipt.settings.effective_commission_usd_per_million,
                *ticks,
            )
        })
        .collect()
}

/// Mirror original day geometry and containment filtering; do not add training or invent missing splits.
fn walk_forward_scenarios(
    request: &FullValidationRequest,
    receipt: &FrozenReplayReceipt,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<(Vec<ExpectedScenario>, usize), String> {
    let wf = &request.walk_forward;
    let step = i64::from(wf.validation_days) + i64::from(wf.test_days);
    let count = (end - start).num_days() / step;
    if count > MAX_SCENARIOS as i64 {
        return Err("Walk-forward planned window count exceeds its limit.".into());
    }
    let mut scenarios = Vec::new();
    for index in 0..count {
        let test_start = start
            .checked_add_signed(Duration::days(
                index * step
                    + i64::from(wf.train_days)
                    + i64::from(wf.validation_days)
                    + 2 * i64::from(wf.embargo_days),
            ))
            .ok_or("Walk-forward date arithmetic overflowed.")?;
        let test_end = test_start
            .checked_add_signed(Duration::days(i64::from(wf.test_days)))
            .ok_or("Walk-forward date arithmetic overflowed.")?;
        if test_end <= end {
            scenarios.push(scenario(
                format!("{}_wf{index:03}_test", receipt.settings.symbol),
                "WalkForward",
                test_start,
                test_end,
                1.0,
                receipt.settings.effective_commission_usd_per_million,
                0,
            ));
        }
    }
    Ok((scenarios, count as usize))
}

/// Build one strict output identity; the original Python engine still performs all replay/validation calculations.
fn scenario(
    name: String,
    layer: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    spread: f64,
    commission: f64,
    latency: u32,
) -> ExpectedScenario {
    ExpectedScenario {
        relative_report_path: format!("validation/{layer}/{name}/report.json"),
        name,
        layer: layer.into(),
        start_utc: utc_text(start),
        end_utc: utc_text(end),
        spread_multiplier: spread,
        commission_usd_per_million: commission,
        latency_ticks: latency,
    }
}

/// Emit original Python-compatible whole-second UTC strings so its containment comparisons remain truthful.
fn utc_text(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}
