# TemplateContract

Compiles the four launcher robot templates
(`examples/templates/*.cs`) directly against the owner cAlgo shim and runs
deterministic shim-lifecycle checks:

```text
dotnet run --project BacktestEngine/tests/TemplateContract/TemplateContract.csproj
dotnet format BacktestEngine/tests/TemplateContract/TemplateContract.csproj --verify-no-changes
```

## What the checks prove

- All four templates are concrete `Robot` subclasses and compile against the
  real shim (the project references `BacktestEngine.CAlgoShim`).
- `OnStart` validates every parameter combination and accepts valid ones —
  the robot fails closed instead of trading on unusable input.
- **Closed bar / no-lookahead.** The harness reproduces the replay lifecycle:
  the first quote opens one quote-only chart bar, every later bar is opened as
  a quote-only forming bar before `EngineOnBar` runs and is completed after.
  Breakout additionally shows that an opening gap above the completed range
  never trades when the completed close stayed inside the range; the forming
  bar at `Bars.Count - 1` never feeds a signal.
- **Warmup.** Every robot stays quiet until enough completed bars exist for its
  indicator window.
- **Signal oracle.** No economic-symbol profile is applied, so the shim's
  `ExecuteMarketOrder` fails closed: an attempted entry surfaces as a
  deterministic "No effective symbol specification" `InvalidOperationException`.
  That throw (not a simulated fill) proves a robot tried to trade on its
  completed-bar signal, and its absence proves the guards held.
- **Duplicate position control.** With one scaffolding position injected
  through the internal `Positions.Add` seam, the identical signal sequences
  never attempt a second entry and keep exactly one position. Injecting
  harness state creates no economics.

## Honest limitations

- The harness binds parameters manually because `[Parameter]` defaults are
  applied by the runner binding step, which this bare-shim harness does not
  run; the source-bridge acceptance build covers the runner path.
- The harness creates no economic profile, no fills, no PnL and no stop/exit
  evidence; real replay acceptance still requires the owner's validated
  economic profiles and recorded data. Nothing here claims profitability,
  qualification or native cTrader parity.
- Execution side coverage is long-side only; short-side logic is the mirrored
  branch of the same deterministic helpers and is reviewed, not driven.
- Standards verification runs `dotnet format` scoped to this project, which
  includes the four linked template sources; legacy engine files are untouched.
