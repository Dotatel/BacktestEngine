import { expect, test } from "vitest";
import type { StrategyParameter } from "@/lib/workspace-contract";
import {
  parameterKind,
  parseParameterText,
  validateParameterValue,
} from "./parameters";

/** Build one reflected parameter with explicit canonical type metadata. */
function reflected(
  valueType: StrategyParameter["valueType"],
  overrides: Partial<StrategyParameter> = {},
): StrategyParameter {
  return {
    name: "value",
    displayName: "Value",
    group: "General",
    valueType,
    default: null,
    min: null,
    max: null,
    step: null,
    options: null,
    ...overrides,
  };
}

test("canonical integer and number types stay numeric without bounds", () => {
  const integer = reflected("integer");
  const number = reflected("number");
  expect(parameterKind(integer)).toBe("number");
  expect(parameterKind(number)).toBe("number");
  expect(validateParameterValue(integer, 2)).toBeNull();
  expect(validateParameterValue(integer, 1.5)).toBe("Enter a whole number.");
  expect(validateParameterValue(number, 1.5)).toBeNull();
  expect(parseParameterText(number, "2.5").value).toBe(2.5);
});

test("null options never become an option control and free text remains typed", () => {
  const timeframe = reflected("timeframe");
  const text = reflected("string");
  expect(parameterKind(timeframe)).toBe("text");
  expect(parameterKind(text)).toBe("text");
  expect(validateParameterValue(timeframe, "5m")).toBeNull();
  expect(parseParameterText(timeframe, "5m").value).toBe("5m");
});

test("bounded steps and non-numeric input report actionable messages", () => {
  const stepped = reflected("integer", { min: 0, max: 10, step: 2 });
  expect(validateParameterValue(stepped, 4)).toBeNull();
  expect(validateParameterValue(stepped, 3)).toBe("Use increments of 2.");
  expect(validateParameterValue(stepped, 12)).toBe(
    "Use a value no greater than 10.",
  );
  expect(parseParameterText(stepped, "abc").error).toBe("Enter a number.");
});
