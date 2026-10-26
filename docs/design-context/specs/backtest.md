# Backtest workspace

Use the native dark/light previews and the concept images for intended details. Reference frame1600×960. Preserve the dense research workstation and its hierarchy.

- Global rail: Explorer, Markets, Data, Strategy, Extensions, with Settings at the bottom. No “More”. Use bundled Lucide icons, normally18px in navigation and16px in compact toolbars.
- Stage tabs: Build, Backtest, Optimize, Validate, Report. These belong to the selected strategy, not the global rail.
- Left panel: strategy selector, Rules, strategy parameters, Reset parameters. Market, period, capital and trading costs do not belong here.
- Two compact rows above the candles: Symbol, TF, Data, Capital and Costs; exact UTC start/end date fields and a two-handle range. Costs opens labeled spread, commission and slippage details with units.
- Chart: candles and volume when present in source data; a **small translucent group at top center** for net return, profit factor, drawdown and trade count. No separate large metric cards, EMA overlays, indicator clutter or oversized legends.
- Trade annotations: simple green entry/up triangles and red exit/sell/down triangles. No circles or connectors. Selection exposes the actual execution action/time/price and links to its ledger row.
- Result tabs: Trades, Statistics, Equity curve, Drawdown, Logs. The table uses plain Buy/Sell and Win/Loss text with semantic colors; no cell badges/cards. Sorting, pagination and export retain run identity.
- Assistant: wide unboxed text, compact role labels, simple suggested-question links and a slim composer. Expand/restore preserves the same conversation, run, draft and scroll position. Do not add large avatars or nested message cards.

## State and data contract

Draft inputs and a completed run are separate objects. Changing parameters, data, costs, capital or period must visibly mark old results as belonging to the previous run. Freeze the configuration when launching a new job; block duplicate submission. Keep empty, validating, queued/running, complete, canceled, interrupted and failed states distinguishable.

Date text and both range handles stay synchronized, bounded by dataset coverage and ordered. Give keyboard and exact text alternatives to dragging. Document the visible last included UTC date versus the engine's exclusive end boundary; distinguish warm-up from scored data.

Cost configuration must distinguish recorded bid/ask spread from modeled additional spread and record commission basis/slippage units, without double-counting. Preflight reports strategy/data/profile/history and engine availability failures with direct repair actions. Export reads the selected saved run; it does not silently rerun it.

Metrics, markers and table rows must come from one actual run. Never invent candles, volume or results for an empty dataset. Explain maximum equity drawdown and marked equity versus balance in details. Undefined metrics remain undefined. The bundled values and conversations are illustrative.

Do not claim these static designs establish engine compatibility, native execution parity, AI integration, brokerage connectivity or production readiness. Error/empty/expanded-chat states have behavior specified here, but their final visuals still require review.
