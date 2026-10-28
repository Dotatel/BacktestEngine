import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppExtension,
  ExampleExtensionId,
  ExtensionsBridge,
} from "@/lib/extensions-contract";
import type { ReportsBridge, SelectedReport } from "@/lib/reports-contract";
import {
  reportTools,
  isolatedExtension,
  extensionReport,
} from "../../../tests/fixtures/app-settings";
import { ExtensionsPage } from "./ExtensionsPage";

// jsdom omits the pointer-capture APIs used by standard Radix Select interactions.
beforeAll(() => {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
});

/** The global jsdom default matches every media query; explicitly model this page's viewport instead. */
function mockCompactViewport(compact: boolean) {
  vi.mocked(window.matchMedia).mockImplementation((query) => ({
    matches: query.includes("max-width") ? compact : true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(true),
  }));
}

beforeEach(() => mockCompactViewport(false));

/** Model one successful native example installation as a disabled reviewed manifest. */
function installedExample(id: ExampleExtensionId): AppExtension {
  const names = {
    "report-tools": "Report tools",
    "trade-ledger-export": "Trade ledger export",
    "html-reports": "HTML reports",
  };
  return {
    ...structuredClone(reportTools),
    id,
    name: names[id],
    enabled: false,
  };
}

/** Inject only manifest metadata and saved-run identity; no native code or live files execute. */
function bridges(source: SelectedReport | null = extensionReport) {
  let entries = structuredClone([reportTools, isolatedExtension]);
  const extensions: ExtensionsBridge = {
    native: true,
    list: vi.fn(async () => entries),
    importFolder: vi.fn().mockResolvedValue(null),
    installExample: vi.fn(async (id) => {
      const entry = installedExample(id);
      entries = [...entries, entry];
      return entry;
    }),
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

/** Render the real page with deterministic registry and navigation boundaries. */
function mount(
  extensions: ExtensionsBridge,
  reports: ReportsBridge,
  projectRoot: string | null = extensionReport.projectRoot,
) {
  const callbacks = {
    onClose: vi.fn(),
    onGoToReports: vi.fn(),
    onOpenAssistant: vi.fn(),
  };
  return {
    ...render(
      <ExtensionsPage
        bridge={extensions}
        reportsBridge={reports}
        projectRoot={projectRoot}
        {...callbacks}
      />,
    ),
    ...callbacks,
  };
}

/** Open only when needed, retaining separate scopes for compact-card actions and the right inspector. */
async function selectEntry(name: string) {
  const toggle = await screen.findByRole("button", { name: `View ${name}` });
  if (toggle.getAttribute("aria-expanded") !== "true")
    await userEvent.click(toggle);
  return {
    card: within(screen.getByRole("article", { name })),
    details: within(screen.getByRole("region", { name: "Extension details" })),
  };
}

describe("Full-page declarative extensions (synthetic DI)", () => {
  it("starts collapsed and exposes the card context while its trigger toggles by pointer and keyboard", async () => {
    const { extensions, reports } = bridges();
    mount(extensions, reports);
    await waitFor(() => expect(extensions.list).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    const card = screen.getByRole("article", { name: reportTools.name });
    const toggle = within(card).getByRole("button", {
      name: `View ${reportTools.name}`,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    expect(toggle).toHaveAccessibleDescription(
      /Installed locally.*1\.0\.0.*Declarative report commands/,
    );
    await userEvent.click(toggle);
    const details = screen.getByRole("region", {
      name: "Extension details",
    });
    expect(details).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(
      details,
    );
    expect(card).not.toContainElement(details);
    await userEvent.click(toggle);
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    expect(card.querySelector("button button")).toBeNull();
  });

  it("closes the right inspector with Close and Escape and restores the selected card trigger focus", async () => {
    const { extensions, reports } = bridges();
    mount(extensions, reports);
    await waitFor(() => expect(extensions.list).toHaveBeenCalledOnce());
    const toggle = screen.getByRole("button", { name: "View Report tools" });
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveFocus();
    expect(
      screen.getByRole("region", { name: "Extension details" }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Close extension details" }),
    );
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    screen.getByRole("button", { name: "Close extension details" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it("moves focus into the compact right overlay and restores its opener after Escape", async () => {
    mockCompactViewport(true);
    const { extensions, reports } = bridges();
    mount(extensions, reports);
    await waitFor(() => expect(extensions.list).toHaveBeenCalledOnce());
    const toggle = screen.getByRole("button", { name: "View Report tools" });
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    const close = screen.getByRole("button", {
      name: "Close extension details",
    });
    expect(close).toHaveFocus();
    const page = screen.getByRole("region", { name: "App extensions" });
    expect(page.querySelector(".extensions-main")).toHaveAttribute("inert");
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(page.querySelector(".extensions-main")).not.toHaveAttribute("inert");
  });

  it("keeps compact export errors and cancellation in the active inspector without duplicate live feedback", async () => {
    mockCompactViewport(true);
    const { extensions, reports } = bridges();
    extensions.list = vi
      .fn()
      .mockResolvedValue([{ ...reportTools, enabled: true }]);
    extensions.exportReport = vi
      .fn()
      .mockRejectedValueOnce("Native export failure.")
      .mockResolvedValueOnce(null);
    mount(extensions, reports);
    const { details } = await selectEntry(reportTools.name);
    const inspector = screen.getByRole("complementary", {
      name: "Extension inspector",
    });
    const main = document.querySelector(".extensions-main")!;
    const exportJson = details.getByRole("button", { name: "Export JSON" });
    await waitFor(() => expect(exportJson).toBeEnabled());
    await userEvent.click(exportJson);
    expect(await within(inspector).findByRole("alert")).toHaveTextContent(
      "Native export failure.",
    );
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(main.querySelector('[role="alert"]')).toBeNull();
    await userEvent.click(exportJson);
    expect(await within(inspector).findByRole("status")).toHaveTextContent(
      "Export canceled. No file was written.",
    );
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(main.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await userEvent.click(
      within(inspector).getByRole("button", {
        name: "Close extension details",
      }),
    );
    expect(inspector).not.toBeInTheDocument();
    expect(within(main as HTMLElement).getByRole("status")).toHaveTextContent(
      "Export canceled. No file was written.",
    );
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("runs Install, Activate and Disable directly without expanding a collapsed card", async () => {
    const { extensions, reports } = bridges();
    mount(extensions, reports);
    const card = within(
      await screen.findByRole("article", { name: "Trade ledger export" }),
    );
    await waitFor(() =>
      expect(card.getByRole("button", { name: "Install" })).toBeEnabled(),
    );
    await userEvent.click(card.getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(card.getByRole("button", { name: "Activate" })).toBeEnabled(),
    );
    expect(extensions.installExample).toHaveBeenCalledOnce();
    expect(extensions.setEnabled).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    await userEvent.click(card.getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(card.getByRole("button", { name: "Disable" })).toBeEnabled(),
    );
    expect(extensions.setEnabled).toHaveBeenLastCalledWith(
      "trade-ledger-export",
      reportTools.manifestSha256,
      true,
    );
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    await userEvent.click(card.getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(card.getByRole("button", { name: "Activate" })).toBeEnabled(),
    );
    expect(extensions.setEnabled).toHaveBeenLastCalledWith(
      "trade-ledger-export",
      reportTools.manifestSha256,
      false,
    );
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
  });

  it("opens only the clicked card and clears expansion when search, category or state changes", async () => {
    const { extensions, reports } = bridges();
    mount(extensions, reports);
    await waitFor(() => expect(extensions.list).toHaveBeenCalledOnce());
    await selectEntry("Report tools");
    await selectEntry("Claude");
    expect(
      screen.getAllByRole("region", { name: "Extension details" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "View Report tools" }),
    ).toHaveAttribute("aria-expanded", "false");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Search extensions" }),
      "claude",
    );
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    await selectEntry("Claude");
    await userEvent.click(screen.getByRole("button", { name: "Assistants" }));
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
    await userEvent.clear(
      screen.getByRole("textbox", { name: "Search extensions" }),
    );
    await selectEntry("ChatGPT");
    await userEvent.click(
      screen.getByRole("combobox", { name: "Extension state" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Available" }));
    expect(
      screen.queryByRole("region", { name: "Extension details" }),
    ).not.toBeInTheDocument();
  });

  it("isolates a broken entry, starts disabled and exports only the reviewed enabled manifest/run/hash", async () => {
    const { extensions, reports } = bridges();
    mount(extensions, reports);
    await waitFor(() => expect(extensions.list).toHaveBeenCalledOnce());
    expect(extensions.installExample).not.toHaveBeenCalled();
    expect(extensions.importFolder).not.toHaveBeenCalled();
    const { card, details } = await selectEntry(reportTools.name);
    expect(details.getByRole("button", { name: "Export JSON" })).toBeDisabled();
    await userEvent.click(card.getByRole("button", { name: "Activate" }));
    expect(extensions.setEnabled).toHaveBeenCalledWith(
      reportTools.id,
      reportTools.manifestSha256,
      true,
    );
    await waitFor(() =>
      expect(
        details.getByRole("button", { name: "Export JSON" }),
      ).toBeEnabled(),
    );
    await userEvent.click(details.getByRole("button", { name: "Export JSON" }));
    expect(extensions.exportReport).toHaveBeenCalledWith(
      { ...reportTools, enabled: true },
      "report.export-json",
      extensionReport,
    );
    expect(
      await screen.findByText("Export canceled. No file was written."),
    ).toBeInTheDocument();
    await userEvent.click(card.getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(
        details.getByRole("button", { name: "Export JSON" }),
      ).toBeDisabled(),
    );
    await selectEntry(isolatedExtension.name);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "imported manifest changed",
    );
  });

  it("requires a saved report, treats picker cancellation honestly and can disable isolated registration", async () => {
    const { extensions, reports } = bridges(null);
    mount(extensions, reports);
    const { card, details } = await selectEntry(reportTools.name);
    await userEvent.click(
      await card.findByRole("button", { name: "Activate" }),
    );
    expect(details.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Import folder" }),
    );
    expect(
      await screen.findByText("Import canceled. No extension was added."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Imported .*Review/)).not.toBeInTheDocument();
    await selectEntry(isolatedExtension.name);
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
    const { card, details } = await selectEntry(reportTools.name);
    await waitFor(() =>
      expect(
        details.getByRole("button", { name: "Export JSON" }),
      ).toBeEnabled(),
    );
    await userEvent.click(details.getByRole("button", { name: "Export JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Manifest changed",
    );
    await userEvent.click(details.getByRole("button", { name: "Export JSON" }));
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
    await waitFor(() => expect(extensions.list).toHaveBeenCalledOnce());
    view.rerender(
      <ExtensionsPage
        bridge={extensions}
        reportsBridge={reports}
        projectRoot="another-project"
        onClose={view.onClose}
        onGoToReports={view.onGoToReports}
        onOpenAssistant={view.onOpenAssistant}
      />,
    );
    await waitFor(() => expect(extensions.list).toHaveBeenCalledTimes(2));
    await act(async () => finish([reportTools]));
    const { card, details } = await selectEntry(reportTools.name);
    expect(card.getByRole("button", { name: "Install" })).toBeEnabled();
    expect(
      card.queryByRole("button", { name: "Activate" }),
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

  it("installs a bundled example only after a click, then requires explicit enablement", async () => {
    const { extensions, reports } = bridges();
    mount(extensions, reports);
    const { card, details } = await selectEntry("Trade ledger export");
    expect(extensions.installExample).not.toHaveBeenCalled();
    await userEvent.click(card.getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(extensions.installExample).toHaveBeenCalledWith(
        "trade-ledger-export",
      ),
    );
    await waitFor(() =>
      expect(card.getByRole("button", { name: "Activate" })).toBeEnabled(),
    );
    expect(extensions.setEnabled).not.toHaveBeenCalled();
    expect(details.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    await userEvent.click(card.getByRole("button", { name: "Activate" }));
    expect(extensions.setEnabled).toHaveBeenCalledWith(
      "trade-ledger-export",
      reportTools.manifestSha256,
      true,
    );
    expect(
      screen.getAllByRole("article", { name: "Trade ledger export" }),
    ).toHaveLength(1);
  });

  it("searches and filters examples without installing or connecting assistant previews", async () => {
    const { extensions, reports } = bridges();
    const callbacks = mount(extensions, reports);
    await waitFor(() => expect(extensions.list).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Assistants" }));
    await selectEntry("Claude");
    expect(
      screen.getByRole("region", { name: "Extension details" }),
    ).toHaveTextContent(/Preview only/i);
    expect(
      screen.queryByRole("button", { name: "Install" }),
    ).not.toBeInTheDocument();
    await selectEntry("ChatGPT");
    expect(
      screen.getByRole("region", { name: "Extension details" }),
    ).toHaveTextContent(/Preview only/i);
    await selectEntry("OpenCode");
    expect(callbacks.onOpenAssistant).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Open assistant" }),
    );
    expect(callbacks.onOpenAssistant).toHaveBeenCalledOnce();
    expect(extensions.installExample).not.toHaveBeenCalled();
    expect(extensions.setEnabled).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "All extensions" }),
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Search extensions" }),
      "html",
    );
    expect(
      screen.getByRole("article", { name: "HTML reports" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("article", { name: "Claude" }),
    ).not.toBeInTheDocument();
    await userEvent.clear(
      screen.getByRole("textbox", { name: "Search extensions" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Back to workspace" }),
    );
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });
});
