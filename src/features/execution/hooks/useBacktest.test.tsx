import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionBridge } from "@/lib/execution";
import type {
  ExecutionDataset,
  ExecutionRunResult,
  ExecutionSymbolSpec,
} from "@/lib/execution-contract";
import { useBacktest } from "./useBacktest";
import { historySelection } from "@/features/reports/saved-runs.test-support";

const dataset: ExecutionDataset = {
  id: "dataset-1",
  originalPath: "C:/data.csv",
  storedPath: "app/data.csv",
  sha256: "abc",
  sizeBytes: 10,
  kind: "ticks",
  rowCount: 2,
  importedAt: "2026-01-01T00:00:00.000Z",
};

const spec: ExecutionSymbolSpec = {
  id: "spec-1",
  originalPath: "C:/spec.json",
  storedPath: "app/spec.json",
  sha256: "def",
  sizeBytes: 5,
  schemaVersion: "1",
  importedAt: "2026-01-01T00:00:00.000Z",
};

const successResult: ExecutionRunResult = {
  runId: "run-1",
  success: true,
  status: "completed",
  strategy: "ExampleStrategy",
  symbol: "EURUSD",
  timeframe: "M1",
  buildArtifactPath: "artifact.dll",
  buildRevision: "rev",
  datasetId: "dataset-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000,
  runFolder: "run",
  reportJsonPath: "report.json",
  reportSha256: null,
  replayReceiptSha256: null,
  tradesCsvPath: "trades.csv",
  openPositionsCsvPath: "positions.csv",
  equityCsvPath: null,
  account: null,
  replay: null,
  tradeStatistics: null,
  nativeReportDrawdown: null,
  fullReplayDrawdown: null,
  trades: [],
  openPositions: [],
  equity: [],
  errors: [],
  output: "",
};

function createBridge(
  overrides: Partial<ExecutionBridge> = {},
): ExecutionBridge {
  return {
    native: true,
    importHistoricalCsv: vi.fn(),
    listDatasets: vi.fn().mockResolvedValue([dataset]),
    importSymbolSpec: vi.fn(),
    listSymbolSpecs: vi.fn().mockResolvedValue([spec]),
    run: vi.fn().mockResolvedValue(successResult),
    cancel: vi.fn().mockResolvedValue(undefined),
    lastGoodResult: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("useBacktest", () => {
  it("shows verified saved evidence with frozen inputs while preserving the current draft", async () => {
    const bridge = createBridge();
    const view = renderHook(
      ({ savedSelection }) =>
        useBacktest(bridge, "project-a", "current-draft", savedSelection),
      {
        initialProps: {
          savedSelection: null as typeof historySelection | null,
        },
      },
    );
    await waitFor(() =>
      expect(view.result.current.selectedDatasetId).toBe("dataset-1"),
    );
    act(() =>
      view.result.current.updateEconomics({
        initialBalance: 5432,
        startDate: "2025-01-01",
      }),
    );
    view.rerender({ savedSelection: historySelection });
    expect(view.result.current.lastGoodResult?.runId).toBe(
      historySelection.run.runId,
    );
    expect(view.result.current.savedInputs).toEqual(historySelection.inputs);
    expect(view.result.current.resultRequest).toBeNull();
    expect(view.result.current.resultStale).toBe(true);
    expect(view.result.current.economics.initialBalance).toBe(5432);
    expect(view.result.current.economics.startDate).toBe("2025-01-01");
    expect(view.result.current.selectedDatasetId).toBe("dataset-1");
    expect(bridge.run).not.toHaveBeenCalled();
  });

  it("rejects foreign historical evidence and clears saved inputs when switching projects", async () => {
    const bridge = createBridge();
    const view = renderHook(
      ({ projectRoot }) =>
        useBacktest(bridge, projectRoot, "draft", historySelection),
      { initialProps: { projectRoot: "project-a" } },
    );
    await waitFor(() => expect(view.result.current.savedInputs).not.toBeNull());
    view.rerender({ projectRoot: "project-b" });
    expect(view.result.current.lastGoodResult).toBeNull();
    expect(view.result.current.savedInputs).toBeNull();
    expect(bridge.run).not.toHaveBeenCalled();
  });
  it("reports invalid input when no dataset is selected", async () => {
    const bridge = createBridge({
      listDatasets: vi.fn().mockResolvedValue([]),
      listSymbolSpecs: vi.fn().mockResolvedValue([spec]),
    });
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    await act(async () => {
      await result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    expect(result.current.error).toContain("dataset");
    expect(bridge.run).not.toHaveBeenCalled();
  });

  it("stores a successful run as the last good result", async () => {
    const bridge = createBridge();
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    await waitFor(() =>
      expect(result.current.selectedSymbolSpecId).toBe("spec-1"),
    );
    await act(async () => {
      await result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: { FastPeriod: 5 },
      });
    });
    expect(result.current.result?.runId).toBe("run-1");
    expect(result.current.lastGoodResult?.runId).toBe("run-1");
    expect(result.current.resultStale).toBe(false);
  });

  it("reports run errors without replacing the last good result", async () => {
    const failed: ExecutionRunResult = {
      ...successResult,
      runId: "run-2",
      success: false,
      errors: ["boom"],
    };
    const bridge = createBridge({ run: vi.fn().mockResolvedValue(failed) });
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    await waitFor(() =>
      expect(result.current.selectedSymbolSpecId).toBe("spec-1"),
    );
    await act(async () => {
      await result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    expect(result.current.error).toContain("boom");
    expect(result.current.lastGoodResult).toBeNull();
  });

  it("retains the last good result when a later run fails", async () => {
    const failed: ExecutionRunResult = {
      ...successResult,
      runId: "run-2",
      success: false,
      errors: ["boom"],
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce(successResult)
      .mockResolvedValueOnce(failed);
    const bridge = createBridge({ run });
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    await waitFor(() =>
      expect(result.current.selectedSymbolSpecId).toBe("spec-1"),
    );
    await act(async () => {
      await result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    await act(async () => {
      await result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    expect(result.current.lastGoodResult?.runId).toBe("run-1");
  });

  it("ignores a second submit while a run is in progress", async () => {
    let resolveRun: (value: ExecutionRunResult) => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<ExecutionRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const bridge = createBridge({ run });
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    await waitFor(() =>
      expect(result.current.selectedSymbolSpecId).toBe("spec-1"),
    );
    act(() => {
      void result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    await waitFor(() => expect(result.current.phase).toBe("running"));
    await act(async () => {
      await result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveRun(successResult);
    });
    await waitFor(() => expect(result.current.phase).toBe("idle"));
  });

  it("marks the retained result stale when inputs change", async () => {
    const bridge = createBridge();
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    await waitFor(() =>
      expect(result.current.selectedSymbolSpecId).toBe("spec-1"),
    );
    await act(async () => {
      await result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    act(() => {
      result.current.updateEconomics({ initialBalance: 20000 });
    });
    expect(result.current.resultStale).toBe(true);
    expect(result.current.result?.runId).toBe("run-1");
  });

  it("recovers from an invalid date without invoking the bridge", async () => {
    const bridge = createBridge();
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    await waitFor(() =>
      expect(result.current.selectedSymbolSpecId).toBe("spec-1"),
    );
    act(() => {
      result.current.updateEconomics({ startDate: "not-a-date" });
    });
    await act(async () => {
      await result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    expect(result.current.error).toContain("valid start date");
    expect(result.current.phase).toBe("idle");
    expect(bridge.run).not.toHaveBeenCalled();
  });

  it("keeps cancelling until a delayed run settles and ignores late success", async () => {
    let resolveRun: (value: ExecutionRunResult) => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<ExecutionRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const bridge = createBridge({ run });
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    await waitFor(() =>
      expect(result.current.selectedSymbolSpecId).toBe("spec-1"),
    );
    act(() => {
      void result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    await waitFor(() => expect(result.current.phase).toBe("running"));
    let resolveCancel: () => void = () => {};
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    bridge.cancel = cancel;
    act(() => {
      void result.current.cancel();
    });
    await waitFor(() => expect(result.current.phase).toBe("cancelling"));
    await act(async () => {
      resolveCancel();
    });
    // Run is still settling; phase must remain cancelling.
    await waitFor(() => expect(result.current.phase).toBe("cancelling"));
    await act(async () => {
      resolveRun({ ...successResult, runId: "late-run" });
    });
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(result.current.lastGoodResult).toBeNull();
  });

  it("ignores a deferred old-project run after the project changes", async () => {
    let resolveRun: (value: ExecutionRunResult) => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<ExecutionRunResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const bridge = createBridge({ run });
    const { result, rerender } = renderHook(
      ({ projectRoot }) => useBacktest(bridge, projectRoot),
      { initialProps: { projectRoot: "project-a" } },
    );
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    await waitFor(() =>
      expect(result.current.selectedSymbolSpecId).toBe("spec-1"),
    );
    act(() => {
      void result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    await waitFor(() => expect(result.current.phase).toBe("running"));
    rerender({ projectRoot: "project-b" });
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    await act(async () => {
      resolveRun({ ...successResult, runId: "old-run" });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.result).toBeNull();
    expect(result.current.lastGoodResult).toBeNull();
  });

  it("calls cancel only through the bridge", async () => {
    const bridge = createBridge();
    const { result } = renderHook(() => useBacktest(bridge));
    await act(async () => {
      await result.current.cancel();
    });
    // cancel is a no-op while idle; bridge should not be called
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it("does not let an old project's finally unlock or overwrite a new run", async () => {
    const resolvers: ((value: ExecutionRunResult) => void)[] = [];
    const run = vi.fn(
      () =>
        new Promise<ExecutionRunResult>((resolve) => resolvers.push(resolve)),
    );
    const bridge = createBridge({ run });
    const { result, rerender } = renderHook(
      ({ root }) => useBacktest(bridge, root),
      { initialProps: { root: "a" } },
    );
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    const input = {
      buildArtifactPath: "artifact.dll",
      strategy: "ExampleStrategy",
      parameters: {},
    };
    act(() => {
      void result.current.run(input);
    });
    rerender({ root: "b" });
    act(() => {
      void result.current.run(input);
    });
    expect(result.current.phase).toBe("running");
    await act(async () => resolvers[0]({ ...successResult, runId: "old" }));
    expect(result.current.phase).toBe("running");
    expect(result.current.result).toBeNull();
    await act(async () => {
      await result.current.run(input);
    });
    expect(run).toHaveBeenCalledTimes(2);
    await act(async () => resolvers[1]({ ...successResult, runId: "new" }));
    expect(result.current.result?.runId).toBe("new");
  });

  it("rejects a zero-length exclusive period", async () => {
    const bridge = createBridge();
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    act(() =>
      result.current.updateEconomics({
        startDate: "2026-01-01",
        endDate: "2026-01-01",
      }),
    );
    await act(async () =>
      result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      }),
    );
    expect(result.current.error).toContain("exclusive end date");
    expect(bridge.run).not.toHaveBeenCalled();
  });

  it("freezes draft mutations while busy and snapshots parameters before dispatch", async () => {
    let finish: (result: ExecutionRunResult) => void = () => {};
    const bridge = createBridge({
      run: vi.fn(
        () =>
          new Promise<ExecutionRunResult>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    const parameters = { Fast: 20 };
    act(() => {
      void result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters,
      });
    });
    parameters.Fast = 99;
    act(() => {
      result.current.updateEconomics({ initialBalance: 90000 });
      result.current.selectDataset("another-dataset");
      result.current.selectSymbolSpec("another-profile");
      result.current.setImportKind("ticks");
    });
    expect(result.current.economics.initialBalance).toBe(10000);
    expect(result.current.selectedDatasetId).toBe("dataset-1");
    expect(result.current.selectedSymbolSpecId).toBe("spec-1");
    expect(result.current.importKind).toBe("bars");
    expect(result.current.activeRequest?.parameterOverrides).toEqual({
      Fast: "20",
    });
    await act(async () => finish(successResult));
    expect(result.current.resultRequest?.startingBalance).toBe(10000);
  });

  it("keeps the run active when cancellation fails, allowing a genuine completion", async () => {
    let finish: (result: ExecutionRunResult) => void = () => {};
    const bridge = createBridge({
      run: vi.fn(
        () =>
          new Promise<ExecutionRunResult>((resolve) => {
            finish = resolve;
          }),
      ),
      cancel: vi.fn().mockRejectedValue(new Error("Cancellation failed")),
    });
    const { result } = renderHook(() => useBacktest(bridge));
    await waitFor(() =>
      expect(result.current.selectedDatasetId).toBe("dataset-1"),
    );
    act(() => {
      void result.current.run({
        buildArtifactPath: "artifact.dll",
        strategy: "ExampleStrategy",
        parameters: {},
      });
    });
    await act(async () => result.current.cancel());
    expect(result.current.phase).toBe("running");
    expect(result.current.error).toBe("Cancellation failed");
    await act(async () => finish(successResult));
    expect(result.current.result?.runId).toBe("run-1");
  });
});
