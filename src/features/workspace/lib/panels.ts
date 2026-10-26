/** Remember whether a secondary panel was closed by the compact layout or explicitly by the user. */
export interface PanelVisibilityIntent {
  userCollapsed: boolean;
  autoCollapsed: boolean;
}

/** The breakpoint action to apply and the intent to remember afterward. */
export interface PanelVisibilityDecision {
  action: "collapse" | "expand" | null;
  intent: PanelVisibilityIntent;
}

/**
 * Decide whether the compact breakpoint may change a panel. An explicit user collapse always
 * wins; only a panel the breakpoint closed itself is restored when room returns.
 */
export function compactPanelDecision(
  compact: boolean,
  intent: PanelVisibilityIntent,
): PanelVisibilityDecision {
  if (!compact) return roomyDecision(intent);
  if (intent.userCollapsed) return unchangedDecision(intent);
  return {
    action: "collapse",
    intent: { userCollapsed: false, autoCollapsed: true },
  };
}

/** Restore only the panel the breakpoint closed earlier. */
function roomyDecision(intent: PanelVisibilityIntent): PanelVisibilityDecision {
  if (!intent.autoCollapsed || intent.userCollapsed)
    return unchangedDecision(intent);
  return {
    action: "expand",
    intent: { userCollapsed: false, autoCollapsed: false },
  };
}

/** Keep the current intent when the breakpoint should not act. */
function unchangedDecision(
  intent: PanelVisibilityIntent,
): PanelVisibilityDecision {
  return { action: null, intent };
}
