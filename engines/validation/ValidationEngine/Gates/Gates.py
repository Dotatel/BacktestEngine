"""Validation gate checks.

Definition:
    Applies deterministic and Monte Carlo thresholds to validation metrics.

Inputs example:
    checks = deterministic_checks(combined_report, gate_config)

Expected output:
    A dictionary of named pass/fail checks.
"""

from __future__ import annotations

from typing import Any

from ValidationEngine.Config import GateConfig
from ValidationEngine.Reports.CombinedReport import CombinedReport


def deterministic_checks(report: CombinedReport, gates: GateConfig) -> dict[str, bool]:
    """Apply deterministic validation gates.

    Definition:
        Checks trade count, net profit, profit factor, and drawdown.

    Inputs example:
        deterministic_checks(combined_report, gates)

    Expected output:
        A dictionary of booleans.
    """

    return {
        "min_trades": report.total_trades >= gates.min_trades,
        "net_positive": report.net_profit > 0.0,
        "profit_factor": report.profit_factor >= gates.min_profit_factor,
        "drawdown": report.max_drawdown_pct <= gates.max_drawdown_pct,
    }


def monte_carlo_checks(summary: list[dict[str, Any]], gates: GateConfig) -> dict[str, bool]:
    """Apply Monte Carlo survivability gates.

    Definition:
        Requires every Monte Carlo method to meet minimum survivability.

    Inputs example:
        monte_carlo_checks(summary, gates)

    Expected output:
        A dictionary of booleans.
    """

    return {
        "all_methods_present": len(summary) > 0,
        "all_methods_survive": all(method_passes(row, gates) for row in summary),
    }


def method_passes(row: dict[str, Any], gates: GateConfig) -> bool:
    """Check one Monte Carlo method summary.

    Definition:
        Returns true when survivability probability meets the configured gate.

    Inputs example:
        method_passes({"survivability_probability": 0.9}, gates)

    Expected output:
        True or False.
    """

    return float(row.get("survivability_probability", 0.0)) >= gates.min_survivability
