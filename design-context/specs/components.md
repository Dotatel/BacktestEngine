# Component and state contract

The original Figma library uses **local shadcn-style adaptations** and Lucide icons. No published shadcn kit or Code Connect binding is asserted. Reuse primitives if the selected implementation stack supports them; framework choice remains open.

| Component | Required variants/state | Rule |
| --- | --- | --- |
| Button | primary, secondary/outline, ghost; rest, hover, focus, pressed, disabled, busy | One clear primary action per task region. Stable labels and dimensions when busy. |
| Navigation item | rest, hover, focus, selected, disabled/unavailable | Small consistent icon, readable label; selected route is not color-only. |
| Field/select | rest, focus, invalid, disabled | Visible label, unit and useful error text; no placeholder-only identification. |
| Radio option | unselected, selected, focus, disabled | Preview then text/description/radio underneath for onboarding. |
| Date range | rest, focused handle, dragging, invalid/unavailable interval | Exact text input plus keyboard controls; ordered bounds within coverage. |
| Example | gray rest, colored hover, colored focus, activating | Four consistent cells; no enclosing marketing cards. |
| Tab | rest, hover, focus, selected | Preserve associated content and selected run. |
| Recent project row | rest, hover, focus, opening, missing/error | Whole row opens; do not fabricate history. |
| Result table | empty, populated, loading, error; row focus/selection | Plain colored direction/result text with readable labels. |
| Assistant | docked, expanded, generating, stopped, failed | Preserve conversation, input draft and run context across modes. |

Canonical brand primitives are in `Brand/brand-tokens.json`; semantic roles are in `tokens/semantic.json`. Theme roles include contrast-adjusted success/loss colors from the existing Figma foundation; these do not rename or overwrite the named brand colors. Phosphor means primary action/selection, not profit. Keep text and shape cues alongside status color.

Manrope weights400/500/600/700 are supplied. Existing compact workspace styles (size/line-height): Caption11/16 Regular; Body12/18 Regular; Control13/20 Medium; Text14/22 Regular; Title16/24 SemiBold; Button13/20 SemiBold. Launcher/onboarding use their larger illustrated sizes; do not apply onboarding heading sizes to the dense workspace.

Icons use the exact bundled Lucide SVG paths with `currentColor`. Keep normal stroke weight2 on24-unit viewBoxes, scale consistently. Use the official supplied Dotatel logo; no redrawn wordmark or invented AI-provider symbols.

Implementation verification must cover keyboard order/focus, labels, contrast in both themes, text zoom/wrapping, reduced motion, date input without dragging, and honest loading/error states. These are acceptance criteria, not a completed accessibility audit.
