#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent
RUN_PROJECT = REPO_ROOT / "BacktestEngine" / "src" / "BacktestEngine.Run" / "BacktestEngine.Run.csproj"


def dotnet_command() -> str:
    configured = os.environ.get("DOTNET_BIN")
    if configured:
        return configured
    bundled = Path("/usr/local/share/dotnet/dotnet")
    if bundled.exists():
        return str(bundled)
    found = shutil.which("dotnet")
    if found:
        return found
    raise SystemExit("dotnet was not found. Install .NET SDK or set DOTNET_BIN.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a backtest with BacktestEngine.Run. Arguments after -- are passed to the engine runner."
    )
    parser.add_argument("--skip-build", action="store_true", help="Pass --no-build to dotnet run.")
    parser.add_argument("engine_args", nargs=argparse.REMAINDER, help="Arguments forwarded to BacktestEngine.Run.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    forwarded = list(args.engine_args)
    if forwarded and forwarded[0] == "--":
        forwarded = forwarded[1:]

    command = [dotnet_command(), "run", "--project", str(RUN_PROJECT)]
    if args.skip_build:
        command.append("--no-build")
    command.append("--")
    command.extend(forwarded)

    return subprocess.call(command, cwd=str(REPO_ROOT))


if __name__ == "__main__":
    raise SystemExit(main())
