import type { AppExtension } from "../../src/lib/extensions-contract";
import type { SelectedReport } from "../../src/lib/reports-contract";
import type { SettingsSnapshot } from "../../src/lib/settings-contract";
import type { ReleaseCheck } from "../../src/lib/updates-contract";

// Synthetic presentation fixtures only. These values do not establish native installation or execution.
export const settingsSnapshot: SettingsSnapshot = {
  state: "ready",
  problem: null,
  recoveredBackupPath: null,
  settings: {
    version: 1,
    defaultExportDirectory: null,
    updates: {
      enabled: false,
      lastSuccessfulCheckAt: null,
      dismissedVersions: [],
    },
    extensions: {},
  },
  diagnostics: {
    appVersion: "0.1.0",
    platform: "windows",
    architecture: "x86_64",
    settingsPath: "C:/Synthetic UI fixture/app-settings.json",
    extensionsDirectory: "C:/Synthetic UI fixture/extensions",
    resourceDirectory: "C:/Synthetic UI fixture/resources",
    engineBundlePresent: true,
    pythonBundlePresent: true,
    extensionApiVersion: "1.0.0",
  },
};

export const unavailableRelease: ReleaseCheck = {
  status: "noRelease",
  currentVersion: "0.1.0",
  latestVersion: null,
  checkedAt: "2026-10-24T10:42:52Z",
  message:
    "No public release information available. The project release source is unavailable (HTTP 404).",
  releaseUrl: null,
  downloadUrl: null,
  notes: null,
  dismissed: false,
};

export const reportTools: AppExtension = {
  id: "report-tools",
  name: "Report tools",
  version: "1.0.0",
  apiVersion: "1.0.0",
  description: "Declarative report commands — synthetic UI fixture.",
  manifestSha256: "a".repeat(64),
  permissions: ["commands"],
  commands: [
    {
      id: "report.export-json",
      title: "Export original JSON",
      category: "Reports",
    },
    {
      id: "report.export-csv",
      title: "Export trade ledger",
      category: "Reports",
    },
    {
      id: "report.export-html",
      title: "Export HTML report",
      category: "Reports",
    },
  ],
  compatible: true,
  enabled: false,
  issue: null,
};

export const isolatedExtension: AppExtension = {
  id: "damaged-tools",
  name: "Damaged tools",
  version: null,
  apiVersion: null,
  description: null,
  manifestSha256: null,
  permissions: [],
  commands: [],
  compatible: false,
  enabled: false,
  issue:
    "The imported manifest changed. Re-import a reviewed manifest in a new folder; this extension is isolated.",
};

export const extensionReport: SelectedReport = {
  projectRoot: "C:/Synthetic UI fixture/project",
  runId: "synthetic-run-ui-only",
  reportSha256: "b".repeat(64),
  reportJsonPath: "C:/Synthetic UI fixture/run/report.json",
  buildRevision: "synthetic-build-ui-only",
  datasetId: "synthetic-dataset-ui-only",
  completedAt: "2026-10-24T10:00:00Z",
  strategy: "Synthetic fixture — UI review only",
  symbol: "EURUSD",
  timeframe: "M1",
  accountCurrency: "EUR",
  nativeDrawdownMethod: null,
  metrics: [],
  closedTradeCount: 1,
};
