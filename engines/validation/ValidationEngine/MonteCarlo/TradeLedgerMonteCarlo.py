"""Trade-ledger Monte Carlo runner.

Definition:
    Runs shuffle, bootstrap, missed-trade, execution-noise, and combined-stress simulations.

Inputs example:
    result = run_monte_carlo(trades, config.monte_carlo, config.gates)

Expected output:
    MonteCarloResult containing distributions, method summaries, and concentration metrics.
"""

from __future__ import annotations

from dataclasses import dataclass
import random
from typing import Any

from ValidationEngine.Config import GateConfig, MonteCarloConfig
from ValidationEngine.MonteCarlo.Concentration import concentration_summary
from ValidationEngine.MonteCarlo.Perturbations import (
    apply_execution_noise,
    apply_mask,
    bootstrap_values,
    choose_skip_rate,
    shuffle_values,
    skip_times,
)
from ValidationEngine.MonteCarlo.Survivability import path_metrics, percentile, survives
from ValidationEngine.Reports.TradeLedger import Trade, close_times, economic_baskets, median_net_per_pip, net_profits


@dataclass(frozen=True)
class MonteCarloResult:
    """Trade-ledger Monte Carlo result.

    Definition:
        Stores row-level distributions, per-method summary, and concentration metrics.

    Inputs example:
        MonteCarloResult(distributions=[], summary=[], concentration={})

    Expected output:
        Immutable Monte Carlo result for final reports.
    """

    distributions: list[dict[str, Any]]
    summary: list[dict[str, Any]]
    concentration: dict[str, Any]


def run_monte_carlo(
    trades: list[Trade],
    settings: MonteCarloConfig,
    gates: GateConfig,
) -> MonteCarloResult:
    """Run trade-ledger Monte Carlo.

    Definition:
        Simulates multiple stressed trade paths and summarizes survivability.

    Inputs example:
        run_monte_carlo(trades, monte_carlo_config, gate_config)

    Expected output:
        A MonteCarloResult object.
    """

    trades = economic_baskets(trades)
    values = net_profits(trades)
    times = close_times(trades)
    rng = random.Random(settings.seed)
    distributions = build_distributions(values, times, trades, settings, gates, rng)
    return MonteCarloResult(
        distributions=distributions,
        summary=summarize_methods(distributions, gates),
        concentration=concentration_summary(trades, settings.balance),
    )


def build_distributions(
    values: list[float],
    times: list[str],
    trades: list[Trade],
    settings: MonteCarloConfig,
    gates: GateConfig,
    rng: random.Random,
) -> list[dict[str, Any]]:
    """Build Monte Carlo distribution rows.

    Definition:
        Runs all configured perturbation methods for the requested number of simulations.

    Inputs example:
        build_distributions(values, times, trades, settings, gates, random.Random(42))

    Expected output:
        A list of row dictionaries.
    """

    output: list[dict[str, Any]] = []
    for simulation in range(settings.runs):
        output.extend(simulation_rows(values, times, trades, settings, gates, rng, simulation))
    return output


def simulation_rows(
    values: list[float],
    times: list[str],
    trades: list[Trade],
    settings: MonteCarloConfig,
    gates: GateConfig,
    rng: random.Random,
    simulation: int,
) -> list[dict[str, Any]]:
    """Build all method rows for one simulation.

    Definition:
        Produces shuffle, bootstrap, skip, execution-noise, and combined-stress rows.

    Inputs example:
        simulation_rows(values, times, trades, settings, gates, rng, 1)

    Expected output:
        A list of distribution dictionaries.
    """

    skip_rate = choose_skip_rate(settings.skip_min, settings.skip_max, rng)
    skipped_times, flags = skip_times(times, skip_rate, rng)
    skipped_values = apply_mask(values, flags)
    net_per_pip = median_net_per_pip(trades)
    combined_values = apply_execution_noise(shuffle_values(skipped_values, rng), net_per_pip, settings.slippage_pips, settings.pnl_noise_fraction, rng)
    return [
        method_row("shuffle", simulation, shuffle_values(values, rng), times, settings, gates),
        method_row("bootstrap", simulation, bootstrap_values(values, rng), times, settings, gates),
        method_row("skip", simulation, skipped_values, skipped_times, settings, gates, skip_rate),
        method_row("execution_noise", simulation, apply_execution_noise(values, net_per_pip, settings.slippage_pips, settings.pnl_noise_fraction, rng), times, settings, gates),
        method_row("combined_stress", simulation, combined_values, skipped_times, settings, gates, skip_rate),
    ]


def method_row(
    method: str,
    simulation: int,
    values: list[float],
    times: list[str],
    settings: MonteCarloConfig,
    gates: GateConfig,
    skip_rate: float | None = None,
) -> dict[str, Any]:
    """Build one Monte Carlo distribution row.

    Definition:
        Computes path metrics and survival state for one simulated path.

    Inputs example:
        method_row("shuffle", 1, [1.0], ["2026-06-01T00:00:00Z"], settings, gates)

    Expected output:
        A dictionary with method, simulation, metrics, and survival flag.
    """

    metrics = path_metrics(values, times, settings.balance)
    row = {"method": method, "simulation": simulation, **metrics}
    row["survived"] = survives(row, gates.max_drawdown_pct, gates.max_daily_drawdown_pct)
    row["skip_rate"] = skip_rate
    return row


def summarize_methods(rows: list[dict[str, Any]], gates: GateConfig) -> list[dict[str, Any]]:
    """Summarize Monte Carlo rows by method.

    Definition:
        Aggregates p05 net, p05 PF, p95 drawdown, and survivability by method.

    Inputs example:
        summarize_methods(rows, gates)

    Expected output:
        A list of method summary dictionaries.
    """

    methods = sorted({str(row["method"]) for row in rows})
    return [summarize_method(method, rows, gates) for method in methods]


def summarize_method(method: str, rows: list[dict[str, Any]], gates: GateConfig) -> dict[str, Any]:
    """Summarize one Monte Carlo method.

    Definition:
        Computes tail metrics and gate probabilities for one method.

    Inputs example:
        summarize_method("bootstrap", rows, gates)

    Expected output:
        A summary dictionary.
    """

    selected = [row for row in rows if row["method"] == method]
    net_values = [float(row["net"]) for row in selected]
    pf_values = [float(row["pf"]) for row in selected if float(row["pf"]) != float("inf")]
    dd_values = [float(row["max_drawdown_pct"]) for row in selected]
    survival = sum(1 for row in selected if bool(row["survived"])) / max(1, len(selected))
    return {
        "method": method,
        "runs": len(selected),
        "net_p05": percentile(net_values, 5),
        "pf_p05": percentile(pf_values, 5),
        "max_drawdown_pct_p95": percentile(dd_values, 95),
        "prob_net_le_zero": probability(selected, "net", 0.0, "le"),
        "prob_pf_below_gate": probability(selected, "pf", gates.min_profit_factor, "lt"),
        "prob_dd_gt_gate": probability(selected, "max_drawdown_pct", gates.max_drawdown_pct, "gt"),
        "survivability_probability": survival,
        "passes_survivability_gate": survival >= gates.min_survivability,
    }


def probability(rows: list[dict[str, Any]], key: str, threshold: float, operator: str) -> float:
    """Compute a threshold probability.

    Definition:
        Counts rows that meet a comparison against a threshold.

    Inputs example:
        probability(rows, "net", 0.0, "le")

    Expected output:
        A probability between 0.0 and 1.0.
    """

    if not rows:
        return 0.0
    return sum(1 for row in rows if compare(float(row[key]), threshold, operator)) / len(rows)


def compare(value: float, threshold: float, operator: str) -> bool:
    """Compare a value to a threshold.

    Definition:
        Supports less-than, less-or-equal, and greater-than comparisons.

    Inputs example:
        compare(1.0, 2.0, "lt")

    Expected output:
        True or False.
    """

    comparisons = {
        "lt": value < threshold,
        "le": value <= threshold,
        "gt": value > threshold,
    }
    return comparisons[operator]
