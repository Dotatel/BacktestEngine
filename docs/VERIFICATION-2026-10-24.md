# Standalone onboarding review — 24 October 2026

Implemented and self-reviewed directly by Codex, as requested by the owner. No other agents or OpenCode workers were dispatched. The existing application and its worktrees were preserved. The new Git project is `D:\Projects\Dotatel\BacktestEngine`.

## Verified result

The standalone Windows executable uses Tauri/Rust, React, TypeScript and official shadcn/ui components. It contains the frontend and the retained self-contained C# engine resource. It runs with the Vite development server stopped; Electron, Node and the old repository are not runtime dependencies.

| Check                                                       | Result                                      |
| ----------------------------------------------------------- | ------------------------------------------- |
| Component and preference tests                              | 12 passed                                   |
| Browser UI tests, including six visual regression snapshots | 11 passed                                   |
| Rust settings/protocol tests                                | 7 passed                                    |
| Actual native Windows scenario groups                       | 10 passed                                   |
| Retained C# template contracts                              | 77 assertions passed                        |
| Retained C# optimizer contracts                             | 73 assertions passed                        |
| Retained C#/Python source integrity                         | 100 files match the source SHA-256 manifest |
| TypeScript and production frontend build                    | Passed                                      |
| Tauri Windows executable build                              | Passed                                      |
| Rust formatting and Clippy with warnings denied             | Passed                                      |
| Shared Prettier formatting                                  | Passed                                      |

The browser checks cover 1920 × 1080, 1672 × 941, 1280 × 720 and 800 × 640; all five steps; keyboard arrows/Space/Tab/Enter; focus transfer; local assets; no external asset requests; System/Light/Dark behavior; save errors; Back; reload; and completion. Automated WCAG A/AA scans found no violations in the tested states. Visual regression snapshots pass against the new implementation baselines, which remain pending owner approval.

Native checks operate the actual custom minimize/maximize/restore/close buttons, verify native window state, preserve setup's restored size across step navigation, close/relaunch the app to verify disk persistence, recover corrupt settings with a backup, finish/reopen setup, and invoke the real bundled C# strategy metadata through Rust. The optional OpenCode check successfully reads an existing local service's version; it sends no prompts and creates no agent session. The final native run reports `openCodeServiceVerified: true`.

Native evidence: `artifacts/native/2026-10-24T04-11-51-432Z/report.json`, its P01–P05 PNGs, connected-agent PNG, recovery PNG and actual engine metadata. Browser evidence is under `test-results/` and `playwright-report/`. Build/test logs are ignored local artifacts at the project root. Source provenance is retained in `docs/retained-source.json`.

## Visual review

Compared the rendered onboarding with the approved native P01/P02/P05 references, supplied P03/P04 concepts and source measurements. The official artwork, unboxed choices, Manrope typography, centered primary actions, five-step order, theme roles and real summary values are retained. The custom Windows title bar is an explicit owner-requested adaptation. Light variants inherit the supplied light theme rather than claiming an independently approved pixel-perfect reference.

The first render exposed timing in radio keyboard selection and image loading checks. Keyboard selection now commits synchronously on keydown. Native inspection also found and repaired recovery text falling below the compact window and Restore falling back to the welcome rectangle. The native host now establishes a separate 1024 × 720 setup restore rectangle, and step navigation respects a user's restored window.

The design detector reported no primary findings. Its one advisory concerns the background grid, which is explicitly present in the approved DotaTel references and is retained for fidelity. No independent agent review was substituted or claimed: this milestone awaits the owner's review.

## Limits of this checkpoint

- The native automated pass count covers the three caption buttons and lifecycle. Title-bar drag/double-click dispatch is covered at the component boundary; physical pointer-driven movement was not conclusively measured by the native automation. The drag path calls the native window thread directly. Do not describe that movement as independently verified.
- OpenCode Desktop is the first supported live connection. Codex and Claude Code adapters remain explicitly unavailable; optional setup can always be skipped. This is not a claim of complete assistant-provider integration.
- The milestone ends at a setup-complete screen. Project workspace migration, strategy editing/compilation UI, full backtest UI and installer qualification await owner approval of this foundation.
- Hosted CI is configured but has not run because no remote repository or publication was requested. This is a local review build; trading parity and release qualification are not inferred from onboarding checks.
- No test suite can establish that every possible issue is absent. All listed local checks pass; the tested onboarding has no remaining known functional failure.
