import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppExtension, ExtensionsBridge } from "@/lib/extensions-contract";
import type { ReportsBridge, SelectedReport } from "@/lib/reports-contract";
import {
  reportTools,
  isolatedExtension,
  extensionReport,
} from "../../../tests/fixtures/app-settings";
import { ExtensionsDialog } from "./ExtensionsDialog";

/** Inject only manifest metadata and saved-run identity; no native code or live files execute. */
function bridges(source: SelectedReport | null = extensionReport) {
  let entries = structuredClone([reportTools, isolatedExtension]);
  const extensions: ExtensionsBridge = {
    native: true,
    list: vi.fn(async () => entries),
    importFolder: vi.fn().mockResolvedValue(null),
    setEnabled: vi.fn(async (id, _hash, enabled) => {
      entries = entries.map((entry) =>
        entry.id === id ? { ...entry, enabled } : entry,
      );
      return entries;
    }),
    exportReport: vi.fn().mockResolvedValue(null),
  };
  const reports: ReportsBridge = {
    native: true,
    selected: vi.fn().mockResolvedValue(source),
    exportSaved: vi.fn().mockResolvedValue(null),
  };
  return { extensions, reports };
}

/** Render the actual dialog with deterministic synthetic registry bridges. */
function mount(
  extensions: ExtensionsBridge,
  reports: ReportsBridge,
  projectRoot: string | null = extensionReport.projectRoot,
) {
  return render(
    <ExtensionsDialog
      bridge={extensions}
      reportsBridge={reports}
      projectRoot={projectRoot}
      trigger={<button>Open extensions</button>}
    />,
  );
}

describe("Experimental declarative extensions (synthetic DI)", () => {
  it("isolates a broken entry, starts disabled and exports only the reviewed enabled manifest/run/hash", async () => {
    const { extensions, reports } = bridges();
    mount(extensions, reports);
    expect(extensions.list).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Open extensions" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "imported manifest changed",
    );
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(extensions.setEnabled).toHaveBeenCalledWith(
      reportTools.id,
      reportTools.manifestSha256,
      true,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Export JSON" }),
    );
    expect(extensions.exportReport).toHaveBeenCalledWith(
      { ...reportTools, enabled: true },
      "report.export-json",
      extensionReport,
    );
    expect(
      await screen.findByText("Export canceled. No file was written."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeDisabled();
  });

  it("requires a saved report, treats picker cancellation honestly and can disable isolated registration", async () => {
    const { extensions, reports } = bridges(null);
    mount(extensions, reports);
    await userEvent.click(
      screen.getByRole("button", { name: "Open extensions" }),
    );
    await screen.findByRole("button", { name: "Enable" });
    await userEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Import folder" }),
    );
    expect(
      await screen.findByText("Import canceled. No extension was added."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Imported .*Review/)).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Disable registration" }),
    );
    expect(extensions.setEnabled).toHaveBeenLastCalledWith(
      isolatedExtension.id,
      null,
      false,
    );
    expect(extensions.exportReport).not.toHaveBeenCalled();
  });

  it("displays native tamper failures without claiming a saved export and rejects mismatched receipts", async () => {
    const { extensions, reports } = bridges();
    extensions.list = vi
      .fn()
      .mockResolvedValue([{ ...reportTools, enabled: true }]);
    extensions.exportReport = vi
      .fn()
      .mockRejectedValueOnce("Manifest changed while the save dialog was open.")
      .mockResolvedValueOnce({
        path: "C:/Synthetic UI fixture/wrong.json",
        runId: "another-run",
        reportSha256: extensionReport.reportSha256,
      });
    mount(extensions, reports);
    await userEvent.click(
      screen.getByRole("button", { name: "Open extensions" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Export JSON" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Manifest changed",
    );
    await userEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "does not match the reviewed run",
    );
    expect(screen.queryByText(/^Saved C:/)).not.toBeInTheDocument();
  });

  it("ignores a late registry/report response from a previous project", async () => {
    const { extensions, reports } = bridges();
    let finish: (value: AppExtension[]) => void = () => {};
    extensions.list = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<AppExtension[]>((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce([]);
    const view = mount(extensions, reports);
    await userEvent.click(
      screen.getByRole("button", { name: "Open extensions" }),
    );
    view.rerender(
      <ExtensionsDialog
        bridge={extensions}
        reportsBridge={reports}
        projectRoot="another-project"
        trigger={<button>Open extensions</button>}
      />,
    );
    await waitFor(() => expect(extensions.list).toHaveBeenCalledTimes(2));
    await act(async () => finish([reportTools]));
    expect(
      screen.queryByRole("article", { name: reportTools.name }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(extensionReport.runId)).not.toBeInTheDocument();
  });

  it("shows an unsupported manifest import error without adding or enabling an extension", async () => {
    const { extensions, reports } = bridges();
    extensions.importFolder = vi
      .fn()
      .mockRejectedValue(
        "Only the declarative commands permission is supported; filesystem and network grants are unavailable.",
      );
    mount(extensions, reports);
    await userEvent.click(
      screen.getByRole("button", { name: "Open extensions" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Import folder" }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Import folder" }),
    );
    expect(
      await screen.findByText(/Only the declarative commands permission/),
    ).toBeInTheDocument();
    expect(extensions.setEnabled).not.toHaveBeenCalled();
    expect(extensions.exportReport).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/^Imported .*Review its commands/),
    ).not.toBeInTheDocument();
  });
});
