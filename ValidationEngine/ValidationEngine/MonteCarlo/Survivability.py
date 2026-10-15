"""Survivability metrics for Monte Carlo paths.

Definition:
    Computes path metrics, drawdown, daily loss, percentiles, and survival probability.

Inputs example:
    row = path_metrics([10.0, -5.0], ["2026-06-01T00:00:00Z"], 10000.0)

Expected output:
    Dictionaries used in Monte Carlo summaries.
"""

from __future__ import annotations

from datetime import datetime
import math
from typing import Any


def path_metrics(values: list[float], close_times: list[str], balance: float) -> dict[str, float | int]:
    """Compute metrics for one trade path.

    Definition:
        Computes net, PF, drawdown, daily loss, win rate, and loss streak.

    Inputs example:
        path_metrics([10.0, -5.0], ["2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z"], 10000.0)

    Expected output:
        A dictionary of numeric path metrics.
    """

    gross_profit = sum(value for value in values if value > 0.0)
    gross_loss_abs = -sum(value for value in values if value < 0.0)
    trades = len(values)
    return {
        "trades": trades,
        "net": sum(values),
        "pf": profit_factor(gross_profit, gross_loss_abs),
        "max_drawdown": max_drawdown(values, balance),
        "max_drawdown_pct": max_drawdown_pct(values, balance),
        "max_daily_closed_loss_pct": max_daily_closed_loss_pct(values, close_times, balance),
        "win_rate_pct": win_rate_pct(values),
        "max_loss_streak": max_loss_streak(values),
    }


def profit_factor(gross_profit: float, gross_loss_abs: float) -> float:
    """Compute profit factor.

    Definition:
        Divides gross profit by absolute gross loss.

    Inputs example:
        profit_factor(100.0, 50.0)

    Expected output:
        A float such as 2.0.
    """

    if gross_loss_abs <= 0.0:
        return math.inf if gross_profit > 0.0 else 0.0
    return gross_profit / gross_loss_abs


def max_drawdown(values: list[float], balance: float) -> float:
    """Compute absolute sequence drawdown.

    Definition:
        Tracks cumulative balance and returns the largest peak-to-trough loss.

    Inputs example:
        max_drawdown([10.0, -20.0], 10000.0)

    Expected output:
        A non-negative drawdown amount.
    """

    equity = balance
    peak = balance
    worst = 0.0
    for value in values:
        equity += value
        peak = max(peak, equity)
        worst = max(worst, peak - equity)
    return worst


def max_drawdown_pct(values: list[float], balance: float) -> float:
    """Compute percentage sequence drawdown.

    Definition:
        Divides max drawdown by starting balance.

    Inputs example:
        max_drawdown_pct([10.0, -20.0], 10000.0)

    Expected output:
        A drawdown percentage.
    """

    if balance <= 0.0:
        return 0.0
    return max_drawdown(values, balance) / balance * 100.0


def max_daily_closed_loss_pct(values: list[float], close_times: list[str], balance: float) -> float:
    """Compute worst closed-trade daily loss percentage.

    Definition:
        Groups closed trades by UTC date and measures the worst negative day.

    Inputs example:
        max_daily_closed_loss_pct([-10.0], ["2026-06-01T00:00:00Z"], 10000.0)

    Expected output:
        A non-negative daily loss percentage.
    """

    daily = daily_pnl(values, close_times)
    if balance <= 0.0:
        return 0.0
    return max((max(0.0, -value) / balance * 100.0 for value in daily.values()), default=0.0)


def daily_pnl(values: list[float], close_times: list[str]) -> dict[str, float]:
    """Group trade PnL by close date.

    Definition:
        Sums trade values by UTC close date.

    Inputs example:
        daily_pnl([1.0], ["2026-06-01T00:00:00Z"])

    Expected output:
        A dictionary keyed by YYYY-MM-DD.
    """

    output: dict[str, float] = {}
    for value, close_time in zip(values, close_times):
        key = date_key(close_time)
        output[key] = output.get(key, 0.0) + value
    return output


def date_key(value: str) -> str:
    """Return a UTC date key from a timestamp.

    Definition:
        Converts timestamp text to YYYY-MM-DD when possible.

    Inputs example:
        date_key("2026-06-01T01:00:00Z")

    Expected output:
        A date string such as "2026-06-01".
    """

    if not value:
        return "unknown"
    return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()


def win_rate_pct(values: list[float]) -> float:
    """Compute winning trade percentage.

    Definition:
        Counts positive trades and divides by trade count.

    Inputs example:
        win_rate_pct([1.0, -1.0])

    Expected output:
        A percentage such as 50.0.
    """

    if not values:
        return 0.0
    return sum(1 for value in values if value > 0.0) / len(values) * 100.0


def max_loss_streak(values: list[float]) -> int:
    """Compute longest consecutive losing streak.

    Definition:
        Counts the longest sequence of negative trade values.

    Inputs example:
        max_loss_streak([1.0, -1.0, -2.0])

    Expected output:
        An integer such as 2.
    """

    current = 0
    worst = 0
    for value in values:
        current = current + 1 if value < 0.0 else 0
        worst = max(worst, current)
    return worst


def percentile(values: list[float], percent: float) -> float:
    """Compute a percentile.

    Definition:
        Returns a nearest-rank interpolated percentile from numeric values.

    Inputs example:
        percentile([1.0, 2.0, 3.0], 50)

    Expected output:
        A float percentile value.
    """

    if not values:
        return 0.0
    ordered = sorted(values)
    index = (len(ordered) - 1) * percent / 100.0
    lower = int(math.floor(index))
    upper = int(math.ceil(index))
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def survives(row: dict[str, Any], max_drawdown_pct_gate: float, max_daily_drawdown_pct_gate: float) -> bool:
    """Decide whether one Monte Carlo path survives.

    Definition:
        Returns true when net is positive and drawdown gates are not breached.

    Inputs example:
        survives({"net": 10.0, "max_drawdown_pct": 1.0, "max_daily_closed_loss_pct": 1.0}, 5.0, 3.0)

    Expected output:
        True or False.
    """

    return bool(
        float(row["net"]) > 0.0
        and float(row["max_drawdown_pct"]) <= max_drawdown_pct_gate
        and float(row["max_daily_closed_loss_pct"]) <= max_daily_drawdown_pct_gate
    )
