import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../../src/components/ui/button";
import { SettingsDialog } from "../../../src/features/settings/SettingsDialog";
import { ExtensionsDialog } from "../../../src/features/extensions/ExtensionsDialog";
import type { SettingsBridge } from "../../../src/lib/settings-contract";
import type { ExtensionsBridge } from "../../../src/lib/extensions-contract";
import type { Appearance, WorkspaceStyle } from "../../../src/lib/preferences";
import type { UpdatesBridge } from "../../../src/lib/updates-contract";
import {
  settingsSnapshot,
  unavailableRelease,
  reportTools,
  isolatedExtension,
  extensionReport,
} from "../../fixtures/app-settings";
import "../../../src/styles.css";

/** Synthetic DI review only: no native dialog, manifest import, report execution or network request occurs. */
function Fixture() {
  const params = new URLSearchParams(location.search);
  const [appearance, setAppearance] = useState<Appearance>(
    params.get("theme") === "light" ? "light" : "dark",
  );
  const [style, setStyle] = useState<WorkspaceStyle>("advanced");
  const [draft, setDraft] = useState(
    "Unsaved synthetic editor draft — UI fixture only",
  );
  const bridge = useMemo(() => {
    let snapshot = structuredClone(settingsSnapshot);
    snapshot.settings!.defaultExportDirectory =
      "C:/Synthetic UI fixture/export-folder";
    let entries = structuredClone([reportTools, isolatedExtension]);
    if (params.has("corrupt"))
      snapshot = {
        ...snapshot,
        state: "corrupt",
        settings: null,
        problem:
          "The synthetic settings document is damaged. Original bytes remain preserved until explicit recovery.",
      };
    const settings: SettingsBridge = {
      native: true,
      load: async () => snapshot,
      setUpdatesEnabled: async (enabled) => {
        snapshot = {
          ...snapshot,
          settings: {
            ...snapshot.settings!,
            updates: { ...snapshot.settings!.updates, enabled },
          },
        };
        return snapshot;
      },
      chooseExportDirectory: async () => null,
      clearExportDirectory: async () => {
        snapshot = {
          ...snapshot,
          settings: { ...snapshot.settings!, defaultExportDirectory: null },
        };
        return snapshot;
      },
      recover: async () => {
        snapshot = {
          ...structuredClone(settingsSnapshot),
          recoveredBackupPath:
            "C:/Synthetic UI fixture/app-settings.backup.json",
        };
        return snapshot;
      },
    };
    const updates: UpdatesBridge = {
      native: true,
      checkNow: async () => unavailableRelease,
      dismiss: async () => {},
      openRelease: async () => {},
    };
    const extensions: ExtensionsBridge = {
      native: true,
      list: async () => entries,
      importFolder: async () => null,
      setEnabled: async (id, _hash, enabled) => {
        entries = entries.map((entry) =>
          entry.id === id ? { ...entry, enabled } : entry,
        );
        return entries;
      },
      exportReport: async () => null,
    };
    return {
      settings,
      updates,
      extensions,
      reports: {
        native: true,
        selected: async () => extensionReport,
        exportSaved: async () => null,
      },
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", appearance === "dark");
  }, [appearance]);
  return (
    <main
      aria-label="Synthetic settings and extension review"
      style={{
        padding: "var(--space-6)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
      }}
    >
      <h1>Synthetic presentation fixtures</h1>
      <p>
        Injected settings, extension metadata and saved-run identity. This page
        performs no native operations and makes no release or trading claim.
      </p>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <SettingsDialog
          appearance={appearance}
          workspaceStyle={style}
          onAppearanceChange={setAppearance}
          onWorkspaceStyleChange={setStyle}
          onReviewSetup={() => {}}
          bridge={bridge.settings}
          updatesBridge={bridge.updates}
          trigger={<Button variant="outline">Workspace settings</Button>}
        />
        <ExtensionsDialog
          bridge={bridge.extensions}
          reportsBridge={bridge.reports}
          projectRoot={extensionReport.projectRoot}
          trigger={<Button variant="outline">Extensions</Button>}
        />
      </div>
      <label htmlFor="fixture-draft">Unsaved synthetic draft</label>
      <textarea
        id="fixture-draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p>Selected workspace style: {style}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
