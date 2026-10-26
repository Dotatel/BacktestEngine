# Build workspace verification — 24 October 2026

The main Build workspace is implemented in the standalone Tauri + React + shadcn/ui project. The approved onboarding and integrated custom caption remain in place. This is a local development/review milestone; owner visual approval and later execution stages remain outstanding.

## Delivered behavior

- Open a real project folder or create an app-managed example. Browse and expand the virtualized tree, navigate with the keyboard, and create, rename and move files/folders. Drag/drop and labeled Move dialogs share the same validated operation.
- Edit actual source in locally bundled Monaco, switch tabs, search, undo and save with Ctrl+S or Save all. Drafts survive failed writes. Revision checks reject overwriting external changes. Dirty tabs, project changes, structural edits and closing the window require an explicit save/discard decision.
- Save drafts before compiling. The native host snapshots saved sources, compiles them against the preserved C# engine and reflects the resulting assembly's strategy schema. Problems identify real compiler locations and navigate to project source. Overlapping builds are rejected; cancellation kills the active child and invalidates its result. Editing makes an earlier successful result stale.
- Validate reflected parameters, reset defaults and save/load named presets scoped to the project and strategy. Report success only after the native session write succeeds. Restore open files, active file, presets and appearance after closing and reopening.
- Resize explorer/editor/results/inspector panels, reveal collapsed panels and retain explicit collapse intent. Light/Dark/System continue using the existing preference owner. All fonts, editor assets and workers load locally.

## Final checks

| Check                                          | Result                                                                                                                      | Local evidence                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Prettier                                       | All matched files pass                                                                                                      | `artifacts/workspace-format-final.log`                            |
| Clean-code structural checks                   | 51 owned production source files pass, including calibrated checker self-tests                                              | `artifacts/workspace-standards-final.log`                         |
| Component/domain tests                         | 42 tests in 10 files pass                                                                                                   | `artifacts/workspace-unit-final.log`                              |
| Browser interaction/accessibility/visual suite | 24 tests pass; six existing onboarding goldens unchanged                                                                    | `artifacts/workspace-ui-final.log`                                |
| Rust formatting                                | Pass                                                                                                                        | `artifacts/final-rust-fmt.log`                                    |
| Clippy, all targets, warnings denied           | Pass                                                                                                                        | `artifacts/final-rust-clippy.log`                                 |
| Rust tests                                     | 41 pass, 0 failed, 0 ignored; includes actual SDK builds, metadata, compiler diagnostics, cancellation and timeout behavior | `artifacts/final-rust-test.log`                                   |
| Embedded-frontend executable build             | Pass, `pnpm tauri build --debug --no-bundle`                                                                                | `artifacts/workspace-build-final.log`                             |
| Native onboarding/window/engine checks         | 10 groups pass                                                                                                              | `artifacts/native/2026-10-24T06-47-34-507Z/report.json`           |
| Native workspace checks                        | 11 groups pass, 0 failures, 0 skips                                                                                         | `artifacts/workspace-native/2026-10-24T07-10-14-171Z/report.json` |
| Preserved-source integrity                     | 100/100 SHA-256 matches against the retained-source manifest                                                                | `artifacts/final-retained-integrity.json`                         |
| Impeccable Build detector                      | No primary findings; one advisory for the previously approved shared grid background                                        | `artifacts/impeccable-build-detect.json`                          |
| Relocated review resources                     | Executable hash matches the tested binary; all 209 adjacent engine/source resource files match                              | `artifacts/review/build-workspace-copy.json`                      |

Browser coverage includes real keyboard editing, durable saves/reload, create/rename/move, actual HTML5 drag/drop, dirty-tab decisions, failed-write recovery, honest preview compilation limits, automated accessibility and layout at 1920 × 1080, 1024 × 720 and 800 × 640 in both themes. No onboarding snapshots were regenerated for this milestone.

Native workspace coverage uses the actual WebView2/Tauri executable and fresh isolated files. It asserts on-disk contents, containment and invalid moves, stale revisions preserving external edits, a real compiled assembly and original schema, a real CS1029 source location, successful rebuilds after correction, overlap rejection, actual cancellation, durable restoration, and the visible editor → save → compile → reflected parameters → preset workflow. The populated form has no automated WCAG A/AA violations or horizontal clipping after preset save.

## Review and quality corrections

Codex integrated and reviewed the patches rather than accepting worker completion messages as verification. The review corrected async document reads across project switches, edits arriving during saves, saved-source epoch capture, failed session/preset write handling, integer schema normalization, local Monaco initialization timing, missing drag handles, Windows HTML5 drag/drop configuration, compact panel sizing and user-collapse intent. Rendered QA additionally fixed tab semantics, light-mode text contrast, header alignment and a long preset's intrinsic-width overflow. A final minimum-width render exposed clipped explorer actions; secondary actions now use the existing shadcn Dropdown Menu, and browser checks assert every header control fits inside the explorer. Shadcn controls keep their upstream size/variant geometry.

Test-harness corrections included Monaco's modern zero-sized EditContext textbox, multiline typing/undo assumptions and distinguishing a signaled child exit from a still-running child. A synthetic clipboard experiment invoked a WebView permission prompt; it was abandoned without granting permission, and the final workflow uses ordinary editing keys. One exploratory run reached the existing 20-second metadata-process timeout; direct execution of that assembly and the final documented-toolchain run succeeded. The timeout was not relaxed or hidden, and failures remain explicit.

## Agents and skills

The native and UI implementation sessions used the available free OpenCode GLM 5.3 Flash and DeepSeek V4.1 Flash models. Their model catalog entries reported zero input/output cost before dispatch. Both workers' tool logs show explicit reads of Reuse First, Ponytail, Impeccable and the project coding standard. The free Mimo test worker stopped making progress; its exact session was interrupted before the requested GPT 6.1 High fallback took ownership of native regression checks. All implementation workers are stopped; the shared OpenCode service and unrelated work were not stopped.

The new [Reuse First skill](../.agents/skills/reuse-first/SKILL.md) is installed project-locally and at `C:/Users/MITOs/.codex/skills/reuse-first`. Both copies pass the official skill validator and have identical hashes. [Dependency decisions](BUILD-DEPENDENCIES.md) record repository/platform/library research, compatibility, licenses and the custom domain logic that remains necessary. The existing clean-code checker now also protects the workspace presentation/native boundary.

## Running review copy

Project: `D:/Projects/Dotatel/BacktestEngine`.

Executable: `artifacts/review/build-workspace-app/BacktestEngine.exe`. Keep adjacent `engine/` and `enginesrc/`. `Start Review.cmd` reopens its separate review profile and example; direct executable launches use ordinary application settings.

The review app was launched from its relocated folder with the development server stopped and no CDP debugging port. Computer Use clicked its visible Build control and confirmed **Build succeeded, 0 errors, 0 warnings**, two reflected parameters and Build ready. The final review build completed in 20286 ms (an earlier review build completed in 5043 ms); these are observed local timings, not a performance guarantee. The populated app is left open. Normal user preferences and projects were not reset or overwritten.

## Practical limits

Compiling edited strategies requires a .NET 10 SDK. The bundled numerical runner is self-contained, but bundling it does not bundle the SDK. Monaco supplies syntax/editing facilities; full semantic C# language-server completion is not included. Build evidence is transient and must be regenerated after restarting; saved files and presets persist.

The preserved C# source emits informational SDK analyzer suggestions, currently 18 for the example's linked engine sources; the successful review build has no compiler errors or warnings. These suggestions are displayed honestly and do not change preserved numerical code. Compilation/reflection runs trusted local C# under the current user's permissions, not in an untrusted-code sandbox.

Backtest/Optimize/Validate/Report, assistant conversations, OS file-drop import, delete operations, release signing, installer distribution, hosted CI execution and trading/numerical parity qualification are outside this milestone. The Windows CI workflow is configured; only local runs are claimed here. Passing checks and reviewed renders do not prove that every possible defect is absent.
