# Desktop progress preview — 24 October 2026

This is a review build, not full-product acceptance or an installable release qualification. The owner requested a runnable snapshot while implementation continues.

## Exact copy

- App: `artifacts/review/progress-20261024-120332/app/BacktestEngine.exe`.
- SHA-256: `28639A3F4D881105DE191F5864FFFF2F270B4F42E9CBC99D472472471B3B6CEB`.
- `Start Preview.cmd` opens the workspace using isolated settings and an independent copy of the example project. `Start Onboarding.cmd` uses another settings directory for the full first-run flow.
- 209 engine/resource files copied and independently hash-checked. Existing review copies and owner source files preserved.
- Debug Tauri executable; .NET SDK is available on this machine via the approved portable toolchain. This copy does not establish clean-machine/offline installer readiness.

## Checks on this snapshot

- Frontend: 57 unit tests passed; structural standards passed for 57 authored source files.
- Browser: 33 tests passed, including existing onboarding goldens and Build interactions/accessibility. Eight older “execution review” browser captures actually show browser workspace states; they are **not evidence of Backtest native rendering**.
- Rust: 55 tests passed, including a fresh profile registration/verifier round trip. Source registration fixes still need the complete missing/changed-dependency/manifest tampering regression coverage requested by QA.
- TypeScript/Vite/Tauri native build succeeded. Formatter check passed after scoped formatting. Large editor/bundle chunk warnings remain.
- Retained C#/Python integrity: 100/100 files matched original hashes in this review turn.
- True native rendering: copied preview executable built the example successfully and opened Backtest in both themes at 1920×1080, 1024×720 and 800×640. Six captures and accessibility results (zero automated violations) are in `artifacts/execution-ui-review/preview-1792832652361/`.
- Native execution harness: **4 passed, 1 failed** in `artifacts/execution-native-qa/2026-10-24T09-04-22-915Z/report.json`. Artifact rejection returned a receipt-revision mismatch that the assertion did not allow. Later checks did not run. Do not describe this suite as green.

## Acceptance remains open

Build is the working local baseline. Backtest is a draft screen and integration: its layout still differs from the approved chart-centred design; genuine candle/volume data, result tabs and the full workflow are incomplete. No positive real replay, zero-trade run or report equality has been accepted: an actual validated `economic-symbol/v2` profile and its active source/cost authorities are missing. Synthetic fixtures never establish that evidence.

Validation integration, optimization, reports/export, complete settings, app extensions, optional user-controlled updates, useful CLI/agent integration, bundled dependencies, offline installer testing and independent release review remain tracked in the full product goal. This preview does not narrow or complete that goal.
