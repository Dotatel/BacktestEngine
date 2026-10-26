import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceParametersController } from "@/features/workspace/hooks/useWorkspaceParameters";
import type {
  OptimizationBridge,
  OptimizationRunResult,
} from "@/lib/optimization-contract";
import type { ExecutionBridge } from "@/lib/execution-contract";
import { OptimizeStage } from "./OptimizeStage";

// Synthetic presentation fixtures only, never proof of native numerical behavior.
const parameters = {
  activeStrategy: null,
  values: {},
} as unknown as WorkspaceParametersController;
const execution = {
  native: true,
  listDatasets: vi.fn().mockResolvedValue([]),
  listSymbolSpecs: vi.fn().mockResolvedValue([]),
} as unknown as ExecutionBridge;

/** Minimal injected native-looking bridge isolates evidence rendering and honest empty states. */
function service(
  saved: OptimizationRunResult | null = null,
): OptimizationBridge {
  return {
    native: true,
    run: vi.fn(),
    cancel: vi.fn(),
    lastGoodResult: vi.fn().mockResolvedValue(saved),
  };
}

describe("Optimize stage (synthetic DI)", () => {
  it("explains required inputs and disables launch before a successful current build", async () => {
    render(
      <OptimizeStage
        bridge={service()}
        executionBridge={execution}
        projectRoot="project-a"
        build={null}
        stale={false}
        parameters={parameters}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/Loading imported inputs/),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/Import historical CSV/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Run optimization" }),
    ).toBeDisabled();
  });
  it("never displays failed-candidate metric placeholders as observed zero", async () => {
    const saved = {
      runId: "synthetic",
      projectRoot: "project-a",
      status: "completed",
      exitCode: 2,
      budget: 2,
      method: "grid",
      seed: 42,
      candidates: [
        {
          id: "candidate_000001",
          hash: "0123456789abcdef",
          status: "failed",
          error: "Synthetic runner failed",
          parameters: { Hold: "10" },
          metrics: null,
        },
      ],
      errors: [],
      output: "Synthetic UI fixture only",
    } as unknown as OptimizationRunResult;
    render(
      <OptimizeStage
        bridge={service(saved)}
        executionBridge={execution}
        projectRoot="project-a"
        build={null}
        stale={false}
        parameters={parameters}
      />,
    );
    expect(await screen.findByText("Synthetic runner failed")).toBeVisible();
    const row = screen.getByRole("row", { name: /candidate_000001/ });
    expect(row.textContent).toContain("n/a");
    expect(row.textContent).not.toMatch(/\b999\b/);
    expect(screen.getByText(/does not establish out-of-sample/)).toBeVisible();
  });
  it("browser preview is unavailable and never invokes native restore", () => {
    const bridge = { ...service(), native: false };
    render(
      <OptimizeStage
        bridge={bridge}
        executionBridge={execution}
        projectRoot="project-a"
        build={null}
        stale={false}
        parameters={parameters}
      />,
    );
    expect(
      screen.getByText(/Browser preview produces no candidates/),
    ).toBeVisible();
    expect(bridge.lastGoodResult).not.toHaveBeenCalled();
  });
});
