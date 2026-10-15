"""Tests for config loading and walk-forward windows.

Definition:
    Verifies example config parsing and embargo window generation.

Inputs example:
    python3 -m unittest ValidationEngine/Tests/test_ConfigAndWindows.py

Expected output:
    Passing unit tests.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import unittest

from ValidationEngine.BacktestRunner import build_command
from ValidationEngine.Config import load_config
from ValidationEngine.Robustness.LatencyStress import build_latency_scenarios
from ValidationEngine.Robustness.ScenarioMatrix import build_scenarios
from ValidationEngine.WalkForward.WalkForwardBacktests import build_walk_forward_backtest_scenarios
from ValidationEngine.WalkForward.WalkForwardEmbargo import validate_embargo
from ValidationEngine.WalkForward.WindowBuilder import build_walk_forward_windows


class ConfigAndWindowTests(unittest.TestCase):
    """Unit tests for config and walk-forward helpers.

    Definition:
        Checks that the example config loads and embargo gaps pass.

    Inputs example:
        unittest runs this class automatically.

    Expected output:
        All assertions pass.
    """

    def test_example_config_loads(self) -> None:
        """Test example config loading.

        Definition:
            Loads the XAU example config and checks key fields.

        Inputs example:
            self.test_example_config_loads()

        Expected output:
            Config object contains XAUUSD and the requested parameter file.
        """

        config = load_config(Path("ValidationEngine/Configs/XauTickValidation.example.json"))
        self.assertEqual(config.symbols[0].name, "XAUUSD")
        self.assertIn("example.cbotset", str(config.parameter_file))
        self.assertEqual(config.parameter_overrides["HoldTicks"], "100")
        self.assertEqual(config.latency_stress.latency_ticks, [1, 5, 10])
        self.assertEqual(config.max_workers, 1)
        self.assertFalse(config.reuse_existing_reports)

    def test_command_includes_parameter_overrides(self) -> None:
        """Test command parameter override wiring.

        Definition:
            Builds one BacktestEngine command and checks repeated --param output.

        Inputs example:
            self.test_command_includes_parameter_overrides()

        Expected output:
            Command contains HoldTicks=100.
        """

        config = load_config(Path("ValidationEngine/Configs/XauTickValidation.example.json"))
        scenario = build_scenarios(config)[0]
        command = build_command(config, scenario)
        self.assertIn("--param", command)
        self.assertIn("HoldTicks=100", command)

    def test_command_includes_latency_stress(self) -> None:
        """Test command latency stress wiring.

        Definition:
            Builds one latency scenario and checks delayed-fill command output.

        Inputs example:
            self.test_command_includes_latency_stress()

        Expected output:
            Command contains --execution-latency-ticks.
        """

        config = load_config(Path("ValidationEngine/Configs/XauTickValidation.example.json"))
        scenario = build_latency_scenarios(config)[0]
        command = build_command(config, scenario)
        self.assertIn("--execution-latency-ticks", command)
        self.assertIn("1", command)

    def test_command_includes_multiple_tick_files(self) -> None:
        """Test that continuous replay emits one --ticks per ordered file."""

        config = load_config(Path("ValidationEngine/Configs/XauTickValidation.example.json"))
        symbol = replace(config.symbols[0], tick_files=(Path("one.csv"), Path("two.csv")))
        scenario = build_scenarios(replace(config, symbols=[symbol]))[0]
        command = build_command(config, scenario)
        self.assertEqual(command.count("--ticks"), 2)
        self.assertLess(command.index("one.csv"), command.index("two.csv"))

    def test_command_supports_fixed_spread_stress(self) -> None:
        """Test fixed base spread scaling for research-parity validation."""

        config = load_config(Path("ValidationEngine/Configs/XauTickValidation.example.json"))
        costs = replace(config.cost_stress, base_spread_pips=1.0)
        scenario = build_scenarios(replace(config, cost_stress=costs))[0]
        command = build_command(config, scenario)
        self.assertIn("--spread-pips", command)
        self.assertNotIn("--spread-multiplier", command)

    def test_walk_forward_embargo_passes(self) -> None:
        """Test walk-forward embargo validation.

        Definition:
            Builds walk-forward windows from the example config and validates embargo gaps.

        Inputs example:
            self.test_walk_forward_embargo_passes()

        Expected output:
            At least one window exists and embargo checks pass.
        """

        config = load_config(Path("ValidationEngine/Configs/XauTickValidation.example.json"))
        windows = build_walk_forward_windows(config.walk_forward)
        result = validate_embargo(windows[0], config.walk_forward.embargo_days)
        self.assertTrue(result["train_to_validation_passed"])
        self.assertTrue(result["validation_to_test_passed"])

    def test_walk_forward_backtest_scenarios_build(self) -> None:
        """Test walk-forward backtest scenario creation.

        Definition:
            Converts embargo windows into executable BacktestEngine test scenarios.

        Inputs example:
            self.test_walk_forward_backtest_scenarios_build()

        Expected output:
            At least one walk-forward test scenario is available for the example config.
        """

        config = load_config(Path("ValidationEngine/Configs/XauTickValidation.example.json"))
        windows = build_walk_forward_windows(config.walk_forward)
        scenarios = build_walk_forward_backtest_scenarios(config, windows)
        self.assertGreaterEqual(len(scenarios), 1)
        self.assertEqual(scenarios[0].layer, "WalkForward")


if __name__ == "__main__":
    unittest.main()
