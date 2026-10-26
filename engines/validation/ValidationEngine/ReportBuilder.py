"""Final report builder for ValidationEngine.

Definition:
    Writes JSON and Markdown artifacts for planned or executed validation runs.

Inputs example:
    write_validation_outputs(output_dir, payload)

Expected output:
    FinalReport.md and FinalVerdict.json files in the validation run folder.
"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
import json
from pathlib import Path
from typing import Any

from ValidationEngine.BacktestRunner import BacktestRunResult
from ValidationEngine.Reports.CombinedReport import CombinedReport


def write_validation_outputs(output_dir: Path, payload: dict[str, Any]) -> None:
    """Write final validation artifacts.

    Definition:
        Serializes the validation payload to JSON and Markdown.

    Inputs example:
        write_validation_outputs(Path("run"), {"RunName": "xau"})

    Expected output:
        FinalVerdict.json and FinalReport.md files.
    """

    output_dir.mkdir(parents=True, exist_ok=True)
    write_json(output_dir / "FinalVerdict.json", payload)
    (output_dir / "FinalReport.md").write_text(build_markdown(payload))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON with safe object conversion.

    Definition:
        Converts dataclasses and paths into JSON-safe values before writing.

    Inputs example:
        write_json(Path("FinalVerdict.json"), payload)

    Expected output:
        A JSON file on disk.
    """

    path.write_text(json.dumps(to_jsonable(payload), indent=2, sort_keys=True))


def to_jsonable(value: Any) -> Any:
    """Convert Python objects to JSON-safe values.

    Definition:
        Recursively converts dataclasses, paths, dictionaries, and lists.

    Inputs example:
        to_jsonable(Path("file"))

    Expected output:
        JSON-compatible data.
    """

    if is_dataclass(value):
        return to_jsonable(asdict(value))
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [to_jsonable(item) for item in value]
    return value


def build_markdown(payload: dict[str, Any]) -> str:
    """Build final Markdown report.

    Definition:
        Creates a compact human-readable validation report.

    Inputs example:
        build_markdown(payload)

    Expected output:
        A Markdown string.
    """

    lines = [
        f"# Validation Report - {payload.get('run_name', 'unknown')}",
        "",
        "## Verdict",
        "",
        f"- Status: `{payload.get('verdict', {}).get('status', 'UNPROVEN')}`",
        f"- Failed: `{', '.join(payload.get('verdict', {}).get('failed', [])) or 'none'}`",
        f"- Unproven: `{', '.join(payload.get('verdict', {}).get('unproven', [])) or 'none'}`",
        "",
        "## Planned Scenarios",
        "",
        *scenario_lines(payload.get("run_results", [])),
        "",
        "## Combined Report",
        "",
        *combined_lines(payload.get("combined_report")),
        "",
        "## Latency Stress",
        "",
        *combined_lines(payload.get("latency_report")),
        "",
        "## Walk-Forward Backtests",
        "",
        *combined_lines(payload.get("walk_forward_report")),
        "",
        "## Monte Carlo",
        "",
        f"- Source ledger: `{payload.get('monte_carlo_source_report') or 'none'}`",
        *monte_carlo_lines(payload.get("monte_carlo")),
    ]
    return "\n".join(lines) + "\n"


def scenario_lines(results: list[BacktestRunResult] | list[dict[str, Any]]) -> list[str]:
    """Build scenario Markdown lines.

    Definition:
        Converts run result rows into Markdown bullets.

    Inputs example:
        scenario_lines([result])

    Expected output:
        A list of Markdown strings.
    """

    if not results:
        return ["_No scenarios planned._"]
    return [scenario_line(row) for row in results]


def scenario_line(row: BacktestRunResult | dict[str, Any]) -> str:
    """Build one scenario Markdown line.

    Definition:
        Formats one planned or executed scenario.

    Inputs example:
        scenario_line(result)

    Expected output:
        A Markdown bullet string.
    """

    data = to_jsonable(row)
    return f"- `{data['name']}` status `{data['status']}` report `{data['report_path']}`"


def combined_lines(report: CombinedReport | dict[str, Any] | None) -> list[str]:
    """Build combined report Markdown lines.

    Definition:
        Formats aggregate deterministic report metrics.

    Inputs example:
        combined_lines(combined_report)

    Expected output:
        A list of Markdown strings.
    """

    if report is None:
        return ["_No combined report available._"]
    data = to_jsonable(report)
    return [
        f"- Trades: `{data['total_trades']}`",
        f"- Net profit: `{data['net_profit']}`",
        f"- Profit factor: `{data['profit_factor']}`",
        f"- Positive reports: `{data['positive_report_count']} / {data['report_count']}`",
    ]


def monte_carlo_lines(result: dict[str, Any] | None) -> list[str]:
    """Build Monte Carlo Markdown lines.

    Definition:
        Formats per-method Monte Carlo summary rows.

    Inputs example:
        monte_carlo_lines({"summary": []})

    Expected output:
        A list of Markdown strings.
    """

    if result is None:
        return ["_No Monte Carlo result available._"]
    rows = result.get("summary", [])
    if not rows:
        return ["_No Monte Carlo summary rows._"]
    return [f"- `{row['method']}` survivability `{row['survivability_probability']}` p05 net `{row['net_p05']}`" for row in rows]
