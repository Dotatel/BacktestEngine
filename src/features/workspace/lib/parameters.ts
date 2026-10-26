import type {
  CompiledStrategy,
  StrategyParameter,
} from "@/lib/workspace-contract";

/** The input control appropriate for a reflected parameter's value type. */
export type ParameterKind = "options" | "boolean" | "number" | "text";

/** A parsed parameter value or a field-level validation message. */
export interface ParsedParameter {
  value?: unknown;
  error?: string;
}

/** A parameter group in the reflected schema's original order. */
export interface ParameterGroup {
  name: string;
  parameters: StrategyParameter[];
}

const numericTypes = new Set([
  "integer",
  "number",
  "byte",
  "decimal",
  "double",
  "float",
  "int",
  "int16",
  "int32",
  "int64",
  "long",
  "sbyte",
  "short",
  "single",
  "uint",
  "uint16",
  "uint32",
  "uint64",
  "ushort",
]);

/** Decide which control and parsing rules apply to a reflected parameter. */
export function parameterKind(parameter: StrategyParameter): ParameterKind {
  if (parameter.options && parameter.options.length > 0) return "options";
  if (parameter.valueType.toLocaleLowerCase().includes("bool"))
    return "boolean";
  if (numericTypes.has(parameter.valueType.toLocaleLowerCase()))
    return "number";
  if (
    parameter.min !== null ||
    parameter.max !== null ||
    parameter.step !== null
  )
    return "number";
  return "text";
}

/** Produce the engine default, falling back to a type-appropriate empty value. */
export function defaultValue(parameter: StrategyParameter): unknown {
  if (parameter.default !== null && parameter.default !== undefined)
    return parameter.default;
  const kind = parameterKind(parameter);
  if (kind === "boolean") return false;
  if (kind === "number") return parameter.min ?? 0;
  if (kind === "options") return parameter.options?.[0] ?? "";
  return "";
}

/** Build a complete default value map for one reflected strategy. */
export function defaultsFor(
  strategy: CompiledStrategy,
): Record<string, unknown> {
  return Object.fromEntries(
    strategy.parameters.map((parameter) => [
      parameter.name,
      defaultValue(parameter),
    ]),
  );
}

/** Group parameters for display without reordering the compiler's reflection output. */
export function groupParameters(strategy: CompiledStrategy): ParameterGroup[] {
  const groups = new Map<string, StrategyParameter[]>();
  for (const parameter of strategy.parameters) {
    const name = parameter.group.trim() || "Parameters";
    groups.set(name, [...(groups.get(name) ?? []), parameter]);
  }
  return Array.from(groups, ([name, parameters]) => ({ name, parameters }));
}

/** Validate a typed parameter value against the reflected schema. */
export function validateParameterValue(
  parameter: StrategyParameter,
  value: unknown,
): string | null {
  const kind = parameterKind(parameter);
  if (kind === "options")
    return parameter.options?.includes(String(value))
      ? null
      : "Choose one of the reflected options.";
  if (kind === "boolean")
    return typeof value === "boolean" ? null : "Choose true or false.";
  if (kind === "number") {
    const numeric = asNumber(value);
    if (numeric === null) return "Enter a number.";
    return validateNumber(parameter, numeric);
  }
  return typeof value === "string" ? null : "Enter text.";
}

/** Validate and convert editor text into the value stored for a parameter or preset. */
export function parseParameterText(
  parameter: StrategyParameter,
  text: string,
): ParsedParameter {
  const kind = parameterKind(parameter);
  if (kind === "options")
    return parameter.options?.includes(text)
      ? { value: text }
      : { error: "Choose one of the reflected options." };
  if (kind === "boolean")
    return text === "true" || text === "false"
      ? { value: text === "true" }
      : { error: "Choose true or false." };
  if (kind === "number") {
    const numeric = asNumber(text);
    if (numeric === null) return { error: "Enter a number." };
    const error = validateNumber(parameter, numeric);
    return error ? { error } : { value: numeric };
  }
  return { value: text };
}

/** Convert a stored value into the text shown in a parameter input. */
export function parameterText(
  parameter: StrategyParameter,
  value: unknown,
): string {
  if (parameterKind(parameter) === "boolean")
    return value === true ? "true" : "false";
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Build a short, honest hint for numeric bounds and step. */
export function parameterHint(parameter: StrategyParameter): string {
  const kind = parameterKind(parameter);
  if (kind === "options") return `${parameter.options?.length ?? 0} options`;
  if (kind === "boolean") return "true or false";
  if (kind !== "number") return parameter.valueType || "text";
  const parts: string[] = [];
  if (parameter.min !== null) parts.push(`min ${parameter.min}`);
  if (parameter.max !== null) parts.push(`max ${parameter.max}`);
  if (parameter.step !== null) parts.push(`step ${parameter.step}`);
  return parts.join(" · ") || parameter.valueType;
}

/** Apply a stored preset to a strategy, keeping valid values and reporting skipped names. */
export function coercePresetValues(
  strategy: CompiledStrategy,
  values: Record<string, unknown>,
): { values: Record<string, unknown>; skipped: string[] } {
  const result = defaultsFor(strategy);
  const skipped: string[] = [];
  for (const parameter of strategy.parameters) {
    if (!(parameter.name in values)) continue;
    const candidate = values[parameter.name];
    if (validateParameterValue(parameter, candidate) === null)
      result[parameter.name] = candidate;
    else skipped.push(parameter.displayName || parameter.name);
  }
  return { values: result, skipped };
}

/** Parse a numeric value from either a number or a numeric string. */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Check inclusive bounds and optional step alignment without one-sided assumptions. */
function validateNumber(
  parameter: StrategyParameter,
  value: number,
): string | null {
  if (parameter.valueType === "integer" && !Number.isInteger(value))
    return "Enter a whole number.";
  if (parameter.min !== null && value < parameter.min)
    return `Use a value of at least ${parameter.min}.`;
  if (parameter.max !== null && value > parameter.max)
    return `Use a value no greater than ${parameter.max}.`;
  if (parameter.step === null || parameter.step <= 0) return null;
  const anchor = parameter.min ?? 0;
  const steps = (value - anchor) / parameter.step;
  return Math.abs(steps - Math.round(steps)) < 1e-7
    ? null
    : `Use increments of ${parameter.step}.`;
}
