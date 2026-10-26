import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReportsBridge, SelectedReport } from "@/lib/reports-contract";
import type { SavedRunSelection } from "@/lib/saved-runs-contract";
import { ReportsStage } from "./ReportsStage";
import {
  historyPage,
  historyReport,
  historyRow,
  historySelection,
  syntheticHistoryBridge,
} from "./saved-runs.test-support";

describe("Reports history interactions (synthetic DI only)", () => {
  it("opens a recorded row by keyboard then refreshes the exact selected report", async () => {
    let selected: SelectedReport | null = null;
    const onSavedRunSelected = vi.fn();
    const reportBridge: ReportsBridge = {
      native: true,
      selected: vi.fn(async () => selected),
      exportSaved: vi.fn(),
    };
    const select = vi.fn(async () => {
      selected = historyReport;
      return historySelection;
    });
    render(
      <ReportsStage
        bridge={reportBridge}
        historyBridge={syntheticHistoryBridge({ select })}
        projectRoot="project-a"
        onSavedRunSelected={onSavedRunSelected}
      />,
    );
    const button = await screen.findByRole("button", {
      name: `Verify and open run ${historyRow.runId}`,
    });
    await waitFor(() => expect(button).toBeEnabled());
    expect(
      screen.queryByRole("button", { name: "Export original JSON" }),
    ).not.toBeInTheDocument();
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText(historyReport.reportSha256)).toBeVisible();
    expect(select).toHaveBeenCalledWith(
      "project-a",
      historyRow.runId,
      historyRow.completionSha256,
    );
    expect(onSavedRunSelected).toHaveBeenCalledWith(historySelection);
    expect(screen.getByText("Selected", { exact: true })).toBeVisible();
  });

  it("disables every history and export action while verification is pending", async () => {
    let finish: (value: SavedRunSelection) => void = () => {};
    const pending = new Promise<SavedRunSelection>((resolve) => {
      finish = resolve;
    });
    const reportBridge: ReportsBridge = {
      native: true,
      selected: async () => historyReport,
      exportSaved: vi.fn(),
    };
    render(
      <ReportsStage
        bridge={reportBridge}
        historyBridge={syntheticHistoryBridge({ select: () => pending })}
        projectRoot="project-a"
      />,
    );
    const button = await screen.findByRole("button", {
      name: `Verify and open run ${historyRow.runId}`,
    });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(
      screen.getByRole("button", { name: "Refresh history" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Export original JSON" }),
    ).toBeDisabled();
    expect(screen.getByText(/Verifying the selected run/)).toBeVisible();
    await act(async () => finish(historySelection));
  });

  it("discloses unreadable entries without attributing unassigned files to this project", async () => {
    render(
      <ReportsStage
        bridge={{
          native: true,
          selected: async () => null,
          exportSaved: vi.fn(),
        }}
        historyBridge={syntheticHistoryBridge({
          list: async () => ({
            ...historyPage,
            rows: [],
            unassignedEntries: 2,
            issues: [{ runId: null, message: "Unreadable entry preserved." }],
            additionalIssueCount: 3,
          }),
        })}
        projectRoot="project-a"
      />,
    );
    expect(
      await screen.findByText(/No recorded runs in this page/),
    ).toBeVisible();
    await userEvent.click(
      screen.getByText("Some stored entries could not be listed"),
    );
    expect(screen.getByText(/not attributed to this project: 2/)).toBeVisible();
    expect(screen.getByText("Unreadable entry preserved.")).toBeVisible();
    expect(screen.getByText(/3 additional issues/)).toBeVisible();
  });
});
