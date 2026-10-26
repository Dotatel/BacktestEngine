"""Latency stress scenario builder.

Definition:
    Builds engine-level delayed-fill rerun scenarios.

Inputs example:
    scenarios = build_latency_scenarios(config)

Expected output:
    A list of BacktestScenario objects with execution latency configured.
"""

from __future__ import annotations

from ValidationEngine.Config import ValidationConfig
from ValidationEngine.Robustness.ScenarioMatrix import BacktestScenario, build_custom_scenario


def build_latency_scenarios(config: ValidationConfig) -> list[BacktestScenario]:
    """Build latency stress scenarios.

    Definition:
        Creates one baseline-spread delayed-fill scenario per configured window and latency.

    Inputs example:
        build_latency_scenarios(config)

    Expected output:
        A list of BacktestScenario objects.
    """

    return [
        build_latency_scenario(config, window_index, latency_ticks)
        for window_index in range(len(config.windows))
        for latency_ticks in config.latency_stress.latency_ticks
        if latency_ticks > 0
    ]


def build_latency_scenario(config: ValidationConfig, window_index: int, latency_ticks: int) -> BacktestScenario:
    """Build one latency stress scenario.

    Definition:
        Builds a delayed-fill BacktestEngine scenario for one configured window.

    Inputs example:
        build_latency_scenario(config, 0, 5)

    Expected output:
        A BacktestScenario whose command includes --execution-latency-ticks.
    """

    window = config.windows[window_index]
    name = f"{config.symbols[0].name}_{window.name}_{latency_name(latency_ticks)}"
    return build_custom_scenario(config, name, window_index, "LatencyStress", 1.0, latency_ticks)


def latency_name(latency_ticks: int) -> str:
    """Build a latency stress name.

    Definition:
        Creates a stable label for delayed execution tick assumptions.

    Inputs example:
        latency_name(3)

    Expected output:
        A string such as "latency3ticks".
    """

    return f"latency{latency_ticks}ticks"
