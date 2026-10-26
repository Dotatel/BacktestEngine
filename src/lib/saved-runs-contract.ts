import type { ExecutionRunResult } from "./execution-contract";

/** Native-recorded identity only; opening a row separately verifies frozen source and report bytes. */
export interface SavedRunSummary {
  runId: string;
  completionSha256: string;
  projectRoot: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  completedAt: string;
  verification: "recordedNotOpened";
}

/** Bounded native enumeration page in filesystem order, without financial previews or newest-first claims. */
export interface SavedRunPage {
  rows: SavedRunSummary[];
  nextCursor: string | null;
  examinedEntries: number;
  unassignedEntries: number;
  issues: { runId: string | null; message: string }[];
  additionalIssueCount: number;
}

/** Exact replay controls recovered from the verified receipt, independent of current editor drafts. */
export interface SavedReplaySettings {
  strategy: string;
  symbol: string;
  timeframe: string;
  startingBalance: number;
  commissionUsdPerMillion: number;
  effectiveCommissionUsdPerMillion: number;
  slippagePips: number;
  spreadPips: number | null;
  startUtc: string | null;
  endUtc: string | null;
  maxTicks: number | null;
  maxBars: number | null;
  barTimeframe: string | null;
  barPriceMode: string | null;
  writeEquityCsv: boolean;
  parameterOverrides: Record<string, string>;
  parameterMode: "noFile";
}

/** Historical economics and source identity; native verification keeps private authority paths out of IPC. */
export interface SavedRunInputs {
  settings: SavedReplaySettings;
  commissionTerms: {
    model: string;
    rateCurrency: string;
    sideSemantics: string;
    profileRate: number;
    minimumCommission: number;
    minimumCurrency: string;
    roundingMode: string;
    nativeEndUtc: string | null;
  };
  dataset: {
    id: string;
    sha256: string;
    kind: string;
    rowCount: number;
    sizeBytes: number;
  };
  profile: { id: string; sha256: string; schemaVersion: string };
  approvedArtifactSha256: string;
  approvedRuntimeSha256: Record<string, string>;
  sourceManifestSha256: string;
  sourceFileCount: number;
  authorities: { sha256: string; sizeBytes: number }[];
}

/** Strictly reparsed native selection and frozen controls for the same host-selected project. */
export interface SavedRunSelection {
  projectRoot: string;
  completionSha256: string;
  run: ExecutionRunResult;
  inputs: SavedRunInputs;
}

/** Native history operations accept project expectations and issued IDs, never renderer-provided file paths. */
export interface SavedRunsBridge {
  native: boolean;
  list(
    projectRoot: string,
    cursor: string | null,
    limit: number,
  ): Promise<SavedRunPage>;
  select(
    projectRoot: string,
    runId: string,
    completionSha256: string,
  ): Promise<SavedRunSelection>;
  restoreSelected(projectRoot: string): Promise<SavedRunSelection | null>;
}
