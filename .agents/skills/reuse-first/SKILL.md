---
name: reuse-first
description: Research existing project code, platform features and maintained libraries before implementing a nontrivial reusable software capability or choosing a dependency. Use for editors, file trees and drag/drop, persistence/settings, charts, tables, forms and similar infrastructure. Skip research rituals for trivial local edits with an established solution.
---

# Reuse First

Choose the smallest proven solution that meets the actual requirement. Do not start a custom implementation merely because you can write one, and do not install a package merely because one exists.

## Before implementing a capability

1. Identify the real behavior and constraints: existing stack/design system, supported versions, offline use, accessibility, platform permissions, data integrity and expected scale. Read callers and the applicable project skills.
2. Search the repository and locked dependencies first (`rg`, package manifests, existing components/services/tests). Reuse the project's established implementation unless there is evidence it cannot meet the requirement.
3. Check the platform or standard library. Then, for a genuine gap, search current official documentation and upstream repositories for maintained tools/components. Verify current versions and compatibility from the package registry or upstream source; search snippets are discovery, not proof.
4. Compare credible options against the behavior that matters: license, maintenance, documented support, keyboard/screen-reader behavior, edge cases, offline assets/workers, bundle/runtime cost, integration effort and removal cost. Prefer an existing shared component over a parallel UI system. Do not build a generalized comparison framework or research beyond what changes the decision.
5. Record the decision briefly in existing task notes or a focused dependency decision: what already exists, selected solution with official links, why it fits, material limitations, and why custom code remains necessary. If browsing is unavailable, state what was verified locally and what remains uncertain rather than inventing evidence.
6. Integrate the documented public API with focused domain adapters. Keep validation, cancellation, atomic writes and error handling at the app boundary. A library handles generic mechanics; application code owns product rules. Verify behavior in the actual target runtime before accepting the integration.

## Common applications

- **Explorer/file trees:** investigate a maintained accessible tree with keyboard navigation, rename and drag/drop before writing recursive interaction logic. Verify moving folders, rejecting ancestor cycles/name collisions, preserving unsaved documents, and persisting actual filesystem changes. A tree package does not authorize filesystem access or make path validation unnecessary.
- **Editors:** investigate a supported editor and its React integration instead of expanding a textarea into an IDE. Bundle assets/workers locally for offline desktop use. Syntax coloring is not compiler validation or language-server completion; distinguish those capabilities honestly.
- **Settings/configuration:** preserve and reuse the current validated durable store. Consider the platform's persistence tooling for missing infrastructure. Do not replace working atomic storage just to add a package, and never silently reset malformed or failed writes.
- **Charts/tables:** investigate established components before writing drawing, interaction, sorting or virtualization infrastructure. Check truthful source data, undefined values, accessibility, resizing, licensing and package weight. A request about charts as an example does not authorize adding charts to the product.

## Working with other agents

Include this skill and the project's UI/clean-code skills in each implementation brief. Require a short research decision before custom infrastructure. Assign file ownership, share typed contracts and review the actual patch/tests; a worker's success message is not acceptance. Respect the user's model/cost constraints and delegation authorization. Stop a stalled worker before handing its files to a replacement.

Research should reduce bespoke code and integration risk. It never guarantees fewer bugs, replaces testing, or expands the user's scope.
