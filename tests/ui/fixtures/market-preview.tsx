import { createRoot } from "react-dom/client";
import { BacktestStage } from "../../../src/features/execution/BacktestStage";
import type { WorkspaceParametersController } from "../../../src/features/workspace/hooks/useWorkspaceParameters";
import type { ExecutionBridge } from "../../../src/lib/execution-contract";
import type { MarketPreviewBridge } from "../../../src/lib/market-preview-contract";
import { dataset } from "../../fixtures/backtest";
import { priceFixture } from "../../fixtures/market-preview";
import "../../../src/styles.css";
import "../../../src/features/execution/execution.css";

document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("appearance") !== "light",
);
const parameters: WorkspaceParametersController = {
  strategies: [],
  activeStrategy: null,
  values: {},
  invalidNames: [],
  presets: [],
  message: "",
  messageTone: "info",
  selectStrategy() {},
  setValue() {},
  resetDefaults() {},
  loadPreset() {},
  async savePreset() {
    return null;
  },
  clearMessage() {},
};
const bridge: ExecutionBridge = {
  native: true,
  async listDatasets() {
    return [dataset];
  },
  async listSymbolSpecs() {
    return [];
  },
  async importHistoricalCsv() {
    throw new Error("Fixture only");
  },
  async importSymbolSpec() {
    throw new Error("Fixture only");
  },
  async run() {
    throw new Error("No compiler or engine exists in this fixture");
  },
  async cancel() {},
  async lastGoodResult() {
    return null;
  },
};
const previewBridge: MarketPreviewBridge = {
  native: true,
  async preview(request) {
    const recordedVolume =
      new URLSearchParams(location.search).get("volume") === "recorded";
    return {
      ...priceFixture,
      priceBasis: request.tickPrice,
      volumeBasis: recordedVolume ? "volume" : null,
      candles: priceFixture.candles.map((candle, index) => ({
        ...candle,
        volume: recordedVolume ? (index + 1) * 5 : null,
      })),
    };
  },
};

createRoot(document.getElementById("root")!).render(
  <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <p
      style={{
        margin: 0,
        padding: "8px 16px",
        color: "var(--muted-foreground)",
        fontSize: "var(--type-small)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      Presentation fixture · synthetic OHLC · no native import, compiler or
      engine is running
    </p>
    <div style={{ flex: 1, minHeight: 0 }}>
      <BacktestStage
        bridge={bridge}
        previewBridge={previewBridge}
        parameters={parameters}
        build={null}
        stale={false}
        projectRoot="fixture-project"
      />
    </div>
  </main>,
);
