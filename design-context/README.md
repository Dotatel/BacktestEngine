# Screen index

Snapshot: 18 October 2026. [Read the LLM instructions first](../DESIGN.md).

| Screen | Visual reference | Supplement | Status |
| --- | --- | --- | --- |
| P01 Welcome | [Native PNG](screens/onboarding/P01.png) | [SVG](screens/onboarding/P01.svg) | Approved compact-window composition |
| P02 Workspace style | [Native PNG](screens/onboarding/P02.png) | [SVG](screens/onboarding/P02.svg) | Approved Simple/Advanced |
| P03 Appearance | [Approved concept](screens/onboarding/concept-P03-appearance.png) | [Native SVG](screens/onboarding/P03.svg) | Approved; native PNG not captured |
| P04 AI agent | [Approved concept](screens/onboarding/concept-P04-ai-agent.png) | [Native SVG](screens/onboarding/P04.svg) | Approved; native PNG not captured |
| P05 Finish | [Native PNG](screens/onboarding/P05.png) | [SVG](screens/onboarding/P05.svg) | Approved; summary values are examples |
| Project launcher | [Default](screens/project-launcher/default.png) | [EMA](screens/project-launcher/ema.png), [Breakout](screens/project-launcher/breakout.png), [Mean](screens/project-launcher/mean.png), [RSI](screens/project-launcher/rsi.png) | Native state previews; prototype links incomplete |
| Backtest dark | [Native PNG](screens/backtest/dark.png) | [Approved concept](screens/backtest/concept-dark.png) | Approved workspace |
| Backtest light | [Native PNG](screens/backtest/light.png) | [Approved concept](screens/backtest/concept-light.png) | Approved workspace |

Concept images are generated references; native previews show the actual editable Figma construction. Exact export coverage is in [provenance](provenance/figma.json). SVGs may contain outlined text and embedded preview artwork; do not use a whole-screen SVG as the application implementation.

The [offline gallery](index.html) opens the bundled screens without a Figma account. A model without image support should read the specs and request visual review from an image-capable model; a prose-only reading cannot verify fidelity.

## Contents

- `assets/`: local font files, licensed Lucide icons, approved option artwork, and example preview mapping.
- `tokens/`: existing theme roles, dimensions and CSS; canonical brand primitives remain in `../Brand/brand-tokens.json`.
- `specs/`: screen behavior, component states, future scope and machine-readable interactions.
- `flows/`: updated first launch and project journeys as Mermaid source.
- `source/figma/`: historical authored native construction code, useful as geometry/style context. It is tied to the original file's node IDs and is **not** an unattended importer.
- `prompts/`: reusable implementation/review instructions.
- `manifest.json`: file paths, categories, dimensions and SHA-256 hashes, checked by `scripts/validate.py`.

Full-screen SVG exports for the launcher and Backtest were not captured. Their native PNG previews and existing Figma construction sources are included; do not describe those as lossless standalone vector exports. The approved preview artwork can be reused from the included state images using the supplied crop map and CSS without redrawing it.

To share this design, give a model this branch or a repository archive and direct it to `DESIGN.md`. No MCP connection, temporary upload URL, private local path or installed design skill is required.
