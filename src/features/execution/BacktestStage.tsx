import { useEffect, useState } from "react";
import { LoaderCircle, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WorkspaceParametersController } from "@/features/workspace/hooks/useWorkspaceParameters";
import type { WorkspaceBuild } from "@/lib/workspace-contract";
import type { ExecutionBridge } from "@/lib/execution";
import { marketPreview } from "@/lib/market-preview";
import type { MarketPreviewBridge } from "@/lib/market-preview-contract";
import type { SavedRunSelection } from "@/lib/saved-runs-contract";
import { useBacktest } from "./hooks/useBacktest";
import { BacktestInputs } from "./components/BacktestInputs";
import { StrategyControls } from "./components/StrategyControls";
import { useMarketPreview } from "./hooks/useMarketPreview";
import { MarketPriceChart } from "./components/MarketPriceChart";
import { matchingTradeMarkers } from "./lib/trade-markers";
import {
  BacktestResults,
  RunMetrics,
  RunIdentity,
} from "./components/BacktestResults";

/** Compose the selected project's compiled strategy, draft inputs and isolated run evidence. */
export interface BacktestStageProps {
  bridge: ExecutionBridge;
  build: WorkspaceBuild | null;
  stale: boolean;
  parameters: WorkspaceParametersController;
  projectRoot?: string | null;
  onBuild?: () => void;
  onBusyChange?: (busy: boolean) => void;
  previewBridge?: MarketPreviewBridge;
  savedSelection?: SavedRunSelection | null;
}

/** Render the approved chart-centred layout without inventing prices or a conversation. */
export function BacktestStage({
  bridge,
  build,
  stale,
  parameters,
  projectRoot,
  onBuild,
  onBusyChange,
  previewBridge = marketPreview,
  savedSelection = null,
}: BacktestStageProps) {
  const draftIdentity = JSON.stringify([
    build?.artifactPath,
    stale,
    parameters.activeStrategy?.strategy,
    parameters.values,
  ]);
  const backtest = useBacktest(
    bridge,
    projectRoot ?? null,
    draftIdentity,
    savedSelection,
  );
  const dataset =
    backtest.datasets.find(
      (candidate) => candidate.id === backtest.selectedDatasetId,
    ) ?? null;
  const prices = useMarketPreview(
    previewBridge,
    dataset,
    backtest.economics,
    projectRoot ?? null,
  );
  const busy = backtest.phase !== "idle";
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const canRun =
    bridge.native &&
    Boolean(build?.success && build.artifactPath) &&
    !stale &&
    Boolean(parameters.activeStrategy) &&
    backtest.selectedDatasetId !== null &&
    backtest.selectedSymbolSpecId !== null &&
    parameters.invalidNames.length === 0 &&
    !busy;
  const source = backtest.lastGoodResult;
  const [selectedTrade, setSelectedTrade] = useState<{ id: string } | null>(
    null,
  );
  useEffect(() => {
    setSelectedTrade(null);
  }, [source?.runId]);
  const previous =
    backtest.resultStale ||
    busy ||
    backtest.attemptStatus === "failed" ||
    backtest.attemptStatus === "cancelled" ||
    backtest.attemptStatus === "timeout";
  const buildNotice = buildMessage(build, stale);
  const markers = matchingTradeMarkers(
    prices.data,
    dataset,
    source,
    backtest.resultRequest,
    previous,
  );

  /** Freeze the current compiled strategy and its values before native execution. */
  function run() {
    void backtest.run({
      buildArtifactPath: build?.artifactPath ?? null,
      strategy: parameters.activeStrategy?.strategy ?? "",
      parameters: parameters.values,
    });
  }

  return (
    <section
      className="execution-stage"
      aria-label="Backtest stage"
      aria-busy={busy}
    >
      <StrategyControls
        parameters={parameters}
        disabled={busy}
        onBuild={onBuild}
      />
      <div className="execution-workspace">
        <BacktestInputs
          controller={backtest}
          native={bridge.native}
          coverage={prices.coverage}
        >
          {busy ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void backtest.cancel()}
              disabled={backtest.phase === "cancelling"}
            >
              <Square aria-hidden="true" />
              {backtest.phase === "cancelling" ? "Cancelling…" : "Cancel"}
            </Button>
          ) : (
            <Button size="sm" onClick={run} disabled={!canRun}>
              <Play aria-hidden="true" />
              Run backtest
            </Button>
          )}
        </BacktestInputs>
        <div className="execution-feedback" aria-live="polite">
          {buildNotice && (
            <p>
              {buildNotice}
              {onBuild && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onBuild}
                  disabled={busy}
                >
                  Go to Build
                </Button>
              )}
            </p>
          )}
          {!bridge.native && (
            <p>
              Browser preview · backtests and local imports are available in the
              desktop app.
            </p>
          )}
          {backtest.error && (
            <p className="execution-error" role="alert">
              {backtest.error}
            </p>
          )}
          {busy && (
            <p className="execution-operation">
              <LoaderCircle className="spinner" aria-hidden="true" />
              {backtest.phase === "cancelling"
                ? "Stopping the current backtest…"
                : "Running backtest with frozen inputs…"}
            </p>
          )}
          {backtest.attemptStatus === "cancelled" && (
            <p>Backtest canceled. The last successful run is retained.</p>
          )}
          {backtest.attemptStatus === "timeout" && (
            <p>
              Backtest timed out. Review the attempt details before trying
              again.
            </p>
          )}
          {backtest.result && !backtest.result.success && (
            <details>
              <summary>
                Latest attempt · {backtest.result.runId} ·{" "}
                {backtest.result.status}
              </summary>
              <pre>
                {backtest.result.output || "No log output was captured."}
              </pre>
            </details>
          )}
        </div>
        <section
          className="execution-price-pane"
          aria-label="Market chart"
          tabIndex={0}
        >
          <header className="execution-pane-heading">
            <span>
              {prices.data
                ? `Imported prices · ${prices.data.timeframe}`
                : "Market chart"}
            </span>
            <span>Times in UTC</span>
          </header>
          <RunMetrics result={source} previous={previous} />
          <MarketPriceChart
            controller={prices}
            native={previewBridge.native}
            datasetSelected={Boolean(dataset)}
            disabled={busy}
            markers={markers}
            onSelectTrade={(id) => setSelectedTrade({ id })}
            onAllHistory={() =>
              backtest.updateEconomics({ startDate: "", endDate: "" })
            }
          />
          <RunIdentity
            result={source}
            request={backtest.resultRequest}
            savedInputs={backtest.savedInputs}
            previous={previous}
            activeRequest={busy ? backtest.activeRequest : null}
          />
        </section>
        <BacktestResults
          result={source}
          attempt={backtest.result}
          previous={Boolean(source) && previous}
          selectedTrade={selectedTrade}
        />
      </div>
    </section>
  );
}

/** Explain the compiled-source prerequisite in trader-facing terms. */
function buildMessage(
  build: WorkspaceBuild | null,
  stale: boolean,
): string | null {
  if (!build?.success || !build.artifactPath)
    return "Build a successful strategy before running a backtest.";
  if (stale)
    return "The current build is stale. Rebuild before running a backtest.";
  return null;
}
