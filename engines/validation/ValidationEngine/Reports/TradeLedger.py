"""Trade ledger model and CSV helpers.

Definition:
    Provides a normalized Trade object and helper functions for trade ledgers.

Inputs example:
    write_trades_csv(Path("trades.csv"), trades)

Expected output:
    CSV and in-memory trade ledgers with consistent field names.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import csv


@dataclass(frozen=True)
class Trade:
    """One normalized closed trade.

    Definition:
        Stores the minimum fields needed for metrics and Monte Carlo.

    Inputs example:
        Trade(symbol="XAUUSD", side="Buy", net_profit=10.5, pips=2.0, close_time_utc="2026-06-01T01:00:00Z", source="report.json")

    Expected output:
        Immutable trade row used by Monte Carlo and reports.
    """

    symbol: str
    side: str
    net_profit: float
    gross_profit: float
    pips: float
    close_time_utc: str
    source: str
    entry_time_utc: str = ""
    label: str = ""
    economic_leg_count: int = 1
    execution_value_per_pip: float = 0.0


def economic_baskets(trades: list[Trade]) -> list[Trade]:
    """Combine positions opened by one decision into economic trade baskets.

    Positions from the same report, symbol, and exact entry timestamp are one
    indivisible economic outcome. This is important for hedged strategies:
    independently shuffling the core and hedge creates paths the strategy
    could never realize. Trades without an entry timestamp remain independent.
    """

    grouped: OrderedDict[tuple[str, str, str, int | None], list[Trade]] = OrderedDict()
    for index, trade in enumerate(trades):
        unique_index = None if trade.entry_time_utc else index
        key = (trade.source, trade.symbol, trade.entry_time_utc, unique_index)
        grouped.setdefault(key, []).append(trade)

    baskets = [build_economic_basket(legs) for legs in grouped.values()]
    return sorted(baskets, key=lambda trade: (trade.close_time_utc, trade.entry_time_utc))


def build_economic_basket(legs: list[Trade]) -> Trade:
    """Aggregate one or more simultaneous position legs without losing costs."""

    if len(legs) == 1:
        leg = legs[0]
        if leg.execution_value_per_pip > 0.0:
            return leg
        return Trade(
            symbol=leg.symbol,
            side=leg.side,
            net_profit=leg.net_profit,
            gross_profit=leg.gross_profit,
            pips=leg.pips,
            close_time_utc=leg.close_time_utc,
            source=leg.source,
            entry_time_utc=leg.entry_time_utc,
            label=leg.label,
            economic_leg_count=leg.economic_leg_count,
            execution_value_per_pip=trade_execution_value_per_pip(leg),
        )

    return Trade(
        symbol=legs[0].symbol,
        side="Basket",
        net_profit=sum(leg.net_profit for leg in legs),
        gross_profit=sum(leg.gross_profit for leg in legs),
        pips=sum(leg.pips for leg in legs),
        close_time_utc=max(leg.close_time_utc for leg in legs),
        source=legs[0].source,
        entry_time_utc=legs[0].entry_time_utc,
        label="+".join(dict.fromkeys(leg.label for leg in legs if leg.label)),
        economic_leg_count=sum(leg.economic_leg_count for leg in legs),
        execution_value_per_pip=sum(trade_execution_value_per_pip(leg) for leg in legs),
    )


def trade_execution_value_per_pip(trade: Trade) -> float:
    """Return the execution value of one trade leg for one pip of slippage."""

    if trade.execution_value_per_pip > 0.0:
        return trade.execution_value_per_pip
    if abs(trade.pips) <= 1e-9:
        return 0.0
    return abs(trade.gross_profit) / abs(trade.pips)


def net_profits(trades: list[Trade]) -> list[float]:
    """Return trade net profits.

    Definition:
        Extracts net profit values from a trade list.

    Inputs example:
        net_profits([Trade(..., net_profit=1.0, ...)])

    Expected output:
        A list of floats.
    """

    return [trade.net_profit for trade in trades]


def close_times(trades: list[Trade]) -> list[str]:
    """Return trade close times.

    Definition:
        Extracts close time strings from a trade list.

    Inputs example:
        close_times([Trade(..., close_time_utc="2026-06-01T00:00:00Z", ...)])

    Expected output:
        A list of UTC timestamp strings.
    """

    return [trade.close_time_utc for trade in trades]


def median_net_per_pip(trades: list[Trade]) -> float:
    """Estimate median net value per pip.

    Definition:
        Computes median absolute gross-profit-per-pip for slippage conversion.

    Inputs example:
        median_net_per_pip([Trade(..., gross_profit=10.0, pips=2.0, ...)])

    Expected output:
        A float such as 5.0.
    """

    ratios = sorted(
        trade_execution_value_per_pip(trade)
        for trade in trades
        if trade_execution_value_per_pip(trade) > 0.0
    )
    if not ratios:
        return 0.0
    return ratios[len(ratios) // 2]


def write_trades_csv(path: Path, trades: list[Trade]) -> None:
    """Write normalized trades to CSV.

    Definition:
        Serializes a list of Trade objects to a CSV file.

    Inputs example:
        write_trades_csv(Path("combined_trades.csv"), trades)

    Expected output:
        A CSV file with one row per trade.
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=trade_fieldnames())
        writer.writeheader()
        writer.writerows(trade_to_row(trade) for trade in trades)


def trade_fieldnames() -> list[str]:
    """Return normalized trade CSV fields.

    Definition:
        Provides the field order used by write_trades_csv.

    Inputs example:
        trade_fieldnames()

    Expected output:
        A list of CSV column names.
    """

    return [
        "symbol",
        "side",
        "net_profit",
        "gross_profit",
        "pips",
        "entry_time_utc",
        "close_time_utc",
        "label",
        "economic_leg_count",
        "execution_value_per_pip",
        "source",
    ]


def trade_to_row(trade: Trade) -> dict[str, str | float]:
    """Convert one Trade to a CSV row dictionary.

    Definition:
        Maps Trade fields to CSV-compatible values.

    Inputs example:
        trade_to_row(trade)

    Expected output:
        A dictionary suitable for csv.DictWriter.
    """

    return {
        "symbol": trade.symbol,
        "side": trade.side,
        "net_profit": trade.net_profit,
        "gross_profit": trade.gross_profit,
        "pips": trade.pips,
        "entry_time_utc": normalize_time(trade.entry_time_utc),
        "close_time_utc": normalize_time(trade.close_time_utc),
        "label": trade.label,
        "economic_leg_count": trade.economic_leg_count,
        "execution_value_per_pip": trade.execution_value_per_pip,
        "source": trade.source,
    }


def normalize_time(value: str) -> str:
    """Normalize a timestamp string for reports.

    Definition:
        Returns an ISO-like string and preserves unknown values as empty strings.

    Inputs example:
        normalize_time("2026-06-01T00:00:00Z")

    Expected output:
        A string timestamp.
    """

    if not value:
        return ""
    return value


def parse_date(value: str) -> datetime | None:
    """Parse a UTC timestamp.

    Definition:
        Converts ISO timestamp strings to datetime objects when possible.

    Inputs example:
        parse_date("2026-06-01T00:00:00Z")

    Expected output:
        A datetime object or None.
    """

    if not value:
        return None
    text = value.replace("Z", "+00:00")
    return datetime.fromisoformat(text)
