"""Combined report metrics for validation runs.

Definition:
    Combines parsed BacktestEngine reports into aggregate trade and metric summaries.

Inputs example:
    summary = combine_reports(reports)

Expected output:
    CombinedReport object with aggregate metrics and normalized trades.
"""

from __future__ import annotations

from dataclasses import dataclass
import math

from ValidationEngine.Reports.BacktestReport import BacktestReport
from ValidationEngine.Reports.TradeLedger import Trade


@dataclass(frozen=True)
class CombinedReport:
    """Aggregate report for multiple BacktestEngine reports.

    Definition:
        Stores combined trades and metrics across validation scenarios.

    Inputs example:
        CombinedReport(trades=[], net_profit=0.0, profit_factor=0.0, ...)

    Expected output:
        Immutable aggregate summary.
    """

    trades: list[Trade]
    net_profit: float
    gross_profit: float
    gross_loss_abs: float
    profit_factor: float
    total_trades: int
    max_drawdown_pct: float
    positive_report_count: int
    report_count: int


def combine_reports(reports: list[BacktestReport]) -> CombinedReport:
    """Combine multiple BacktestReport objects.

    Definition:
        Aggregates trades and metrics across report objects.

    Inputs example:
        combine_reports([report_a, report_b])

    Expected output:
        A CombinedReport object.
    """

    trades = [trade for report in reports for trade in report.trades]
    gross_profit = sum(max(0.0, trade.net_profit) for trade in trades)
    gross_loss_abs = -sum(min(0.0, trade.net_profit) for trade in trades)
    net_profit = sum(trade.net_profit for trade in trades)
    return CombinedReport(
        trades=trades,
        net_profit=net_profit,
        gross_profit=gross_profit,
        gross_loss_abs=gross_loss_abs,
        profit_factor=profit_factor(gross_profit, gross_loss_abs),
        total_trades=len(trades),
        max_drawdown_pct=max((report.max_drawdown_pct for report in reports), default=0.0),
        positive_report_count=sum(1 for report in reports if report.net_profit > 0.0),
        report_count=len(reports),
    )


def profit_factor(gross_profit: float, gross_loss_abs: float) -> float:
    """Compute profit factor.

    Definition:
        Divides gross profit by absolute gross loss with safe zero-loss behavior.

    Inputs example:
        profit_factor(100.0, 50.0)

    Expected output:
        A float such as 2.0.
    """

    if gross_loss_abs <= 0.0:
        return math.inf if gross_profit > 0.0 else 0.0
    return gross_profit / gross_loss_abs
