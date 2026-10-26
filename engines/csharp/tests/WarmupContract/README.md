# Independent startup history regression

Run `dotnet run --project BacktestEngine/tests/WarmupContract -- --symbol-spec /path/economic-symbol.v2.json`
with an existing authenticated economic specification. The real first-tick
pipeline requires this contract even though this test places no orders.

The harness exercises the real runner parser, history loader and first tick.
It verifies independent M1/M5/M15/H1 histories, exact OHLC preservation, startup
visibility, causal callback timing, and rejection of duplicate, reversed, current
or future bars. These tests do not claim the files match a particular broker.

Runner example:

```text
--warmup-series h1=/path/native-h1.csv --warmup-series m15=/path/native-m15.csv
```

The CSV columns are `time_utc,open,high,low,close`. Each timeframe requires its
own captured series; only bars before the first replay event are accepted.
Do not combine this option with `--warmup-bars`. In optimizer scenarios use
`"warmup_series": { "h1": "native-h1.csv", "m15": "native-m15.csv" }`.
