"""Command line interface for ValidationEngine.

Definition:
    Plans or runs validation scenarios, combines reports, runs Monte Carlo, and writes final artifacts.

Inputs example:
    python -m ValidationEngine.Cli --config ValidationEngine/Configs/XauTickValidation.example.json --dry-run

Expected output:
    A validation run folder under the configured OutputRoot.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from ValidationEngine.BacktestRunner import BacktestRunResult, run_scenario
from ValidationEngine.Config import ValidationConfig, load_config
from ValidationEngine.Gates.Gates import deterministic_checks, monte_carlo_checks
from ValidationEngine.Gates.Verdict import build_verdict
from ValidationEngine.MonteCarlo.TradeLedgerMonteCarlo import MonteCarloResult, run_monte_carlo
from ValidationEngine.ReportBuilder import to_jsonable, write_validation_outputs
from ValidationEngine.Reports.BacktestReport import BacktestReport, load_backtest_report
from ValidationEngine.Reports.CombinedReport import CombinedReport, combine_reports
from ValidationEngine.Reports.TradeLedger import write_trades_csv
from ValidationEngine.Robustness.LatencyStress import build_latency_scenarios
from ValidationEngine.Robustness.ScenarioMatrix import build_scenarios
from ValidationEngine.WalkForward.WalkForwardBacktests import build_walk_forward_backtest_scenarios
from ValidationEngine.WalkForward.WalkForwardEmbargo import validate_embargo
from ValidationEngine.WalkForward.WindowBuilder import build_walk_forward_windows


def main() -> None:
    """Run the ValidationEngine CLI.

    Definition:
        Parses CLI arguments and executes the validation workflow.

    Inputs example:
        main()

    Expected output:
        Files written to the configured validation output folder.
    """

    args = parse_args()
    config = load_config(args.config)
    payload = run_validation(config, args.dry_run)
    output_dir = config.output_root / config.run_name
    write_validation_outputs(output_dir, payload)
    print(output_dir / "FinalReport.md")


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments.

    Definition:
        Reads config and dry-run flags from command line arguments.

    Inputs example:
        parse_args()

    Expected output:
        argparse.Namespace with config and dry_run attributes.
    """

    parser = argparse.ArgumentParser(description="Run strategy validation.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def run_validation(config: ValidationConfig, dry_run: bool) -> dict[str, Any]:
    """Run a validation workflow.

    Definition:
        Plans scenarios, runs optional backtests, parses reports, runs Monte Carlo, and builds a payload.

    Inputs example:
        run_validation(config, dry_run=True)

    Expected output:
        A JSON-safe payload dictionary.
    """

    walk_forward = build_walk_forward_windows(config.walk_forward)
    scenarios = build_scenarios(config)
    latency_scenarios = build_latency_scenarios(config)
    walk_forward_scenarios = build_walk_forward_backtest_scenarios(config, walk_forward)
    run_results = run_scenarios(config, scenarios, dry_run)
    latency_results = run_scenarios(config, latency_scenarios, dry_run)
    walk_forward_results = run_scenarios(config, walk_forward_scenarios, dry_run)
    reports = load_available_reports(config, run_results)
    latency_reports = load_available_reports(config, latency_results)
    walk_forward_reports = load_available_reports(config, walk_forward_results)
    combined = combine_reports(reports) if reports else None
    latency_combined = combine_reports(latency_reports) if latency_reports else None
    walk_forward_combined = combine_reports(walk_forward_reports) if walk_forward_reports else None
    monte_carlo_source = reports[0] if reports else None
    monte_carlo = (
        run_monte_carlo(monte_carlo_source.trades, config.monte_carlo, config.gates)
        if monte_carlo_source and monte_carlo_source.trades
        else None
    )
    output_combined_artifacts(config, combined)
    missing = missing_evidence(run_results, reports, monte_carlo, latency_results, latency_reports, walk_forward_results, walk_forward_reports)
    verdict = build_final_verdict(config, combined, monte_carlo, missing, latency_combined, walk_forward_combined)
    return build_payload(
        config,
        run_results,
        latency_results,
        walk_forward_results,
        combined,
        latency_combined,
        walk_forward_combined,
        monte_carlo,
        monte_carlo_source,
        verdict,
        walk_forward,
    )


def run_scenarios(config: ValidationConfig, scenarios: list[Any], dry_run: bool) -> list[BacktestRunResult]:
    """Run a list of BacktestEngine scenarios.

    Definition:
        Executes or plans each scenario according to config and dry-run settings.

    Inputs example:
        run_scenarios(config, scenarios, dry_run=False)

    Expected output:
        A list of BacktestRunResult objects.
    """

    effective_dry_run = dry_run or not config.run_backtests
    if config.max_workers <= 1:
        return [run_scenario(config, scenario, effective_dry_run) for scenario in scenarios]
    with ThreadPoolExecutor(max_workers=config.max_workers) as pool:
        return list(pool.map(lambda scenario: run_scenario(config, scenario, effective_dry_run), scenarios))


def load_available_reports(config: ValidationConfig, run_results: list[BacktestRunResult]) -> list[BacktestReport]:
    """Load available report files.

    Definition:
        Reads existing report paths plus reports produced by completed scenarios.

    Inputs example:
        load_available_reports(config, run_results)

    Expected output:
        A list of BacktestReport objects.
    """

    paths = config.existing_reports + [result.report_path for result in run_results if result.report_path.exists()]
    return [load_backtest_report(path) for path in paths if path.exists()]


def output_combined_artifacts(config: ValidationConfig, combined: CombinedReport | None) -> None:
    """Write combined trade artifacts when available.

    Definition:
        Writes CombinedTrades.csv only when reports produced trades.

    Inputs example:
        output_combined_artifacts(config, combined)

    Expected output:
        A combined trade CSV or no file when no trades exist.
    """

    if combined is None:
        return
    write_trades_csv(config.output_root / config.run_name / "CombinedTrades.csv", combined.trades)


def missing_evidence(
    run_results: list[BacktestRunResult],
    reports: list[BacktestReport],
    monte_carlo: MonteCarloResult | None,
    latency_results: list[BacktestRunResult],
    latency_reports: list[BacktestReport],
    walk_forward_results: list[BacktestRunResult],
    walk_forward_reports: list[BacktestReport],
) -> list[str]:
    """List missing or unproven validation evidence.

    Definition:
        Tracks planned-only runs, missing BacktestEngine reports, and missing Monte Carlo output.

    Inputs example:
        missing_evidence(run_results, [], None)

    Expected output:
        A list of evidence labels.
    """

    missing = []
    missing.extend(["backtest_engine_execution"] if any(result.status != "completed" for result in run_results) else [])
    missing.extend(["backtest_reports"] if not reports else [])
    missing.extend(["trade_ledger_monte_carlo"] if monte_carlo is None else [])
    missing.extend(["engine_level_latency_stress"] if missing_layer(latency_results, latency_reports) else [])
    missing.extend(["walk_forward_embargo_backtests"] if missing_layer(walk_forward_results, walk_forward_reports) else [])
    return missing


def missing_layer(results: list[BacktestRunResult], reports: list[BacktestReport]) -> bool:
    """Return whether a validation layer is missing executed evidence.

    Definition:
        Treats an empty layer, failed run, planned run, or missing report as missing.

    Inputs example:
        missing_layer(results, reports)

    Expected output:
        True when the layer cannot support a verdict.
    """

    if not results or not reports:
        return True
    return any(result.status != "completed" for result in results)


def build_final_verdict(
    config: ValidationConfig,
    combined: CombinedReport | None,
    monte_carlo: MonteCarloResult | None,
    missing: list[str],
    latency_combined: CombinedReport | None,
    walk_forward_combined: CombinedReport | None,
) -> dict[str, str | list[str]]:
    """Build the final validation verdict.

    Definition:
        Applies deterministic and Monte Carlo checks when evidence exists.

    Inputs example:
        build_final_verdict(config, combined, monte_carlo, missing)

    Expected output:
        A verdict dictionary.
    """

    deterministic = deterministic_checks(combined, config.gates) if combined else {}
    monte_carlo_result = monte_carlo_checks(monte_carlo.summary, config.gates) if monte_carlo else {}
    robustness = robustness_checks(config, latency_combined, walk_forward_combined)
    return build_verdict(deterministic, monte_carlo_result, robustness, missing)


def robustness_checks(
    config: ValidationConfig,
    latency_combined: CombinedReport | None,
    walk_forward_combined: CombinedReport | None,
) -> dict[str, bool]:
    """Build robustness pass/fail checks.

    Definition:
        Checks latency-stress and walk-forward aggregate profitability when available.

    Inputs example:
        robustness_checks(config, latency_combined, walk_forward_combined)

    Expected output:
        A dictionary of robustness gates.
    """

    checks: dict[str, bool] = {}
    if latency_combined is not None:
        checks["latency_net_positive"] = latency_combined.net_profit > 0.0
        checks["latency_profit_factor"] = latency_combined.profit_factor >= config.gates.min_profit_factor
    if walk_forward_combined is not None:
        checks["walk_forward_net_positive"] = walk_forward_combined.net_profit > 0.0
        checks["walk_forward_profit_factor"] = walk_forward_combined.profit_factor >= config.gates.min_profit_factor
    return checks


def build_payload(
    config: ValidationConfig,
    run_results: list[BacktestRunResult],
    latency_results: list[BacktestRunResult],
    walk_forward_results: list[BacktestRunResult],
    combined: CombinedReport | None,
    latency_combined: CombinedReport | None,
    walk_forward_combined: CombinedReport | None,
    monte_carlo: MonteCarloResult | None,
    monte_carlo_source: BacktestReport | None,
    verdict: dict[str, str | list[str]],
    walk_forward: list[Any],
) -> dict[str, Any]:
    """Build final output payload.

    Definition:
        Creates a JSON-safe dictionary containing run metadata and results.

    Inputs example:
        build_payload(config, run_results, combined, monte_carlo, verdict)

    Expected output:
        A dictionary ready for JSON and Markdown writers.
    """

    embargo = [validate_embargo(window, config.walk_forward.embargo_days) for window in walk_forward]
    return {
        "run_name": config.run_name,
        "strategy": config.strategy,
        "parameter_file": str(config.parameter_file),
        "run_results": to_jsonable(run_results),
        "latency_results": to_jsonable(latency_results),
        "walk_forward_results": to_jsonable(walk_forward_results),
        "combined_report": to_jsonable(combined) if combined else None,
        "latency_report": to_jsonable(latency_combined) if latency_combined else None,
        "walk_forward_report": to_jsonable(walk_forward_combined) if walk_forward_combined else None,
        "monte_carlo": to_jsonable(monte_carlo) if monte_carlo else None,
        "monte_carlo_source_report": str(monte_carlo_source.path) if monte_carlo_source else None,
        "walk_forward_windows": to_jsonable(walk_forward),
        "walk_forward_embargo": embargo,
        "verdict": verdict,
    }


if __name__ == "__main__":
    main()
