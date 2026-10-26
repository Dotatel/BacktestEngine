# BG-01-initial checkpoint

Prepared for the `BG-01-initial` branch on 26 October 2026. This branch carries the standalone Tauri, Rust, React and shadcn/ui application, keeping the original C# engine and Python validation under `engines/`. The existing repository history remains its parent; this checkpoint does not merge into `main` or `stage` or publish a release.

## Latest reviewed application

The review executable was built on 24 October 2026 at 20:18:29 Riyadh time. Its SHA-256 is `E9F6515DB22F80D2410D9D430B197E8897D3A5ED7866DD45302FD4D1A0EF6D50`. A separate frozen copy was verified against 5,863 bundled resource files before native checks. The running review also compiled its copied example strategy, reflected two parameters and reported zero compiler errors and warnings. The retained engine's 25 informational analyzer suggestions remained visible.

The latest visible integrations are verified saved-run history in Report, frozen engine-scenario controls in Validate, and an optional assistant pane in the workspace header. Historical inputs remain separate from current drafts. Assistant drafts survive hiding the pane and closing/restarting the application; connecting and sending remain explicit actions.

## Verification at that source checkpoint

- Rust library: 239 passing tests, including saved-run and optimizer lifecycle checks. Six producer tests were repeated after a private type-only cleanup.
- All-target Clippy with warnings denied, Rust formatting and retained-source verification passed. All 100 captured original source files matched their recorded SHA-256 values.
- Frontend: 165 passing unit tests; TypeScript, formatting and structural standards passed.
- Browser: 71 of 72 checks passed in the first full run. A Vite full reload left an empty page during the 800px onboarding check; the affected check passed with the source frozen. The initial failure evidence was preserved.
- Native execution: 26 checks passed, zero failures. Native assistant: four checks passed, zero failures, including a hidden unsaved draft flushed through the custom window close.

Generated test evidence and local review launchers remain under ignored `artifacts/`; they are not part of this source commit. Follow the README to prepare resources, build and reproduce checks on another machine. The CI workflow provides a fresh environment check rather than inheriting local evidence.

## Remaining acceptance limits

Genuine financial replay and zero-trade report equality still require a validated `economic-symbol/v2` profile and its active authority inputs. Synthetic guard fixtures establish no financial or native-platform parity. The full engine-scenario workflow has no genuine positive financial acceptance result. Live assistant model replies were not requested or tested. Clean-machine installer qualification and release signing remain outside this checkpoint.
