import { useCallback, useEffect, useState } from "react";
import type { ExecutionDataset } from "@/lib/execution-contract";
import { errorMessage } from "@/lib/preferences";
import {
  previewTimeframes,
  type MarketPreview,
  type MarketPreviewBridge,
  type MarketPreviewRequest,
  type PreviewTimeframe,
} from "@/lib/market-preview-contract";
import type { BacktestEconomics } from "./useBacktest";

/** Visible preview state; source coverage is retained only for the same verified dataset receipt. */
export interface MarketPreviewController {
  data: MarketPreview | null;
  coverage: MarketPreview["coverage"] | null;
  loading: boolean;
  error: string;
  tickPrice: "bid" | "mid";
  setTickPrice(value: "bid" | "mid"): void;
  refresh(): void;
}

/** Debounce draft edits and suppress outdated responses without pretending a preview is a run. */
export function useMarketPreview(
  bridge: MarketPreviewBridge,
  dataset: ExecutionDataset | null,
  economics: BacktestEconomics,
  projectRoot: string | null,
): MarketPreviewController {
  const [data, setData] = useState<MarketPreview | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [receipt, setReceipt] = useState<{
    key: string;
    coverage: MarketPreview["coverage"];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tickPrice, setTickPrice] = useState<"bid" | "mid">("bid");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const key = `${projectRoot ?? ""}:${dataset?.id}:${dataset?.sha256}`;
  const timeframe = economics.timeframe;
  const sourceTimeframe = economics.barTimeframe;
  const startDate = economics.startDate;
  const endDate = economics.endDate;
  const requestKey = JSON.stringify([
    key,
    timeframe,
    sourceTimeframe,
    startDate,
    endDate,
    tickPrice,
  ]);

  useEffect(() => {
    let current = true;
    setData(null);
    setError("");
    setLoading(false);
    if (!dataset || !bridge.native) return;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const request = previewRequest(
          dataset,
          timeframe,
          sourceTimeframe,
          startDate,
          endDate,
          tickPrice,
        );
        const next = await bridge.preview(request);
        if (!current) return;
        if (next.datasetId !== dataset.id || next.sha256 !== dataset.sha256)
          throw new Error(
            "Price preview does not match the selected dataset receipt. Refresh imported data.",
          );
        setData(next);
        setLoadedKey(requestKey);
        setReceipt({ key, coverage: next.coverage });
      } catch (failure) {
        if (current) setError(errorMessage(failure));
      } finally {
        if (current) setLoading(false);
      }
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [
    bridge,
    key,
    dataset,
    timeframe,
    sourceTimeframe,
    startDate,
    endDate,
    tickPrice,
    revision,
    requestKey,
  ]);

  return {
    data: loadedKey === requestKey ? data : null,
    coverage: receipt?.key === key ? receipt.coverage : null,
    loading,
    error,
    tickPrice,
    setTickPrice,
    refresh,
  };
}

/** Validate a fixed preview bucket without interpreting unsupported engine timeframe aliases. */
function fixedTimeframe(value: string): Exclude<PreviewTimeframe, "source"> {
  if (
    !previewTimeframes.includes(value as PreviewTimeframe) ||
    value === "source"
  )
    throw new Error(
      "Choose a supported chart timeframe: M1, M5, M15, M30, H1, H4 or D1.",
    );
  return value as Exclude<PreviewTimeframe, "source">;
}

/** Convert exact UTC date text to exclusive-window requests; native validates coverage and content. */
function previewRequest(
  dataset: ExecutionDataset,
  timeframe: string,
  source: string,
  start: string,
  end: string,
  tickPrice: "bid" | "mid",
): MarketPreviewRequest {
  const bucket = selectedTimeframe(dataset.kind, timeframe);
  return {
    datasetId: dataset.id,
    timeframe: bucket,
    sourceTimeframe:
      dataset.kind === "bars" && source ? fixedTimeframe(source) : undefined,
    tickPrice,
    startUtc: start ? dateUtc(start) : undefined,
    endUtc: end ? dateUtc(end) : undefined,
    maximumCandles: 500,
  };
}

/** Preserve source OHLC by default; ticks require a real fixed aggregation bucket. */
function selectedTimeframe(
  kind: "ticks" | "bars",
  value: string,
): PreviewTimeframe {
  if (value) return fixedTimeframe(value);
  return kind === "bars" ? "source" : "M1";
}

/** Reject calendar rollover and malformed text rather than silently selecting another day. */
function dateUtc(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Enter UTC dates as YYYY-MM-DD.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !date.toISOString().startsWith(value))
    throw new Error("Enter a valid UTC calendar date.");
  return date.toISOString();
}
