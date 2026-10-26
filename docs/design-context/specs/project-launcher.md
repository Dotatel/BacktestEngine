# Project launcher

Use the native Default/EMA/Breakout/Mean/RSI PNGs. Keep the Dotatel theme, wordmark, small outline navigation icons and application shell. This is a desktop launcher, with no chart workspace or assistant until a project is opened.

## Layout

At 1617×973, the main panel begins at x84/y76. Shared content boundaries are x336 and x1364 (width1028). The top region has two equal 514px columns with a thin divider at x850, from y166 for322px. Column contents have48px separation from the divider. Align Projects and Recent projects headings on the same baseline.

Projects contains a short description, a phosphor **Create new project** button and an outlined **Open project** button. Native buttons are466×60. Recent projects uses simple full-row links with a small folder icon, name and chevron. The illustrated names are EURUSD research, Gold strategies and Portfolio tests; show actual history in a working product. No fake recent entries for a new installation.

“Start with an example” spans the same x336–1364 content area below both columns. Exactly **four** equal257px cells, with centered200×114 previews starting y594, followed by centered title and a short description. Keep all image/text content within the shared outer boundaries.

| Example | Description |
| --- | --- |
| EMA pullback | Trend-following example |
| Breakout strategy | Range breakout example |
| Mean reversion | Return-to-mean example |
| RSI reversal | Momentum reversal example |

Thumbnails are small skeleton trading workspaces with candles and relevant contextual hints. Reuse their exact artwork via [crop map](../assets/strategy-previews.json) and [CSS](../assets/strategy-previews.css). Full-frame state PNGs are the original image sources, not separately generated replacement illustrations.

## Behavior

- Default previews are muted gray. Only the hovered or keyboard-focused example becomes full color. About150ms transition; respect reduced motion. Keep readable text in both states. Focus retains a visible outline and the color state independently of pointer hover.
- Clicking an example starts project creation with that template selected. Ask for project name/location before writing; do not mutate a recent project or imply the illustrative strategy is profitable.
- Create opens a compact project-creation dialog with name, destination and chosen template/blank state. This dialog's behavior is specified; its final visual design is not included as approved.
- Open invokes the desktop's existing-project picker. Cancel returns unchanged. Validate the project manifest and explain unsupported/corrupt projects. An example strategy is not arbitrary compiled .algo compatibility.
- Recent rows open in one action. If missing, offer Locate or Remove from recents; removing a history entry does not delete the project. Busy/error states keep the row and clear feedback.
- For no recents, use an honest empty message in the right column. Preserve the two-column alignment. Smaller-window adaptation is pending review; avoid inventing a mobile layout. Allow scrolling before collapsing essential actions.

In Figma, the five native state variants exist. **Hover prototype wiring is incomplete**, and the current link from Default is not a verified transition to EMA. The CSS preview demonstrates intended asset behavior only; project operations remain unimplemented by this package.
