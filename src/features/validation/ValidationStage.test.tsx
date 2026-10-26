import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReportsBridge, SelectedReport } from "@/lib/reports-contract";
import type {
  ValidationBridge,
  ValidationRunResult,
} from "@/lib/validation-contract";
import { ValidationStage } from "./ValidationStage";
import {
  defaultValidationForm,
  invalidValidationFields,
  validationRequest,
} from "./validation-form";

// Explicit synthetic DI fixtures: these do not execute Python or establish trading validation.
const source: SelectedReport = {
  projectRoot: "project-a",
  runId: "synthetic-run",
  reportSha256: "a".repeat(64),
  reportJsonPath: "runs/synthetic/report.json",
  buildRevision: "synthetic-build",
  datasetId: "synthetic-data",
  completedAt: "2026-10-24T10:00:00Z",
  strategy: "Synthetic strategy",
  symbol: "EURUSD",
  timeframe: "M1",
  accountCurrency: "EUR",
  nativeDrawdownMethod: null,
  metrics: [],
  closedTradeCount: 4,
};
const completed: ValidationRunResult = {
  validationRunId: "synthetic-validation",
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
  validationDir: "validation/synthetic",
  configPath: "validation/config.json",
  finalVerdictPath: "validation/FinalVerdict.json",
  finalReportPath: "validation/FinalReport.md",
  missingEvidence: [
    "engine_level_latency_stress",
    "walk_forward_embargo_backtests",
  ],
  errors: [],
  output: "Synthetic output",
  lastGoodPreserved: false,
};

/** Inject a deterministic native-like source bridge without filesystem access. */
function reports(overrides: Partial<ReportsBridge> = {}): ReportsBridge {
  return {
    native: true,
    selected: vi.fn().mockResolvedValue(source),
    exportSaved: vi.fn(),
    ...overrides,
  };
}

/** Inject synthetic subprocess results and lifecycle actions, never real engine evidence. */
function bridge(overrides: Partial<ValidationBridge> = {}): ValidationBridge {
  return {
    native: true,
    run: vi.fn().mockResolvedValue(completed),
    cancel: vi.fn().mockResolvedValue(undefined),
    lastGoodResult: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("saved-report Validate stage (synthetic DI)", () => {
  it("submits checked settings and separates completed process from an UNPROVEN verdict", async () => {
    const native = bridge();
    render(
      <ValidationStage
        bridge={native}
        reportsBridge={reports()}
        projectRoot="project-a"
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Run report-only validation" }),
    );
    expect(native.run).toHaveBeenCalledWith(
      validationRequest(source.runId, defaultValidationForm),
    );
    expect(await screen.findByText("UNPROVEN")).toBeInTheDocument();
    expect(screen.getByText("completed", { exact: true })).toBeInTheDocument();
    expect(
      screen.getByText("Engine-level latency stress", { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Walk-forward embargo backtests", { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Process completion does not establish full validation/),
    ).toBeInTheDocument();
    expect(screen.getByText(source.reportSha256)).toBeInTheDocument();
  });

  it("restores only genuine matching native last-good evidence", async () => {
    const native = bridge({
      lastGoodResult: vi.fn().mockResolvedValue(completed),
    });
    render(
      <ValidationStage
        bridge={native}
        reportsBridge={reports()}
        projectRoot="project-a"
      />,
    );
    expect(
      await screen.findByText(completed.validationRunId),
    ).toBeInTheDocument();
    expect(native.run).not.toHaveBeenCalled();
  });

  it("does not upgrade an actual FAIL verdict when the process completed", async () => {
    render(
      <ValidationStage
        bridge={bridge({
          run: vi.fn().mockResolvedValue({ ...completed, verdict: "FAIL" }),
        })}
        reportsBridge={reports()}
        projectRoot="project-a"
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Run report-only validation" }),
    );
    expect(
      await screen.findByText("FAIL", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByText("completed", { exact: true })).toBeInTheDocument();
  });

  it("shows an honest empty browser state with no Python action", async () => {
    const native = bridge({
      native: false,
      lastGoodResult: vi.fn().mockResolvedValue(null),
    });
    render(
      <ValidationStage
        bridge={native}
        reportsBridge={reports({
          native: false,
          selected: vi.fn().mockResolvedValue(null),
        })}
        projectRoot="project-a"
      />,
    );
    expect(
      await screen.findByText(/Complete a successful backtest/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Browser preview contains no validation evidence/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Run report-only validation" }),
    ).not.toBeInTheDocument();
    expect(native.run).not.toHaveBeenCalled();
  });

  it("rejects foreign run/hash evidence instead of showing saved report paths", async () => {
    render(
      <ValidationStage
        bridge={bridge({
          lastGoodResult: vi
            .fn()
            .mockResolvedValue({ ...completed, sourceReportSha256: "foreign" }),
        })}
        reportsBridge={reports()}
        projectRoot="project-a"
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "does not match",
    );
    expect(
      screen.queryByText(completed.finalReportPath),
    ).not.toBeInTheDocument();
  });

  it("marks invalid bounded numeric inputs and prevents launches", async () => {
    const native = bridge();
    render(
      <ValidationStage
        bridge={native}
        reportsBridge={reports()}
        projectRoot="project-a"
      />,
    );
    const input = await screen.findByLabelText("Monte Carlo runs");
    await userEvent.clear(input);
    await userEvent.type(input, "100001");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByRole("button", { name: "Run report-only validation" }),
    ).toBeDisabled();
    expect(native.run).not.toHaveBeenCalled();
  });

  it("blocks duplicate launches and waits for the actual canceled subprocess result", async () => {
    let finish: (result: ValidationRunResult) => void = () => {};
    const pending = new Promise<ValidationRunResult>((resolve) => {
      finish = resolve;
    });
    const native = bridge({ run: vi.fn().mockReturnValue(pending) });
    render(
      <ValidationStage
        bridge={native}
        reportsBridge={reports()}
        projectRoot="project-a"
      />,
    );
    const start = await screen.findByRole("button", {
      name: "Run report-only validation",
    });
    await userEvent.dblClick(start);
    expect(native.run).toHaveBeenCalledTimes(1);
    expect(start).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel validation" }),
    );
    expect(native.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Cancellation requested/)).toBeInTheDocument();
    expect(start).toBeDisabled();
    await act(async () =>
      finish({
        ...completed,
        success: false,
        status: "cancelled",
        verdict: "UNPROVEN",
        errors: ["The process was canceled."],
      }),
    );
    expect(
      await screen.findByText("cancelled", { exact: true }),
    ).toBeInTheDocument();
    await waitFor(() => expect(start).toBeEnabled());
  });

  it("preserves prior completed evidence after a failed attempt", async () => {
    const failed = {
      ...completed,
      validationRunId: "synthetic-failed",
      success: false,
      status: "failed",
      errors: ["Python runtime is unavailable."],
      lastGoodPreserved: true,
    };
    render(
      <ValidationStage
        bridge={bridge({
          lastGoodResult: vi.fn().mockResolvedValue(completed),
          run: vi.fn().mockResolvedValue(failed),
        })}
        reportsBridge={reports()}
        projectRoot="project-a"
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Run report-only validation" }),
    );
    expect(
      await screen.findByText("Previous completed evidence preserved"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Python runtime is unavailable",
    );
  });

  it("ignores old-project results and cancels their pending native job on project change", async () => {
    let finish: (value: ValidationRunResult) => void = () => {};
    const pending = new Promise<ValidationRunResult>((resolve) => {
      finish = resolve;
    });
    const native = bridge({ run: vi.fn().mockReturnValue(pending) });
    const reportBridge = reports({
      selected: vi
        .fn()
        .mockImplementation((project: string) =>
          Promise.resolve(project === "project-a" ? source : null),
        ),
    });
    const view = render(
      <ValidationStage
        bridge={native}
        reportsBridge={reportBridge}
        projectRoot="project-a"
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Run report-only validation" }),
    );
    view.rerender(
      <ValidationStage
        bridge={native}
        reportsBridge={reportBridge}
        projectRoot="project-b"
      />,
    );
    await screen.findByText(/Complete a successful backtest/);
    expect(native.cancel).toHaveBeenCalledTimes(1);
    await act(async () => finish(completed));
    expect(
      screen.queryByText(completed.validationRunId),
    ).not.toBeInTheDocument();
  });

  it("refreshes retained native evidence when the stage becomes active", async () => {
    const native = bridge();
    const reportBridge = reports();
    const view = render(
      <ValidationStage
        bridge={native}
        reportsBridge={reportBridge}
        projectRoot="project-a"
        active={false}
      />,
    );
    expect(reportBridge.selected).not.toHaveBeenCalled();
    view.rerender(
      <ValidationStage
        bridge={native}
        reportsBridge={reportBridge}
        projectRoot="project-a"
        active
      />,
    );
    await screen.findByRole("button", { name: "Run report-only validation" });
    expect(reportBridge.selected).toHaveBeenCalledTimes(1);
  });
});

it("bounds all form fields without accepting missing, nonfinite or fractional integer settings", () => {
  expect(
    invalidValidationFields({
      ...defaultValidationForm,
      seed: "-1",
      minTrades: "1.5",
      minProfitFactor: "NaN",
      monteCarloRuns: "",
    }),
  ).toEqual(["monteCarloRuns", "seed", "minTrades", "minProfitFactor"]);
  expect(() =>
    validationRequest(source.runId, {
      ...defaultValidationForm,
      maxDrawdownPct: "Infinity",
    }),
  ).toThrow("Correct");
});
