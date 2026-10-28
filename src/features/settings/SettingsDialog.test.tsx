import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsBridge, SettingsSnapshot } from "@/lib/settings-contract";
import type { UpdatesBridge } from "@/lib/updates-contract";
import {
  settingsSnapshot,
  unavailableRelease,
} from "../../../tests/fixtures/app-settings";
import { SettingsPage } from "./SettingsPage";

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

/** Render the real Settings page with original setup callbacks kept separately injectable. */
function mount(settings: SettingsBridge, updates: UpdatesBridge) {
  const onAppearanceChange = vi.fn();
  const onWorkspaceStyleChange = vi.fn();
  const onReviewSetup = vi.fn();
  const onClose = vi.fn();
  render(
    <SettingsPage
      appearance="dark"
      workspaceStyle="advanced"
      onAppearanceChange={onAppearanceChange}
      onWorkspaceStyleChange={onWorkspaceStyleChange}
      onReviewSetup={onReviewSetup}
      bridge={settings}
      updatesBridge={updates}
      onClose={onClose}
      project={{
        name: "Synthetic project",
        root: "C:/Synthetic UI fixture/project",
      }}
    />,
  );
  return { onAppearanceChange, onWorkspaceStyleChange, onReviewSetup, onClose };
}

describe("Settings page (synthetic DI)", () => {
  it("does no release request on mount or consent; only an explicit enabled Check now requests metadata", async () => {
    const { settings, updates } = bridges();
    mount(settings, updates);
    expect(updates.checkNow).not.toHaveBeenCalled();
    await waitFor(() => expect(settings.load).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Updates" }));
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
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Choose folder" }),
      ).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Appearance" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Appearance" }));
    await userEvent.click(screen.getByRole("option", { name: "Light" }));
    await userEvent.click(screen.getByRole("button", { name: "General" }));
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
    await userEvent.click(
      screen.getByRole("button", { name: "Back to workspace" }),
    );
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it("requires a separate explicit corruption-recovery confirmation and displays the retained backup", async () => {
    const { settings, updates } = bridges({
      ...settingsSnapshot,
      state: "corrupt",
      settings: null,
      problem: "Settings JSON is damaged. Original bytes are preserved.",
    });
    mount(settings, updates);
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
    expect(settings.load).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Choose folder" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Keyboard shortcuts" }),
    );
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
    await userEvent.click(screen.getByRole("button", { name: "Updates" }));
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
  it("exposes category navigation, read-only project context and a focused page heading", async () => {
    const { settings, updates } = bridges();
    mount(settings, updates);
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });
    expect(within(navigation).getAllByRole("button")).toHaveLength(5);
    expect(
      within(navigation).getByRole("button", { name: "General" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Synthetic project")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(
      within(navigation).getByRole("button", {
        name: "Appearance",
      }),
    );
    expect(
      within(navigation).getByRole("button", {
        name: "Appearance",
      }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Appearance",
      }),
    ).toHaveFocus();
    expect(
      screen.queryByRole("combobox", { name: "Workspace style" }),
    ).not.toBeInTheDocument();
    expect(settings.load).toHaveBeenCalledOnce();
    expect(updates.checkNow).not.toHaveBeenCalled();
  });

  it("retains an in-flight folder write across category navigation", async () => {
    const { settings, updates } = bridges();
    let complete: ((value: SettingsSnapshot) => void) | undefined;
    settings.chooseExportDirectory = vi.fn(
      () =>
        new Promise<SettingsSnapshot>((resolve) => {
          complete = resolve;
        }),
    );
    mount(settings, updates);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Choose folder" }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Choose folder" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Appearance" }));
    await userEvent.click(screen.getByRole("button", { name: "General" }));
    expect(
      screen.getByRole("button", { name: "Choose folder" }),
    ).toBeDisabled();
    await act(async () =>
      complete!({
        ...settingsSnapshot,
        settings: {
          ...settingsSnapshot.settings!,
          defaultExportDirectory: "C:/Synthetic UI fixture/chosen",
        },
      }),
    );
    expect(
      await screen.findByText("Default export folder saved."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("C:/Synthetic UI fixture/chosen"),
    ).toBeInTheDocument();
    expect(settings.chooseExportDirectory).toHaveBeenCalledOnce();
    expect(settings.load).toHaveBeenCalledOnce();
  });
});
