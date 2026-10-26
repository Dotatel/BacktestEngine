import { describe, expect, it } from "vitest";
import { successResult } from "../../../../tests/fixtures/backtest";
import {
  chartSamples,
  formatMetric,
  sampledDrawdown,
  tradesCsv,
} from "./results";

describe("run display evidence", () => {
  it("retains unavailable values and real zero distinctly", () => {
    expect(formatMetric(null)).toBe("n/a");
    expect(formatMetric(undefined)).toBe("n/a");
    expect(formatMetric(Number.NaN)).toBe("n/a");
    expect(formatMetric(0, "%")).toBe("0%");
  });

  it("computes sampled drawdown from the rolling peak, including unrealized changes", () => {
    const points = [100, 120, 90, 110, 150, 120].map((equity, index) => ({
      timeUtc: String(index),
      equity,
      balance: 100,
    }));
    const drawdowns = sampledDrawdown(points).map(
      (point) => point.drawdownPercent,
    );
    expect(drawdowns[3]).toBeCloseTo(100 / 12);
    expect(drawdowns.filter((_point, index) => index !== 3)).toEqual([
      0, 0, 25, 0, 20,
    ]);
    expect(
      sampledDrawdown([{ timeUtc: "0", equity: 0, balance: 0 }])[0]
        .drawdownPercent,
    ).toBeNull();
  });

  it("keeps endpoints and price extremes when bounding the displayed equity series", () => {
    const points = Array.from({ length: 2000 }, (_, index) => ({
      timeUtc: String(index),
      equity: 100,
      balance: 100,
    }));
    points[501].equity = 1;
    points[1501].equity = 1000;
    const result = chartSamples(points);
    expect(result.length).toBeLessThanOrEqual(600);
    expect(result[0]).toBe(points[0]);
    expect(result.at(-1)).toBe(points.at(-1));
    expect(result).toContain(points[501]);
    expect(result).toContain(points[1501]);
  });

  it("exports the full selected ledger with provenance and neutralized spreadsheet formulas", () => {
    const result = {
      ...successResult,
      strategy: '=HYPERLINK("bad")',
      trades: Array.from({ length: 25 }, (_, index) => ({
        ...successResult.trades[0],
        id: String(index),
      })),
    };
    const csv = tradesCsv(result);
    expect(csv.split("\r\n")).toHaveLength(26);
    expect(csv).toContain('"run-1","dataset-1"');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"24"');
  });
});
