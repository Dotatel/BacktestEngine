# Native M1 execution contract

Run `dotnet run --project BacktestEngine/tests/NativeMinuteContract -- --symbol-spec /path/XAUUSD.economic-symbol.v2.json`.

These cases reproduce observed cTrader server-M1 behavior from controlled probes
on 10 January 2025. The short initial OHLC sequence and fill expectations come
from `xauusd-server-m1-protection3`; the both-touch cases come from
`xauusd-server-m1-bull-both-touch` and the bearish/reversed-order probes. Terminal
fill expectations and its preceding initialization bar come from
`xauusd-server-m1-terminal-protection`. Original captures are retained under
`/tmp/ctrader-parity-repair-20261004/probes` for this audit.

The contract is one callback tick per minute, Tick before Bar, completed prior
minute OHLC visible at the next callback, and SL-before-TP range-based protection
filled at bar extrema. The first open initializes startup; final-bar hidden fills
appear in the ledger without delivering closed callbacks before OnStop.
The full-period optimizer replay added a same-side protection-book regression:
native cTrader processes sorted mutable books, skipping the adjacent protection
after removal. That protection can fill at the next opening quote at the same
timestamp, or the next completed minute range. Tests retain both observed paths.
The independent `xauusd-m1-multiple-equal-protection` native probe supplies a
neutral eight-position regression across several minutes, including same-level
ID ordering, skipped neighbors, SL-before-TP phases and the next-opening fill.
The neutral `xauusd-m1-weekend-opening-rollover` probe also establishes that
gap-opening protections run before deferred swaps: its opening-quote close pays
no Friday swap, while the position surviving that quote receives its swap before
closing on the following minute range.

These tests cover the observed execution semantics. They do not establish the
98% multi-symbol strategy parity target or historical commission/swap validity.
# Tick rollover boundary regression

The shared replay contract also checks a native XAUUSD observation from
25 June 2026: a short opened at 20:00:00.106 and stopped at 4040 on the first
quote after the daily break, at 22:00:10.838. Native cTrader assigned zero swap.
Protective execution must precede deferred rollover in tick mode as well as
native M1 mode; positions surviving the opening quote still accrue swap.
`VerifyTickOpeningBeforeSwap` retains the opening/last-before-break/first-after-
break quotes and checks both the stopped short and a surviving long.

## Native report sampling regression

`equity-sampling-probe.json` contains 459 observed XAUUSD quote/equity samples
from a native two-position hedge on 2 June 2026. The contract checks each observed
account equity, including the crossed quote, then checks the native report's
absolute/percentage equity and balance drawdown. It uses the four observed
$0.11 fills as an isolated fee fixture; the full strategy suite independently
validates its June-30 economic authorities.

The native report samples adverse bid/ask extremes and individual deal events.
It can therefore differ from a full tick-by-tick equity path. The engine retains
both: `native_report_drawdown` for native reporting/optimizer compatibility,
and the original `drawdown`, daily drawdown and risk-path fields for full replay
risk. Explicit `--metrics-start-utc` sub-windows use the original bounded metrics.
