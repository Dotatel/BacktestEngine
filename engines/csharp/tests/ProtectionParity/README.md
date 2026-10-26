# Native protection price regression

```sh
dotnet run --project BacktestEngine/tests/ProtectionParity/ProtectionParity.csproj -- \
  --symbol-spec /path/to/XAUUSD.economic-symbol.v2.json \
  --symbol-spec /path/to/EURUSD.economic-symbol.v2.json
```

These tests cover the actual order and stop/target execution paths, using ten native cTrader observations captured on 2025-01-10 with the backtest-only `NativeParityProbe`. The checked-in fixture records the probe artifact hash, executable quotes, requested pips, and native returned protection prices. Raw native prices are retained alongside their displayed price precision.

Observed behavior:

- XAUUSD distances of 9.65 and 9.74 pips become 0.97 in price; 9.75 and 9.76 become 0.98.
- EURUSD 9.75 pips becomes 0.00098 in price.
- The distance is rounded before adding or subtracting the entry price. For a buy at 2670.18, a 9.65-pip stop is 2669.21. Rounding the final raw absolute price would incorrectly produce 2669.22.
- The absolute threshold retains the binary result of entry plus or minus the rounded distance. A neutral EURUSD probe opened at 1.05161 with a 57.1-pip stop, producing the raw threshold 1.0458999999999998. It remained open at displayed quotes 1.04590 and closed at 1.04588. Rounding the absolute threshold executes too early.
- Rounding the distance also fixes the recorded protection regression: entry 2638.40 plus rounded distance 0.97 equals 2639.37, which fills at 21:44:19.493. The old unrounded distance delayed the fill until 21:44:19.620 at 2639.40.

The suite checks buy/sell stops and targets against raw native thresholds, preserves market fills when a tick gaps beyond a level, and separately verifies level-fill mode. It does not round executable bid/ask quotes. It does not qualify swap calculations or changes to absolute protection prices through modification APIs.

Three native tick tapes add twenty-four positions with equal and staggered protection levels and a quote triggering both sell stops and buy targets. They establish nearest-price ordering, descending position IDs at equal prices, sell-stop processing before buy targets, and the native mutable-book traversal that skips the next adjacent order after a fill until another quote arrives. The tapes retain executable quotes and native exit times/prices, including the skipped target that subsequently exits at its stop.

The suite also checks entry and exit quote fields, including native-M1 fills at the raw high/low quote while the callback-visible quote stays unchanged. Unsupported partial closes and invalid close volumes must fail without changing balances, position volume, fees or history; an explicit full-volume close stays supported. The current suite passes 289 assertions. The opposite-direction cross-book ordering and full-run parity remain separate acceptance checks; these deterministic and native fixtures establish the covered protection semantics.
