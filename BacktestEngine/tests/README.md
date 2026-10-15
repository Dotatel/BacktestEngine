# Execution contracts

Portable checks: `python3 BacktestEngine/test.py`.

Additional checks require validated profiles and their cost authorities:

```sh
dotnet run --project BacktestEngine/tests/WarmupContract -- --symbol-spec /path/XAUUSD.json
dotnet run --project BacktestEngine/tests/NativeMinuteContract -- --symbol-spec /path/XAUUSD.json
dotnet run --project BacktestEngine/tests/ProtectionParity -- --symbol-spec /path/XAUUSD.json --symbol-spec /path/EURUSD.json
dotnet run --project BacktestEngine/tests/CommissionParity -- --symbol-spec /path/XAUUSD.json --runner BacktestEngine/src/BacktestEngine.Run/bin/Debug/net10.0/BacktestEngine.Run.dll
```

Native fixture observations in these tests describe bounded mechanical behavior.
No full-strategy historical qualification is claimed by this export.
