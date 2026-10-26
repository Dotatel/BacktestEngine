"""Slippage stress descriptors.

Definition:
    Builds slippage assumptions for trade-ledger and future engine-level stress.

Inputs example:
    rows = build_slippage_rows([0.0, 1.0, 2.0])

Expected output:
    A list of named slippage stress rows.
"""

from __future__ import annotations


def build_slippage_rows(slippage_pips: list[float]) -> list[dict[str, float | str]]:
    """Build slippage stress rows.

    Definition:
        Converts slippage pip values into named rows.

    Inputs example:
        build_slippage_rows([0.0, 2.0])

    Expected output:
        A list of dictionaries.
    """

    return [{"name": slippage_name(value), "slippage_pips": value} for value in slippage_pips]


def slippage_name(value: float) -> str:
    """Build a slippage stress name.

    Definition:
        Creates a stable label for one slippage assumption.

    Inputs example:
        slippage_name(2.0)

    Expected output:
        A string such as "slippage2_0pips".
    """

    return f"slippage{str(value).replace('.', '_')}pips"
