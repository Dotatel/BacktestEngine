# Saved-run history UI checkpoint

The Reports stage now accepts `historyBridge?: SavedRunsBridge`, `executionBusy?: boolean`, and `onSavedRunSelected?: (selection: SavedRunSelection) => void`. The native bridge export is `savedRuns` from `src/lib/saved-runs.ts`. Existing Reports callers remain supported.

History lists native-recorded identities in bounded forward pages of 25, in the host's filesystem enumeration order. It makes no newest-first or financial-preview claim. Refresh starts enumeration again; Next page uses the exact native opaque cursor. Broken/unassigned entries stay visible as bounded diagnostics, without assigning their ownership to the current project.

The hook restores only the explicit selected pointer once per project open, including while the retained Reports stage is hidden. It waits for current build/execution/optimization/validation activity via `executionBusy`. A missing pointer never selects a fallback row; a failed restore remains visible after listing succeeds and has an explicit retry. Project generations suppress late foreign responses. Opening a row verifies its native-issued run/completion identity before refreshing the report and notifying composition.

Backtest accepts `savedSelection?: SavedRunSelection | null`. It displays the verified historical result and receipt-captured inputs without changing current economics, dataset, profile or strategy controls. Historical results are marked Previous. No executable request or private symbol-profile path is reconstructed from history. Price-chart trade annotations remain unavailable when the current chart/input identity cannot be matched. A subsequent successful new run replaces historical inputs with its actual submitted request.

Reuse: existing native `saved_runs_list`, `saved_runs_select`, `saved_runs_restore_selected`; existing report refresh/export bridge; existing Backtest result presentation; checked-in shadcn Button public `size="sm"` and variants. No package or native changes were needed.

Verification on 2026-10-24:

- Focused Vitest: 44 passing tests across Reports, history lifecycle/presentation, native request envelopes and Backtest hook/component. Synthetic DI fixtures are explicitly labelled and contain no genuine engine qualification.
- TypeScript: passed after adding the explicit browser-fixture report type.
- Structural standards: 115 authored source files passed.
- History-only browser review: four passing dark/light × 1920×1080/800×640 checks; keyboard activation, zero Axe violations and no horizontal overflow. Captures under `artifacts/saved-history-ui-review/` are synthetic DI presentation evidence only.

Root owns final composition, full frontend checks, native build and actual native acceptance. This lane did not run Cargo/SDK, start the native application, access a provider, mutate stored runs, or touch the existing review process. Backend saved-run fixtures and Release validation were left to the native owner; native saved-run behaviour is not proven by these UI tests.
