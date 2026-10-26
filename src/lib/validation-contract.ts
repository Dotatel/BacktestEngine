/** Bounded retained-engine thresholds; omitted values use the documented validation defaults. */
export interface ValidationGates {
  minTrades?: number;
  minProfitFactor?: number;
  maxDrawdownPct?: number;
  maxDailyDrawdownPct?: number;
  minSurvivability?: number;
}

/** Report-only validation request identifies host-selected source, never arbitrary renderer paths. */
export interface ValidationRunRequest {
  runId: string;
  monteCarloRuns?: number;
  seed?: number;
  gates?: ValidationGates;
}

/** Completed process evidence; success does not mean trading validation passed. */
export interface ValidationRunResult {
  validationRunId: string;
  executionRunId: string;
  sourceReportSha256: string;
  mode: "savedReport";
  success: boolean;
  status: "completed" | "failed" | "cancelled" | "timeout";
  verdict: "PASS" | "FAIL" | "UNPROVEN";
  projectRoot: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  validationDir: string;
  configPath: string;
  finalVerdictPath: string;
  finalReportPath: string;
  missingEvidence: string[];
  errors: string[];
  output: string;
  lastGoodPreserved: boolean;
}

/** Native report-only operations preserve the original Python algorithms and missing-evidence verdict. */
export interface ValidationBridge {
  native: boolean;
  run(request: ValidationRunRequest): Promise<ValidationRunResult>;
  cancel(): Promise<void>;
  lastGoodResult(): Promise<ValidationRunResult | null>;
}
