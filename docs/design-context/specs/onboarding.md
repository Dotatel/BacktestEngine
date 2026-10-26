# First launch

These five steps supersede the old onboarding flow. There is no workspace-folder/storage step, compulsory account, marketing tour or mandatory AI connection.

| Step | Content and action | Window behavior |
| --- | --- | --- |
| P01 Welcome | Official Dotatel logo, “Welcome to BacktestEngine”, **Get Started**. | A compact native window. The Figma 1672×941 frame is a presentation scene containing a 660×470 window; do not make the actual welcome window full-screen. |
| P02 Workspace style | Simple: “Same tools, simpler interface.” Advanced: “More controls and panels in view.” Continue and Back. | Get Started expands to the full desktop setup window. Simple is the illustrated selection; do not claim that it removes engine capabilities. |
| P03 Appearance | System, Light, Dark. Preview, title, short description, radio below each option. Continue and Back. | Keep the established Dotatel background and appearance illustrations. Apply selection consistently, with a system-setting listener only when System is selected. |
| P04 Connect agent | Codex, Claude Code, OpenCode. Small authentic brand marks, text/description/radio below. Connect agent, Skip for now, Back. | Connection is optional. Selection alone is not a successful connection. |
| P05 Finish | “You’re all set”, actual chosen workspace style, appearance and connected/skipped agent. Open BacktestEngine, Back. | Continue to the project launcher; no project is created automatically. |

Use the images as the authority for composition. P02–P04 use unboxed options: preview/mark → title → one short description → radio. No large enclosing cards, giant icons, selected badges or invented feature lists. The native source and SVGs preserve the visual measurements; main UI font is Manrope.

## Behavior to implement

- Persist validated preferences as the user advances. Back retains selections. Closing halfway should resume completed progress on the next launch; committing Finish marks onboarding complete. These persistence rules are proposed implementation requirements, not a claim about existing app behavior.
- A returning configured user reaches the project launcher. Reopen setup from Settings without resetting project files.
- Radio groups support keyboard arrows, Space, visible focus and readable selected states. Use real labels and radios; do not use a screenshot as a control.
- AI states: not connected, connecting, connected, failed, canceled, skipped. Show actionable connection errors and a retry/skip path. Do not invent provider-specific OAuth, API-key or local-session flows until the real integration contract is selected.
- Keep authentication secrets out of UI logs and project files. Display only the provider and connection status in Finish. Use the bundled provider marks to identify brands; no endorsement is implied.
- Workspace style and appearance must be changeable later. Full appearance variants for every onboarding screen have not been independently approved; do not silently invent them under the guise of an exact replica.
