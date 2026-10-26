/** Supported fixed UTC preview buckets; source preserves imported OHLC rows unchanged. */
export type PreviewTimeframe =
  "source" | "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";

/** Bounded display request against an app-owned, hash-verified imported dataset. */
export interface MarketPreviewRequest {
  datasetId: string;
  timeframe: PreviewTimeframe;
  tickPrice: "bid" | "mid";
  sourceTimeframe?: Exclude<PreviewTimeframe, "source">;
  startUtc?: string;
  endUtc?: string;
  maximumCandles: number;
}

/** One genuine source or aggregated UTC candle. Missing volume is never replaced with zero. */
export interface MarketCandle {
  timeUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/** Verified source extent and bounded selected observations; no trading result is implied. */
export interface MarketPreview {
  datasetId: string;
  sha256: string;
  kind: "bars" | "ticks";
  sourceRowCount: number;
  selectedRowCount: number;
  coverage: { firstTimeUtc: string; lastTimeUtc: string };
  selection: { startUtc: string; endUtcExclusive: string };
  timeframe: PreviewTimeframe;
  sourceTimeframe: Exclude<PreviewTimeframe, "source"> | null;
  priceBasis: "sourceOhlc" | "bid" | "mid";
  volumeBasis: "volume" | "tickVolume" | null;
  totalCandles: number;
  truncated: boolean;
  candles: MarketCandle[];
}

/** Price inspection is independent of strategy compilation and symbol-economic authentication. */
export interface MarketPreviewBridge {
  native: boolean;
  preview(request: MarketPreviewRequest): Promise<MarketPreview>;
}

/** Selectable preview buckets shared by controls and the validated host contract. */
export const previewTimeframes: PreviewTimeframe[] = [
  "source",
  "M1",
  "M5",
  "M15",
  "M30",
  "H1",
  "H4",
  "D1",
];
