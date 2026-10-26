import { describe, expect, it } from "vitest";
import type { ExecutionRunRequest } from "@/lib/execution-contract";
import { dataset, successResult } from "../../../../tests/fixtures/backtest";
import { priceFixture } from "../../../../tests/fixtures/market-preview";
import { matchingTradeMarkers } from "./trade-markers";

const request: ExecutionRunRequest = {
  datasetId: dataset.id,
  strategy: successResult.strategy,
  symbolSpecPath: "fixture",
  startingBalance: 10000,
  commissionUsdPerMillion: 0,
  slippagePips: 0,
};

describe("trade annotations preserve run identity", () => {
  it("uses actual entry/exit times and prices, including retained engine timeframe names", () => {
    const markers = matchingTradeMarkers(
      priceFixture,
      dataset,
      { ...successResult, timeframe: "Minute" },
      request,
      false,
    );
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      tradeId: "trade-1",
      action: "Buy entry",
      timeUtc: successResult.trades[0].entryTimeUtc,
      price: 1.1,
      entry: true,
    });
    expect(markers[1]).toMatchObject({
      action: "Sell exit",
      price: 1.11,
      entry: false,
    });
  });

  it("hides cross-draft, cross-dataset, receipt and timeframe overlays", () => {
    expect(
      matchingTradeMarkers(priceFixture, dataset, successResult, request, true),
    ).toEqual([]);
    expect(
      matchingTradeMarkers(
        priceFixture,
        dataset,
        { ...successResult, datasetId: "other" },
        request,
        false,
      ),
    ).toEqual([]);
    expect(
      matchingTradeMarkers(
        { ...priceFixture, sha256: "other" },
        dataset,
        successResult,
        request,
        false,
      ),
    ).toEqual([]);
    expect(
      matchingTradeMarkers(
        { ...priceFixture, timeframe: "H1" },
        dataset,
        successResult,
        request,
        false,
      ),
    ).toEqual([]);
  });

  it("bounds marker drawing and leaves trades outside the selected preview unmodified", () => {
    const result = {
      ...successResult,
      trades: Array.from({ length: 300 }, (_, index) => ({
        ...successResult.trades[0],
        id: String(index),
      })),
    };
    expect(
      matchingTradeMarkers(priceFixture, dataset, result, request, false),
    ).toHaveLength(200);
    expect(result.trades).toHaveLength(300);
    expect(
      matchingTradeMarkers(
        {
          ...priceFixture,
          selection: {
            ...priceFixture.selection,
            endUtcExclusive: "2026-01-01T00:00:00Z",
          },
        },
        dataset,
        result,
        request,
        false,
      ),
    ).toEqual([]);
  });
});
