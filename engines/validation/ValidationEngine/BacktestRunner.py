"""BacktestEngine command builder and runner.

Definition:
    Converts validation scenarios into BacktestEngine.Run commands and optionally executes them.

Inputs example:
    result = run_scenario(config, scenario, dry_run=True)

Expected output:
    A BacktestRunResult with command, report path, and execution status.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import shutil
import subprocess

from ValidationEngine.Config import ValidationConfig
from ValidationEngine.Robustness.ScenarioMatrix import BacktestScenario


@dataclass(frozen=True)
class BacktestRunResult:
    """Result of a BacktestEngine scenario run.

    Definition:
        Stores command details and process result information.

    Inputs example:
        BacktestRunResult(name="XAUUSD_june", command=["dotnet"], report_path=Path("report.json"), exit_code=0, status="completed")

    Expected output:
        Immutable run result used by report builders.
    """

    name: str
    command: list[str]
    report_path: Path
    exit_code: int | None
    status: str
    stdout: str
    stderr: str


def build_command(config: ValidationConfig, scenario: BacktestScenario) -> list[str]:
    """Build a BacktestEngine.Run command.

    Definition:
        Creates the dotnet command for one scenario without executing it.

    Inputs example:
        build_command(config, scenario)

    Expected output:
        A list of command tokens.
    """

    command = [
        "dotnet",
        "run",
        "--project",
        str(config.backtest_project),
        "--",
        "--strategy",
        config.strategy,
        "--params",
        str(config.parameter_file),
        "--symbol",
        scenario.symbol,
        "--timeframe",
        config.timeframe,
    ]
    command = append_tick_files(command, scenario.tick_files)
    command += [
        "--symbol-spec",
        str(scenario.symbol_spec),
        "--start-utc",
        scenario.start_utc,
        "--end-utc",
        scenario.end_utc,
        "--commission-usd-per-million",
        str(scenario.commission_usd_per_million),
        "--report-json",
        str(scenario.report_path),
        "--skip-equity-csv",
    ]
    command = append_spread(command, scenario.spread_multiplier, scenario.spread_pips)
    command = append_max_ticks(command, config.max_ticks)
    command = append_latency(command, scenario.execution_latency_ticks)
    return append_parameter_overrides(command, config.parameter_overrides)


def append_tick_files(command: list[str], tick_files: tuple[Path, ...]) -> list[str]:
    """Append repeatable ordered tick inputs for one continuous replay."""

    for tick_file in tick_files:
        command += ["--ticks", str(tick_file)]
    return command


def append_spread(command: list[str], multiplier: float, spread_pips: float | None) -> list[str]:
    """Append either a fixed spread or recorded-spread multiplier."""

    if spread_pips is not None:
        return command + ["--spread-pips", str(spread_pips)]
    return command + ["--spread-multiplier", str(multiplier)]


def append_max_ticks(command: list[str], max_ticks: int) -> list[str]:
    """Append max tick limit when configured.

    Definition:
        Adds --max-ticks to a command only when the limit is positive.

    Inputs example:
        append_max_ticks(["dotnet"], 50000)

    Expected output:
        A command list with optional max tick tokens.
    """

    if max_ticks <= 0:
        return command
    return command + ["--max-ticks", str(max_ticks)]


def append_parameter_overrides(command: list[str], parameter_overrides: dict[str, str]) -> list[str]:
    """Append cBot parameter overrides.

    Definition:
        Adds repeatable --param Name=Value tokens to a BacktestEngine command.

    Inputs example:
        append_parameter_overrides(["dotnet"], {"MaxDailyLossPercent": "0.5"})

    Expected output:
        ["dotnet", "--param", "MaxDailyLossPercent=0.5"].
    """

    for name, value in sorted(parameter_overrides.items()):
        command = command + ["--param", f"{name}={value}"]
    return command


def append_latency(command: list[str], execution_latency_ticks: int) -> list[str]:
    """Append execution latency when configured.

    Definition:
        Adds --execution-latency-ticks to BacktestEngine commands for delayed-fill stress.

    Inputs example:
        append_latency(["dotnet"], 5)

    Expected output:
        ["dotnet", "--execution-latency-ticks", "5"].
    """

    if execution_latency_ticks <= 0:
        return command
    return command + ["--execution-latency-ticks", str(execution_latency_ticks)]


def run_scenario(
    config: ValidationConfig,
    scenario: BacktestScenario,
    dry_run: bool,
) -> BacktestRunResult:
    """Run or plan one BacktestEngine scenario.

    Definition:
        Executes one scenario unless dry_run is true.

    Inputs example:
        run_scenario(config, scenario, dry_run=True)

    Expected output:
        A BacktestRunResult with status "planned", "completed", or "failed".
    """

    command = build_command(config, scenario)
    if dry_run:
        return planned_result(scenario, command)
    if config.reuse_existing_reports and scenario.report_path.exists():
        return existing_report_result(scenario, command)
    if shutil.which("dotnet") is None:
        return missing_dotnet_result(scenario, command)
    return execute_command(scenario, command)


def existing_report_result(scenario: BacktestScenario, command: list[str]) -> BacktestRunResult:
    """Return a completed result for an explicitly reusable report."""

    return BacktestRunResult(
        scenario.name,
        command,
        scenario.report_path,
        0,
        "completed",
        "Reused existing report.",
        "",
    )


def planned_result(scenario: BacktestScenario, command: list[str]) -> BacktestRunResult:
    """Create a planned run result.

    Definition:
        Represents a command that was intentionally not executed.

    Inputs example:
        planned_result(scenario, ["dotnet"])

    Expected output:
        A BacktestRunResult with status "planned".
    """

    return BacktestRunResult(scenario.name, command, scenario.report_path, None, "planned", "", "")


def missing_dotnet_result(scenario: BacktestScenario, command: list[str]) -> BacktestRunResult:
    """Create a missing-dotnet run result.

    Definition:
        Represents a scenario that cannot run because dotnet is unavailable.

    Inputs example:
        missing_dotnet_result(scenario, ["dotnet"])

    Expected output:
        A BacktestRunResult with status "unproven_missing_dotnet".
    """

    return BacktestRunResult(scenario.name, command, scenario.report_path, None, "unproven_missing_dotnet", "", "dotnet was not found")


def execute_command(scenario: BacktestScenario, command: list[str]) -> BacktestRunResult:
    """Execute one BacktestEngine command.

    Definition:
        Runs a subprocess and captures stdout and stderr.

    Inputs example:
        execute_command(scenario, ["dotnet", "--version"])

    Expected output:
        A BacktestRunResult with process output and exit code.
    """

    scenario.report_path.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.run(command, check=False, text=True, capture_output=True)
    status = "completed" if process.returncode == 0 else "failed"
    return BacktestRunResult(
        scenario.name,
        command,
        scenario.report_path,
        process.returncode,
        status,
        process.stdout,
        process.stderr,
    )
