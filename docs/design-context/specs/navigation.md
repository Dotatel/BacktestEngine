# Navigation and future scope

Approved visual coverage is limited to onboarding, the project launcher and the Backtest workspace. The routes below retain the wider journey as **proposed product scope**, not additional approved screens or implemented features.

| Area | Intended surfaces and purpose |
| --- | --- |
| Startup | Load saved preferences; first-run setup or launcher; interrupted-work review with retry/recovery. No endless splash. |
| Explorer | Project overview/files, strategy/data readiness, saved runs, comparison and project settings. Preserve source and frozen artifacts. |
| Strategy / Build | Strategy library, supported source import, source/rules editor, parameter schema, build diagnostics and named presets. AI suggestions require review. |
| Backtest | Configure a draft, preflight, execute a frozen run, inspect trades/statistics/equity/drawdown/logs. |
| Optimize | Explicit baseline, grid/seeded random ranges, budget and ranking; inspect complete/partial/failed candidates before promoting a preset. |
| Validate | Frozen candidate, cost/latency stress, Monte Carlo, random windows and walk-forward plans; report failed/unproven evidence honestly. |
| Report | Saved-run evidence, comparisons, notes, provenance and export. Do not promise an unavailable renderer. |
| Markets | Dataset-compatible symbols, economic profiles, units, sessions and coverage. No fabricated live quotes. |
| Data | Library, file import/mapping, quality/coverage detail, versioned references and dependency-aware removal. Preserve original files. |
| Extensions | Installed/available, compatibility, detail, enable/disable, requested access and failure states. Availability requires a real extension mechanism. |
| Settings | Appearance, workspace style, AI agent connections, paths/defaults, shortcuts, diagnostics and optional replay of setup. |
| Assistant | Docked and expanded conversation with project/strategy/run context, proposal review and explicit action boundaries. |
| Jobs | Progress/logs for real jobs, outcomes and cancellation. Do not invent pause/resume or checkpoint support. |

Global navigation stays Explorer, Markets, Data, Strategy, Extensions, Settings. Stage tabs stay Build, Backtest, Optimize, Validate, Report. Jobs, help, project switching and popovers need not add global rail items.

Create/Open/Example lead to project overview. Opening a saved run restores its frozen inputs and evidence. Leaving a running job does not silently abandon it. Unsupported imports, missing files, unavailable agents and engine failures require useful recovery paths.

This package does not establish cloud collaboration, billing, live execution, bundled broker data or universal compiled .algo support. Future additions should extend the route/state contracts and add reviewed visuals, without silently changing these approved screens.
