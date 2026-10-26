import type { MarketPreview } from "../../src/lib/market-preview-contract";
import { dataset } from "./backtest";

/** Synthetic UI-only OHLC fixture. Native aggregation correctness is established separately. */
export const priceFixture: MarketPreview = {
  datasetId: dataset.id,
  sha256: dataset.sha256,
  kind: "ticks",
  sourceRowCount: 6,
  selectedRowCount: 6,
  coverage: {
    firstTimeUtc: "2026-01-01T00:00:00.000Z",
    lastTimeUtc: "2026-01-04T00:01:00.000Z",
  },
  selection: {
    startUtc: "2026-01-01T00:00:00.000Z",
    endUtcExclusive: "2026-01-04T00:01:00.001Z",
  },
  timeframe: "M1",
  sourceTimeframe: null,
  priceBasis: "bid",
  volumeBasis: null,
  totalCandles: 3,
  truncated: false,
  candles: [
    {
      timeUtc: "2026-01-01T00:00:00.000Z",
      open: 1.1,
      high: 1.12,
      low: 1.09,
      close: 1.11,
      volume: null,
    },
    {
      timeUtc: "2026-01-02T00:00:00.000Z",
      open: 1.11,
      high: 1.13,
      low: 1.1,
      close: 1.12,
      volume: null,
    },
    {
      timeUtc: "2026-01-04T00:01:00.000Z",
      open: 1.12,
      high: 1.12,
      low: 1.1,
      close: 1.1,
      volume: null,
    },
  ],
};
