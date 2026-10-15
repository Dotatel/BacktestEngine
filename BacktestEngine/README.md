# Replay engine

See the [repository guide](../README.md) for builds, replay inputs, reports and strategy registration.
Use `python3 BacktestEngine/test.py` for the portable checks.

`drawdown` retains full replay-path risk. `native_report_drawdown` separately models
native report sampling and can differ. Open positions remain marked in reports.
Tick replay preserves observed bid/ask spreads by default. Bar replay requires an
explicit source timeframe, spread and deliberate bar-price mode.
