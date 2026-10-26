"""Monte Carlo perturbation helpers.

Definition:
    Provides small deterministic helpers for trade shuffle, bootstrap, missed trades, slippage, and PnL noise.

Inputs example:
    values = apply_execution_noise([10.0, -5.0], 1.0, 2.0, 0.1, random.Random(42))

Expected output:
    New trade-profit paths used by Monte Carlo simulations.
"""

from __future__ import annotations

import random


def shuffle_values(values: list[float], rng: random.Random) -> list[float]:
    """Shuffle trade values.

    Definition:
        Returns the same trades in a randomized order.

    Inputs example:
        shuffle_values([1.0, 2.0, 3.0], random.Random(42))

    Expected output:
        A list with the same values in a new order.
    """

    output = list(values)
    rng.shuffle(output)
    return output


def bootstrap_values(values: list[float], rng: random.Random) -> list[float]:
    """Bootstrap trade values with replacement.

    Definition:
        Creates a same-length sample by drawing trades with replacement.

    Inputs example:
        bootstrap_values([1.0, -1.0], random.Random(42))

    Expected output:
        A list of sampled trade values.
    """

    return [rng.choice(values) for _ in values]


def choose_skip_rate(skip_min: float, skip_max: float, rng: random.Random) -> float:
    """Choose one missed-trade rate.

    Definition:
        Returns a random skip rate between configured bounds.

    Inputs example:
        choose_skip_rate(0.05, 0.20, random.Random(42))

    Expected output:
        A float such as 0.1459.
    """

    return rng.uniform(skip_min, skip_max)


def skip_values(values: list[float], skip_rate: float, rng: random.Random) -> list[float]:
    """Randomly remove trades.

    Definition:
        Simulates missed trades by keeping each trade with probability 1 - skip_rate.

    Inputs example:
        skip_values([1.0, -1.0, 2.0], 0.10, random.Random(42))

    Expected output:
        A filtered list of trade values.
    """

    return [value for value in values if rng.random() >= skip_rate]


def skip_times(times: list[str], skip_rate: float, rng: random.Random) -> tuple[list[str], list[bool]]:
    """Randomly keep timestamp rows.

    Definition:
        Creates a timestamp subset and the boolean keep mask used for matching trades.

    Inputs example:
        skip_times(["a", "b"], 0.10, random.Random(42))

    Expected output:
        A tuple of kept timestamps and keep flags.
    """

    flags = [rng.random() >= skip_rate for _ in times]
    return [time for time, keep in zip(times, flags) if keep], flags


def apply_mask(values: list[float], flags: list[bool]) -> list[float]:
    """Apply a boolean keep mask to trade values.

    Definition:
        Keeps values whose matching flag is true.

    Inputs example:
        apply_mask([1.0, 2.0], [True, False])

    Expected output:
        A filtered list such as [1.0].
    """

    return [value for value, keep in zip(values, flags) if keep]


def apply_execution_noise(
    values: list[float],
    net_per_pip: float,
    slippage_pips: float,
    pnl_noise_fraction: float,
    rng: random.Random,
) -> list[float]:
    """Apply slippage and PnL noise to trades.

    Definition:
        Subtracts random adverse slippage and adds Gaussian PnL noise per trade.

    Inputs example:
        apply_execution_noise([10.0], 1.0, 2.0, 0.10, random.Random(42))

    Expected output:
        A list of stressed trade values.
    """

    return [
        value + rng.gauss(0.0, abs(value) * pnl_noise_fraction) - rng.uniform(0.0, slippage_pips) * net_per_pip
        for value in values
    ]
