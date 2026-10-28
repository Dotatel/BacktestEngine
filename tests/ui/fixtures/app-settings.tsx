import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../../src/components/ui/button";
import { SettingsPage } from "../../../src/features/settings/SettingsPage";
import { ExtensionsPage } from "../../../src/features/extensions/ExtensionsPage";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const extensionsTrigger = useRef<HTMLButtonElement>(null);
  const [navigationNotice, setNavigationNotice] = useState("");
  const [style, setStyle] = useState<WorkspaceStyle>("advanced");
  const [draft, setDraft] = useState(
    "Unsaved synthetic editor draft — UI fixture only",
  );
  const bridge = useMemo(() => {
    let snapshot = structuredClone(settingsSnapshot);
    snapshot.settings!.defaultExportDirectory =
      "C:/Synthetic UI fixture/export-folder";
    let entries = params.has("empty")
      ? []
      : structuredClone([reportTools, isolatedExtension]);
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
      installExample: async (id) => {
        const names = {
          "report-tools": "Report tools",
          "trade-ledger-export": "Trade ledger export",
          "html-reports": "HTML reports",
        };
        const entry = {
          ...structuredClone(reportTools),
          id,
          name: names[id],
          enabled: false,
        };
        entries = [...entries, entry];
        return entry;
      },
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
        selected: async () =>
          params.has("no-report") ? null : extensionReport,
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
      style={{ height: "100vh", display: "flex", flexDirection: "column" }}
    >
      {settingsOpen && (
        <SettingsPage
          appearance={appearance}
          workspaceStyle={style}
          onAppearanceChange={setAppearance}
          onWorkspaceStyleChange={setStyle}
          onReviewSetup={() => {}}
          onClose={() => setSettingsOpen(false)}
          project={{
            name: "Synthetic project",
            root: "C:/Synthetic UI fixture/project",
          }}
          bridge={bridge.settings}
          updatesBridge={bridge.updates}
        />
      )}
      {extensionsOpen && (
        <ExtensionsPage
          bridge={bridge.extensions}
          reportsBridge={bridge.reports}
          projectRoot={extensionReport.projectRoot}
          onClose={() => {
            setExtensionsOpen(false);
            requestAnimationFrame(() => extensionsTrigger.current?.focus());
          }}
          onGoToReports={() => {
            setExtensionsOpen(false);
            setNavigationNotice("Reports navigation requested");
          }}
          onOpenAssistant={() => {
            setExtensionsOpen(false);
            setNavigationNotice("Assistant navigation requested");
          }}
        />
      )}
      <div hidden={settingsOpen || extensionsOpen}>
        <div
          style={{
            padding: "var(--space-6)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
          }}
        >
          <h1>Synthetic presentation fixtures</h1>
          <p>
            Injected settings, extension metadata and saved-run identity. This
            page performs no native operations and makes no release or trading
            claim.
          </p>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button variant="outline" onClick={() => setSettingsOpen(true)}>
              Workspace settings
            </Button>
            <Button
              ref={extensionsTrigger}
              variant="outline"
              onClick={() => setExtensionsOpen(true)}
            >
              Extensions
            </Button>
          </div>
          <label htmlFor="fixture-draft">Unsaved synthetic draft</label>
          <textarea
            id="fixture-draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p>Selected workspace style: {style}</p>
          {navigationNotice && <p role="status">{navigationNotice}</p>}
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
