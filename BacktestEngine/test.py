#!/usr/bin/env python3
"""Build the portable engines and run their data-independent contract tests."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
dotnet = os.environ.get("DOTNET_BIN") or shutil.which("dotnet")
if not dotnet and Path("/usr/local/share/dotnet/dotnet").exists():
    dotnet = "/usr/local/share/dotnet/dotnet"
if not dotnet:
    raise SystemExit("Install .NET 10 or set DOTNET_BIN.")
def run(command, env=None):
    subprocess.run(command, cwd=ROOT, env=env, check=True)
for project in sorted((ROOT / "BacktestEngine/src").glob("*/*.csproj")):
    run([dotnet, "build", str(project), "--nologo", "-v:q"])
run([dotnet, "run", "--project", "BacktestEngine/tests/OptimizerContract"])
run([sys.executable, "-m", "unittest", "discover", "-s", "BacktestEngine/validation/TradeParity", "-p", "test_*.py"])
env = dict(os.environ, PYTHONPATH=str(ROOT / "ValidationEngine"))
run([sys.executable, "-m", "unittest", "discover", "-s", "ValidationEngine/Tests", "-p", "test_*.py"], env)
print("PASS: portable engine builds and contract tests")
