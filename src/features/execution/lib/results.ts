import type {
  ExecutionEquityPoint,
  ExecutionRunResult,
} from "@/lib/execution-contract";

/** Format a reported value, retaining undefined and non-finite metrics as unavailable. */
export function formatMetric(
  value: number | null | undefined,
  suffix = "",
): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "n/a";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}${suffix}`;
}

/** Render an exact timestamp in UTC without locale-dependent time-zone conversion. */
export function formatUtc(value: string): string {
  if (!value) return "n/a";
  return value
    .replace("T", " ")
    .replace(/\.0+Z$/, "")
    .replace(/Z$/, "");
}

/** Compute drawdown only from genuine marked-equity samples; no invented observations. */
export function sampledDrawdown(points: ExecutionEquityPoint[]) {
  let peak = Number.NEGATIVE_INFINITY;
  return points.map((point) => {
    peak = Math.max(peak, point.equity);
    return {
      ...point,
      drawdownPercent: peak > 0 ? ((peak - point.equity) / peak) * 100 : null,
    };
  });
}

/** Bound drawing work while retaining each bucket's equity extremes and both endpoints. */
export function chartSamples<T extends ExecutionEquityPoint>(
  points: T[],
  maximum = 600,
): T[] {
  if (points.length <= maximum) return points;
  const bucketSize = Math.ceil(points.length / Math.floor((maximum - 2) / 2));
  const selected = new Set([0, points.length - 1]);
  for (let start = 0; start < points.length; start += bucketSize) {
    const bucket = points.slice(start, start + bucketSize);
    const low = bucket.reduce(
      (best, point, index) =>
        point.equity < bucket[best].equity ? index : best,
      0,
    );
    const high = bucket.reduce(
      (best, point, index) =>
        point.equity > bucket[best].equity ? index : best,
      0,
    );
    selected.add(start + low);
    selected.add(start + high);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => points[index]);
}

/** Serialize the selected run's complete ledger, independent of visible sorting and pagination. */
export function tradesCsv(result: ExecutionRunResult): string {
  const header = [
    "runId",
    "datasetId",
    "strategy",
    "tradeId",
    "symbol",
    "side",
    "entryTimeUtc",
    "closeTimeUtc",
    "entryPrice",
    "closePrice",
    "volumeInUnits",
    "netProfit",
  ];
  const rows = result.trades.map((trade) => [
    result.runId,
    result.datasetId,
    result.strategy,
    trade.id,
    trade.symbol,
    trade.side,
    trade.entryTimeUtc,
    trade.closeTimeUtc,
    trade.entryPrice,
    trade.closePrice,
    trade.volumeInUnits,
    trade.netProfit,
  ]);
  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

/** Escape spreadsheet formulas and CSV delimiters in user-defined strategy and symbol names. */
function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Download existing run evidence through a browser Blob; this never reruns the strategy. */
export function exportTrades(result: ExecutionRunResult): void {
  const url = URL.createObjectURL(
    new Blob([tradesCsv(result)], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `backtest-${result.runId.replace(/[^a-zA-Z0-9_-]/g, "_")}-trades.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
