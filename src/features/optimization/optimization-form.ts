import type {
  CompiledStrategy,
  StrategyParameter,
} from "@/lib/workspace-contract";
import type {
  OptimizationDimension,
  OptimizationRunRequest,
  OptimizationScalar,
} from "@/lib/optimization-contract";
import { validateParameterValue } from "@/features/workspace/lib/parameters";

/** Editable strings preserve incomplete numeric drafts without silently substituting zero. */
export interface OptimizationForm {
  datasetId: string;
  symbolSpecId: string;
  timeframe: string;
  barTimeframe: string;
  barPriceMode: string;
  startingBalance: string;
  commission: string;
  spread: string;
  slippage: string;
  startUtc: string;
  endUtc: string;
  maxRows: string;
  method: "grid" | "random";
  seed: string;
  maxRuns: string;
  maxWorkers: string;
}

/** Search dimensions are explicit JSON scalar arrays, preserving commas and value types. */
export interface DimensionDraft {
  name: string;
  text: string;
}

export const defaultOptimizationForm: OptimizationForm = {
  datasetId: "",
  symbolSpecId: "",
  timeframe: "M1",
  barTimeframe: "M1",
  barPriceMode: "ohlc",
  startingBalance: "10000",
  commission: "-1",
  spread: "",
  slippage: "0",
  startUtc: "",
  endUtc: "",
  maxRows: "0",
  method: "grid",
  seed: "42",
  maxRuns: "20",
  maxWorkers: "1",
};

/** Freeze a complete typed request from the actual reflected strategy and imported record identities. */
export function optimizationRequest(
  form: OptimizationForm,
  dimensions: DimensionDraft[],
  strategy: CompiledStrategy,
  values: Record<string, unknown>,
  kind: "ticks" | "bars",
): OptimizationRunRequest {
  if (!form.datasetId || !form.symbolSpecId)
    throw new Error("Select imported history and a symbol profile.");
  if (!form.timeframe.trim()) throw new Error("Enter the chart timeframe.");
  const baseParameters = Object.fromEntries(
    strategy.parameters.map((parameter) => [
      parameter.name,
      scalarValue(parameter, values[parameter.name]),
    ]),
  );
  if (Number(form.slippage) !== 0 || !form.slippage.trim())
    throw new Error(
      "The retained optimizer does not support nonzero slippage. Use zero or run a backtest with slippage.",
    );
  if (!dimensions.length || dimensions.length > 8)
    throw new Error("Add between one and eight search parameters.");
  if (
    new Set(dimensions.map((dimension) => dimension.name)).size !==
    dimensions.length
  )
    throw new Error("Choose each search parameter only once.");
  const search = dimensions.map((dimension) =>
    parseDimension(dimension, strategy),
  );
  const startingBalance = numeric(
    form.startingBalance,
    "Starting balance",
    Number.MIN_VALUE,
    1e12,
  );
  const commissionUsdPerMillion = numeric(
    form.commission,
    "Commission",
    -1,
    1e9,
  );
  const spreadPips = form.spread.trim()
    ? numeric(form.spread, "Spread", 0, 1e6)
    : undefined;
  if (
    kind === "bars" &&
    (spreadPips === undefined || !form.barTimeframe.trim())
  )
    throw new Error(
      "Bar replay requires an explicit spread and source bar timeframe.",
    );
  const startUtc = optionalDate(form.startUtc),
    endUtc = optionalDate(form.endUtc);
  if (startUtc && endUtc && startUtc >= endUtc)
    throw new Error("End UTC must be after start UTC.");
  const maxRows = integer(form.maxRows, "Row limit", 0, 2147483647);
  return {
    strategy: strategy.strategy,
    datasetId: form.datasetId,
    symbolSpecId: form.symbolSpecId,
    timeframe: form.timeframe.trim(),
    barTimeframe: kind === "bars" ? form.barTimeframe.trim() : undefined,
    barPriceMode: kind === "bars" ? form.barPriceMode : undefined,
    startingBalance,
    commissionUsdPerMillion,
    slippagePips: 0,
    spreadPips,
    startUtc,
    endUtc,
    maxTicks: kind === "ticks" ? maxRows : undefined,
    maxBars: kind === "bars" ? maxRows : undefined,
    baseParameters,
    dimensions: search,
    method: form.method,
    seed: integer(form.seed, "Seed", 0, 2147483647),
    maxRuns: integer(form.maxRuns, "Run budget", 1, 100),
    maxWorkers: integer(form.maxWorkers, "Workers", 1, 2),
  };
}

/** Reject objects, null search values and values outside the reflected compiler schema. */
export function parseDimension(
  draft: DimensionDraft,
  strategy: CompiledStrategy,
): OptimizationDimension {
  const parameter = strategy.parameters.find(
    (item) => item.name === draft.name,
  );
  if (!parameter) throw new Error("Select a reflected search parameter.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft.text);
  } catch {
    throw new Error(`${parameter.name}: enter a JSON array, such as [10,20].`);
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 32)
    throw new Error(`${parameter.name}: provide one to 32 values.`);
  const values = parsed.map((value) => {
    if (value === null)
      throw new Error(`${parameter.name}: search values cannot be null.`);
    return scalarValue(parameter, value) as Exclude<OptimizationScalar, null>;
  });
  if (
    new Set(values.map((value) => JSON.stringify(value))).size !== values.length
  )
    throw new Error(`${parameter.name}: remove duplicate values.`);
  return { name: parameter.name, values };
}

/** Keep typed scalars strict even where the shared parameter editor accepts numeric input text. */
function scalarValue(
  parameter: StrategyParameter,
  value: unknown,
): OptimizationScalar {
  const numericType =
    parameter.valueType === "integer" || parameter.valueType === "number";
  if (numericType && typeof value !== "number")
    throw new Error(`${parameter.name}: use a typed number.`);
  if (
    typeof value !== "number" &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    value !== null
  )
    throw new Error(`${parameter.name}: use a scalar value.`);
  const error = validateParameterValue(parameter, value);
  if (error) throw new Error(`${parameter.name}: ${error}`);
  return value as OptimizationScalar;
}

/** Enforce finite numeric bounds before native IPC; native validation remains authoritative. */
function numeric(
  text: string,
  label: string,
  min: number,
  max: number,
): number {
  const value = text.trim() ? Number(text) : Number.NaN;
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label}: enter a number from ${min} to ${max}.`);
  return value;
}

/** Retain exact integral budgets and seeds rather than truncating user drafts. */
function integer(
  text: string,
  label: string,
  min: number,
  max: number,
): number {
  const value = numeric(text, label, min, max);
  if (!Number.isSafeInteger(value))
    throw new Error(`${label}: enter a whole number.`);
  return value;
}

/** Require an explicit UTC offset and normalize dates before comparing the interval. */
function optionalDate(text: string): string | undefined {
  if (!text.trim()) return undefined;
  if (
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(text) ||
    !Number.isFinite(Date.parse(text))
  )
    throw new Error("Enter UTC timestamps such as 2026-01-01T00:00:00Z.");
  return new Date(text).toISOString();
}
