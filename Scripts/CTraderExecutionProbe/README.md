# CTraderExecutionProbe

`CTraderExecutionProbe` is a diagnostic cBot for cTrader parity work.

It opens one deterministic market position and closes it after a configured number of bars, while cTrader produces the authoritative backtest `report.json`.

## Purpose

Use this probe before testing ExampleStrategy trade parity. It answers basic execution questions:

- Does cTrader fill buy market orders at ask?
- Does cTrader fill sell market orders at bid?
- How does cTrader report entry price, close price, pips, commissions, gross PnL, and net PnL?
- What `Position.CurrentPrice` and close reason does cTrader expose when SL/TP closes a position?
- What does cTrader put in `history.items` for a simple closed position?

## Build

```bash
/usr/local/share/dotnet/dotnet build Scripts/CTraderExecutionProbe/CTraderExecutionProbe.csproj
```

The cTrader SDK writes an `.algo` file under `bin/Debug/net6.0/`.

## Suggested cTrader CLI Scenario

Run two tiny scenarios:

- Buy, close after one m1 bar.
- Sell, close after one m1 bar.

Suggested settings:

```text
symbol: XAUUSD
period: m1
data-mode: tick data from server or m1, depending on the behavior being tested
balance: 10000
commission: 6.57
spread: 0 for tick-data bid/ask replay, or fixed spread for deterministic bar tests
```

Parameters:

```json
{
  "Parameters": {
    "OutputDirectory": "BacktestEngineExecutionProbe",
    "Side": 0,
    "VolumeInUnits": 1.0,
    "OpenOnBar": 1,
    "CloseAfterBars": 1,
    "StopLossPips": 0.0,
    "TakeProfitPips": 0.0,
    "StopAfterClose": true,
    "MaxBars": 20
  }
}
```

`Side` values:

- `0`: buy.
- `1`: sell.

## Outputs

The cBot writes:

- `events.csv`
- `execution_probe.json`

Important `events.csv` columns:

- `bid` and `ask`: cTrader's visible symbol prices when the event is logged.
- `entry_price`: cTrader's filled entry price for an open position.
- `current_price`: cTrader's `Position.CurrentPrice`; for captured m1 protected exits this matched the report close price.
- `pips`, `gross`, `commissions`, and `net`: cTrader's live position accounting at the event.
- `bar_open`, `bar_high`, `bar_low`, and `bar_close`: the current forming bar values visible at the event.
- `previous_bar_open`, `previous_bar_high`, `previous_bar_low`, and `previous_bar_close`: the last closed bar values visible at the event.
- `close_reason`: cTrader's `PositionClosedEventArgs.Reason` for `closed` events.

cTrader CLI should also write:

- `report.json`
- `report.html`

Feed the cTrader `report.json` and the BacktestEngine report into `BacktestEngine.ReportComparator`.
