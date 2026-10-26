import { createRoot } from "react-dom/client";
import { useWorkspaceParameters } from "../../../src/features/workspace/hooks/useWorkspaceParameters";
import { BacktestStage } from "../../../src/features/execution/BacktestStage";
import type { ExecutionBridge } from "../../../src/lib/execution-contract";
import type { MarketPreviewBridge } from "../../../src/lib/market-preview-contract";
import { priceFixture } from "../../fixtures/market-preview";
import type { WorkspaceBuild } from "../../../src/lib/workspace-contract";
import {
  build,
  dataset,
  spec,
  successResult,
  strategy,
} from "../../fixtures/backtest";
import "../../../src/styles.css";
import "../../../src/features/execution/execution.css";

const appearance = new URLSearchParams(location.search).get("appearance");
const priceBridge: MarketPreviewBridge | undefined =
  new URLSearchParams(location.search).get("prices") === "fixture"
    ? {
        native: true,
        async preview(request) {
          return { ...priceFixture, priceBasis: request.tickPrice };
        },
      }
    : undefined;
document.documentElement.classList.toggle("dark", appearance !== "light");
const fixtureBuild: WorkspaceBuild = {
  ...build,
  strategies: [
    {
      ...strategy,
      parameters: [
        {
          name: "FastPeriod",
          displayName: "EMA fast",
          valueType: "integer",
          default: 20,
          min: 1,
          max: 500,
          step: 1,
          group: "Parameters",
          options: null,
        },
        {
          name: "SlowPeriod",
          displayName: "EMA slow",
          valueType: "integer",
          default: 100,
          min: 1,
          max: 500,
          step: 1,
          group: "Parameters",
          options: null,
        },
        {
          name: "RiskPercent",
          displayName: "Risk per trade (%)",
          valueType: "number",
          default: 0.5,
          min: 0.1,
          max: 10,
          step: 0.1,
          group: "Parameters",
          options: null,
        },
      ],
    },
  ],
};
const trades = Array.from({ length: 25 }, (_, index) => ({
  ...successResult.trades[0],
  id: `fixture-trade-${index + 1}`,
  side: index % 2 ? "Sell" : "Buy",
  netProfit: index % 2 ? -10 : 20,
}));

/** Synthetic bridge exists only in this separate test entry; production routing never imports it. */
const bridge: ExecutionBridge = {
  native: true,
  listDatasets: async () => [dataset],
  listSymbolSpecs: async () => [spec],
  importHistoricalCsv: async () => {
    throw new Error("Fixture: local import is not connected.");
  },
  importSymbolSpec: async () => {
    throw new Error("Fixture: local import is not connected.");
  },
  run: async () => ({
    ...successResult,
    runId: "fixture-run-001",
    trades,
    equity: [
      { timeUtc: "2026-01-01T00:00:00.000Z", balance: 10000, equity: 10000 },
      { timeUtc: "2026-01-01T00:01:00.000Z", balance: 10140, equity: 10140 },
    ],
    account: successResult.account
      ? {
          ...successResult.account,
          balance: 10140,
          equity: 10140,
          closedNetProfit: 140,
          markedToMarketNetProfit: 140,
          markedToMarketReturnPercent: 1.4,
        }
      : null,
    tradeStatistics: successResult.tradeStatistics
      ? {
          ...successResult.tradeStatistics,
          totalTrades: 25,
          winningTrades: 13,
          losingTrades: 12,
          longTrades: 13,
          shortTrades: 12,
          grossProfit: 260,
          grossLoss: 120,
          netProfit: 140,
          averageNetProfit: 5.6,
          largestWin: 20,
          largestLoss: -10,
          totalPips: 250,
          winRate: 52,
          lossRate: 48,
          profitFactor: 260 / 120,
        }
      : null,
  }),
  cancel: async () => {},
  lastGoodResult: async () => null,
};

/** Exercise the real schema controller and stage with explicitly labelled, presentation-only data. */
function Fixture() {
  const parameters = useWorkspaceParameters(
    "fixture-project",
    fixtureBuild,
    [],
    async () => {},
  );
  return (
    <main
      style={{ height: "100dvh", display: "flex", flexDirection: "column" }}
    >
      <p
        style={{
          margin: 0,
          padding: "8px 16px",
          borderBottom: "1px solid var(--border)",
          color: "var(--muted-foreground)",
          fontSize: "var(--type-small)",
        }}
      >
        Presentation fixture · synthetic results · no native compiler or engine
        is running
      </p>
      <div style={{ flex: 1, minHeight: 0 }}>
        <BacktestStage
          bridge={bridge}
          previewBridge={priceBridge}
          build={fixtureBuild}
          stale={false}
          parameters={parameters}
          projectRoot="fixture-project"
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
