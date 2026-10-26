import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SelectedReport, ReportsBridge } from "@/lib/reports-contract";
import type {
  ValidationBridge,
  ValidationRunResult,
} from "@/lib/validation-contract";
import { useValidation } from "./useValidation";

// Synthetic controller fixtures only; native process/engine acceptance is checked separately.
const source: SelectedReport = {
  projectRoot: "project-a",
  runId: "synthetic-a",
  reportSha256: "a".repeat(64),
  reportJsonPath: "synthetic.json",
  buildRevision: "synthetic",
  datasetId: "synthetic",
  completedAt: "2026-10-24T10:00:00Z",
  strategy: "Synthetic",
  symbol: "EURUSD",
  timeframe: "M1",
  accountCurrency: "EUR",
  nativeDrawdownMethod: null,
  metrics: [],
  closedTradeCount: 4,
};
const completed: ValidationRunResult = {
  validationRunId: "validation-synthetic",
  executionRunId: source.runId,
  sourceReportSha256: source.reportSha256,
  mode: "savedReport",
  success: true,
  status: "completed",
  verdict: "UNPROVEN",
  projectRoot: source.projectRoot,
  startedAt: "2026-10-24T10:01:00Z",
  completedAt: "2026-10-24T10:01:02Z",
  durationMs: 2000,
  validationDir: "synthetic",
  configPath: "synthetic-config.json",
  finalVerdictPath: "synthetic-verdict.json",
  finalReportPath: "synthetic-report.md",
  missingEvidence: [
    "engine_level_latency_stress",
    "walk_forward_embargo_backtests",
  ],
  errors: [],
  output: "",
  lastGoodPreserved: false,
};

/** Supply narrowly injected synthetic services for controller race checks. */
function services() {
  const reports: ReportsBridge = {
    native: true,
    selected: vi.fn().mockResolvedValue(source),
    exportSaved: vi.fn(),
  };
  const bridge: ValidationBridge = {
    native: true,
    run: vi.fn().mockResolvedValue(completed),
    cancel: vi.fn().mockResolvedValue(undefined),
    lastGoodResult: vi.fn().mockResolvedValue(null),
  };
  return { reports, bridge };
}

describe("validation controller generation and job guards (synthetic DI)", () => {
  it("latches synchronously before two same-tick start requests", async () => {
    const { reports, bridge } = services();
    let finish: (value: ValidationRunResult) => void = () => {};
    vi.mocked(bridge.run).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const hook = renderHook(() =>
      useValidation(bridge, reports, "project-a", true),
    );
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    act(() => {
      void hook.result.current.run();
      void hook.result.current.run();
    });
    expect(bridge.run).toHaveBeenCalledTimes(1);
    await act(async () => finish(completed));
    expect(hook.result.current.result?.validationRunId).toBe(
      completed.validationRunId,
    );
  });

  it("does not attach a completed old-run response to a newly selected backtest", async () => {
    const { reports, bridge } = services();
    const next = {
      ...source,
      runId: "synthetic-b",
      reportSha256: "b".repeat(64),
    };
    vi.mocked(reports.selected)
      .mockResolvedValueOnce(source)
      .mockResolvedValue(next);
    const hook = renderHook(() =>
      useValidation(bridge, reports, "project-a", true),
    );
    await waitFor(() =>
      expect(hook.result.current.source?.runId).toBe(source.runId),
    );
    await act(async () => hook.result.current.run());
    expect(hook.result.current.source?.runId).toBe(next.runId);
    expect(hook.result.current.result).toBeNull();
    expect(hook.result.current.lastGood).toBeNull();
    expect(hook.result.current.error).toContain("selected backtest changed");
  });

  it("discards a late source-load response from a prior project", async () => {
    const { reports, bridge } = services();
    let finish: (value: SelectedReport) => void = () => {};
    const pending = new Promise<SelectedReport>((resolve) => {
      finish = resolve;
    });
    const next = { ...source, projectRoot: "project-b", runId: "synthetic-b" };
    vi.mocked(reports.selected).mockImplementation((project) =>
      project === "project-a" ? pending : Promise.resolve(next),
    );
    const hook = renderHook(
      ({ project }) => useValidation(bridge, reports, project, true),
      { initialProps: { project: "project-a" } },
    );
    hook.rerender({ project: "project-b" });
    await waitFor(() =>
      expect(hook.result.current.source?.projectRoot).toBe("project-b"),
    );
    await act(async () => finish(source));
    expect(hook.result.current.source?.projectRoot).toBe("project-b");
    expect(hook.result.current.error).toBe("");
  });

  it("keeps a live job busy when native cancellation fails and allows retry", async () => {
    const { reports, bridge } = services();
    let finish: (value: ValidationRunResult) => void = () => {};
    vi.mocked(bridge.run).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.mocked(bridge.cancel).mockRejectedValueOnce(
      new Error("Cancel channel is busy."),
    );
    const hook = renderHook(() =>
      useValidation(bridge, reports, "project-a", true),
    );
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    act(() => {
      void hook.result.current.run();
    });
    await act(async () => hook.result.current.cancel());
    expect(hook.result.current.phase).toBe("running");
    expect(hook.result.current.error).toContain("Cancel channel is busy");
    await act(async () => hook.result.current.cancel());
    expect(hook.result.current.phase).toBe("cancelling");
    await act(async () =>
      finish({ ...completed, success: false, status: "cancelled" }),
    );
    expect(hook.result.current.phase).toBe("idle");
  });
});
