# BacktestEngine design context

Start here when giving this repository to an LLM. This package describes the approved **desktop application** direction. It is design context, not evidence that the application UI or its integrations have been implemented.

1. Read this file and [screen index](design-context/README.md).
2. Open the relevant screen image; do not infer appearance from prose alone.
3. Read its [specification](design-context/specs/) and [interaction contract](design-context/specs/interactions.json).
4. Use [Dotatel brand tokens](Brand/brand-tokens.json), [theme roles](design-context/tokens/semantic.json), [dimensions](design-context/tokens/layout.json), and bundled assets.
5. Implement only the requested scope. Compare a rendered desktop screenshot against the selected reference before reporting completion.

## Source priority

Explicit user corrections take priority. Approved native Figma previews define the present visual direction; approved concepts fill missing states. Specifications define intended behavior. Proposed future pages are not approved visual designs. If these disagree, report the specific discrepancy rather than inventing a replacement.

- [Onboarding](design-context/specs/onboarding.md): compact Welcome → full-window Simple/Advanced → System/Light/Dark → optional AI agent → Finish.
- [Project launcher](design-context/specs/project-launcher.md): equal Projects/Recent columns, divider, Create/Open buttons, four small examples with text underneath. Gray previews become colored on hover **and keyboard focus**.
- [Backtest workspace](design-context/specs/backtest.md): strategy-only side panel; market/cost/date controls above chart; compact metrics overlay; candles, volume and simple green/red triangle markers; plain table cells; simplified assistant.
- [Components](design-context/specs/components.md), [navigation and future scope](design-context/specs/navigation.md), [Mermaid journeys](design-context/flows/).

## Assets and implementation boundaries

The package includes logos, 27 Lucide SVGs, local Manrope fonts and licenses, onboarding illustrations/agent marks, screen PNGs, five onboarding SVG exports, authored Figma source scripts, and reusable exact thumbnail crop coordinates. See [asset instructions](design-context/assets/README.md).

The Figma library uses local adaptations of shadcn patterns; it is not an imported official shadcn Figma kit. The framework and desktop host are not selected by this package. Keep the design portable across implementations.

Figma launcher variants exist, but prototype hover links are unfinished. AI authentication, project filesystem behavior, responsive layouts, error states and accessibility behavior are specified work, not completed integrations. Do not turn illustrative project names, prices, chart shapes or returns into live data or performance claims. See [provenance](design-context/provenance/figma.json) for export coverage and limitations.

Earlier local concepts are deliberately outside this package. Do not treat those alternatives as current requirements. The private Refactoring UI skill/book is not needed to consume this package and is not distributed here.

## Give another model this prompt

> Read DESIGN.md in this repository first. Inspect the referenced PNG and specification for the screen I request. Reuse the bundled assets and named tokens, preserve the approved desktop layout, and implement only my requested scope. Explain any missing backend contracts. Render and inspect the result before claiming a visual match.

Validate or rebuild the file manifest with `python3 design-context/scripts/validate.py` and `python3 design-context/scripts/validate.py --write` respectively. Everything needed to read this package is local; Figma access is optional.
