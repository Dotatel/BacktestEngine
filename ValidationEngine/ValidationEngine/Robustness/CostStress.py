"""Cost stress scenario helpers.

Definition:
    Builds named spread and commission stress combinations.

Inputs example:
    rows = build_cost_stress_rows([1.0, 2.0], [1.0, 3.0])

Expected output:
    A list of cost stress dictionaries.
"""

from __future__ import annotations


def build_cost_stress_rows(spread_multipliers: list[float], commission_multipliers: list[float]) -> list[dict[str, float | str]]:
    """Build cost stress rows.

    Definition:
        Expands spread and commission multiplier combinations.

    Inputs example:
        build_cost_stress_rows([1.0, 2.0], [1.0])

    Expected output:
        A list of dictionaries.
    """

    return [
        {
            "name": stress_name(spread, commission),
            "spread_multiplier": spread,
            "commission_multiplier": commission,
        }
        for spread in spread_multipliers
        for commission in commission_multipliers
    ]


def stress_name(spread_multiplier: float, commission_multiplier: float) -> str:
    """Build a cost stress name.

    Definition:
        Creates a stable label for spread and commission settings.

    Inputs example:
        stress_name(1.5, 2.0)

    Expected output:
        A string such as "spread1_5x_commission2_0x".
    """

    spread = str(spread_multiplier).replace(".", "_")
    commission = str(commission_multiplier).replace(".", "_")
    return f"spread{spread}x_commission{commission}x"
