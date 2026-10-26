import { expect, test } from "vitest";
import { compactPanelDecision } from "./panels";

test("the compact breakpoint closes an open panel and remembers why", () => {
  const decision = compactPanelDecision(true, {
    userCollapsed: false,
    autoCollapsed: false,
  });
  expect(decision).toEqual({
    action: "collapse",
    intent: { userCollapsed: false, autoCollapsed: true },
  });
});

test("the compact breakpoint never overrides an explicit user collapse", () => {
  const intent = { userCollapsed: true, autoCollapsed: false };
  expect(compactPanelDecision(true, intent)).toEqual({
    action: null,
    intent,
  });
});

test("room restores only a panel the breakpoint closed itself", () => {
  expect(
    compactPanelDecision(false, {
      userCollapsed: false,
      autoCollapsed: true,
    }),
  ).toEqual({
    action: "expand",
    intent: { userCollapsed: false, autoCollapsed: false },
  });
  const explicit = { userCollapsed: true, autoCollapsed: false };
  expect(compactPanelDecision(false, explicit)).toEqual({
    action: null,
    intent: explicit,
  });
});
