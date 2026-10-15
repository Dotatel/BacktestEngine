#!/usr/bin/env python3
"""Generate ticks in-process, replay the recording, and assert economic parity."""

from __future__ import annotations

import json
import argparse
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DLL = ROOT / "BacktestEngine/src/BacktestEngine.Run/bin/Release/net10.0/BacktestEngine.Run.dll"
PARAMS = ROOT / "BacktestEngine/examples/example.cbotset"
MODEL = ROOT / "BacktestEngine/SyntheticMarketEngine/models/xauusd-default.json"
DOTNET = "/usr/local/share/dotnet/dotnet"
PARITY_KEYS = ("account", "drawdown", "risk_path", "open_risk", "trade_statistics", "trades", "open_positions")


def run(argv: list[str]) -> None:
    result = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        raise RuntimeError(f"Local replay failed ({result.returncode}):\n{result.stdout[-4000:]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbol-spec", required=True, type=Path, help="Validated XAUUSD economic-symbol.v2 profile")
    parser.add_argument("--runner-dll", type=Path, default=DLL)
    parser.add_argument("--params", type=Path, default=PARAMS)
    parser.add_argument("--start-utc", default="2026-06-25T00:00:00Z")
    parser.add_argument("--end-utc", help="Required matching exclusive endpoint for an endpoint-bound fee profile")
    args = parser.parse_args()
    if not args.runner_dll.exists():
        raise SystemExit(f"Build the ExampleStrategy runner first: missing {args.runner_dll}")

    with tempfile.TemporaryDirectory(prefix="ExampleStrategy-synthetic-smoke-") as directory:
        target = Path(directory)
        ticks = target / "ticks.csv"
        generated_report = target / "generated.json"
        replayed_report = target / "replayed.json"
        common = [
            DOTNET,
            str(args.runner_dll.resolve()),
            "--strategy", "ExampleStrategy",
            "--params", str(args.params.resolve()),
            "--symbol", "XAUUSD",
            "--period", "m5",
            "--symbol-spec", str(args.symbol_spec.resolve()),
            "--start-utc", args.start_utc,
            "--skip-equity-csv",
        ]
        if args.end_utc:
            common += ["--end-utc", args.end_utc]
        run(common + [
            "--synthetic-model", str(MODEL),
            "--synthetic-duration", "1d",
            "--synthetic-ticks", "20000",
            "--synthetic-seed", "48271",
            "--synthetic-record", str(ticks),
            "--report-json", str(generated_report),
        ])
        run(common + ["--ticks", str(ticks), "--report-json", str(replayed_report)])

        generated = json.loads(generated_report.read_text())
        replayed = json.loads(replayed_report.read_text())
        mismatches = [key for key in PARITY_KEYS if generated.get(key) != replayed.get(key)]
        replay_fields = ("ticks_or_synthetic_ticks", "on_bar_count", "chart_bar_count", "hour_bar_count", "first_time_utc", "last_time_utc")
        mismatches.extend(
            f"replay.{key}"
            for key in replay_fields
            if generated["replay"].get(key) != replayed["replay"].get(key)
        )
        if mismatches:
            raise SystemExit("Synthetic saved-stream parity failed: " + ", ".join(mismatches))
        if generated["synthetic"]["generated_ticks"] != 20000:
            raise SystemExit("Synthetic generator did not produce the requested tick count")
        print("PASS: 20,000 streamed ticks replay with exact economic and bar parity")


if __name__ == "__main__":
    main()
