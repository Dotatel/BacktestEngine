import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionBridge, ExecutionRunResult } from "@/lib/execution";
import type { WorkspaceParametersController } from "@/features/workspace/hooks/useWorkspaceParameters";
import {
  dataset,
  spec,
  strategy,
  build,
  successResult,
} from "../../../tests/fixtures/backtest";
import { BacktestStage } from "./BacktestStage";
import { historySelection } from "@/features/reports/saved-runs.test-support";

vi.mock("@/lib/execution", async () => ({
  ...(await vi.importActual<typeof import("@/lib/execution")>(
    "@/lib/execution",
  )),
  pickHistoricalCsv: vi.fn().mockResolvedValue("C:/data.csv"),
  pickSymbolSpec: vi.fn().mockResolvedValue("C:/spec.json"),
}));

const parameters: WorkspaceParametersController = {
  strategies: [strategy],
  activeStrategy: strategy,
  values: { HoldTicks: 100 },
  invalidNames: [],
  presets: [],
  message: "",
  messageTone: "info",
  selectStrategy: vi.fn(),
  setValue: vi.fn(),
  resetDefaults: vi.fn(),
  loadPreset: vi.fn(),
  savePreset: vi.fn(),
  clearMessage: vi.fn(),
};

/** Inject synthetic evidence only at the component boundary; never impersonate a native compiler. */
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

/** Launch the injected component after its catalog finishes loading. */
async function runBacktest() {
  const button = screen.getByRole("button", { name: "Run backtest" });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  await screen.findByText(/Completed run/);
}

describe("BacktestStage presentation with injected fixtures", () => {
  it("labels a selected historical run previous and shows its exact saved inputs separately from controls", async () => {
    render(
      <BacktestStage
        bridge={createBridge()}
        build={build}
        stale={false}
        parameters={parameters}
        projectRoot="project-a"
        savedSelection={historySelection}
      />,
    );
    expect(await screen.findByText(/Previous run metrics/)).toBeVisible();
    await userEvent.click(screen.getByText("Run inputs and provenance"));
    expect(
      screen.getByText("Saved run selected. Current controls are unchanged."),
    ).toBeVisible();
    expect(screen.getByText(/capital 1,000/)).toBeVisible();
    expect(screen.getByText(/commission profile default/)).toBeVisible();
    expect(screen.getByLabelText("Capital")).toHaveValue(10000);
    expect(
      screen.queryByText(/Original launch inputs are unavailable/),
    ).not.toBeInTheDocument();
  });
  it("keeps the strategy left, market inputs above the chart, and missing prices honest", async () => {
    render(
      <BacktestStage
        bridge={createBridge()}
        build={null}
        stale={false}
        parameters={parameters}
      />,
    );
    expect(await screen.findByText(/No backtest result yet/)).toBeVisible();
    expect(
      screen.getByText(/Build a successful strategy before/),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Price chart unavailable" }),
    ).toBeVisible();
    const sidebar = screen.getByRole("complementary", {
      name: "Strategy parameters",
    });
    expect(within(sidebar).queryByLabelText("Capital")).toBeNull();
    expect(
      screen.getByLabelText("Capital").closest(".execution-inputs"),
    ).not.toBeNull();
    expect(screen.getByLabelText("End UTC (exclusive)")).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(
      screen.getByRole("button", { name: "Export trades" }),
    ).toBeDisabled();
  });

  it("blocks stale builds and browsers even when fixture catalogs are injected", async () => {
    const bridge = createBridge({ native: false });
    render(
      <BacktestStage
        bridge={bridge}
        build={build}
        stale
        parameters={parameters}
      />,
    );
    expect(screen.getByRole("button", { name: "Run backtest" })).toBeDisabled();
    expect(screen.getByText(/current build is stale/)).toBeVisible();
    expect(bridge.listDatasets).not.toHaveBeenCalled();
  });

  it("shows one run across all result tabs and preserves undefined metrics", async () => {
    render(
      <BacktestStage
        bridge={createBridge()}
        build={build}
        stale={false}
        parameters={parameters}
      />,
    );
    await runBacktest();
    expect(screen.getAllByText(/run-1/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("n/a").length).toBeGreaterThan(0);
    expect(screen.getByRole("table")).toHaveAccessibleName(/run-1/);
    expect(screen.getByText("Buy")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect trade trade-1" }),
    );
    expect(screen.getByText(/TakeProfit/)).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Statistics" }));
    expect(screen.getByText("Final marked equity")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Equity curve" }));
    expect(
      screen.getByRole("img", { name: "Equity and balance" }),
    ).toBeVisible();
    expect(screen.getByText(/2 of 2 samples/)).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Drawdown" }));
    expect(
      screen.getByRole("img", { name: "Sampled equity drawdown" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(screen.getByText(/Run run-1 · completed/)).toBeVisible();
  });

  it("marks a result previous after external parameters change and retains frozen inputs", async () => {
    const bridge = createBridge();
    const { rerender } = render(
      <BacktestStage
        bridge={bridge}
        build={build}
        stale={false}
        parameters={parameters}
      />,
    );
    await runBacktest();
    rerender(
      <BacktestStage
        bridge={bridge}
        build={build}
        stale={false}
        parameters={{ ...parameters, values: { HoldTicks: 200 } }}
      />,
    );
    expect(await screen.findByText("Previous run")).toBeVisible();
    await userEvent.click(screen.getByText("Run inputs and provenance"));
    expect(screen.getByText(/HoldTicks = 100/)).toBeVisible();
    expect(screen.queryByText(/HoldTicks = 200/)).toBeNull();
  });

  it("freezes inputs and ignores a cancelled run's late success", async () => {
    let resolveRun: (value: ExecutionRunResult) => void = () => {};
    const bridge = createBridge({
      run: vi.fn(
        () =>
          new Promise<ExecutionRunResult>((resolve) => {
            resolveRun = resolve;
          }),
      ),
    });
    render(
      <BacktestStage
        bridge={bridge}
        build={build}
        stale={false}
        parameters={parameters}
      />,
    );
    const button = screen.getByRole("button", { name: "Run backtest" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(screen.getByLabelText("Capital")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reset parameters" }),
    ).toBeDisabled();
    expect(screen.getByText("Current backtest · frozen inputs")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => resolveRun(successResult));
    expect(await screen.findByText(/Backtest canceled/)).toBeVisible();
    expect(screen.queryByText(/Completed run/)).toBeNull();
  });

  it("discloses explicit cost units and reports import failures in the open data dialog", async () => {
    const bridge = createBridge({
      importHistoricalCsv: vi
        .fn()
        .mockRejectedValue(new Error("Import failed.")),
    });
    render(
      <BacktestStage
        bridge={bridge}
        build={build}
        stale={false}
        parameters={parameters}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Costs" }));
    expect(
      screen.getByLabelText("Commission (USD per million units)"),
    ).toBeVisible();
    expect(screen.getByLabelText("Slippage (pips per fill)")).toBeVisible();
    expect(screen.getByText(/Fixed spread replaces it/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      screen.getByRole("button", { name: "Data settings" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Import historical CSV" }),
    );
    expect(
      await within(screen.getByRole("dialog")).findByRole("alert"),
    ).toHaveTextContent("Import failed.");
  });
});
