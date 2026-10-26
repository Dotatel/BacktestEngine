# Execution contract

Native execution runs the original C# engine (`BacktestEngine.Run`) against imported
historical market data and an approved build artifact. The browser preview never fabricates
results; it reports native capability limits honestly.

## Ownership

- Native host: `src-tauri/src/execution*.rs`, `src-tauri/src/market_data*.rs`,
  `src-tauri/src/workspace_build.rs`, `src-tauri/src/lib.rs`.
- TypeScript boundary: `src/lib/execution-contract.ts`.
- UI consumers: `src/features/execution/**` (UI worker) consume the contract only.

## Rules

1. Execution uses the original `RunnerOptions`/`Program` entry point. The compiled
   artifact is the saved-source build produced by `workspace_build`; it is not a rewritten
   simulator.
2. Only artifacts approved by the native build receipt for the selected project may run.
   Arbitrary external DLLs or compiled-bot imports are rejected.
3. Historical CSV is imported and copied into app-owned storage with content provenance.
   The original user file is never overwritten.
4. Every run requires explicit symbol economics, balance, commission, slippage and a valid
   date range where supported.
5. Progress, cancellation, timeout and errors are honest. Overlapping jobs are rejected.
   Malformed or non-finite results are rejected.
6. Last good results are preserved separately from new pending or failed work.
7. Full replay drawdown and native report drawdown are reported separately.

## Commands

- `execution_import_market_data(path, kind)` -> `ExecutionDataset`
- `execution_run(request)` -> `ExecutionRunResult`
- `execution_cancel()` -> `void`
- `execution_last_good_result()` -> `ExecutionRunResult | null`

## Artifact approval

The host verifies the artifact path is contained in the app-owned builds directory and has a
valid `revision.json` receipt. Stale or failed builds (no receipt, no artifact) are rejected.
