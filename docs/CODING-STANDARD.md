# Coding standard

These are the owner's established requirements, carried into the standalone project. They take precedence over a skill's generic preferences.

- Give each component, hook and service one responsibility. Presentation must not perform filesystem/native IPC or own persistence queues.
- Keep named functions focused and descriptive. Keep control-flow nesting to two levels and avoid nested conditional expressions. Extract meaningful domain operations rather than adding flags.
- Document named functions, classes and public contracts using JSDoc/XML docs/docstrings. Explain purpose, relevant inputs/outputs, side effects, errors and limitations when applicable. This overrides Ponytail's comments-only-on-why default.
- Use existing components, platform APIs and dependencies first. Do not create generic repositories, event buses, factories, wrappers or future configuration for this flow.
- Use shadcn's component size/variant APIs unchanged. Screen CSS may arrange components; it must not override their height, width, radius, type size, icon size or padding. Typography and motion follow shared design tokens.
- Preserve validation at storage/IPC boundaries, atomic persistence, cancellation, actionable errors, keyboard navigation, visible focus and reduced-motion behavior.
- Preserve the retained C# and Python numerical code and tests. Test fixtures do not establish native trading parity.
- Format owned source, type-check and run structural, behavior, accessibility, visual and applicable Windows checks. Compare rendered UI against the approved direction. Record intentional baseline changes; do not update snapshots to conceal a failure.

`pnpm standards` checks authored TypeScript structure and component-geometry overrides. It excludes retained engines, imported design references and upstream shadcn component source; those stay under their existing integrity/license contracts. Structural checks supplement review rather than proving code quality by themselves.
