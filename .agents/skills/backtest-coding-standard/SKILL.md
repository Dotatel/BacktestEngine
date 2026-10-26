---
name: backtest-coding-standard
description: Apply the owner's clean-code, documentation, shared-component and real verification standards to the standalone BacktestEngine application.
---

# BacktestEngine coding standard

Read AGENTS.md and docs/CODING-STANDARD.md. Apply this standard together with Reuse First, Ponytail and Impeccable for UI work. The owner's requirements take priority: document named functions and public contracts even though Ponytail normally minimizes comments. Follow the current owner-authorized delegation policy in AGENTS.md; the lead performs QA and integration review.

Keep presentation, navigation, persistence, connections and native integration separate. Use idiomatic React functions/hooks and focused Rust modules; introduce classes only when a stateful lifecycle actually needs one. Use descriptive names, one purpose per function and at most two nested control-flow blocks. Prefer early returns and named domain operations over flags and nested ternaries.

Inspect every caller before changing a shared boundary. Preserve validation, atomic writes, cancellation, errors, accessibility, offline operation and user files. Keep the C# engine and Python validation behavior unchanged. No speculative abstractions, generic framework layers, unnecessary dependencies or code for later.

Use the checked-in shadcn components and their public size/variant APIs. Page styles own composition; they do not redefine component geometry. Put reused typography, spacing and motion choices in the design system. Do not claim a visual match from tests alone.

Run formatting, type checks, structural checks, meaningful behavior/accessibility tests and relevant native checks. Inspect real rendered screens at supported sizes. Report exact evidence, remaining limits and whether the owner has approved the result. Never claim trading parity or a release qualification from onboarding tests.
