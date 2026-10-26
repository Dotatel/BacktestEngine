"""Scenario matrix builder for engine rerun robustness.

Definition:
    Creates BacktestEngine run scenarios from symbols, windows, and cost stress settings.

Inputs example:
    scenarios = build_scenarios(config)

Expected output:
    A list of BacktestScenario objects ready for BacktestRunner.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ValidationEngine.Config import ValidationConfig


@dataclass(frozen=True)
class BacktestScenario:
    """One planned BacktestEngine scenario.

    Definition:
        Stores all inputs required for one BacktestEngine.Run invocation.

    Inputs example:
        BacktestScenario(name="XAUUSD_june_spread1", symbol="XAUUSD", ...)

    Expected output:
        Immutable scenario object used by BacktestRunner.
    """

    name: str
    symbol: str
    tick_files: tuple[Path, ...]
    symbol_spec: Path
    start_utc: str
    end_utc: str
    spread_multiplier: float
    commission_usd_per_million: float
    report_path: Path
    layer: str = "cost_stress"
    execution_latency_ticks: int = 0
    spread_pips: float | None = None

    @property
    def tick_file(self) -> Path:
        """Return the first tick file for backward-compatible callers."""

        return self.tick_files[0]


def build_scenarios(config: ValidationConfig) -> list[BacktestScenario]:
    """Build all configured BacktestEngine scenarios.

    Definition:
        Expands symbol, window, spread multiplier, and commission multiplier combinations.

    Inputs example:
        build_scenarios(config)

    Expected output:
        A list of BacktestScenario objects.
    """

    return [
        build_scenario(config, symbol_index, window_index, spread, commission)
        for symbol_index in range(len(config.symbols))
        for window_index in range(len(config.windows))
        for spread in config.cost_stress.spread_multipliers
        for commission in config.cost_stress.commission_multipliers
    ]


def build_scenario(
    config: ValidationConfig,
    symbol_index: int,
    window_index: int,
    spread_multiplier: float,
    commission_multiplier: float,
) -> BacktestScenario:
    """Build one BacktestEngine scenario.

    Definition:
        Creates one named scenario and output report path.

    Inputs example:
        build_scenario(config, 0, 0, 1.5, 1.0)

    Expected output:
        A BacktestScenario for the requested matrix cell.
    """

    symbol = config.symbols[symbol_index]
    window = config.windows[window_index]
    scenario_name = scenario_id(symbol.name, window.name, spread_multiplier, commission_multiplier)
    report_path = config.output_root / config.run_name / "Reports" / scenario_name / "report.json"
    return BacktestScenario(
        name=scenario_name,
        symbol=symbol.name,
        tick_files=window.tick_files or symbol.tick_files,
        symbol_spec=window.symbol_spec or symbol.symbol_spec,
        start_utc=window.start_utc,
        end_utc=window.end_utc,
        spread_multiplier=spread_multiplier,
        commission_usd_per_million=config.cost_stress.base_commission_usd_per_million * commission_multiplier,
        report_path=report_path,
        spread_pips=scaled_spread_pips(config, spread_multiplier),
    )


def build_custom_scenario(
    config: ValidationConfig,
    name: str,
    window_index: int,
    layer: str,
    spread_multiplier: float,
    execution_latency_ticks: int,
) -> BacktestScenario:
    """Build one custom scenario for a validation layer.

    Definition:
        Creates a scenario for latency or walk-forward reruns using a configured window.

    Inputs example:
        build_custom_scenario(config, "latency1", 0, "latency_stress", 1.0, 1)

    Expected output:
        A BacktestScenario with layer-specific report path and latency setting.
    """

    symbol = config.symbols[0]
    window = config.windows[window_index]
    report_path = config.output_root / config.run_name / layer / name / "report.json"
    return BacktestScenario(
        name=name,
        symbol=symbol.name,
        tick_files=window.tick_files or symbol.tick_files,
        symbol_spec=window.symbol_spec or symbol.symbol_spec,
        start_utc=window.start_utc,
        end_utc=window.end_utc,
        spread_multiplier=spread_multiplier,
        commission_usd_per_million=config.cost_stress.base_commission_usd_per_million,
        report_path=report_path,
        layer=layer,
        execution_latency_ticks=execution_latency_ticks,
        spread_pips=scaled_spread_pips(config, spread_multiplier),
    )


def scaled_spread_pips(config: ValidationConfig, multiplier: float) -> float | None:
    """Return fixed spread pips when the cost model defines a fixed base."""

    base = config.cost_stress.base_spread_pips
    return None if base is None else base * multiplier


def scenario_id(symbol: str, window: str, spread_multiplier: float, commission_multiplier: float) -> str:
    """Create a stable scenario identifier.

    Definition:
        Converts scenario dimensions into a filesystem-safe name.

    Inputs example:
        scenario_id("XAUUSD", "june", 1.5, 2.0)

    Expected output:
        A string such as "XAUUSD_june_spread1_5x_commission2_0x".
    """

    spread = str(spread_multiplier).replace(".", "_")
    commission = str(commission_multiplier).replace(".", "_")
    return f"{symbol}_{window}_spread{spread}x_commission{commission}x"
