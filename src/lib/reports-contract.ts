/** Source-provided statistic; null means unavailable in the original engine JSON. */
export interface ReportMetric {
  label: string;
  value: number | null;
  unit: "money" | "%" | "count" | "ratio";
}

/** Host-verified identity and direct source statistics for a successful saved run. */
export interface SelectedReport {
  projectRoot: string;
  runId: string;
  reportSha256: string;
  reportJsonPath: string;
  buildRevision: string;
  datasetId: string;
  completedAt: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  accountCurrency: string | null;
  nativeDrawdownMethod: string | null;
  metrics: ReportMetric[];
  closedTradeCount: number;
}

/** Supported representations of the actual saved engine output. */
export type ReportFormat = "html" | "json" | "tradesCsv";

/** Atomic export receipt; native cancellation returns null instead. */
export interface ReportExportReceipt {
  path: string;
  runId: string;
  reportSha256: string;
}

/** Native boundary: expectations identify the reviewed run, never arbitrary read/write paths. */
export interface ReportsBridge {
  native: boolean;
  selected(projectRoot: string): Promise<SelectedReport | null>;
  exportSaved(
    projectRoot: string,
    runId: string,
    reportSha256: string,
    format: ReportFormat,
  ): Promise<ReportExportReceipt | null>;
}
