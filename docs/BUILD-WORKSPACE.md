# Build workspace implementation contract

Owner-authorized milestone, 24 October 2026. Extend the approved onboarding visual world with a dense, calm strategy workstation. Codex leads QA; free OpenCode workers implement separate owned files. No paid OpenCode calls. If a worker returns a limit or stalls, interrupt its exact session before a GPT 6.1 High replacement takes ownership. No unrelated sessions, services or user files may be stopped/reset.

Read AGENTS.md and `.agents/skills/{reuse-first,ponytail,backtest-coding-standard,impeccable}/SKILL.md`. Named functions/contracts need documentation, nesting <=2, no nested ternaries, no per-screen shadcn geometry overrides, no fake successful builds. Use current official docs and package metadata; record decisions in docs/BUILD-DEPENDENCIES.md. The owner is away and explicitly requests no questions: proceed with the existing references and documented assumptions. No concept reset or onboarding redesign.

## Scope

- Main Build stage with the existing custom title bar, project identity, stage tabs, slim global navigation rail, resizable explorer/editor/parameters and bottom Problems/Output panel. Use the existing local wordmark, Manrope, semantic palette, compact typography and standard shadcn presets. Later stages/navigation are honestly unavailable.
- Empty state with Open folder and Use example project. Native projects/files are real; browser preview is isolated and labeled. Opening/creating a project restores/persists its selected/open files. No account or agent required.
- Accessible explorer: expand/select, keyboard navigation, create file/folder, rename and move (drag/drop plus an accessible move alternative). Reuse a tree library. Reject collisions, ancestor cycles and root escapes. Preserve unsaved documents; block structural changes while dirty or explicitly resolve them, never silently discard text. Deletion is out of this milestone.
- Real locally bundled code editor, C#/JSON syntax highlighting, line numbers, find, undo/redo, tabs, dirty indicators, Save/Save all and Ctrl/Cmd+S. No CDN assets/workers. Syntax highlighting is not C# semantic IntelliSense. External-edit conflicts must reject saves and preserve the draft.
- Real saved-source C# builds through the preserved engine source-linked build mechanism. Never mutate retained engine files. Use the installed .NET SDK; give a useful SDK-missing error if absent. Use official compiler diagnostics rather than writing a C# parser. Reject overlapping builds; provide cancellation/timeout and no stale success after edits. Invoke the engine's existing StrategyMetadata code on compiled robot types to display truthful parameter schemas/defaults.
- Parameters and named presets stored durably in app-owned session metadata, scoped by project root and robot name, with labeled inputs and validation from reflected schema. Keep presets distinct from source changes and report stale build evidence after editing.
- Theme settings may reuse onboarding's appearance owner. No implementation of Backtest/Optimize/Validate/Report, charts, AI conversations or extensions. No fabricated trades/results.

## Shared boundary

`src/lib/workspace-contract.ts` is owned by the QA lead. All data shapes and bridge signatures there are authoritative. File paths are project-relative forward-slash IDs. Root is shown to users but all operations resolve against the selected canonical root at the host. Documents carry a host revision to detect external modifications. The frontend must preserve drafts if saving fails. Use an explicit build report with compiler diagnostics, reflected strategies and artifact path, not a magic busy string.

Native command mapping: `workspace_load_session`, `workspace_save_session {session}`, `workspace_create_project`, `workspace_open_project {root}`, `workspace_refresh_project`, `workspace_read_document {path}`, `workspace_save_document {path,content,revision}`, `workspace_create_entry {parent,name,kind}`, `workspace_rename_entry {path,name}`, `workspace_move_entry {path,parent}`, `workspace_build`, `workspace_cancel_build`. The frontend native folder picker uses the official Tauri dialog plugin, then calls open_project. Scope all mutations to the selected root and reject symlinks/reparse-point traversal outside it. Build caches/snapshots live in app-owned directories, outside user source. No unbounded renderer shell commands.

## Ownership

- Native worker: `src-tauri/src/workspace*.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/capabilities/main.json`, `src-tauri/tauri.conf.json`, `scripts/prepare-engine.ps1`, `.gitignore`, additional app-owned build helper/template files under `tools/` if truly needed. Do not touch frontend/tests/retained engines. Coordinate shared lib.rs rather than replacing existing preference/window behavior.
- UI worker: new `src/features/workspace/**` only, including tests there if useful. Export `BuildWorkspace` taking `BuildWorkspaceProps`. Do not edit App, onboarding, shared UI primitives, bridge, package manifests, backend or other tests. The lead installs/reviews dependencies, builds the bridge and integrates routing/tests.
- QA lead: shared contract, TS bridge/browser preview, dependency installation, skills/docs, integration/routing, top-level tests, review captures and final corrections.

## Acceptance

Source review and standards gate; type/build checks; meaningful file/conflict/build/cancel tests; existing onboarding regression suite; real native filesystem and compiler checks; keyboard tree/editor/save flow; light/dark/responsive renders at 1024×720 and 1920×1080; accessible labeled controls and empty/error states; offline editor assets; preserved-source SHA manifest. Inspect real rendered UI. Agent self-reports are evidence to verify, not acceptance. Publish no release or remote repository.
