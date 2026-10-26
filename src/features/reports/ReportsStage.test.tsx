import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReportsBridge, SelectedReport } from "@/lib/reports-contract";
import { ReportsStage, formatReportMetric } from "./ReportsStage";

// Synthetic DI evidence only: no engine execution or broker parity is claimed by these tests.
const source: SelectedReport = {
  projectRoot: "project-a",
  runId: "run-synthetic",
  reportSha256: "a".repeat(64),
  reportJsonPath: "runs/run-synthetic/report.json",
  buildRevision: "revision-a",
  datasetId: "dataset-a",
  completedAt: "2026-10-24T10:00:00Z",
  strategy: "Example strategy",
  symbol: "EURUSD",
  timeframe: "M1",
  accountCurrency: "EUR",
  nativeDrawdownMethod: "ctrader-price-extremes-and-deals-v1",
  closedTradeCount: 1,
  metrics: [
    { label: "Closing balance", value: 12.5, unit: "money" },
    { label: "Profit factor", value: null, unit: "ratio" },
    { label: "Full replay equity drawdown", value: 4, unit: "%" },
    { label: "Native price-extremes equity drawdown", value: 3, unit: "%" },
  ],
};

/** Provide a small injected bridge whose synthetic source is explicit and deterministic. */
function bridge(overrides: Partial<ReportsBridge> = {}): ReportsBridge {
  return {
    native: true,
    selected: vi.fn().mockResolvedValue(source),
    exportSaved: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("Reports saved-source presentation (synthetic DI)", () => {
  it("refreshes newly selected runs when the retained stage becomes active", async () => {
    const selected = vi
      .fn()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ ...source, runId: "new-synthetic-run" });
    const native = bridge({ selected });
    const view = render(
      <ReportsStage bridge={native} projectRoot="project-a" active={false} />,
    );
    expect(selected).not.toHaveBeenCalled();
    view.rerender(
      <ReportsStage bridge={native} projectRoot="project-a" active />,
    );
    await screen.findByText(source.runId);
    view.rerender(
      <ReportsStage bridge={native} projectRoot="project-a" active={false} />,
    );
    view.rerender(
      <ReportsStage bridge={native} projectRoot="project-a" active />,
    );
    expect(await screen.findByText("new-synthetic-run")).toBeInTheDocument();
    expect(selected).toHaveBeenCalledTimes(2);
  });

  it("shows the exact source identity, currency, undefined values and distinct drawdown methods", async () => {
    render(<ReportsStage bridge={bridge()} projectRoot="project-a" />);
    expect(await screen.findByText(source.reportSha256)).toBeInTheDocument();
    expect(screen.getByText("12.5 EUR")).toBeInTheDocument();
    expect(screen.getByText("n/a")).toBeInTheDocument();
    expect(screen.getByText("Full replay equity drawdown")).toBeInTheDocument();
    expect(
      screen.getByText("Native price-extremes equity drawdown"),
    ).toBeInTheDocument();
  });

  it("exports reviewed run/hash through the injected native save action and reports cancellation", async () => {
    const native = bridge();
    render(<ReportsStage bridge={native} projectRoot="project-a" />);
    const exportButton = await screen.findByRole("button", {
      name: "Export original JSON",
    });
    await userEvent.click(exportButton);
    expect(native.exportSaved).toHaveBeenCalledWith(
      "project-a",
      source.runId,
      source.reportSha256,
      "json",
    );
    expect(
      await screen.findByText("Export canceled. No file was written."),
    ).toBeInTheDocument();
  });

  it("shows native export failures and permits retry without pretending a file was saved", async () => {
    const native = bridge({
      exportSaved: vi
        .fn()
        .mockRejectedValue(
          "The destination already exists. Choose a new filename.",
        ),
    });
    render(<ReportsStage bridge={native} projectRoot="project-a" />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Export HTML report" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "destination already exists",
    );
    expect(
      screen.getByRole("button", { name: "Export HTML report" }),
    ).toBeEnabled();
    expect(screen.queryByText(/^Saved .*\.html$/)).not.toBeInTheDocument();
  });

  it("handles empty native and browser states honestly", async () => {
    render(
      <ReportsStage
        bridge={bridge({
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
      screen.getByText(/Browser preview has no saved engine evidence/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Export HTML report" }),
    ).not.toBeInTheDocument();
  });

  it("rejects foreign project evidence and removes exports", async () => {
    render(
      <ReportsStage
        bridge={bridge({
          selected: vi
            .fn()
            .mockResolvedValue({ ...source, projectRoot: "project-b" }),
        })}
        projectRoot="project-a"
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "another project",
    );
    expect(screen.queryByText(source.reportSha256)).not.toBeInTheDocument();
  });

  it("ignores a late old-project selection while a new project is active", async () => {
    let finish: (value: SelectedReport | null) => void = () => {};
    const pending = new Promise<SelectedReport | null>((resolve) => {
      finish = resolve;
    });
    const native = bridge({
      selected: vi
        .fn()
        .mockImplementation((project: string) =>
          project === "project-a" ? pending : Promise.resolve(null),
        ),
    });
    const view = render(
      <ReportsStage bridge={native} projectRoot="project-a" />,
    );
    expect(screen.getByText(/Reading saved run/)).toBeInTheDocument();
    view.rerender(<ReportsStage bridge={native} projectRoot="project-b" />);
    await screen.findByText(/Complete a successful backtest/);
    await act(async () => finish(source));
    expect(screen.queryByText(source.reportSha256)).not.toBeInTheDocument();
  });

  it("blocks duplicate exports while the native dialog is pending", async () => {
    let finish: () => void = () => {};
    const pending = new Promise<null>((resolve) => {
      finish = () => resolve(null);
    });
    render(
      <ReportsStage
        bridge={bridge({ exportSaved: vi.fn().mockReturnValue(pending) })}
        projectRoot="project-a"
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Export closed trades CSV" }),
    );
    expect(
      screen.getByRole("button", { name: "Export HTML report" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Refresh saved run" }),
    ).toBeDisabled();
    await act(async () => finish());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Export HTML report" }),
      ).toBeEnabled(),
    );
  });
});

it("never formats non-finite or unavailable source money as a zero or assumed dollars", () => {
  expect(
    formatReportMetric({ label: "Balance", value: NaN, unit: "money" }, "USD"),
  ).toBe("n/a");
  expect(
    formatReportMetric({ label: "Balance", value: 3, unit: "money" }, null),
  ).toBe("3 (currency n/a)");
});
