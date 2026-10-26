/** Imported local historical market data stored in app-owned storage with content provenance. */
export interface ExecutionDataset {
  /** Stable app-owned dataset identifier. */
  id: string;
  /** Original user-selected source path recorded for provenance; never used as a live input after import. */
  originalPath: string;
  /** App-owned canonical copy path used by runs. */
  storedPath: string;
  /** Content hash of the imported file. */
  sha256: string;
  /** Imported file size in bytes. */
  sizeBytes: number;
  /** Imported market data kind. */
  kind: "ticks" | "bars";
  /** Number of data rows imported, excluding the header. */
  rowCount: number;
  /** ISO-8601 UTC timestamp of import. */
  importedAt: string;
}

/** Imported and validated symbol specification in app-owned storage. */
export interface ExecutionSymbolSpec {
  id: string;
  originalPath: string;
  storedPath: string;
  sha256: string;
  sizeBytes: number;
  schemaVersion: string;
  importedAt: string;
}

/** Validated run request; every economic and data input is explicit and host-approved. */
export interface ExecutionRunRequest {
  /** Approved build artifact path returned by the native build for the selected project (host-overridden). */
  buildArtifactPath?: string;
  /** Compiled strategy name selected from the approved build. */
  strategy: string;
  /** Imported dataset identifier or app-owned path used as historical input. */
  datasetId: string;
  /** Validated symbol economics profile path. */
  symbolSpecPath: string;
  /** Intended symbol (defaults to the profile's symbol). */
  symbol?: string;
  /** Optional cBot parameter file path in app-owned storage. */
  parameterPath?: string;
  /** Parameter overrides applied after the parameter file. */
  parameterOverrides?: Record<string, string>;
  /** Starting account balance. */
  startingBalance: number;
  /** Commission in USD per million units, or negative to use the symbol profile default. */
  commissionUsdPerMillion: number;
  /** Adverse slippage in pips per fill. */
  slippagePips: number;
  /** Fixed spread in pips, or negative to use imported/quoted spread. */
  spreadPips?: number;
  /** Chart timeframe override. */
  timeframe?: string;
  /** Source timeframe for bar replay. */
  barTimeframe?: string;
  /** Bar replay price mode (ohlc, open, native-m1). */
  barPriceMode?: string;
  /** Inclusive replay start (ISO-8601 UTC). */
  startUtc?: string;
  /** Exclusive replay end (ISO-8601 UTC). */
  endUtc?: string;
  /** Maximum ticks to replay (0 means all). */
  maxTicks?: number;
  /** Maximum bars to replay (0 means all). */
  maxBars?: number;
  /** Whether to write the equity CSV artifact. */
  writeEquityCsv?: boolean;
}

/** One closed trade from the runner report. */
export interface ExecutionTrade {
  id: string;
  symbol: string;
  label: string;
  side: string;
  volumeInUnits: number;
  entryTimeUtc: string;
  entryPrice: number;
  entryBid: number;
  entryAsk: number;
  entrySpread: number;
  closeTimeUtc: string;
  closePrice: number;
  closeBid: number;
  closeAsk: number;
  closeSpread: number;
  closeReason: string;
  pips: number;
  grossProfit: number;
  pnlConversionFees: number;
  commissions: number;
  swaps: number;
  netProfit: number;
  intendedRiskMoney: number;
  maeNetProfit: number;
  mfeNetProfit: number;
  netR: number | null;
  economicSpecificationHash: string;
}

/** One open position at valuation time. */
export interface ExecutionOpenPosition {
  id: string;
  symbol: string;
  label: string;
  side: string;
  volumeInUnits: number;
  entryTimeUtc: string;
  entryPrice: number;
  valuationTimeUtc: string;
  valuationPrice: number;
  ageHours: number;
  pips: number;
  grossProfit: number;
  pnlConversionFees: number;
  commissions: number;
  swaps: number;
  netProfit: number;
  intendedRiskMoney: number;
  maeNetProfit: number;
  mfeNetProfit: number;
  netR: number | null;
  economicSpecificationHash: string;
}

/** One equity sample. */
export interface ExecutionEquityPoint {
  timeUtc: string;
  balance: number;
  equity: number;
}

/** Native report drawdown (cTrader price extremes and deals). */
export interface NativeReportDrawdown {
  method: string;
  equityPoints: number;
  maxEquityDrawdown: number;
  maxEquityDrawdownPercent: number;
  maxBalanceDrawdown: number;
  maxBalanceDrawdownPercent: number;
}

/** Full replay drawdown computed over the equity path. */
export interface FullReplayDrawdown {
  equityPoints: number;
  maxBalanceDrawdown: number;
  maxBalanceDrawdownPercent: number;
  maxBalanceDrawdownPeakTimeUtc: string;
  maxBalanceDrawdownTroughTimeUtc: string;
  maxBalanceDrawdownPeak: number;
  maxBalanceDrawdownTrough: number;
  maxEquityDrawdown: number;
  maxEquityDrawdownPercent: number;
  maxEquityDrawdownPeakTimeUtc: string;
  maxEquityDrawdownTroughTimeUtc: string;
  maxEquityDrawdownPeak: number;
  maxEquityDrawdownTrough: number;
}

/** Trade statistics block. */
export interface ExecutionTradeStatistics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  longTrades: number;
  shortTrades: number;
  grossProfit: number;
  grossLoss: number;
  commissions: number;
  swaps: number;
  netProfit: number;
  profitFactor: number | null;
  totalPips: number;
  averageNetProfit: number;
  largestWin: number;
  largestLoss: number;
  winRate: number;
  lossRate: number;
}

/** Account summary. */
export interface ExecutionAccountSummary {
  currency: string;
  currencyDigits: number;
  startingCapital: number;
  balance: number;
  equity: number;
  closedNetProfit: number;
  openNetProfit: number;
  markedToMarketNetProfit: number;
  markedToMarketReturnPercent: number;
}

/** Replay summary. */
export interface ExecutionReplaySummary {
  mode: string;
  barPriceMode: string | null;
  inputCount: number;
  ticksOrSyntheticTicks: number;
  onBarCount: number;
  chartBarCount: number;
  hourBarCount: number;
  elapsedMs: number;
  ticksPerSecond: number;
  firstTimeUtc: string;
  lastTimeUtc: string;
}

/** Result of one completed engine run. */
export interface ExecutionRunResult {
  /** Unique run identifier. */
  runId: string;
  /** Whether the run completed successfully with a valid report. */
  success: boolean;
  /** Run status. */
  status: "completed" | "failed" | "cancelled" | "timeout";
  /** Strategy name run. */
  strategy: string;
  /** Symbol actually run. */
  symbol: string;
  /** Timeframe run. */
  timeframe: string;
  /** Approved build artifact used. */
  buildArtifactPath: string;
  /** Build revision the artifact was approved from. */
  buildRevision: string;
  /** Imported dataset used. */
  datasetId: string;
  /** ISO timestamps. */
  startedAt: string;
  completedAt: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** App-owned run folder. */
  runFolder: string;
  /** Report JSON path. */
  reportJsonPath: string;
  /** SHA-256 of immutable report bytes captured by the host; null in presentation fixtures. */
  reportSha256: string | null;
  /** Host-captured replay input receipt; absent for legacy runs and unsuccessful completion. */
  replayReceiptSha256: string | null;
  /** Trades CSV path. */
  tradesCsvPath: string;
  /** Open positions CSV path. */
  openPositionsCsvPath: string;
  /** Equity CSV path, if written. */
  equityCsvPath: string | null;
  /** Parsed metrics. */
  account: ExecutionAccountSummary | null;
  replay: ExecutionReplaySummary | null;
  tradeStatistics: ExecutionTradeStatistics | null;
  nativeReportDrawdown: NativeReportDrawdown | null;
  fullReplayDrawdown: FullReplayDrawdown | null;
  trades: ExecutionTrade[];
  openPositions: ExecutionOpenPosition[];
  equity: ExecutionEquityPoint[];
  /** Honest errors/diagnostics. */
  errors: string[];
  /** Captured process output (bounded). */
  output: string;
}

/** Progress event emitted by the native host during a run; percentages are honest estimates. */
export interface ExecutionProgress {
  runId: string;
  stage:
    | "starting"
    | "running"
    | "parsing"
    | "completed"
    | "failed"
    | "cancelled"
    | "timeout";
  percent?: number;
  message?: string;
}

/** Scoped native execution operations; previews cannot run the C# engine. */
export interface ExecutionBridge {
  native: boolean;
  /** Validate and import a user-selected historical CSV into app-owned storage with provenance. */
  importHistoricalCsv(
    path: string,
    kind: "ticks" | "bars",
  ): Promise<ExecutionDataset>;
  /** List durable imported datasets. */
  listDatasets(): Promise<ExecutionDataset[]>;
  /** Validate and import a symbol specification JSON into app-owned storage. */
  importSymbolSpec(path: string): Promise<ExecutionSymbolSpec>;
  /** List durable imported symbol specifications. */
  listSymbolSpecs(): Promise<ExecutionSymbolSpec[]>;
  /** Run one approved build artifact against imported historical data. */
  run(request: ExecutionRunRequest): Promise<ExecutionRunResult>;
  /** Cancel the currently running execution, if any. */
  cancel(): Promise<void>;
  /** Return the last successful run result, if any. */
  lastGoodResult(): Promise<ExecutionRunResult | null>;
}
