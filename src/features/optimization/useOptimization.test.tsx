import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionBridge } from "@/lib/execution-contract";
import type {
  OptimizationBridge,
  OptimizationRunRequest,
  OptimizationRunResult,
} from "@/lib/optimization-contract";
import { useOptimization } from "./useOptimization";

// Deliberately synthetic DI lifecycle fixtures; actual C# process proof is a separate native suite.
const completed = {
  runId: "synthetic-a",
  projectRoot: "project-a",
  strategy: "Synthetic",
  success: true,
  candidates: [],
} as unknown as OptimizationRunResult;
const request = { strategy: "Synthetic" } as OptimizationRunRequest;

/** Inject only the service methods exercised by the optimizer lifecycle. */
function services() {
  const bridge: OptimizationBridge = {
    native: true,
    run: vi.fn().mockResolvedValue(completed),
    cancel: vi.fn().mockResolvedValue(undefined),
    lastGoodResult: vi.fn().mockResolvedValue(null),
  };
  const execution = {
    native: true,
    listDatasets: vi.fn().mockResolvedValue([]),
    listSymbolSpecs: vi.fn().mockResolvedValue([]),
  } as unknown as ExecutionBridge;
  return { bridge, execution };
}

describe("optimization lifecycle (synthetic DI)", () => {
  it("does not launch between a synchronous refresh and its loading render", async () => {
    const { bridge, execution } = services();
    const hook = renderHook(() =>
      useOptimization(bridge, execution, "project-a", "build-a", true),
    );
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    act(() => {
      void hook.result.current.refresh();
      void hook.result.current.run(request);
    });
    expect(bridge.run).not.toHaveBeenCalled();
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
  });
  it("latches same-tick duplicate launches and remains busy after cancellation request", async () => {
    const { bridge, execution } = services();
    let finish!: (value: OptimizationRunResult) => void;
    vi.mocked(bridge.run).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const hook = renderHook(() =>
      useOptimization(bridge, execution, "project-a", "build-a", true),
    );
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    act(() => {
      void hook.result.current.run(request);
      void hook.result.current.run(request);
    });
    expect(bridge.run).toHaveBeenCalledTimes(1);
    await act(async () => hook.result.current.cancel());
    expect(hook.result.current.phase).toBe("cancelling");
    act(() => {
      void hook.result.current.run(request);
    });
    expect(bridge.run).toHaveBeenCalledTimes(1);
    await act(async () =>
      finish({ ...completed, success: false, status: "cancelled" }),
    );
    expect(hook.result.current.phase).toBe("idle");
  });
  it("cancels and discards late project/build responses without releasing the launch latch early", async () => {
    const { bridge, execution } = services();
    let finish!: (value: OptimizationRunResult) => void;
    vi.mocked(bridge.run).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const hook = renderHook(
      ({ project }) =>
        useOptimization(bridge, execution, project, "build-a", true),
      { initialProps: { project: "project-a" } },
    );
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    act(() => {
      void hook.result.current.run(request);
    });
    hook.rerender({ project: "project-b" });
    expect(bridge.cancel).toHaveBeenCalled();
    act(() => {
      void hook.result.current.run(request);
    });
    expect(bridge.run).toHaveBeenCalledTimes(1);
    await act(async () => finish(completed));
    expect(hook.result.current.result).toBeNull();
    expect(hook.result.current.lastGood).toBeNull();
  });
  it("preserves the previous successful attempt after an honest failure", async () => {
    const { bridge, execution } = services();
    const hook = renderHook(() =>
      useOptimization(bridge, execution, "project-a", "build-a", true),
    );
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.run(request));
    vi.mocked(bridge.run).mockResolvedValue({
      ...completed,
      runId: "synthetic-failure",
      success: false,
      status: "failed",
    });
    await act(async () => hook.result.current.run(request));
    expect(hook.result.current.result?.success).toBe(false);
    expect(hook.result.current.lastGood?.runId).toBe(completed.runId);
  });
  it("rejects foreign restored evidence and refreshes only on stage activation", async () => {
    const { bridge, execution } = services();
    vi.mocked(bridge.lastGoodResult).mockResolvedValue({
      ...completed,
      projectRoot: "foreign",
    });
    const hook = renderHook(
      ({ active }) =>
        useOptimization(bridge, execution, "project-a", "build-a", active),
      { initialProps: { active: false } },
    );
    expect(bridge.lastGoodResult).not.toHaveBeenCalled();
    hook.rerender({ active: true });
    await waitFor(() =>
      expect(hook.result.current.error).toContain("another project"),
    );
    expect(hook.result.current.result).toBeNull();
  });
});
