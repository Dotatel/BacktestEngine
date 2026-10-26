import type { FullValidationRequest } from "@/lib/full-validation";

/** Text inputs stay editable until a complete scenario request passes local bounds. */
export const fullValidationDefaults = {
  spreadMultipliers: "1, 1.5, 2",
  commissionMultipliers: "1, 1.5, 2",
  latencyTicks: "1, 2, 5",
  trainDays: "90",
  validationDays: "30",
  testDays: "30",
  embargoDays: "1",
  monteCarloRuns: "1000",
  seed: "42",
};

/** Shared form shape names exactly the controls passed to the retained workflow. */
export type FullValidationForm = typeof fullValidationDefaults;

/** Reject blank, nonfinite, fractional integer and out-of-range user inputs. */
function numeric(
  text: string,
  min: number,
  max: number,
  integer = true,
): number {
  const value = Number(text);
  if (
    !text.trim() ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(
      "Correct the scenario settings: use finite values within the displayed bounds.",
    );
  return value;
}

/** Bound each explicit axis before handing scenario expansion to the native planner. */
function axis(
  text: string,
  min: number,
  max: number,
  integer: boolean,
): number[] {
  const values = text
    .split(",")
    .map((item) => numeric(item, min, max, integer));
  if (values.length > 8 || new Set(values).size !== values.length)
    throw new Error(
      "Each scenario list needs 1–8 distinct comma-separated values.",
    );
  return values;
}

/** Build a request from a host-issued baseline capability, never a renderer-provided file path. */
export function fullValidationRequest(
  form: FullValidationForm,
  runId: string,
  receipt: string,
): FullValidationRequest {
  return {
    executionRunId: runId,
    replayReceiptSha256: receipt,
    spreadMultipliers: axis(form.spreadMultipliers, 0.1, 10, false),
    commissionMultipliers: axis(form.commissionMultipliers, 0.1, 10, false),
    latencyTicks: axis(form.latencyTicks, 1, 1000, true),
    walkForward: {
      trainDays: numeric(form.trainDays, 1, 3650),
      validationDays: numeric(form.validationDays, 1, 3650),
      testDays: numeric(form.testDays, 1, 3650),
      embargoDays: numeric(form.embargoDays, 0, 365),
    },
    monteCarloRuns: numeric(form.monteCarloRuns, 1, 10000),
    seed: numeric(form.seed, 0, 2147483647),
    gates: null,
  };
}
