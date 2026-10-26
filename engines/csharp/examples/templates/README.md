# Launcher robot templates

Four documented educational robot sources for the desktop launcher and
`createProject({ template })`. Each file is self-contained, compiles through the
engine's source bridge against the local cAlgo shim, and duplicates only the
small indicator helpers it needs. There is no shared indicator framework and no
profitability, qualification or native-parity claim.

| Template key | Source file (repository-relative) | Robot type |
| --- | --- | --- |
| `mechanical` (default, pre-existing) | `BacktestEngine/examples/ExampleStrategy.cs` | `ExampleStrategy` |
| `ema-pullback` | `BacktestEngine/examples/templates/EmaPullbackStrategy.cs` | `EmaPullbackStrategy` |
| `breakout` | `BacktestEngine/examples/templates/BreakoutStrategy.cs` | `BreakoutStrategy` |
| `mean-reversion` | `BacktestEngine/examples/templates/MeanReversionStrategy.cs` | `MeanReversionStrategy` |
| `rsi-reversal` | `BacktestEngine/examples/templates/RsiReversalStrategy.cs` | `RsiReversalStrategy` |

These names are authoritative for the project and UI lanes.

## Shared design rules

- **Completed bars only.** Market replay opens the next bar before `OnBar`
  runs, so `Bars[Count - 1]` is the forming quote bar. Every signal helper reads
  the last completed bar at `Bars.Count - 2` and earlier. A new-bar opening gap
  never triggers a signal by itself; the completed close decides.
- **Indicators are local helpers.** The shim has no Indicators API; EMA, range
  extremes, standard deviation and Wilder RSI are small documented static
  helpers inside each file that only read indices at or before the decision
  bar.
- **Fail closed on inputs.** `OnStart` validates every parameter combination and
  throws `ArgumentException` for unusable values, which aborts the run with an
  actionable error.
- **Duplicate position control.** Each robot trades under one fixed label and
  skips the signal when `Positions.FindAll(label, SymbolName)` is non-empty, so
  at most one position per label is open at any time.
- **Explicit exits.** Every entry passes fixed stop-loss and take-profit pips to
  `ExecuteMarketOrder`; volume is the symbol minimum volume times a positive
  integer multiplier.

## Compile/verify notes

- `BacktestEngine/tests/TemplateContract` compiles all four templates against
  the shim and runs deterministic shim-lifecycle checks (parameter rejection,
  warmup, closed-bar no-lookahead, duplicate-position suppression). See that
  project's README.
- Real source-bridge builds and robot-type discovery for every template run in
  `tests/acceptance/template-build.test.mjs`.
- None of the checks use an authenticated economic profile; they make no
  economic acceptance claim.
