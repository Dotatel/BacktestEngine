import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecutionBridge } from "@/lib/execution";
import type {
  ExecutionDataset,
  ExecutionRunRequest,
  ExecutionRunResult,
  ExecutionSymbolSpec,
} from "@/lib/execution-contract";
import { pickHistoricalCsv, pickSymbolSpec } from "@/lib/execution";
import { errorMessage } from "@/lib/preferences";
import type {
  SavedRunInputs,
  SavedRunSelection,
} from "@/lib/saved-runs-contract";

/** Visible replay phase for one backtest request. */
export type BacktestPhase = "idle" | "running" | "cancelling";

/** Explicit run inputs owned by the user; native host validates every field. */
export interface BacktestEconomics {
  initialBalance: number;
  commission: number;
  slippage: number;
  spreadPips: number;
  timeframe: string;
  barTimeframe: string;
  barPriceMode: string;
  startDate: string;
  endDate: string;
}

/** Controller for dataset selection, explicit run inputs and honest replay output. */
export interface BacktestController {
  datasets: ExecutionDataset[];
  symbolSpecs: ExecutionSymbolSpec[];
  selectedDatasetId: string | null;
  selectedSymbolSpecId: string | null;
  importKind: "ticks" | "bars";
  economics: BacktestEconomics;
  phase: BacktestPhase;
  result: ExecutionRunResult | null;
  lastGoodResult: ExecutionRunResult | null;
  resultStale: boolean;
  error: string;
  /** Frozen input for the visible successful result; never reinterpreted as the draft. */
  resultRequest: ExecutionRunRequest | null;
  /** Verified historical inputs remain read-only and never replace the current draft. */
  savedInputs: SavedRunInputs | null;
  /** Frozen input of the latest attempt, also available while it runs. */
  activeRequest: ExecutionRunRequest | null;
  attemptStatus:
    "ready" | "running" | "completed" | "cancelled" | "failed" | "timeout";
  selectDataset(id: string): void;
  selectSymbolSpec(id: string): void;
  setImportKind(kind: "ticks" | "bars"): void;
  updateEconomics(patch: Partial<BacktestEconomics>): void;
  importDataset(): Promise<void>;
  importSymbolSpec(): Promise<void>;
  refreshCatalog(): Promise<void>;
  run(input: {
    buildArtifactPath: string | null;
    strategy: string;
    parameters: Record<string, unknown>;
  }): Promise<void>;
  cancel(): Promise<void>;
  clearResult(): void;
}

const defaultEconomics: BacktestEconomics = {
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

/** Accept only calendar dates in UTC date-only form. */
function validDateOnly(value: string): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().startsWith(value)
  );
}

/** Normalize a malformed unsuccessful completion into a failed attempt. */
function statusForOutcome(
  outcome: ExecutionRunResult,
): BacktestController["attemptStatus"] {
  if (outcome.success) return "completed";
  if (outcome.status === "completed") return "failed";
  return outcome.status;
}

/**
 * Keep replay inputs and output in one focused controller. Presentation renders state and
 * dispatches intent; host import, validation and engine execution stay behind the bridge.
 */
export function useBacktest(
  bridge: ExecutionBridge,
  projectRoot: string | null = null,
  draftIdentity = "",
  savedSelection: SavedRunSelection | null = null,
): BacktestController {
  const [datasets, setDatasets] = useState<ExecutionDataset[]>([]);
  const [symbolSpecs, setSymbolSpecs] = useState<ExecutionSymbolSpec[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(
    null,
  );
  const [selectedSymbolSpecId, setSelectedSymbolSpecId] = useState<
    string | null
  >(null);
  const [importKind, setImportKind] = useState<"ticks" | "bars">("bars");
  const [economics, setEconomics] =
    useState<BacktestEconomics>(defaultEconomics);
  const [phase, setPhase] = useState<BacktestPhase>("idle");
  const [result, setResult] = useState<ExecutionRunResult | null>(null);
  const [lastGoodResult, setLastGoodResult] =
    useState<ExecutionRunResult | null>(null);
  const [resultStale, setResultStale] = useState(false);
  const [error, setError] = useState("");
  const [resultRequest, setResultRequest] =
    useState<ExecutionRunRequest | null>(null);
  const [savedInputs, setSavedInputs] = useState<SavedRunInputs | null>(null);
  const [activeRequest, setActiveRequest] =
    useState<ExecutionRunRequest | null>(null);
  const [attemptStatus, setAttemptStatus] =
    useState<BacktestController["attemptStatus"]>("ready");
  const draftIdentityRef = useRef(draftIdentity);
  const runGenerationRef = useRef(0);
  const runningRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const projectRootRef = useRef(projectRoot);
  const scopeGenerationRef = useRef(0);

  /** Load durable imported catalogs without inventing market data or specs. */
  const refreshCatalog = useCallback(async () => {
    if (!bridge.native || runningRef.current) return;
    const scopeGeneration = scopeGenerationRef.current;
    try {
      const [nextDatasets, nextSpecs] = await Promise.all([
        bridge.listDatasets(),
        bridge.listSymbolSpecs(),
      ]);
      if (scopeGenerationRef.current !== scopeGeneration || runningRef.current)
        return;
      setDatasets(nextDatasets);
      setSymbolSpecs(nextSpecs);
      setSelectedDatasetId((current) =>
        current && nextDatasets.some((dataset) => dataset.id === current)
          ? current
          : (nextDatasets[0]?.id ?? null),
      );
      setSelectedSymbolSpecId((current) =>
        current && nextSpecs.some((spec) => spec.id === current)
          ? current
          : (nextSpecs[0]?.id ?? null),
      );
    } catch (failure) {
      if (scopeGenerationRef.current !== scopeGeneration) return;
      setError(errorMessage(failure));
    }
  }, [bridge]);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  useEffect(() => {
    if (projectRootRef.current === projectRoot) return;
    projectRootRef.current = projectRoot;
    scopeGenerationRef.current += 1;
    cancelRequestedRef.current = true;
    runningRef.current = false;
    setResult(null);
    setLastGoodResult(null);
    setResultRequest(null);
    setSavedInputs(null);
    setActiveRequest(null);
    setAttemptStatus("ready");
    runGenerationRef.current += 1;
    setResultStale(false);
    setError("");
    setPhase("idle");
  }, [projectRoot]);

  useEffect(() => {
    if (!savedSelection || runningRef.current) return;
    if (
      savedSelection.projectRoot !== projectRoot ||
      !savedSelection.run.success ||
      savedSelection.run.status !== "completed"
    )
      return;
    if (
      !savedSelection.run.reportSha256 ||
      !savedSelection.run.replayReceiptSha256
    )
      return;
    setLastGoodResult(savedSelection.run);
    setResult(savedSelection.run);
    setSavedInputs(savedSelection.inputs);
    setResultRequest(null);
    setActiveRequest(null);
    setAttemptStatus("completed");
    setResultStale(true);
    setError("");
  }, [projectRoot, savedSelection]);

  const markStale = useCallback(() => {
    if (result || lastGoodResult) setResultStale(true);
  }, [result, lastGoodResult]);

  useEffect(() => {
    if (draftIdentityRef.current === draftIdentity) return;
    draftIdentityRef.current = draftIdentity;
    markStale();
  }, [draftIdentity, markStale]);

  const selectDataset = useCallback(
    (id: string) => {
      if (runningRef.current) return;
      setSelectedDatasetId(id);
      markStale();
    },
    [markStale],
  );

  const selectSymbolSpec = useCallback(
    (id: string) => {
      if (runningRef.current) return;
      setSelectedSymbolSpecId(id);
      markStale();
    },
    [markStale],
  );

  const updateEconomics = useCallback(
    (patch: Partial<BacktestEconomics>) => {
      if (runningRef.current) return;
      setEconomics((current) => ({ ...current, ...patch }));
      markStale();
    },
    [markStale],
  );

  const setImportKindWrapped = useCallback(
    (kind: "ticks" | "bars") => {
      if (runningRef.current) return;
      setImportKind(kind);
      markStale();
    },
    [markStale],
  );

  /** Settle only this generation; an old project's finally cannot unlock a newer run. */
  const settleRun = useCallback((generation: number) => {
    if (runGenerationRef.current !== generation) return;
    if (cancelRequestedRef.current) setAttemptStatus("cancelled");
    cancelRequestedRef.current = false;
    runningRef.current = false;
    setPhase("idle");
  }, []);

  /** Import through the official native picker, then host validation. */
  const importDataset = useCallback(async () => {
    if (runningRef.current) return;
    const scopeGeneration = scopeGenerationRef.current;
    try {
      const path = await pickHistoricalCsv();
      if (!path) return;
      const imported = await bridge.importHistoricalCsv(path, importKind);
      if (scopeGenerationRef.current !== scopeGeneration || runningRef.current)
        return;
      setDatasets((current) => [...current, imported]);
      setSelectedDatasetId(imported.id);
      markStale();
    } catch (failure) {
      if (scopeGenerationRef.current !== scopeGeneration) return;
      setError(errorMessage(failure));
    }
  }, [bridge, importKind, markStale]);

  const importSymbolSpec = useCallback(async () => {
    if (runningRef.current) return;
    const scopeGeneration = scopeGenerationRef.current;
    try {
      const path = await pickSymbolSpec();
      if (!path) return;
      const imported = await bridge.importSymbolSpec(path);
      if (scopeGenerationRef.current !== scopeGeneration || runningRef.current)
        return;
      setSymbolSpecs((current) => [...current, imported]);
      setSelectedSymbolSpecId(imported.id);
      markStale();
    } catch (failure) {
      if (scopeGenerationRef.current !== scopeGeneration) return;
      setError(errorMessage(failure));
    }
  }, [bridge, markStale]);

  const run = useCallback(
    async (input: {
      buildArtifactPath: string | null;
      strategy: string;
      parameters: Record<string, unknown>;
    }) => {
      if (runningRef.current) return;
      if (!bridge.native) {
        setError(
          "Run backtests in the desktop app with a compiled strategy and imported data.",
        );
        return;
      }
      const scopeGeneration = scopeGenerationRef.current;
      const selectedSymbolSpec = symbolSpecs.find(
        (spec) => spec.id === selectedSymbolSpecId,
      );
      const selectedDataset = datasets.find(
        (dataset) => dataset.id === selectedDatasetId,
      );
      if (!selectedDatasetId) {
        setError("Select an imported historical dataset before running.");
        return;
      }
      if (!selectedSymbolSpec) {
        setError("Select an imported symbol specification before running.");
        return;
      }
      if (!input.buildArtifactPath) {
        setError("Build a successful strategy artifact before running.");
        return;
      }
      if (!input.strategy) {
        setError("Select a compiled strategy before running.");
        return;
      }
      if (
        !Number.isFinite(economics.initialBalance) ||
        !Number.isFinite(economics.commission) ||
        !Number.isFinite(economics.slippage) ||
        !Number.isFinite(economics.spreadPips)
      ) {
        setError("Enter finite numeric values for balance, costs and spread.");
        return;
      }
      if (selectedDataset?.kind === "bars" && !economics.barTimeframe.trim()) {
        setError(
          "Choose the source bar timeframe in Data settings before running.",
        );
        return;
      }
      if (!validDateOnly(economics.startDate)) {
        setError("Enter a valid start date as YYYY-MM-DD.");
        return;
      }
      if (!validDateOnly(economics.endDate)) {
        setError("Enter a valid end date as YYYY-MM-DD.");
        return;
      }
      if (economics.startDate && economics.endDate) {
        const start = Date.parse(economics.startDate);
        const end = Date.parse(economics.endDate);
        if (start >= end) {
          setError("Start date must be before the exclusive end date.");
          return;
        }
      }
      const parameterOverrides = Object.fromEntries(
        Object.entries(input.parameters).map(([key, value]) => [
          key,
          String(value),
        ]),
      );
      let request: ExecutionRunRequest;
      try {
        request = {
          buildArtifactPath: input.buildArtifactPath,
          strategy: input.strategy,
          datasetId: selectedDatasetId,
          symbolSpecPath: selectedSymbolSpec.storedPath,
          parameterOverrides,
          startingBalance: economics.initialBalance,
          commissionUsdPerMillion: economics.commission,
          slippagePips: economics.slippage,
          spreadPips: economics.spreadPips,
          timeframe: economics.timeframe.trim() || undefined,
          barTimeframe: economics.barTimeframe.trim() || undefined,
          barPriceMode: economics.barPriceMode.trim() || undefined,
          startUtc: economics.startDate
            ? new Date(economics.startDate).toISOString()
            : undefined,
          endUtc: economics.endDate
            ? new Date(economics.endDate).toISOString()
            : undefined,
          writeEquityCsv: true,
        };
      } catch (failure) {
        setError(errorMessage(failure));
        return;
      }
      runningRef.current = true;
      const runGeneration = ++runGenerationRef.current;
      cancelRequestedRef.current = false;
      setError("");
      setActiveRequest(request);
      setAttemptStatus("running");
      setPhase("running");
      try {
        const outcome = await bridge.run(request);
        if (
          runGenerationRef.current !== runGeneration ||
          scopeGenerationRef.current !== scopeGeneration
        )
          return;
        if (cancelRequestedRef.current) return;
        setResult(outcome);
        setAttemptStatus(statusForOutcome(outcome));
        if (outcome.success) {
          setError("");
          setLastGoodResult(outcome);
          setResultRequest(request);
          setSavedInputs(null);
          setResultStale(draftIdentityRef.current !== draftIdentity);
        }
        if (!outcome.success && outcome.errors.length > 0) {
          setError(outcome.errors.join(" "));
        }
      } catch (failure) {
        if (
          !cancelRequestedRef.current &&
          scopeGenerationRef.current === scopeGeneration &&
          runGenerationRef.current === runGeneration
        ) {
          setError(errorMessage(failure));
          setAttemptStatus("failed");
        }
      } finally {
        settleRun(runGeneration);
      }
    },
    [
      bridge,
      datasets,
      draftIdentity,
      economics,
      selectedDatasetId,
      selectedSymbolSpecId,
      symbolSpecs,
      settleRun,
    ],
  );

  const cancel = useCallback(async () => {
    if (phase !== "running" || cancelRequestedRef.current) return;
    const runGeneration = runGenerationRef.current;
    cancelRequestedRef.current = true;
    setPhase("cancelling");
    try {
      await bridge.cancel();
    } catch (failure) {
      if (runGenerationRef.current !== runGeneration) return;
      setError(errorMessage(failure));
      if (!runningRef.current) return;
      cancelRequestedRef.current = false;
      setPhase("running");
    }
  }, [bridge, phase]);

  const clearResult = useCallback(() => {
    if (runningRef.current) return;
    setResult(null);
    setLastGoodResult(null);
    setResultStale(false);
    setResultRequest(null);
    setSavedInputs(null);
    setActiveRequest(null);
    setAttemptStatus("ready");
    setError("");
  }, []);

  return {
    datasets,
    symbolSpecs,
    selectedDatasetId,
    selectedSymbolSpecId,
    importKind,
    economics,
    phase,
    result,
    lastGoodResult,
    resultStale,
    error,
    resultRequest,
    savedInputs,
    activeRequest,
    attemptStatus,
    selectDataset,
    selectSymbolSpec,
    setImportKind: setImportKindWrapped,
    updateEconomics,
    importDataset,
    importSymbolSpec,
    refreshCatalog,
    run,
    cancel,
    clearResult,
  };
}
