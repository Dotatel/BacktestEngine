"""Configuration models and loaders for ValidationEngine.

Definition:
    Reads JSON configuration files and converts them into typed dataclasses.

Inputs example:
    config = load_config("ValidationEngine/Configs/XauTickValidation.example.json")

Expected output:
    A ValidationConfig object with repository-relative paths expanded.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SymbolConfig:
    """Configuration for one tradable symbol.

    Definition:
        Stores the data and symbol-spec paths needed to run one symbol.

    Inputs example:
        SymbolConfig(name="XAUUSD", tick_files=(Path("ticks.csv"),), symbol_spec=Path("symbol_spec.json"))

    Expected output:
        Immutable symbol configuration used by scenario builders.
    """

    name: str
    tick_files: tuple[Path, ...]
    symbol_spec: Path

    @property
    def tick_file(self) -> Path:
        """Return the first tick file for backward-compatible callers."""

        return self.tick_files[0]


@dataclass(frozen=True)
class WindowConfig:
    """Configuration for one validation date window.

    Definition:
        Stores the window name and UTC date range used by BacktestEngine.

    Inputs example:
        WindowConfig(name="june_2026", start_utc="2026-06-01T00:00:00Z", end_utc="2026-07-01T00:00:00Z")

    Expected output:
        Immutable window configuration used by scenario builders.
    """

    name: str
    start_utc: str
    end_utc: str
    tick_files: tuple[Path, ...] | None = None
    symbol_spec: Path | None = None

    @property
    def tick_file(self) -> Path | None:
        """Return the first optional window tick file."""

        return self.tick_files[0] if self.tick_files else None


@dataclass(frozen=True)
class CostStressConfig:
    """Configuration for cost stress scenarios.

    Definition:
        Stores spread multipliers and commission multipliers for engine reruns.

    Inputs example:
        CostStressConfig(spread_multipliers=[1.0, 1.5, 2.0], commission_multipliers=[1.0, 2.0])

    Expected output:
        Immutable settings used to build cost stress scenarios.
    """

    spread_multipliers: list[float]
    commission_multipliers: list[float]
    base_commission_usd_per_million: float
    base_spread_pips: float | None


@dataclass(frozen=True)
class LatencyStressConfig:
    """Configuration for engine-level latency stress.

    Definition:
        Stores execution latency delays expressed as historical tick offsets.

    Inputs example:
        LatencyStressConfig(latency_ticks=[1, 5, 10])

    Expected output:
        Immutable settings used to build latency stress rerun scenarios.
    """

    latency_ticks: list[int]


@dataclass(frozen=True)
class MonteCarloConfig:
    """Configuration for trade-ledger Monte Carlo.

    Definition:
        Stores the run count, random seed, perturbation ranges, and account balance.

    Inputs example:
        MonteCarloConfig(runs=1000, seed=42, balance=10000.0, skip_min=0.05, skip_max=0.20, slippage_pips=2.0, pnl_noise_fraction=0.10)

    Expected output:
        Immutable settings used by TradeLedgerMonteCarlo.
    """

    runs: int
    seed: int
    balance: float
    skip_min: float
    skip_max: float
    slippage_pips: float
    pnl_noise_fraction: float


@dataclass(frozen=True)
class WalkForwardConfig:
    """Configuration for walk-forward embargo windows.

    Definition:
        Stores chronological split sizes and embargo gap size in days.

    Inputs example:
        WalkForwardConfig(start_utc="2026-01-01T00:00:00Z", end_utc="2026-07-01T00:00:00Z", train_days=45, validation_days=15, test_days=15, embargo_days=2)

    Expected output:
        Immutable settings used to build walk-forward embargo windows.
    """

    start_utc: str
    end_utc: str
    train_days: int
    validation_days: int
    test_days: int
    embargo_days: int


@dataclass(frozen=True)
class GateConfig:
    """Validation threshold configuration.

    Definition:
        Stores deterministic, Monte Carlo, and robustness pass/fail thresholds.

    Inputs example:
        GateConfig(min_trades=30, min_profit_factor=1.15, max_drawdown_pct=10.0, max_daily_drawdown_pct=3.0, min_survivability=0.80)

    Expected output:
        Immutable thresholds used by verdict builders.
    """

    min_trades: int
    min_profit_factor: float
    max_drawdown_pct: float
    max_daily_drawdown_pct: float
    min_survivability: float


@dataclass(frozen=True)
class ValidationConfig:
    """Complete ValidationEngine configuration.

    Definition:
        Stores all settings required to plan or run one validation packet.

    Inputs example:
        ValidationConfig(run_name="xau_example", strategy="ExampleStrategy", ...)

    Expected output:
        Immutable configuration shared across ValidationEngine modules.
    """

    run_name: str
    strategy: str
    parameter_file: Path
    parameter_overrides: dict[str, str]
    output_root: Path
    backtest_project: Path
    timeframe: str
    max_ticks: int
    max_workers: int
    reuse_existing_reports: bool
    run_backtests: bool
    symbols: list[SymbolConfig]
    windows: list[WindowConfig]
    cost_stress: CostStressConfig
    latency_stress: LatencyStressConfig
    monte_carlo: MonteCarloConfig
    walk_forward: WalkForwardConfig
    gates: GateConfig
    existing_reports: list[Path]


def load_config(path: str | Path) -> ValidationConfig:
    """Load a ValidationEngine JSON config.

    Definition:
        Parses a JSON config and resolves paths relative to the repository root.

    Inputs example:
        load_config("ValidationEngine/Configs/XauTickValidation.example.json")

    Expected output:
        A ValidationConfig instance.
    """

    config_path: Path = Path(path).expanduser().resolve()
    repo_root: Path = find_repo_root(config_path)
    raw: dict[str, Any] = json.loads(config_path.read_text())
    return build_config(raw, repo_root)


def find_repo_root(config_path: Path) -> Path:
    """Find the repository root for a config file.

    Definition:
        Walks upward from the config path and then the current directory to find
        the engine repository root.

    Inputs example:
        find_repo_root(Path("/tmp/config.json"))

    Expected output:
        A Path containing BacktestEngine and ValidationEngine folders.
    """

    config_match = first_repo_root(config_path.parent)
    if config_match is not None:
        return config_match
    cwd_match = first_repo_root(Path.cwd())
    if cwd_match is not None:
        return cwd_match
    return config_path.parents[2]


def first_repo_root(start: Path) -> Path | None:
    """Return the first matching repository root.

    Definition:
        Checks the start path and parents for BacktestEngine and ValidationEngine folders.

    Inputs example:
        first_repo_root(Path.cwd())

    Expected output:
        A repository Path or None.
    """

    candidates = [start, *start.parents]
    matches = [path for path in candidates if (path / "BacktestEngine").exists() and (path / "ValidationEngine").exists()]
    return matches[0] if matches else None


def build_config(raw: dict[str, Any], repo_root: Path) -> ValidationConfig:
    """Build a ValidationConfig from parsed JSON.

    Definition:
        Converts raw dictionaries into typed dataclasses.

    Inputs example:
        build_config({"RunName": "xau"}, Path("/repo"))

    Expected output:
        A ValidationConfig instance.
    """

    return ValidationConfig(
        run_name=str(raw["RunName"]),
        strategy=str(raw.get("Strategy", "ExampleStrategy")),
        parameter_file=resolve_repo_path(repo_root, raw["ParameterFile"]),
        parameter_overrides=parse_parameter_overrides(raw.get("ParameterOverrides", {})),
        output_root=resolve_repo_path(repo_root, raw["OutputRoot"]),
        backtest_project=resolve_repo_path(repo_root, raw["Backtest"]["Project"]),
        timeframe=str(raw["Backtest"].get("Timeframe", "m5")),
        max_ticks=int(raw["Backtest"].get("MaxTicks", 0)),
        max_workers=max(1, int(raw["Backtest"].get("MaxWorkers", 1))),
        reuse_existing_reports=bool(raw.get("ReuseExistingReports", False)),
        run_backtests=bool(raw.get("RunBacktests", False)),
        symbols=parse_symbols(raw.get("Symbols", []), repo_root),
        windows=parse_windows(raw.get("Windows", []), repo_root),
        cost_stress=parse_cost_stress(raw.get("CostStress", {})),
        latency_stress=parse_latency_stress(raw.get("LatencyStress", {})),
        monte_carlo=parse_monte_carlo(raw.get("MonteCarlo", {})),
        walk_forward=parse_walk_forward(raw.get("WalkForward", {})),
        gates=parse_gates(raw.get("Gates", {})),
        existing_reports=parse_existing_reports(raw.get("ExistingReports", []), repo_root),
    )


def resolve_repo_path(repo_root: Path, value: str | Path) -> Path:
    """Resolve a repository-relative path.

    Definition:
        Converts absolute, home-relative, and repository-relative values to paths.

    Inputs example:
        resolve_repo_path(Path("/repo"), "data")

    Expected output:
        Path("/repo/data").
    """

    path: Path = Path(value).expanduser()
    return path if path.is_absolute() else repo_root / path


def parse_parameter_overrides(raw: dict[str, Any]) -> dict[str, str]:
    """Parse command-line parameter overrides.

    Definition:
        Converts a JSON object into BacktestEngine --param string values.

    Inputs example:
        parse_parameter_overrides({"MaxDailyLossPercent": 0.5, "UseRiskLayer": True})

    Expected output:
        {"MaxDailyLossPercent": "0.5", "UseRiskLayer": "true"}.
    """

    return {str(name): format_parameter_value(value) for name, value in raw.items()}


def format_parameter_value(value: Any) -> str:
    """Format one parameter override value.

    Definition:
        Converts JSON scalar values to strings accepted by BacktestEngine.

    Inputs example:
        format_parameter_value(True)

    Expected output:
        "true".
    """

    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def parse_symbols(items: list[dict[str, Any]], repo_root: Path) -> list[SymbolConfig]:
    """Parse symbol configuration rows.

    Definition:
        Converts raw symbol dictionaries into SymbolConfig objects.

    Inputs example:
        parse_symbols([{"Name": "XAUUSD", "TickFile": "ticks.csv", "SymbolSpec": "symbol_spec.json"}], Path("/repo"))

    Expected output:
        A list containing SymbolConfig instances.
    """

    return [
        SymbolConfig(
            name=str(item["Name"]),
            tick_files=parse_tick_files(item, repo_root),
            symbol_spec=resolve_repo_path(repo_root, item["SymbolSpec"]),
        )
        for item in items
    ]


def parse_windows(items: list[dict[str, Any]], repo_root: Path) -> list[WindowConfig]:
    """Parse date window configuration rows.

    Definition:
        Converts raw window dictionaries into WindowConfig objects.

    Inputs example:
        parse_windows([{"Name": "june", "StartUtc": "2026-06-01T00:00:00Z", "EndUtc": "2026-07-01T00:00:00Z"}], Path("/repo"))

    Expected output:
        A list containing WindowConfig instances.
    """

    return [
        WindowConfig(
            name=str(item["Name"]),
            start_utc=str(item["StartUtc"]),
            end_utc=str(item["EndUtc"]),
            tick_files=parse_optional_tick_files(item, repo_root),
            symbol_spec=optional_repo_path(repo_root, item.get("SymbolSpec")),
        )
        for item in items
    ]


def parse_tick_files(item: dict[str, Any], repo_root: Path) -> tuple[Path, ...]:
    """Parse one or more ordered tick files for continuous replay.

    `TickFiles` takes precedence over the legacy singular `TickFile` key.
    """

    values = item.get("TickFiles")
    if values is None:
        values = [item["TickFile"]]
    paths = tuple(resolve_repo_path(repo_root, value) for value in values)
    if not paths:
        raise ValueError("TickFiles must contain at least one path")
    return paths


def parse_optional_tick_files(item: dict[str, Any], repo_root: Path) -> tuple[Path, ...] | None:
    """Parse optional ordered window-specific tick files."""

    if "TickFiles" not in item and "TickFile" not in item:
        return None
    return parse_tick_files(item, repo_root)


def optional_repo_path(repo_root: Path, value: Any) -> Path | None:
    """Resolve an optional repository-relative path.

    Definition:
        Returns None for missing values and a resolved Path for present values.

    Inputs example:
        optional_repo_path(Path("/repo"), "data/ticks.csv")

    Expected output:
        A Path object or None.
    """

    if value is None:
        return None
    return resolve_repo_path(repo_root, str(value))


def parse_cost_stress(raw: dict[str, Any]) -> CostStressConfig:
    """Parse cost stress settings.

    Definition:
        Converts raw cost stress settings into CostStressConfig.

    Inputs example:
        parse_cost_stress({"SpreadMultipliers": [1.0, 2.0], "CommissionMultipliers": [1.0], "BaseCommissionUsdPerMillion": 0})

    Expected output:
        A CostStressConfig instance.
    """

    return CostStressConfig(
        spread_multipliers=[float(value) for value in raw.get("SpreadMultipliers", [1.0])],
        commission_multipliers=[float(value) for value in raw.get("CommissionMultipliers", [1.0])],
        base_commission_usd_per_million=float(raw.get("BaseCommissionUsdPerMillion", 0.0)),
        base_spread_pips=optional_float(raw.get("BaseSpreadPips")),
    )


def optional_float(value: Any) -> float | None:
    """Convert an optional JSON numeric value to float."""

    return None if value is None else float(value)


def parse_latency_stress(raw: dict[str, Any]) -> LatencyStressConfig:
    """Parse latency stress settings.

    Definition:
        Converts raw latency stress settings into LatencyStressConfig.

    Inputs example:
        parse_latency_stress({"LatencyTicks": [1, 5]})

    Expected output:
        A LatencyStressConfig instance.
    """

    return LatencyStressConfig(latency_ticks=[int(value) for value in raw.get("LatencyTicks", [1, 5, 10])])


def parse_monte_carlo(raw: dict[str, Any]) -> MonteCarloConfig:
    """Parse Monte Carlo settings.

    Definition:
        Converts raw Monte Carlo settings into MonteCarloConfig.

    Inputs example:
        parse_monte_carlo({"Runs": 1000, "Seed": 42})

    Expected output:
        A MonteCarloConfig instance.
    """

    return MonteCarloConfig(
        runs=int(raw.get("Runs", 1000)),
        seed=int(raw.get("Seed", 42)),
        balance=float(raw.get("Balance", 10000.0)),
        skip_min=float(raw.get("SkipMin", 0.05)),
        skip_max=float(raw.get("SkipMax", 0.20)),
        slippage_pips=float(raw.get("SlippagePips", 2.0)),
        pnl_noise_fraction=float(raw.get("PnlNoiseFraction", 0.10)),
    )


def parse_walk_forward(raw: dict[str, Any]) -> WalkForwardConfig:
    """Parse walk-forward embargo settings.

    Definition:
        Converts raw walk-forward settings into WalkForwardConfig.

    Inputs example:
        parse_walk_forward({"StartUtc": "2026-01-01T00:00:00Z", "EndUtc": "2026-07-01T00:00:00Z"})

    Expected output:
        A WalkForwardConfig instance.
    """

    return WalkForwardConfig(
        start_utc=str(raw.get("StartUtc", "2026-01-01T00:00:00Z")),
        end_utc=str(raw.get("EndUtc", "2026-07-01T00:00:00Z")),
        train_days=int(raw.get("TrainDays", 45)),
        validation_days=int(raw.get("ValidationDays", 15)),
        test_days=int(raw.get("TestDays", 15)),
        embargo_days=int(raw.get("EmbargoDays", 2)),
    )


def parse_gates(raw: dict[str, Any]) -> GateConfig:
    """Parse validation gates.

    Definition:
        Converts raw threshold settings into GateConfig.

    Inputs example:
        parse_gates({"MinTrades": 30, "MinProfitFactor": 1.15})

    Expected output:
        A GateConfig instance.
    """

    return GateConfig(
        min_trades=int(raw.get("MinTrades", 30)),
        min_profit_factor=float(raw.get("MinProfitFactor", 1.15)),
        max_drawdown_pct=float(raw.get("MaxDrawdownPct", 10.0)),
        max_daily_drawdown_pct=float(raw.get("MaxDailyDrawdownPct", 3.0)),
        min_survivability=float(raw.get("MinSurvivability", 0.80)),
    )


def parse_existing_reports(items: list[str], repo_root: Path) -> list[Path]:
    """Parse optional existing report paths.

    Definition:
        Converts report path strings into repository-resolved Path objects.

    Inputs example:
        parse_existing_reports(["report.json"], Path("/repo"))

    Expected output:
        A list of resolved report paths.
    """

    return [resolve_repo_path(repo_root, item) for item in items]
