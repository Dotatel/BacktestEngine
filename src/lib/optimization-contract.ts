/** Finite typed scalar accepted by a reflected strategy parameter; null is base-preset-only. */
export type OptimizationScalar = string | number | boolean | null;

/** Exact value arrays passed to the original C# grid/random generator. */
export interface OptimizationDimension {
  name: string;
  values: Exclude<OptimizationScalar, null>[];
}

/** Host-bounded draft identifies catalog records, never arbitrary command or filesystem paths. */
export interface OptimizationRunRequest {
  strategy: string;
  datasetId: string;
  symbolSpecId: string;
  timeframe: string;
  barTimeframe?: string;
  barPriceMode?: string;
  startingBalance: number;
  commissionUsdPerMillion: number;
  slippagePips: number;
  spreadPips?: number;
  startUtc?: string;
  endUtc?: string;
  maxTicks?: number;
  maxBars?: number;
  baseParameters: Record<string, OptimizationScalar>;
  dimensions: OptimizationDimension[];
  method: "grid" | "random";
  seed: number;
  maxRuns: number;
  maxWorkers: number;
}

/** Actual reported metrics remain separate from the retained optimizer's scoring conventions. */
export interface OptimizationMetrics {
  currency: string | null;
  netProfit: number | null;
  markedToMarketNetProfit: number | null;
  profitFactor: number | null;
  optimizerProfitFactor: number | null;
  closedTrades: number | null;
  nativeDrawdownPercent: number | null;
  nativeDrawdownMethod: string | null;
  fullReplayDrawdownPercent: number | null;
  fitnessScore: number;
}

/** Original candidate state and verified source evidence; failed/unproven candidates have no metrics. */
export interface OptimizationCandidate {
  id: string;
  hash: string;
  status: "completed" | "failed" | "unproven";
  error: string | null;
  parameters: Record<string, string>;
  metrics: OptimizationMetrics | null;
  reportJsonPath: string | null;
  reportSha256: string | null;
  parameterFilePath: string | null;
  elapsedMs: number | null;
}

/** One genuine native optimization attempt; candidate failures and process lifecycle are explicit. */
export interface OptimizationRunResult {
  runId: string;
  projectRoot: string;
  buildRevision: string;
  approvedArtifactSha256: string;
  datasetId: string;
  datasetSha256: string;
  symbolSpecId: string;
  symbolSpecSha256: string;
  configSha256: string;
  strategy: string;
  method: "grid" | "random";
  seed: number;
  budget: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  runFolder: string;
  configPath: string;
  status: "completed" | "failed" | "cancelled" | "timeout";
  success: boolean;
  exitCode: number | null;
  candidates: OptimizationCandidate[];
  errors: string[];
  output: string;
  lastGoodPreserved: boolean;
}

/** Real optimizer operations; browser previews never generate or score candidate results. */
export interface OptimizationBridge {
  native: boolean;
  run(request: OptimizationRunRequest): Promise<OptimizationRunResult>;
  cancel(): Promise<void>;
  lastGoodResult(): Promise<OptimizationRunResult | null>;
}
