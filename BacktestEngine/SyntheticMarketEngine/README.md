# Synthetic market engine

The runtime generator is implemented in `src/BacktestEngine.Run/SyntheticMarket.cs`.
It streams deterministic bid/ask ticks through the normal replay execution paths.
Models and scenarios here describe market generation, not a strategy.

```sh
dotnet run --project BacktestEngine/src/BacktestEngine.Run -- \
  --strategy ExampleStrategy --params BacktestEngine/examples/example.cbotset \
  --symbol XAUUSD --symbol-spec /path/XAUUSD.economic-symbol.v2.json \
  --synthetic-model BacktestEngine/SyntheticMarketEngine/models/xauusd-default.json \
  --synthetic-duration 1d --synthetic-seed 48271 --synthetic-record runs/ticks.csv \
  --report-json runs/synthetic.json
```

For profiles bound to a native endpoint, supply the matching exclusive `--end-utc`.
Use `smoke_test.py --symbol-spec /path/profile.json --end-utc <matching-end>` to
compare 20,000 generated ticks with their saved-stream replay after a Release build.
This verifies replay consistency, not real-market profitability.
