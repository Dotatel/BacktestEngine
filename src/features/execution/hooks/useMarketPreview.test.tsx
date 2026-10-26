import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  MarketPreview,
  MarketPreviewBridge,
} from "@/lib/market-preview-contract";
import { dataset } from "../../../../tests/fixtures/backtest";
import { priceFixture } from "../../../../tests/fixtures/market-preview";
import { useMarketPreview } from "./useMarketPreview";
import type { BacktestEconomics } from "./useBacktest";

const economics: BacktestEconomics = {
  initialBalance: 10000,
  commission: 0,
  slippage: 0,
  spreadPips: -1,
  timeframe: "",
  barTimeframe: "",
  barPriceMode: "ohlc",
  startDate: "",
  endDate: "",
};

describe("useMarketPreview verified source boundary", () => {
  it("loads prices independently of a compiled strategy or authenticated economic profile", async () => {
    const bridge: MarketPreviewBridge = {
      native: true,
      preview: vi.fn().mockResolvedValue(priceFixture),
    };
    const { result } = renderHook(() =>
      useMarketPreview(bridge, dataset, economics, "project"),
    );
    await waitFor(() => expect(result.current.data).toEqual(priceFixture));
    expect(bridge.preview).toHaveBeenCalledWith({
      datasetId: dataset.id,
      timeframe: "M1",
      tickPrice: "bid",
      maximumCandles: 500,
      sourceTimeframe: undefined,
      startUtc: undefined,
      endUtc: undefined,
    });
    expect(result.current.coverage).toEqual(priceFixture.coverage);
  });

  it("rejects a response that belongs to another imported receipt", async () => {
    const bridge: MarketPreviewBridge = {
      native: true,
      preview: vi
        .fn()
        .mockResolvedValue({ ...priceFixture, sha256: "different" }),
    };
    const { result } = renderHook(() =>
      useMarketPreview(bridge, dataset, economics, "project"),
    );
    await waitFor(() => expect(result.current.error).toContain("receipt"));
    expect(result.current.data).toBeNull();
  });

  it("ignores old-project responses and never calls native operations from browser mode", async () => {
    let finish: (value: MarketPreview) => void = () => {};
    const bridge: MarketPreviewBridge = {
      native: true,
      preview: vi.fn(
        () =>
          new Promise<MarketPreview>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const { result, rerender } = renderHook(
      ({ root, bridge }) => useMarketPreview(bridge, dataset, economics, root),
      { initialProps: { root: "a", bridge } },
    );
    await waitFor(() => expect(bridge.preview).toHaveBeenCalledOnce());
    const browser = { native: false, preview: vi.fn() };
    rerender({ root: "b", bridge: browser });
    await act(async () => finish(priceFixture));
    expect(result.current.data).toBeNull();
    expect(result.current.coverage).toBeNull();
    expect(browser.preview).not.toHaveBeenCalled();
  });

  it("preserves original bars by default and passes exact exclusive UTC dates", async () => {
    const bars = { ...dataset, kind: "bars" as const };
    const bridge: MarketPreviewBridge = {
      native: true,
      preview: vi.fn().mockResolvedValue(priceFixture),
    };
    renderHook(() =>
      useMarketPreview(
        bridge,
        bars,
        { ...economics, startDate: "2026-01-01", endDate: "2026-01-04" },
        "project",
      ),
    );
    await waitFor(() => expect(bridge.preview).toHaveBeenCalled());
    expect(bridge.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        timeframe: "source",
        startUtc: "2026-01-01T00:00:00.000Z",
        endUtc: "2026-01-04T00:00:00.000Z",
      }),
    );
  });
});
