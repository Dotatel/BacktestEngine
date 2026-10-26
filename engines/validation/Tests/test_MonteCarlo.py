"""Tests for trade-ledger Monte Carlo.

Definition:
    Verifies Monte Carlo perturbation and summary behavior.

Inputs example:
    python3 -m unittest ValidationEngine/Tests/test_MonteCarlo.py

Expected output:
    Passing unit tests.
"""

from __future__ import annotations

import unittest

from ValidationEngine.Config import GateConfig, MonteCarloConfig
from ValidationEngine.MonteCarlo.TradeLedgerMonteCarlo import run_monte_carlo
from ValidationEngine.Reports.TradeLedger import Trade, economic_baskets


class MonteCarloTests(unittest.TestCase):
    """Unit tests for trade-ledger Monte Carlo.

    Definition:
        Checks that all expected Monte Carlo methods produce summaries.

    Inputs example:
        unittest runs this class automatically.

    Expected output:
        All assertions pass.
    """

    def test_all_methods_are_present(self) -> None:
        """Test that all Monte Carlo methods are summarized.

        Definition:
            Runs a small Monte Carlo sample and checks method names.

        Inputs example:
            self.test_all_methods_are_present()

        Expected output:
            The expected method set is present.
        """

        result = run_monte_carlo(sample_trades(), sample_monte_carlo_config(), sample_gate_config())
        methods = {row["method"] for row in result.summary}
        self.assertEqual(methods, {"bootstrap", "combined_stress", "execution_noise", "shuffle", "skip"})

    def test_core_and_hedge_are_one_economic_basket(self) -> None:
        """A simultaneous hedge must never be randomized away from its core."""

        trades = [
            Trade(
                "XAUUSD", "Buy", -1000.0, -999.0, -100.0,
                "2026-06-02T00:00:00Z", "report.json",
                "2026-06-01T00:00:00Z", "EXAMPLE_CORE",
            ),
            Trade(
                "XAUUSD", "Sell", 900.0, 901.0, 99.0,
                "2026-06-02T00:00:00Z", "report.json",
                "2026-06-01T00:00:00Z", "EXAMPLE_HEDGE",
            ),
            Trade(
                "XAUUSD", "Buy", 25.0, 26.0, 2.0,
                "2026-06-03T00:00:00Z", "report.json",
                "2026-06-03T00:00:00Z", "EXAMPLE_CORE",
            ),
        ]

        baskets = economic_baskets(trades)

        self.assertEqual(len(baskets), 2)
        self.assertEqual(baskets[0].economic_leg_count, 2)
        self.assertAlmostEqual(baskets[0].net_profit, -100.0)
        self.assertNotIn(-1000.0, [basket.net_profit for basket in baskets])

    def test_missing_entry_times_remain_independent(self) -> None:
        """Legacy ledgers without entry timestamps must not collapse together."""

        baskets = economic_baskets(sample_trades())

        self.assertEqual(len(baskets), len(sample_trades()))


def sample_trades() -> list[Trade]:
    """Build sample trades for tests.

    Definition:
        Creates a small mixed win/loss trade list.

    Inputs example:
        sample_trades()

    Expected output:
        A list of Trade objects.
    """

    return [
        Trade("XAUUSD", "Buy", 10.0, 10.0, 2.0, "2026-06-01T00:00:00Z", "test"),
        Trade("XAUUSD", "Sell", -4.0, -4.0, -1.0, "2026-06-02T00:00:00Z", "test"),
        Trade("XAUUSD", "Buy", 8.0, 8.0, 2.0, "2026-06-03T00:00:00Z", "test"),
        Trade("XAUUSD", "Sell", -3.0, -3.0, -1.0, "2026-06-04T00:00:00Z", "test"),
    ]


def sample_monte_carlo_config() -> MonteCarloConfig:
    """Build sample Monte Carlo config.

    Definition:
        Creates a small deterministic Monte Carlo config.

    Inputs example:
        sample_monte_carlo_config()

    Expected output:
        A MonteCarloConfig object.
    """

    return MonteCarloConfig(10, 42, 10000.0, 0.05, 0.20, 2.0, 0.10)


def sample_gate_config() -> GateConfig:
    """Build sample gate config.

    Definition:
        Creates permissive gates for unit tests.

    Inputs example:
        sample_gate_config()

    Expected output:
        A GateConfig object.
    """

    return GateConfig(1, 1.0, 10.0, 3.0, 0.5)


if __name__ == "__main__":
    unittest.main()
