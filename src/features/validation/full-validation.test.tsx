import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { successResult } from "../../../tests/fixtures/backtest";
import type { ExecutionBridge } from "@/lib/execution-contract";
import type { SelectedReport } from "@/lib/reports-contract";
import type {
  FullValidationBridge,
  FullValidationResult,
} from "@/lib/full-validation";
import {
  fullValidationDefaults,
  fullValidationRequest,
} from "./full-validation-form";
import { useFullValidation } from "./useFullValidation";

const source: SelectedReport = {
  projectRoot: "synthetic-project",
  runId: successResult.runId,
  reportSha256: "a".repeat(64),
  reportJsonPath: "synthetic/report.json",
  buildRevision: "synthetic-build",
  datasetId: "synthetic-data",
  completedAt: "2026-10-24T00:00:00Z",
  strategy: "Fixture",
  symbol: "EURUSD",
  timeframe: "M1",
  accountCurrency: null,
  nativeDrawdownMethod: null,
  metrics: [],
  closedTradeCount: 0,
};
const baseline = {
  ...successResult,
  reportSha256: source.reportSha256,
  replayReceiptSha256: "b".repeat(64),
};
const completed: FullValidationResult = {
  validationRunId: "synthetic-validation",
  executionRunId: source.runId,
  projectRoot: source.projectRoot,
  replayReceiptSha256: baseline.replayReceiptSha256,
  sourceReportSha256: source.reportSha256,
  success: true,
  status: "completed",
  verdict: "UNPROVEN",
  plannedScenarios: 13,
  generatedWalkForwardWindows: 1,
  excludedWalkForwardWindows: 0,
  validationDirectory: "synthetic-validation",
  errors: [],
  output: "",
  evidence: { missingEvidence: ["synthetic_fixture_only"] },
};

/** Isolated lifecycle doubles never execute engines or establish numerical acceptance. */
function bridges() {
  const executions = {
    native: true,
    lastGoodResult: vi.fn().mockResolvedValue(baseline),
  } as unknown as ExecutionBridge;
  const bridge: FullValidationBridge = {
    native: true,
    run: vi.fn().mockResolvedValue(completed),
    cancel: vi.fn().mockResolvedValue(undefined),
    lastGoodResult: vi.fn().mockResolvedValue(null),
  };
  return { executions, bridge };
}

describe("full validation controls", () => {
  it("does not restore a running phase when cancellation rejects after completion", async () => {
    const { executions, bridge } = bridges();
    let finish!: (result: FullValidationResult) => void;
    let rejectCancel!: (error: Error) => void;
    vi.mocked(bridge.run).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(bridge.cancel).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectCancel = reject;
        }),
    );
    const hook = renderHook(() =>
      useFullValidation(bridge, executions, source),
    );
    await waitFor(() => expect(hook.result.current.baseline).toBeTruthy());
    let pending!: Promise<void>, cancellation!: Promise<void>;
    act(() => {
      pending = hook.result.current.run();
    });
    act(() => {
      cancellation = hook.result.current.cancel();
    });
    await act(async () => {
      finish(completed);
      await pending;
    });
    await act(async () => {
      rejectCancel(new Error("late cancellation diagnostic"));
      await cancellation;
    });
    expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.result).toEqual(completed);
  });
  it("retains cancellation ownership through a source change until the original run stops", async () => {
    const { executions, bridge } = bridges();
    let finish!: (result: FullValidationResult) => void;
    vi.mocked(bridge.run).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(
      ({ selected }) => useFullValidation(bridge, executions, selected),
      { initialProps: { selected: source as SelectedReport | null } },
    );
    await waitFor(() => expect(hook.result.current.baseline).toBeTruthy());
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.run();
    });
    hook.rerender({ selected: null });
    expect(hook.result.current.phase).toBe("cancelling");
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(completed);
      await pending;
    });
    expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.result).toBeNull();
  });
  it("retains exact native run/receipt capabilities and fixed-parameter windows", () => {
    const request = fullValidationRequest(
      fullValidationDefaults,
      source.runId,
      baseline.replayReceiptSha256,
    );
    expect(request.executionRunId).toBe(source.runId);
    expect(request.replayReceiptSha256).toBe(baseline.replayReceiptSha256);
    expect(request.walkForward).toEqual({
      trainDays: 90,
      validationDays: 30,
      testDays: 30,
      embargoDays: 1,
    });
  });
  it.each([
    { spreadMultipliers: "1, NaN" },
    { commissionMultipliers: "1,1" },
    { latencyTicks: "1.5" },
    { testDays: "" },
    { embargoDays: "366" },
    { monteCarloRuns: "10001" },
    { seed: "-1" },
  ])("rejects invalid scenario values before native work: %j", (patch) => {
    expect(() =>
      fullValidationRequest(
        { ...fullValidationDefaults, ...patch },
        source.runId,
        baseline.replayReceiptSha256,
      ),
    ).toThrow();
  });
  it("does not run a legacy saved baseline without a receipt", async () => {
    const { executions, bridge } = bridges();
    vi.mocked(executions.lastGoodResult).mockResolvedValue({
      ...baseline,
      replayReceiptSha256: null,
    });
    const hook = renderHook(() =>
      useFullValidation(bridge, executions, source),
    );
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(() => hook.result.current.run());
    expect(bridge.run).not.toHaveBeenCalled();
  });
  it("rejects a foreign receipt response without displaying its evidence", async () => {
    const { executions, bridge } = bridges();
    vi.mocked(bridge.run).mockResolvedValue({
      ...completed,
      replayReceiptSha256: "c".repeat(64),
    });
    const hook = renderHook(() =>
      useFullValidation(bridge, executions, source),
    );
    await waitFor(() => expect(hook.result.current.baseline).toBeTruthy());
    await act(() => hook.result.current.run());
    expect(hook.result.current.result).toBeNull();
    expect(hook.result.current.error).toContain("baseline changed");
  });
  it("keeps cancellation busy until the native run returns and blocks duplicates", async () => {
    const { executions, bridge } = bridges();
    let finish!: (result: FullValidationResult) => void;
    vi.mocked(bridge.run).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(() =>
      useFullValidation(bridge, executions, source),
    );
    await waitFor(() => expect(hook.result.current.baseline).toBeTruthy());
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.run();
    });
    await act(() => hook.result.current.run());
    await act(() => hook.result.current.cancel());
    expect(bridge.run).toHaveBeenCalledTimes(1);
    expect(hook.result.current.phase).toBe("cancelling");
    await act(async () => {
      finish({ ...completed, success: false, status: "cancelled" });
      await pending;
    });
    expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.result?.status).toBe("cancelled");
  });
  it("discards a late source load after changing project", async () => {
    const { executions, bridge } = bridges();
    let finish!: (value: typeof baseline) => void;
    vi.mocked(executions.lastGoodResult).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(
      ({ selected }) => useFullValidation(bridge, executions, selected),
      { initialProps: { selected: source as SelectedReport | null } },
    );
    hook.rerender({ selected: null });
    await act(async () => {
      finish(baseline);
    });
    expect(hook.result.current.baseline).toBeNull();
    expect(hook.result.current.result).toBeNull();
  });
});
