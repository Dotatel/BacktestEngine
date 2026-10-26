# Onboarding refinement — 24 October 2026

Implemented and self-reviewed directly by Codex. No sub-agents, GLM or OpenCode workers were dispatched. This continues the approved standalone foundation; project workspace and backtest UI remain paused pending owner review.

## Delivered changes

- Applied the owner's selected integrated header: the same app surface, small brand/product label, standard rounded shadcn ghost/icon-sm window buttons, delayed Tooltip hints and actual minimize/maximize/restore/close operations.
- Main actions use unchanged shadcn lg (40 px high, 14 px type), secondary controls use standard presets, caption controls use icon-sm (32 × 32 px), radios retain 16 × 16 px. Removed page-specific geometry overrides. Shared typography is 12/14/16/24/28 px with shared spacing/radius tokens, documented in DESIGN.md.
- Added restrained directional step continuity, selection feedback and completion motion. Reduced-motion disables those animations and the tooltip/dialog transitions. Fixed a transient horizontal scrollbar discovered in the real WebView2 animation; settled native captures now disable animations when recording static evidence.
- Replaced the large App component with a thin composition. Focused hooks own persistence/serialization, provider lifecycle/cancellation, navigation and appearance. Views receive state/actions; the typed bridge owns IPC. Skip persists cleared provider plus next step in one durable write. Storage recovery, atomic writes, failures, keyboard behavior and stale-result protection are preserved.
- Installed official Impeccable 4.7.1 in `.agents/skills/impeccable`, pinned upstream commit `936867543ac2576920d663cc9803597f6044f3ac`, plus project-local Ponytail and the established owner coding standard. Upstream license included. AGENTS.md requires these skills; docs/CODING-STANDARD.md records the owner's overriding documentation/nesting rules.
- Added `pnpm standards` and its CI gate. It parses owned production TypeScript for named-function/public-contract documentation, two-level control-flow nesting, nested conditionals and presentation/native import boundaries; it checks screen CSS/JSX for shared-control geometry overrides. Positive/negative parser/style self-checks run with the gate. These checks supplement source review; they do not prove overall code quality.

## Verified evidence

| Check                                                                | Result                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Component/preference behavior                                        | 12 tests passed                                                             |
| Browser UI/accessibility/motion/visual regression                    | 12 tests passed                                                             |
| Visual baselines                                                     | Six intentionally updated compositions, then verified without update mode   |
| Rust tests                                                           | 7 passed                                                                    |
| Actual relocated Windows executable                                  | 10 native scenario groups passed                                            |
| Local OpenCode service                                               | Version 2.1.4 verified through read-only service metadata; no prompts/tasks |
| Retained source integrity                                            | All 100 C#/Python manifest files match SHA-256                              |
| TypeScript/frontend and Tauri Windows builds                         | Passed                                                                      |
| Formatting, structural gate, Rustfmt and Clippy with warnings denied | Passed                                                                      |

The browser checks cover 800 × 640, 1280 × 720, 1672 × 941 and 1920 × 1080, plus compact 660 × 470 Welcome. Tested states include keyboard navigation, both themes/System changes, persistence/reload, failure/retry, optional-provider errors, local assets and no external asset requests. Automated accessibility scans report no violations in the tested states. Motion and standard component dimensions are asserted directly. Reviewed settled native P01/P03/P04/P05 captures as well as browser theme/size captures.

The final portable executable is `artifacts/review/refined-app/BacktestEngine.exe`, accompanied by 194 engine resource files verified against their built-source hashes. Executable SHA-256: `7b7dab505adc34f25dd64e2c3a8909b15cc9c275128831cbe2b1cb511dc88692`. Build provenance is in `artifacts/review/refined-build.json`.

Final native report and captures: `artifacts/native/2026-10-24T04-54-21-357Z/`. This run tested the relocated portable copy, including real window state, close/relaunch persistence, confirmed recovery backup, saved completion, and actual Rust-to-C# strategy metadata. Final browser log: `artifacts/refinement-browser-final.log`. Other check logs are under `artifacts/refinement-*`. Artifacts are local/ignored; source and intentional visual baselines are reviewable in Git.

Impeccable's requested mechanical detector ran once and reported one advisory for the retained background grid, with no primary finding. The grid is a deliberate existing DotaTel composition retained within the owner's refinement scope, not a newly introduced design pattern. No independent reviewer or owner approval is claimed. The older PRODUCT.md schema can be refreshed through Impeccable `init` if the owner requests that separate interview.

## Limits

Owner-review follow-up: vertically centered Welcome's logo/title/action group while keeping the step indicator at the bottom. Only Welcome CSS and its two theme snapshots changed. All 12 browser checks and 10 relocated native scenarios passed again; native evidence is `artifacts/native/2026-10-24T05-14-38-278Z/`. The rebuilt executable supersedes the earlier fingerprint above; current build metadata is `artifacts/review/refined-build.json`. A fresh isolated review settings folder opens Welcome without changing the owner's saved setup.

This is a local onboarding review build. Hosted CI, installers/signing, workspace/backtest UI and trading parity remain outside this checkpoint. The retained C# numerical tests were not rerun for this frontend-only refinement; their prior results are recorded in VERIFICATION-2026-10-24.md, while this pass rechecked source hashes and real bundled-engine invocation. Native caption buttons are verified; physical pointer-driven title-bar dragging remains inconclusively measured, with dispatch covered at the component boundary. No test suite proves absence of every possible issue. Final visual approval belongs to the owner.
