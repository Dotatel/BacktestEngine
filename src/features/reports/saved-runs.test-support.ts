import type {
  SavedRunPage,
  SavedRunSelection,
  SavedRunSummary,
  SavedRunsBridge,
} from "@/lib/saved-runs-contract";
import type { SelectedReport } from "@/lib/reports-contract";

// Synthetic DI evidence only. These identities and empty metrics do not represent an actual engine run.
export const historyRow: SavedRunSummary = {
  runId: "synthetic-history-run",
  completionSha256: "b".repeat(64),
  projectRoot: "project-a",
  strategy: "Synthetic history strategy",
  symbol: "EURUSD",
  timeframe: "M1",
  completedAt: "2026-10-24T10:00:00Z",
  verification: "recordedNotOpened",
};

export const historyPage: SavedRunPage = {
  rows: [historyRow],
  nextCursor: null,
  examinedEntries: 1,
  unassignedEntries: 0,
  issues: [],
  additionalIssueCount: 0,
};

export const historySelection: SavedRunSelection = {
  projectRoot: historyRow.projectRoot,
  completionSha256: historyRow.completionSha256,
  run: {
    runId: historyRow.runId,
    success: true,
    status: "completed",
    strategy: historyRow.strategy,
    symbol: historyRow.symbol,
    timeframe: historyRow.timeframe,
    buildArtifactPath: "synthetic/WorkspaceCompile.dll",
    buildRevision: "synthetic-revision",
    datasetId: "synthetic-data",
    startedAt: historyRow.completedAt,
    completedAt: historyRow.completedAt,
    durationMs: 0,
    runFolder: "synthetic/run",
    reportJsonPath: "synthetic/report.json",
    reportSha256: "a".repeat(64),
    replayReceiptSha256: "c".repeat(64),
    tradesCsvPath: "synthetic/trades.csv",
    openPositionsCsvPath: "synthetic/positions.csv",
    equityCsvPath: null,
    account: null,
    replay: null,
    tradeStatistics: null,
    nativeReportDrawdown: null,
    fullReplayDrawdown: null,
    trades: [],
    openPositions: [],
    equity: [],
    errors: [],
    output: "Synthetic UI fixture only.",
  },
  inputs: {
    settings: {
      strategy: historyRow.strategy,
      symbol: historyRow.symbol,
      timeframe: historyRow.timeframe,
      startingBalance: 1000,
      commissionUsdPerMillion: -1,
      effectiveCommissionUsdPerMillion: 0,
      slippagePips: 0,
      spreadPips: null,
      startUtc: null,
      endUtc: null,
      maxTicks: null,
      maxBars: null,
      barTimeframe: null,
      barPriceMode: null,
      writeEquityCsv: false,
      parameterOverrides: {},
      parameterMode: "noFile",
    },
    commissionTerms: {
      model: "synthetic",
      rateCurrency: "USD",
      sideSemantics: "synthetic",
      profileRate: 0,
      minimumCommission: 0,
      minimumCurrency: "USD",
      roundingMode: "synthetic",
      nativeEndUtc: null,
    },
    dataset: {
      id: "synthetic-data",
      sha256: "d".repeat(64),
      kind: "bars",
      rowCount: 1,
      sizeBytes: 1,
    },
    profile: {
      id: "synthetic-profile",
      sha256: "e".repeat(64),
      schemaVersion: "synthetic",
    },
    approvedArtifactSha256: "f".repeat(64),
    approvedRuntimeSha256: {},
    sourceManifestSha256: "0".repeat(64),
    sourceFileCount: 5,
    authorities: [],
  },
};

export const historyReport: SelectedReport = {
  projectRoot: historyRow.projectRoot,
  runId: historyRow.runId,
  reportSha256: historySelection.run.reportSha256!,
  reportJsonPath: historySelection.run.reportJsonPath,
  buildRevision: historySelection.run.buildRevision,
  datasetId: historySelection.run.datasetId,
  completedAt: historyRow.completedAt,
  strategy: historyRow.strategy,
  symbol: historyRow.symbol,
  timeframe: historyRow.timeframe,
  accountCurrency: null,
  nativeDrawdownMethod: null,
  closedTradeCount: 0,
  metrics: [{ label: "Profit factor", value: null, unit: "ratio" }],
};

/** Inject synthetic metadata independently of native storage, compilation or report authenticity. */
export function syntheticHistoryBridge(
  overrides: Partial<SavedRunsBridge> = {},
): SavedRunsBridge {
  return {
    native: true,
    list: async () => historyPage,
    restoreSelected: async () => null,
    select: async () => historySelection,
    ...overrides,
  };
}
