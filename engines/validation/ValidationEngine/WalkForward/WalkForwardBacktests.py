"""Walk-forward backtest scenario builder.

Definition:
    Converts embargo-valid walk-forward test windows into BacktestEngine scenarios.

Inputs example:
    scenarios = build_walk_forward_backtest_scenarios(config, windows)

Expected output:
    A list of BacktestScenario objects for walk-forward test reruns.
"""

from __future__ import annotations

from ValidationEngine.Config import ValidationConfig, WindowConfig
from ValidationEngine.Robustness.ScenarioMatrix import BacktestScenario
from ValidationEngine.WalkForward.WindowBuilder import WalkForwardWindow


def build_walk_forward_backtest_scenarios(
    config: ValidationConfig,
    windows: list[WalkForwardWindow],
) -> list[BacktestScenario]:
    """Build walk-forward test backtest scenarios.

    Definition:
        Creates one BacktestEngine test-period scenario for each walk-forward split
        whose test range is contained in a configured tick window.

    Inputs example:
        build_walk_forward_backtest_scenarios(config, windows)

    Expected output:
        A list of BacktestScenario objects.
    """

    return [
        build_walk_forward_backtest_scenario(config, walk_forward, source)
        for walk_forward in windows
        for source in matching_sources(config.windows, walk_forward)
    ]


def matching_sources(config_windows: list[WindowConfig], walk_forward: WalkForwardWindow) -> list[WindowConfig]:
    """Find configured tick windows that contain a walk-forward test range.

    Definition:
        Returns zero or one configured source windows for the split test period.

    Inputs example:
        matching_sources(config.windows, walk_forward)

    Expected output:
        A list containing the matching WindowConfig, or an empty list.
    """

    return [
        window
        for window in config_windows
        if window.start_utc <= walk_forward.test_start_utc and window.end_utc >= walk_forward.test_end_utc
    ][:1]


def build_walk_forward_backtest_scenario(
    config: ValidationConfig,
    walk_forward: WalkForwardWindow,
    source: WindowConfig,
) -> BacktestScenario:
    """Build one walk-forward test backtest scenario.

    Definition:
        Creates a baseline-cost BacktestEngine scenario for the walk-forward test period.

    Inputs example:
        build_walk_forward_backtest_scenario(config, window, source)

    Expected output:
        A BacktestScenario for one embargo-separated test period.
    """

    symbol = config.symbols[0]
    name = f"{symbol.name}_wf{walk_forward.index:03d}_test"
    report_path = config.output_root / config.run_name / "WalkForward" / name / "report.json"
    return BacktestScenario(
        name=name,
        symbol=symbol.name,
        tick_files=source.tick_files or symbol.tick_files,
        symbol_spec=source.symbol_spec or symbol.symbol_spec,
        start_utc=walk_forward.test_start_utc,
        end_utc=walk_forward.test_end_utc,
        spread_multiplier=1.0,
        commission_usd_per_million=config.cost_stress.base_commission_usd_per_million,
        report_path=report_path,
        layer="WalkForward",
        execution_latency_ticks=0,
        spread_pips=config.cost_stress.base_spread_pips,
    )
