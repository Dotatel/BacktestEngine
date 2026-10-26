import type { ValidationRunRequest } from "@/lib/validation-contract";

/** Editable bounded settings use text until all fields have passed numeric validation. */
export interface ValidationForm {
  monteCarloRuns: string;
  seed: string;
  minTrades: string;
  minProfitFactor: string;
  maxDrawdownPct: string;
  maxDailyDrawdownPct: string;
  minSurvivability: string;
}

/** Shared form metadata supplies labels, bounds and steps to validation and presentation. */
export const validationFields = [
  {
    name: "monteCarloRuns",
    label: "Monte Carlo runs",
    min: 1,
    max: 100000,
    step: 1,
  },
  { name: "seed", label: "Random seed", min: 0, max: 2147483647, step: 1 },
  {
    name: "minTrades",
    label: "Minimum closed trades",
    min: 0,
    max: 1000000,
    step: 1,
  },
  {
    name: "minProfitFactor",
    label: "Minimum profit factor",
    min: 0,
    max: 100,
    step: 0.01,
  },
  {
    name: "maxDrawdownPct",
    label: "Maximum drawdown (%)",
    min: 0,
    max: 100,
    step: 0.1,
  },
  {
    name: "maxDailyDrawdownPct",
    label: "Maximum daily drawdown (%)",
    min: 0,
    max: 100,
    step: 0.1,
  },
  {
    name: "minSurvivability",
    label: "Minimum survivability (0–1)",
    min: 0,
    max: 1,
    step: 0.01,
  },
] as const;

/** Retained ValidationEngine defaults are editable assumptions, never invented backtest results. */
export const defaultValidationForm: ValidationForm = {
  monteCarloRuns: "1000",
  seed: "42",
  minTrades: "30",
  minProfitFactor: "1.15",
  maxDrawdownPct: "10",
  maxDailyDrawdownPct: "3",
  minSurvivability: "0.8",
};

/** Return individual invalid field names so the form can expose accessible inline correction. */
export function invalidValidationFields(
  form: ValidationForm,
): (keyof ValidationForm)[] {
  return validationFields
    .filter((field) => {
      const text = form[field.name].trim();
      const value = Number(text);
      if (
        !text ||
        !Number.isFinite(value) ||
        value < field.min ||
        value > field.max
      )
        return true;
      return field.step === 1 && !Number.isInteger(value);
    })
    .map((field) => field.name);
}

/** Convert only a fully checked form to the narrow host request; native bounds remain authoritative. */
export function validationRequest(
  runId: string,
  form: ValidationForm,
): ValidationRunRequest {
  if (invalidValidationFields(form).length)
    throw new Error("Correct the marked validation settings before starting.");
  return {
    runId,
    monteCarloRuns: Number(form.monteCarloRuns),
    seed: Number(form.seed),
    gates: {
      minTrades: Number(form.minTrades),
      minProfitFactor: Number(form.minProfitFactor),
      maxDrawdownPct: Number(form.maxDrawdownPct),
      maxDailyDrawdownPct: Number(form.maxDailyDrawdownPct),
      minSurvivability: Number(form.minSurvivability),
    },
  };
}
