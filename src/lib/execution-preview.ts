import type {
  ExecutionBridge,
  ExecutionRunRequest,
  ExecutionRunResult,
} from "./execution-contract";

/** Browser previews cannot import or replay historical data; report that limitation honestly. */
export const previewExecution: ExecutionBridge = {
  native: false,
  /** Native file import is unavailable in browser preview. */
  async importHistoricalCsv() {
    throw new Error(
      "Importing historical data requires the desktop app. Use the browser preview for UI checks only.",
    );
  },
  /** No durable datasets exist in browser preview. */
  async listDatasets() {
    return [];
  },
  /** Native symbol-spec import is unavailable in browser preview. */
  async importSymbolSpec() {
    throw new Error(
      "Importing symbol specifications requires the desktop app. Use the browser preview for UI checks only.",
    );
  },
  /** No durable symbol specifications exist in browser preview. */
  async listSymbolSpecs() {
    return [];
  },
  /** Report replay unavailability instead of fabricating engine output. */
  async run(_request: ExecutionRunRequest): Promise<ExecutionRunResult> {
    return {
      runId: "browser-preview",
      success: false,
      status: "failed",
      strategy: _request.strategy ?? "",
      symbol: "",
      timeframe: "",
      buildArtifactPath: _request.buildArtifactPath ?? "",
      buildRevision: "",
      datasetId: _request.datasetId,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 0,
      runFolder: "",
      reportJsonPath: "",
      reportSha256: null,
      replayReceiptSha256: null,
      tradesCsvPath: "",
      openPositionsCsvPath: "",
      equityCsvPath: null,
      account: null,
      replay: null,
      tradeStatistics: null,
      nativeReportDrawdown: null,
      fullReplayDrawdown: null,
      trades: [],
      openPositions: [],
      equity: [],
      errors: [
        "This browser preview does not execute the C# backtest engine. Run the desktop app with a built strategy and imported historical data.",
      ],
      output: "No compiler or engine was run in the browser preview.",
    };
  },
  /** No native replay process exists to cancel in preview mode. */
  async cancel() {},
  /** No retained successful run exists in browser preview. */
  async lastGoodResult() {
    return null;
  },
};
