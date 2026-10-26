# Imported market preview — 24 October 2026

Implementation checkpoint after BACKTEST-UI-PROGRESS.md. No synthetic prices are used in production. Root's running native review copy remains untouched; rebuilt native acceptance remains separate.

## Research and decision

The installed Recharts version exposes the public Bar shape, ErrorBar, axes, tooltip and accessibility APIs required for a bounded candle preview. Its [official candlestick example](https://recharts.github.io/en-US/examples/Candlestick/) uses a ranged open/close Bar, relative high/low ErrorBar and a custom candle body. This implementation follows that domain adapter; Recharts owns chart layout, scaling, tooltip interaction and resizing. No generic chart engine is being written.

[TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/docs) was also reviewed: it supports native candlestick series but would add a dependency and canvas lifecycle plus [required attribution](https://tradingview.github.io/lightweight-charts/docs#license-and-attribution). The existing dependency covers the current <=500 candle requirement with SVG accessibility and an exact-value table. No package or lockfile changes are needed.

The new Slider is the unchanged [upstream shadcn component](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/slider.tsx), using the already installed radix-ui package. Root explicitly approved this addition. Screen CSS changes only semantic colors and placement. Root released the native compile freeze before the new module and minimal command registration were added.

## Contract and numeric policy

`MarketPreviewRequest` selects an approved dataset id, source/fixed UTC timeframe, explicit bid/midpoint policy, optional source-bar timeframe, inclusive start/exclusive end and 1–500 maximum candles. A source-bar preview preserves original OHLC without requiring a strategy build or authenticated economic profile. Aggregating bars requires a known source timeframe; upsampling is rejected.

The response contains the dataset id/hash, actual first/last source timestamps, explicit selected period, source/selected row counts, price/volume policy, total candle count and latest bounded candles. Candles use first open, maximum high, minimum low and last close. No gaps or zero volume are invented. Only explicit volume/tick-volume columns contribute volume. Out-of-order data and duplicate bar times are errors; same-time ticks retain file order.

The host calls existing `market_data::load_dataset` to verify app ownership and receipt integrity, then streams and rehashes the exact parsed bytes against that receipt. Streaming retains a maximum 64 KiB line and 500 candles; source limits remain 64 MiB and 5 million rows. The existing loader's initial full-file integrity check remains bounded by 64 MiB. The new module never edits the execution or market-data owners' modules. Command work runs off the UI thread.

## Frontend progress

- Typed production bridge calls the native preview command; browser mode rejects rather than fabricating data.
- Preview requests debounce edits and ignore old dataset/project responses. A mismatched id/hash is rejected. Coverage is retained only for the same dataset receipt.
- Genuine candles and optional recorded volume use the installed library. UTC OHLC values have a table alternative. Actual date controls and two keyboard-accessible handles share source-derived UTC day bounds.
- Default blank dates remain blank and mean all imported observations. The slider's full extent reflects source-derived UTC days. Moving either handle commits exact date text, and All history clears both dates. No displayed date silently substitutes for a different submitted boundary.
- Entry/up and exit/down triangles use actual fill action/time/price from one matching completed run. Dataset receipt, draft freshness and timeframe must match. At most 200 fills are drawn; the complete ledger remains available. Keyboard selection reveals the Trades tab, correct page and actual row. Draft changes remove the overlays and visibly label previous metrics.
- Backtest can open for a native project before economic execution is valid. Run remains guarded by a compiled strategy and selected authenticated symbol profile.
- Validate routing is connected to the independently implemented ValidationStage; completion remains distinct from its PASS/FAIL/UNPROVEN verdict.

## Verification so far

- TypeScript, owned-file formatting and standards passed (79 authored sources).
- Full frontend regression: 97 tests across 18 files passed. The three marker contract tests were rerun after refining exit actions and passed.
- Price UI browser suite: 7 passed, including dark/light × 1920×1080/800×640, candle paths, no invented volume, keyboard handles/date alternatives, exact OHLC table and axe accessibility; matching-run fill-marker keyboard/ledger/stale-overlay behavior; and recorded-volume/provenance separation with usable dataset controls at 1920 and 800. Synthetic UI fixtures are isolated entries with a visible banner and do not establish native aggregation correctness.
- Native preview tests: 12 passed. Cases cover unchanged source OHLC, genuine bucket extrema/volume, tick bid/midpoint and same-time order, inclusive start/exclusive end, latest-candle bounds with true total counts, duplicate/out-of-order rejection, missing/invalid source timeframe, no upsampling, invalid windows/output limits, invalid volume, content tampering/second-read receipt mismatch, line/byte memory guards and fractional timestamps at UTC midnight.
- `cargo clippy --offline --all-targets -- -D warnings` and whole-project `cargo fmt --check` passed. Final native formatting touched only the two new preview files using `skip_children=true`.
- Root independently reviewed the numerical aggregation and then authorized the exact copied native candidate for IPC testing. The native test results are recorded below; final packaging and owner approval remain separate.

## Actual native IPC evidence

Root authorized `artifacts/review/progress-20261024-132824/app/BacktestEngine.exe`, SHA-256 `122E415F79F5AB0B34ACD453EF817EE6F207091497AE9CA7D4B15F3A84143E57`. The isolated harness `artifacts/test-market-preview-native.mjs` used port 9231, a fresh settings/WebView profile, and actual ordinary Tauri import/preview commands. It minimized its own window and terminated only its own process tree. The owner's review PID 25788 remained alive and untouched.

The final functional run passed 5/5 groups: real imported OHLC before any build or symbol profile; exact M5 OHLC/volume and exclusive-end/latest-candle bounds; midpoint ticks with absent volume preserved as null; same-length content-tamper rejection with byte-exact restoration; and the native Backtest chart showing all four source bars while Run remained disabled. The selected last-good trading result stayed null throughout. These are real app IPC checks of an explicit numerical CSV fixture, not trading parity evidence.

Evidence directory: `artifacts/market-preview/native-qa/2026-10-24T10-31-44-922Z/`. It contains `report.json`, `actual-m5-preview.json`, `actual-mid-preview.json`, application logs and dark/light 1920×1080/800×640 captures. The captures show actual native-webview content using the established harness's CDP viewport sizing; they do not prove OS window-frame dimensions. The harness checked that its window stayed minimized for every capture.

The initial run at `2026-10-24T10-29-55-765Z/` is preserved: its four IPC groups passed, then an ambiguous Data locator matched the rail and dataset selector. The harness now selects the Data combobox explicitly. No application or frozen-binary change was needed for that harness failure.

## Concrete visual defect found and fixed after native capture

Inspection of the actual volume-bearing native screenshots exposed candle-body flex shrinkage causing volume bars to overlap the run identity, and an unreadably narrow Data selector at 800. Only feature composition CSS changed: candle content retains its intrinsic height and the Data wrapper has a usable minimum width. Shared control geometry and all native code remain unchanged. Two new browser regressions check that volume and exact-value content stay above provenance, and that the Data selector remains usable. The complete price browser suite passes 7/7; TypeScript and standards pass. This CSS refinement still needs the next rebuilt native candidate; the immutable candidate above is retained as the original evidence.

## Independent numeric review fixture

Four M1 bars at 00:00 `(10,13,9,12,V5)`, 00:01 `(12,15,11,14,V7)`, 00:04 `(14,16,8,9,V3)` and 00:05 `(9,10,7,8,V9)` aggregate into M5 `(10,16,8,9,V15)` and `(9,10,7,8,V9)`. An exclusive 00:05 end removes the last bar. This explicit fixture is shared with root for independent checking.

## Remaining limits

The preview is bounded to the latest 500 candles in the selected period, with explicit truncation. Supported fixed buckets are M1/M5/M15/M30/H1/H4/D1; source bars can be inspected unchanged before declaring a source timeframe. Exact date controls select UTC calendar days. Preview does not infer a symbol from file names, invent intrabar paths, fill market gaps, infer missing volume, classify warm-up versus scored data or establish numerical trading parity. Assistant and optimization remain outside this checkpoint.
