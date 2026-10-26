import { describe, expect, it } from "vitest";
import type { CompiledStrategy } from "@/lib/workspace-contract";
import {
  defaultOptimizationForm,
  optimizationRequest,
  parseDimension,
} from "./optimization-form";

// Synthetic schema fixtures test adapter validation, not trading or optimizer performance.
const strategy: CompiledStrategy = {
  strategy: "Synthetic",
  strategyType: "Synthetic",
  parameters: [
    {
      name: "Hold",
      displayName: "Hold",
      group: "",
      valueType: "integer",
      default: 10,
      min: 1,
      max: 100,
      step: 1,
      options: null,
    },
  ],
};
const form = {
  ...defaultOptimizationForm,
  datasetId: "synthetic-data",
  symbolSpecId: "synthetic-profile",
};
const dimensions = [{ name: "Hold", text: "[10,20]" }];

describe("optimization draft contract (synthetic)", () => {
  it("freezes typed base values and exact arrays without generating candidates", () => {
    const values = { Hold: 12 };
    const request = optimizationRequest(
      form,
      dimensions,
      strategy,
      values,
      "ticks",
    );
    values.Hold = 99;
    expect(request.baseParameters.Hold).toBe(12);
    expect(request.dimensions).toEqual([{ name: "Hold", values: [10, 20] }]);
    expect(request.commissionUsdPerMillion).toBe(-1);
    expect(request.spreadPips).toBeUndefined();
  });
  it.each([
    "{}",
    "[null]",
    "[10,10.0]",
    "[101]",
    '["10"]',
    "[1.5]",
    "[]",
    "bad JSON",
  ])("rejects malformed or schema-invalid dimension %s", (text) => {
    expect(() => parseDimension({ name: "Hold", text }, strategy)).toThrow();
  });
  it("rejects unknown parameter names and nonzero slippage rather than discarding them", () => {
    expect(() =>
      parseDimension({ name: "Balance", text: "[10]" }, strategy),
    ).toThrow();
    expect(() =>
      optimizationRequest(
        { ...form, slippage: "0.1" },
        dimensions,
        strategy,
        { Hold: 10 },
        "ticks",
      ),
    ).toThrow("does not support");
  });
  it("requires explicit bar spread, finite budgets and ordered UTC periods", () => {
    expect(() =>
      optimizationRequest(form, dimensions, strategy, { Hold: 10 }, "bars"),
    ).toThrow("Bar replay");
    expect(() =>
      optimizationRequest(
        { ...form, maxRuns: "101" },
        dimensions,
        strategy,
        { Hold: 10 },
        "ticks",
      ),
    ).toThrow("Run budget");
    expect(() =>
      optimizationRequest(
        {
          ...form,
          startUtc: "2026-01-02T00:00:00Z",
          endUtc: "2026-01-01T00:00:00Z",
        },
        dimensions,
        strategy,
        { Hold: 10 },
        "ticks",
      ),
    ).toThrow("after start");
  });
});
