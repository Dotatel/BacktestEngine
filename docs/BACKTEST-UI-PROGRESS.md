# Backtest UI checkpoint — 24 October 2026

The approved Backtest direction in `docs/design-context/specs/backtest.md` and its dark/light PNGs has been applied to the execution workspace. This is a layout and component-hardening checkpoint, not full-product or native trading acceptance.

## Implemented

- Left compiled-strategy selector, Rules/source explanation, schema-backed parameter controls and Reset parameters. Market, capital, period and costs are above the chart.
- Compact market row with imported symbol profile, timeframe, dataset, capital, cost disclosure, data settings and real Run/Cancel actions. Cost labels show USD per million units and pips per fill; recorded spread and fixed replacement spread are explicit.
- Exact UTC date controls and visible exclusive-end semantics. Blank dates use all imported history.
- Dominant chart region with an honest unavailable-price state. It never generates candles or volume. Compact run metrics retain unavailable values as `n/a`.
- Trades, Statistics, Equity curve, Drawdown and Logs share the same selected run. The ledger supports sorting, 20-row pages, actual execution details and full-ledger CSV download including run/dataset/strategy identity. Export never reruns the strategy.
- Equity and balance use the installed Recharts dependency. Drawdown is calculated only from genuine run samples and labelled sampled equity drawdown; native full-run maximum metrics remain separate. Drawing is bounded while preserving equity endpoints and bucket extremes.
- Completed evidence and drafts remain separate. Parameter/strategy/build/data/economic changes mark successful results as previous. Frozen submitted inputs are visible. Duplicate submissions and draft mutation while busy are blocked. Old-project completion/finally/cancel responses cannot overwrite or unlock newer runs. Failed cancellation leaves the run active and permits genuine completion.
- Report stage routes to the separate Reports implementation, stays mounted, and refreshes on selection. Stage navigation and Save all are disabled during a backtest. Optimize and Validate interfaces remain unavailable.
- Required `reportSha256: string | null` added to the execution result contract for the native report-integrity work; presentation fixtures use null.

## Verification evidence

- `pnpm exec tsc --noEmit` passed.
- `pnpm standards` passed against 69 owned production sources.
- Focused execution unit/component suite: 24 passing tests (cancellation and generation isolation, frozen requests, draft staleness, exclusive dates, result tabs, undefined metrics, sampled drawdown, extrema-preserving display reduction and full-run CSV provenance/formula escaping).
- Full frontend Vitest suite: 75 passing tests across 14 files, including workspace/Report composition.
- `pnpm exec playwright test tests/ui/execution-review.spec.ts`: 8 passing browser tests. Dark/light × 1920×1080/800×640 × empty/completed fixture. Each checks the actual Backtest stage, hierarchy, overflow and axe accessibility; completed fixtures also exercise ledger pagination.
- An additional focused browser interaction passed: actual Recharts SVG in equity/drawdown tabs, logs, full CSV download with the selected run filename, and parameter changes retaining the frozen original values. Nine execution browser tests are now present; the matrix and interaction were run separately.
- Screens inspected: `artifacts/execution-ui-review/di-fixtures/completed-dark-1920x1080.png`, `completed-light-1920x1080.png`, and `empty-light-800x640.png`. The fixture banner explicitly says synthetic results and no native compiler/engine. At compact size the workspace scrolls vertically and the ledger scrolls horizontally.
- The previous execution-review browser tests captured Build while naming it execution. They now use a separate `tests/ui/fixtures/backtest.html` entry with dependency-injected evidence. Production routing never imports this fixture and has no fake compiler-success switch.
- Existing shadcn public size/variant APIs are unchanged. No dependency was added: Recharts, Radix/shadcn and existing schema parsers were already installed. No native window was opened, closed or replaced during this UI pass.

## Explicit remaining capabilities

1. Native imported candle/volume preview and trade annotations are not connected. No trustworthy price or dataset-coverage contract exists yet, so the two-handle coverage-bound range is deferred. The exact date controls remain usable.
2. Proposed minimal host bridge: `previewMarketData({ datasetId, startUtc?, endUtc?, timeframe?, maximumBars: 500 })` returns `{ datasetId, sha256, symbol?, timeframe, coverageStartUtc, coverageEndUtcExclusive, sourceRowCount, bars: [{ timeUtc, open, high, low, close, volume? }], truncated }`. Validate an approved stored dataset; bound aggregation; never manufacture volume. Root/native owners must approve and implement it before frontend integration.
3. No assistant conversation or composer is fabricated. Assistant integration, optimization and validation UI, native progress events, interrupted-job restoration and warm-up/scored-period distinction are not implemented by this checkpoint.
4. Frozen input snapshots currently belong to launches in the mounted session. Durable run-input restoration requires a host contract; the UI does not infer missing historical inputs from current controls.
5. Actual rebuilt Windows desktop, packaged acceptance, numerical correctness and owner visual approval remain root QA work. Browser fixtures establish presentation behavior only.

The existing owner review process/window remains intact. Root coordinates the next rebuilt native QA after integration.
