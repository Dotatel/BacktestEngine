"""BacktestEngine report parser.

Definition:
    Reads BacktestEngine report.json files and extracts normalized trades and metrics.

Inputs example:
    report = load_backtest_report(Path("report.json"))

Expected output:
    A BacktestReport with normalized trades and summary fields.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

from ValidationEngine.Reports.TradeLedger import Trade


@dataclass(frozen=True)
class BacktestReport:
    """Parsed BacktestEngine report.

    Definition:
        Stores source path, trades, and key metrics from one report.

    Inputs example:
        BacktestReport(path=Path("report.json"), symbol="XAUUSD", trades=[], net_profit=0.0, ...)

    Expected output:
        Immutable report object used by combined summaries.
    """

    path: Path
    symbol: str
    trades: list[Trade]
    net_profit: float
    gross_profit: float
    gross_loss: float
    profit_factor: float
    total_trades: int
    max_drawdown_pct: float
    starting_balance: float


def load_backtest_report(path: Path) -> BacktestReport:
    """Load one BacktestEngine report.

    Definition:
        Parses JSON from disk and converts it into a BacktestReport.

    Inputs example:
        load_backtest_report(Path("report.json"))

    Expected output:
        A BacktestReport instance.
    """

    raw: dict[str, Any] = json.loads(path.read_text())
    return parse_backtest_report(path, raw)


def parse_backtest_report(path: Path, raw: dict[str, Any]) -> BacktestReport:
    """Parse one BacktestEngine report payload.

    Definition:
        Extracts normalized trades and summary metrics from raw JSON.

    Inputs example:
        parse_backtest_report(Path("report.json"), {"trades": []})

    Expected output:
        A BacktestReport instance.
    """

    trades = parse_trades(path, raw)
    stats = raw.get("trade_statistics", {})
    drawdown = raw.get("drawdown", {})
    account = raw.get("account", {})
    return BacktestReport(
        path=path,
        symbol=str(raw.get("symbol", "")),
        trades=trades,
        net_profit=float(stats.get("net_profit", sum(trade.net_profit for trade in trades))),
        gross_profit=float(stats.get("gross_profit", 0.0)),
        gross_loss=float(stats.get("gross_loss", 0.0)),
        profit_factor=float(stats.get("profit_factor") or 0.0),
        total_trades=int(stats.get("total_trades", len(trades))),
        max_drawdown_pct=float(drawdown.get("max_equity_drawdown_percent", 0.0)),
        starting_balance=float(account.get("starting_capital", 10000.0)),
    )


def parse_trades(path: Path, raw: dict[str, Any]) -> list[Trade]:
    """Parse normalized trades from one report payload.

    Definition:
        Converts BacktestEngine trades into Trade objects.

    Inputs example:
        parse_trades(Path("report.json"), {"trades": [{"net_profit": 1.0}]})

    Expected output:
        A list of Trade objects.
    """

    items = raw.get("trades", [])
    return [parse_trade(path, item, raw) for item in items]


def parse_trade(path: Path, item: dict[str, Any], raw: dict[str, Any]) -> Trade:
    """Parse one trade row.

    Definition:
        Converts a raw trade dictionary into a normalized Trade.

    Inputs example:
        parse_trade(Path("report.json"), {"symbol": "XAUUSD", "net_profit": 5.0}, raw)

    Expected output:
        A Trade instance.
    """

    return Trade(
        symbol=str(item.get("symbol", raw.get("symbol", ""))),
        side=str(item.get("side", "")),
        net_profit=float(item.get("net_profit", 0.0)),
        gross_profit=float(item.get("gross_profit", item.get("net_profit", 0.0))),
        pips=float(item.get("pips", 0.0)),
        close_time_utc=str(item.get("close_time_utc", "")),
        source=str(path),
        entry_time_utc=str(item.get("entry_time_utc", "")),
        label=str(item.get("label", "")),
    )
