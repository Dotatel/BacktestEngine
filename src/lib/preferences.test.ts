import { expect, test } from "vitest";
import { defaultPreferences, parsePreferences } from "./preferences";

test("only supported setup values cross the storage boundary", () => {
  expect(
    parsePreferences({ ...defaultPreferences, step: 5, completed: true }),
  ).toMatchObject({ completed: true });
  for (const invalid of [
    null,
    {},
    { ...defaultPreferences, step: 0 },
    { ...defaultPreferences, completed: true },
    { ...defaultPreferences, appearance: "sepia" },
    { ...defaultPreferences, agent: "unknown" },
    { ...defaultPreferences, agentVerified: true },
  ]) {
    expect(() => parsePreferences(invalid)).toThrow();
  }
});
