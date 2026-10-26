import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsBridge, SettingsSnapshot } from "@/lib/settings-contract";
import type { UpdatesBridge } from "@/lib/updates-contract";
import {
  settingsSnapshot,
  unavailableRelease,
} from "../../../tests/fixtures/app-settings";
import { SettingsDialog } from "./SettingsDialog";

// jsdom omits pointer-capture APIs implemented by the native WebView and browser review tests.
beforeAll(() => {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
});

/** Inject a synthetic atomic-settings boundary without filesystem access or a live network. */
function bridges(
  snapshot: SettingsSnapshot = structuredClone(settingsSnapshot),
) {
  const settings: SettingsBridge = {
    native: true,
    load: vi.fn().mockResolvedValue(snapshot),
    setUpdatesEnabled: vi.fn(async (enabled) => {
      snapshot = {
        ...snapshot,
        settings: {
          ...snapshot.settings!,
          updates: { ...snapshot.settings!.updates, enabled },
        },
      };
      return snapshot;
    }),
    chooseExportDirectory: vi.fn().mockResolvedValue(null),
    clearExportDirectory: vi.fn().mockResolvedValue(snapshot),
    recover: vi.fn().mockResolvedValue({
      ...settingsSnapshot,
      recoveredBackupPath: "C:/Synthetic UI fixture/app-settings.backup.json",
    }),
  };
  const updates: UpdatesBridge = {
    native: true,
    checkNow: vi.fn().mockResolvedValue(unavailableRelease),
    dismiss: vi.fn().mockResolvedValue(undefined),
    openRelease: vi.fn().mockResolvedValue(undefined),
  };
  return { settings, updates };
}

/** Render the real dialog with original setup callbacks kept separately injectable. */
function mount(settings: SettingsBridge, updates: UpdatesBridge) {
  const onAppearanceChange = vi.fn();
  const onWorkspaceStyleChange = vi.fn();
  const onReviewSetup = vi.fn();
  render(
    <SettingsDialog
      appearance="dark"
      workspaceStyle="advanced"
      onAppearanceChange={onAppearanceChange}
      onWorkspaceStyleChange={onWorkspaceStyleChange}
      onReviewSetup={onReviewSetup}
      bridge={settings}
      updatesBridge={updates}
      trigger={<button>Open settings</button>}
    />,
  );
  return { onAppearanceChange, onWorkspaceStyleChange, onReviewSetup };
}

describe("Settings dialog (synthetic DI)", () => {
  it("does no request on mount, open or consent; only an explicit enabled Check now requests metadata", async () => {
    const { settings, updates } = bridges();
    mount(settings, updates);
    expect(settings.load).not.toHaveBeenCalled();
    expect(updates.checkNow).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Open settings" }),
    );
    await waitFor(() => expect(settings.load).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("tab", { name: "Updates" }));
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Manual release checks" }),
    );
    await userEvent.click(
      screen.getByRole("option", { name: "Enabled — manual only" }),
    );
    await waitFor(() =>
      expect(settings.setUpdatesEnabled).toHaveBeenCalledWith(true),
    );
    expect(updates.checkNow).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(
      await screen.findByText(unavailableRelease.message),
    ).toBeInTheDocument();
    expect(updates.checkNow).toHaveBeenCalledOnce();
    expect(
      screen.getByText("Last valid release check: Never"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });

  it("uses original theme/style callbacks and treats a canceled folder picker honestly", async () => {
    const { settings, updates } = bridges();
    const callbacks = mount(settings, updates);
    await userEvent.click(
      screen.getByRole("button", { name: "Open settings" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Choose folder" }),
      ).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Appearance" }));
    await userEvent.click(screen.getByRole("option", { name: "Light" }));
    await userEvent.click(
      screen.getByRole("combobox", { name: "Workspace style" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Simple" }));
    expect(callbacks.onAppearanceChange).toHaveBeenCalledWith("light");
    expect(callbacks.onWorkspaceStyleChange).toHaveBeenCalledWith("simple");
    expect(callbacks.onReviewSetup).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Choose folder" }),
    );
    await waitFor(() =>
      expect(settings.chooseExportDirectory).toHaveBeenCalledOnce(),
    );
    expect(
      screen.queryByText("Default export folder saved."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Choose the destination in each export dialog"),
    ).toBeInTheDocument();
  });

  it("requires a separate explicit corruption-recovery confirmation and displays the retained backup", async () => {
    const { settings, updates } = bridges({
      ...settingsSnapshot,
      state: "corrupt",
      settings: null,
      problem: "Settings JSON is damaged. Original bytes are preserved.",
    });
    mount(settings, updates);
    await userEvent.click(
      screen.getByRole("button", { name: "Open settings" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Original bytes are preserved",
    );
    expect(
      screen.getByRole("button", { name: "Choose folder" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Back up and reset app settings" }),
    );
    expect(settings.recover).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(settings.recover).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Back up and reset app settings" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Back up and reset" }),
    );
    expect(
      await screen.findByText(/Application settings recovered. Backup:/),
    ).toHaveTextContent("app-settings.backup.json");
    expect(settings.recover).toHaveBeenCalledOnce();
  });

  it("keeps local actions unavailable in browser presentation and exposes only implemented shortcut help", async () => {
    const { settings, updates } = bridges();
    settings.native = false;
    updates.native = false;
    mount(settings, updates);
    await userEvent.click(
      screen.getByRole("button", { name: "Open settings" }),
    );
    expect(settings.load).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Choose folder" }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole("tab", { name: "Shortcuts" }));
    expect(screen.getByText("Save the active file")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("renders release notes as plain text and opens/dismisses a version only after explicit clicks", async () => {
    const snapshot = structuredClone(settingsSnapshot);
    snapshot.settings!.updates.enabled = true;
    const { settings, updates } = bridges(snapshot);
    const url = "https://github.com/Dotatel/BacktestEngine/releases/tag/v0.2.0";
    updates.checkNow = vi.fn().mockResolvedValue({
      ...unavailableRelease,
      status: "updateAvailable",
      latestVersion: "0.2.0",
      releaseUrl: url,
      notes: "<script>synthetic text, never executable</script>",
      message:
        "A newer stable release is available. Review it in your browser.",
    });
    mount(settings, updates);
    await userEvent.click(
      screen.getByRole("button", { name: "Open settings" }),
    );
    await userEvent.click(screen.getByRole("tab", { name: "Updates" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled(),
    );
    expect(updates.checkNow).not.toHaveBeenCalled();
    expect(updates.openRelease).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(
      await screen.findByText(
        "<script>synthetic text, never executable</script>",
      ),
    ).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "View release" }));
    expect(updates.openRelease).toHaveBeenCalledWith(url);
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss this version" }),
    );
    expect(updates.dismiss).toHaveBeenCalledWith("0.2.0");
    expect(
      await screen.findByText(/Release 0.2.0 · dismissed/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Dismiss this version" }),
    ).not.toBeInTheDocument();
  });
});
