# Asset usage

All screen previews and required current-screen art are local. Do not fetch substitute artwork or redraw the wordmark.

- Dotatel logo variants: `../../Brand/Logo/SVG/`; dark-background wordmark is `dotatel-logo-dark.svg`, light-background wordmark is `dotatel-logo-primary.svg`. Follow `../../Brand/Logo/USAGE.md` and brand sizing tokens. The package includes these two variants; other variants mentioned by the original usage guide are not needed by the current screens and are not bundled.
- `fonts/`: Manrope400/500/600/700, CSS font-face declarations and SIL OFL1.1. Source Serif4 remains an editorial brand token; it is unused by these application screens and not required to render them.
- `icons/`: 27 exact Lucide-static1.58.0 SVGs using currentColor; license includes ISC and upstream Feather attribution.
- `onboarding/`: approved Simple/Advanced and System/Light/Dark previews, plus the supplied Codex/Claude/OpenCode marks. Keep provider marks small and preserve their aspect ratios.
- `strategy-previews.json`: exact crop coordinates into the native full-frame launcher PNGs, including gray and colored source paths for all four examples. This supplies the actual artwork without an invented redraw. `strategy-previews.css` renders the crops and a hover/focus color transition; its paths are relative to this folder. Use a focusable `.example` element containing `<span class="strategy-preview" data-strategy="ema" aria-hidden="true"></span>` followed by its visible title and description. Substitute the four documented IDs. Use native layout and controls for the real UI; these skeleton previews are decorative artwork.

The gallery demonstrates asset-only hover/focus. It does not run project creation, the research engine, provider authentication or Figma prototypes.

See `../THIRD_PARTY_NOTICES.md` for source and attribution. No signed upload URLs or local-user filesystem paths are needed.
