# DotaTel BacktestEngine

Standalone **Tauri 2 + Rust + React + TypeScript + shadcn/ui** desktop project. The original **C#/.NET 10 engine** and **Python validation** are retained under `engines/`. No Electron, orchestration runtime, agents or sibling project checkout is needed to run the application.

The approved onboarding and Build workspace provide real project files, a local Monaco editor, C# compilation, diagnostics, reflected parameters and saved presets. Current work adds historical price preview, guarded real execution, results, original-optimizer integration, report-only and engine-scenario Python validation, verified saved-run history, report export, application settings and an optional assistant panel. These increments have different verification levels; the complete product remains in progress. See [the initial branch checkpoint](docs/INITIAL-CHECKPOINT.md) for the latest review-build evidence and [the acceptance matrix](docs/PRODUCT-ACCEPTANCE.md) for earlier checkpoints and remaining work.

The onboarding refinement is recorded in [docs/REFINEMENT-2026-10-24.md](docs/REFINEMENT-2026-10-24.md). Build scope and dependency decisions are in [docs/BUILD-WORKSPACE.md](docs/BUILD-WORKSPACE.md) and [docs/BUILD-DEPENDENCIES.md](docs/BUILD-DEPENDENCIES.md), with earlier test evidence in [docs/BUILD-VERIFICATION-2026-10-24.md](docs/BUILD-VERIFICATION-2026-10-24.md). On the development machine, `artifacts/review/Start Latest Preview.cmd` opens the latest verified review copy with its separate profile. Generated review executables, runtime bundles and local profiles are excluded from Git; a fresh clone must follow the preparation and build steps below.

## Project layout

```text
BacktestEngine/
├── src/                    React interface and typed desktop bridge
│   ├── components/ui/      Official shadcn component source
│   ├── components/         Branded choices and custom title bar
│   ├── features/onboarding/ Approved setup views, navigation, connection and storage
│   ├── features/workspace/
│   │   ├── components/     Explorer, editor, parameters, results and dialogs
│   │   ├── hooks/          Project, documents, build, parameters and session state
│   │   ├── lib/            Parameter validation, paths, panels and local Monaco setup
│   │   └── BuildWorkspace.tsx  Main workspace composition
│   ├── features/execution/   Backtest inputs, real price chart and result inspection
│   ├── features/optimization/ Original optimizer controls and candidate evidence
│   ├── features/reports/     Verified saved-run history, report inspection and export
│   ├── features/validation/  Original Python report checks and frozen engine scenarios
│   ├── features/assistant/   Optional proposal panel, explicit sharing and local drafts
│   ├── features/settings/   Application preferences and diagnostics
│   ├── hooks/              Native window-state and unsaved-close protection
│   ├── styles/             Shared motion tokens and reduced-motion policy
│   └── lib/                Preferences, workspace contracts, scoped IPC and preview
├── src-tauri/
│   ├── src/                Rust settings, scoped filesystem, compiler and engine integration
│   ├── capabilities/       Explicit native window/dialog permissions
│   └── resources/          Generated engine binary/source bundles (ignored)
├── engines/
│   ├── csharp/             Preserved C# source, examples and contract tests
│   └── validation/         Preserved Python validation source
├── public/assets/          Local logos, Manrope and approved option artwork
├── tests/ui/               Browser accessibility, interaction and visual tests
├── scripts/                Development, engine publishing and native UI checks
├── .agents/skills/          Reuse First, Impeccable, Ponytail and the owner coding standard
└── docs/                   Design references, provenance and verification
```

## Run on Windows

Development prerequisites: Node.js 24, pnpm 11, PowerShell 7, stable Rust MSVC, Visual Studio C++ build tools/Windows SDK, .NET 10 SDK and Microsoft WebView2. Prepared application resources include the official .NET SDK for local source compilation and embeddable Python for validation. The installer includes offline WebView2 setup. These resources do not require a sibling project or installed development toolchain on the eventual end-user machine; clean-machine qualification remains pending.

```powershell
pnpm install --frozen-lockfile
./scripts/prepare-engine.ps1
./scripts/prepare-runtimes.ps1
./scripts/prepare-validation.ps1
./scripts/prepare-validation-host.ps1
./scripts/prepare-optimizer.ps1
./scripts/dev.ps1
```

For the current machine, `scripts/windows-env.ps1` also recognizes the optional portable toolchains in the adjacent `../.build-tools` directory. Those tools are outside the repository, and no machine-wide PATH or security setting is changed. Standard installed build tools work without that directory. Tauri's environment summary does not register the portable MSVC distribution as a Visual Studio installation; actual native builds use its compiler, SDK and linker directly.

Build an executable containing the frontend and bundled C# runtime:

```powershell
. ./scripts/windows-env.ps1
pnpm tauri build --debug --no-bundle
```

Run `src-tauri/target/debug/dotatel-backtest-engine.exe` directly. Keep the generated resource folders beside it: `engine/`, `enginesrc/`, `validation/`, `optimizer/` and `runtimes/`. It does not require Vite, Node, OpenCode or the old project for core work. To build an unsigned installer checkpoint, use `pnpm tauri build --debug --bundles nsis`. An installer build alone does not establish release qualification. See [runtime provenance and offline boundaries](docs/OFFLINE-RUNTIMES.md).

## Verify

```powershell
. ./scripts/windows-env.ps1
pnpm format:check
pnpm standards
pnpm test
pnpm build
pnpm test:ui
./scripts/verify-retained-source.ps1
./scripts/test-runtime-staging.ps1
./scripts/test-optimizer-host.ps1
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
pnpm test:desktop
pnpm test:workspace:desktop
```

Native UI checks launch the **actual embedded-frontend Tauri executable**, inspect its WebView2 surface using process-local debugging, operate its real native buttons, invoke the bundled C# engine and test persistence/recovery across fresh app processes. They use an isolated temporary settings/profile folder under `artifacts/native/`; normal review launches have no debugging port. The browser tests are additional frontend coverage, not a substitute for native checks.

Workspace desktop checks use a separate `artifacts/workspace-native/` fixture and additionally verify containment, revision conflicts, real compiler errors, cancellation, reflected schema and the visible editor-to-build-to-preset workflow. No checks overwrite the user's projects or normal application settings.

Set `$env:BACKTEST_TEST_OPENCODE = '1'` before native tests to additionally verify an already-running local OpenCode Desktop service. This makes only a read-only `/api/info` request through its CLI: no agent sessions, model requests, project uploads or account changes occur. Ordinary CI and offline setup require no agent.

Visual snapshots are implementation regression baselines, **pending owner approval**. Do not regenerate them to hide a regression. Compare changes with the approved reference PNGs under `docs/design-context/screens/onboarding/` and inspect real native captures. CI is configured in `.github/workflows/check.yml`; local test results do not assert that a hosted CI run has occurred.

## Behavior and boundaries

- Welcome is a real 660 × 470 window. Get Started expands it. The frame and minimize/maximize/restore/close controls are drawn by React and call Tauri window APIs.
- Setup saves validated preferences atomically as the user advances. Back retains selections, unfinished setup resumes, and Finish persists completion and opens Build. Corrupt settings require explicit recovery and a preserved backup.
- System appearance follows the OS; Light and Dark stay fixed. Fonts and artwork are bundled for offline use.
- Agent connection is optional. OpenCode Desktop is the first supported local-service connection. Codex and Claude Code currently report that their adapters are unavailable; selecting a provider never invents a successful connection. Saved connections are reverified before being represented as live on a new app launch.
- Open folder selects a real project. Use example project creates an app-managed copy of the preserved example. Create, rename and move operate on disk; path escapes, junctions, cycles, collisions and stale revisions are rejected. Drafts survive failed saves; closing or reorganizing requires a save/discard decision.
- The editor bundles Monaco and its worker locally. It offers syntax highlighting, navigation, search and undo; full semantic C# completion/language-server integration is outside this milestone. Browser preview stores isolated fixtures and explicitly cannot compile C#.
- Build saves drafts, snapshots the actual source, compiles against the preserved engine and reads the assembly's reflected strategy metadata. Problems navigate to source; canceled or failed builds never become successful artifacts. Parameter presets are validated and saved separately from source text. Build results become stale after source edits and are rebuilt after reopening the app.
- The native compiler executes the selected strategy assembly to reflect its metadata under the current user's permissions; only open and build source you trust. This is a local development tool, not a sandbox for untrusted C# code.
- Backtest dispatch accepts only the host-approved build and verified registered inputs. Positive and zero-trade replay qualification still require a genuine economics profile and its authority bundle; invalid or missing evidence remains an error. Charts can inspect verified historical prices before a strategy build. Synthetic test data is not trading evidence.
- Report-only Python checks and frozen cost/latency/walk-forward controls are integrated. Walk-forward executes fixed-parameter test splits; it does not train or optimize parameters. Durable selected-run history verifies native completion records before reopening a result. The optional assistant pane preserves local drafts and requires explicit sharing, review and Send. Genuine financial scenario acceptance and live assistant replies remain unverified; no numerical trading-parity or release claim follows from the available tests. Application settings/extensions/manual updates and final installed workflows retain their documented acceptance limits.

The preserved source uses Apache-2.0; copied assets and component dependencies retain their own notices. See `docs/THIRD_PARTY_NOTICES.md`.
