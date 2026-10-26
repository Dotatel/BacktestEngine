import type {
  ExecutionDataset,
  ExecutionRunRequest,
  ExecutionRunResult,
} from "@/lib/execution-contract";
import type { MarketPreview } from "@/lib/market-preview-contract";

/** One real fill annotation bound to a completed run and its ledger row. */
export interface TradeMarker {
  tradeId: string;
  action: string;
  timeUtc: string;
  timestamp: number;
  price: number;
  entry: boolean;
}

/** Reject cross-draft, dataset, hash and timeframe overlays before projecting actual fills. */
export function matchingTradeMarkers(
  preview: MarketPreview | null,
  dataset: ExecutionDataset | null,
  result: ExecutionRunResult | null,
  request: ExecutionRunRequest | null,
  previous: boolean,
): TradeMarker[] {
  if (!preview || !dataset || !result?.success || !request || previous)
    return [];
  if (
    preview.datasetId !== result.datasetId ||
    preview.datasetId !== request.datasetId ||
    preview.sha256 !== dataset.sha256
  )
    return [];
  const chartTimeframe =
    preview.timeframe === "source"
      ? preview.sourceTimeframe
      : preview.timeframe;
  if (
    !chartTimeframe ||
    chartTimeframe !== normalizedTimeframe(result.timeframe)
  )
    return [];
  if (!preview.candles.length) return [];
  const start = Date.parse(preview.candles[0].timeUtc);
  const end = Date.parse(preview.selection.endUtcExclusive);
  return result.trades
    .flatMap((trade) => [
      {
        tradeId: trade.id,
        action: `${trade.side} entry`,
        timeUtc: trade.entryTimeUtc,
        timestamp: Date.parse(trade.entryTimeUtc),
        price: trade.entryPrice,
        entry: true,
      },
      {
        tradeId: trade.id,
        action: `${oppositeSide(trade.side)} exit`,
        timeUtc: trade.closeTimeUtc,
        timestamp: Date.parse(trade.closeTimeUtc),
        price: trade.closePrice,
        entry: false,
      },
    ])
    .filter(
      (marker) =>
        marker.timestamp >= start &&
        marker.timestamp < end &&
        Number.isFinite(marker.price),
    )
    .slice(0, 200);
}

/** Match the retained C# TimeFrame.ToString names to supported display buckets. */
function normalizedTimeframe(value: string): string {
  const aliases: Record<string, string> = {
    Minute: "M1",
    Minute5: "M5",
    Minute15: "M15",
    Minute30: "M30",
    Hour: "H1",
    Hour4: "H4",
    Daily: "D1",
  };
  return aliases[value] ?? value;
}

/** A position exit executes the opposite side of its original entry. */
function oppositeSide(side: string): string {
  if (side.toLowerCase() === "buy") return "Sell";
  if (side.toLowerCase() === "sell") return "Buy";
  return "Close";
}
