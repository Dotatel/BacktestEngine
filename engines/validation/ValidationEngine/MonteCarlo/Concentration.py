"""Concentration and remove-best-trade shock metrics.

Definition:
    Computes whether a strategy depends too heavily on a few trades or periods.

Inputs example:
    result = concentration_summary(trades, 10000.0)

Expected output:
    A dictionary with best trade share and remove-best-trades shocks.
"""

from __future__ import annotations

from typing import Any

from ValidationEngine.MonteCarlo.Survivability import path_metrics
from ValidationEngine.Reports.TradeLedger import Trade, net_profits, close_times


def concentration_summary(trades: list[Trade], balance: float) -> dict[str, Any]:
    """Compute concentration summary.

    Definition:
        Measures best trade contribution and remove-best-trade shocks.

    Inputs example:
        concentration_summary(trades, 10000.0)

    Expected output:
        A dictionary containing concentration metrics.
    """

    values = net_profits(trades)
    total = sum(values)
    return {
        "best_trade_share": best_trade_share(values, total),
        "best_trade_net": max(values, default=0.0),
        "worst_trade_net": min(values, default=0.0),
        "remove_best": remove_best_shocks(values, close_times(trades), balance),
    }


def best_trade_share(values: list[float], total: float) -> float:
    """Compute best trade share of total net.

    Definition:
        Divides the best trade by total net profit.

    Inputs example:
        best_trade_share([10.0, -2.0], 8.0)

    Expected output:
        A float share such as 1.25.
    """

    if total <= 0.0:
        return 0.0
    return max(values, default=0.0) / total


def remove_best_shocks(values: list[float], times: list[str], balance: float) -> list[dict[str, Any]]:
    """Compute remove-best-trade shocks.

    Definition:
        Removes the best 1, 3, 5, and 10 trades and recomputes path metrics.

    Inputs example:
        remove_best_shocks([10.0, -2.0], ["a", "b"], 10000.0)

    Expected output:
        A list of metric dictionaries.
    """

    return [remove_best(values, times, balance, count) for count in [1, 3, 5, 10]]


def remove_best(values: list[float], times: list[str], balance: float, count: int) -> dict[str, Any]:
    """Remove the best N trades and compute metrics.

    Definition:
        Drops the largest count values from a path.

    Inputs example:
        remove_best([10.0, -2.0], ["a", "b"], 10000.0, 1)

    Expected output:
        A dictionary with removed count and metrics.
    """

    keep_indexes = indexes_after_best_removed(values, count)
    stressed_values = [values[index] for index in keep_indexes]
    stressed_times = [times[index] for index in keep_indexes]
    metrics = path_metrics(stressed_values, stressed_times, balance)
    return {"removed_best_trades": count, **metrics}


def indexes_after_best_removed(values: list[float], count: int) -> list[int]:
    """Return indexes after removing best trades.

    Definition:
        Keeps all indexes except the indexes of the largest count values.

    Inputs example:
        indexes_after_best_removed([10.0, -2.0], 1)

    Expected output:
        A list such as [1].
    """

    ranked = sorted(range(len(values)), key=lambda index: values[index], reverse=True)
    removed = set(ranked[:count])
    return [index for index in range(len(values)) if index not in removed]
