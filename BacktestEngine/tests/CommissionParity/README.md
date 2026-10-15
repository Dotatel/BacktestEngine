# Native commission authority regression

```sh
dotnet build BacktestEngine/src/BacktestEngine.Run/BacktestEngine.Run.csproj
dotnet run --project BacktestEngine/tests/CommissionParity/CommissionParity.csproj -- \
  --symbol-spec /path/to/XAUUSD.native-20260630.json \
  --runner BacktestEngine/src/BacktestEngine.Run/bin/Debug/net10.0/BacktestEngine.Run.dll
```

The suite replays the authority's controlled native opening and closing quotes through the actual engine API. It checks both sides and every recorded volume, including the volumes held out from calibration: fill times, entry and round-trip commissions, gross profit, weekend swaps, and net profit. The XAUUSD fixture passed 147 assertions across 12 native positions.

Additional checks verify:

- A same-rate clone preserves the fixed conversion and native end date; a changed commission rate requires a new calibration.
- The runner requires the exact exclusive end timestamp corresponding to the native end date, including rejection of an intraday cutoff on that date.
- All transitive source files are hash checked, including the native symbol capture.
- Correct hashes do not excuse inconsistent schema, symbol, commission model/rate, account precision, report end date, observed fees, or inferred rounding interval.
- The optimizer fingerprint changes when any raw fee event, report or symbol capture changes. Cyclic authority links through a symlink terminate safely.

These tests qualify a supplied, dated native calibration. They do not establish a universal historical currency-conversion model or justify reusing that calibration for another endpoint or commission rate.
