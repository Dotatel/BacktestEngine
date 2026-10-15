# BacktestEngine

Reusable source-linked cBot replay and validation tools. Requires .NET 10 and Python 3.11+.
The local `cAlgo.API` shim implements a bounded subset of cTrader behavior; arbitrary
compiled `.algo` files are not supported. The included strategy is a mechanical example.

## Included tools

- `BacktestEngine/src/BacktestEngine.Run`: tick/bar replay, explicit costs, execution latency,
  synthetic bid/ask generation, marked-to-market reporting and provenance.
- `BacktestEngine/src/BacktestEngine.Optimizer`: grid/random parameter search with replay-aware caching.
- `BacktestEngine/src/BacktestEngine.MonteCarlo`: trade-ledger robustness analysis.
- `ValidationEngine`: spread/commission/latency stress, Monte Carlo, random windows,
  walk-forward embargoes and evidence gates.
- `BacktestEngine/validation`: report comparison, economic-contract construction and neutral native probes.
- `Scripts`: standalone native cTrader data-export and execution probes.

## Build and check

```sh
python3 BacktestEngine/test.py
dotnet run --project BacktestEngine/src/BacktestEngine.Run -- --help
```

The test command builds every engine project, runs optimizer contracts and Python
validation/comparator tests. Additional economic execution tests require your own
validated symbol profiles; see `BacktestEngine/tests/README.md`.

## Replay

```sh
python3 RunEngineBacktest.py -- \
  --strategy ExampleStrategy --params BacktestEngine/examples/example.cbotset \
  --symbol XAUUSD --period m5 --ticks /path/ticks.csv \
  --symbol-spec /path/XAUUSD.economic-symbol.v2.json \
  --start-utc 2026-06-01T00:00:00Z --end-utc 2026-07-01T00:00:00Z \
  --report-json runs/example/report.json
```

Supply recorded UTC bid/ask ticks and a validated `economic-symbol.v2` profile with
its referenced cost authorities. Dates use an inclusive start and exclusive end.
Endpoint-bound commission profiles require the matching end date. Broker data,
credentials, account captures, generated reports and deployment code are external inputs.

## Add a strategy

Add a `Robot` subclass and source-link it in `BacktestEngine.Run.csproj` as shown by
`BacktestEngine/examples/ExampleStrategy.cs`. Registration discovers subclasses in
the runner assembly; select one with `--strategy`. Compile additional strategy sources
and resources explicitly. No native strategy source or trained strategy model is bundled.

## Validation

Edit `ValidationEngine/Configs/XauTickValidation.example.json` with your data/profile
paths and frozen parameters, then run:

```sh
PYTHONPATH=ValidationEngine python3 -m ValidationEngine.Cli \
  --config ValidationEngine/Configs/XauTickValidation.example.json --dry-run
```

Remove `--dry-run` to execute. Missing evidence is unproven. A frozen test pass,
optimizer result or synthetic replay does not establish profitability or universal
native cTrader parity. Strategy-specific historical qualification reports are not bundled.
