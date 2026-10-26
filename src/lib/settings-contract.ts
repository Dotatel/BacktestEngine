/** Missing application settings only; appearance and workspace style stay in existing preferences. */
export interface AppSettings {
  version: 1;
  defaultExportDirectory: string | null;
  updates: {
    enabled: boolean;
    lastSuccessfulCheckAt: string | null;
    dismissedVersions: string[];
  };
  extensions: Record<string, { enabled: boolean; manifestSha256: string }>;
}

/** Local troubleshooting facts; bundle presence does not claim executable compatibility. */
export interface SettingsDiagnostics {
  appVersion: string;
  platform: string;
  architecture: string;
  settingsPath: string;
  extensionsDirectory: string;
  resourceDirectory: string;
  engineBundlePresent: boolean;
  pythonBundlePresent: boolean;
  extensionApiVersion: string;
}

/** Missing storage is first-run; damaged storage stays preserved until explicit recovery. */
export interface SettingsSnapshot {
  state: "firstRun" | "ready" | "corrupt";
  settings: AppSettings | null;
  problem: string | null;
  recoveredBackupPath: string | null;
  diagnostics: SettingsDiagnostics;
}

/** Native settings operations expose narrow intent, never arbitrary renderer filesystem paths. */
export interface SettingsBridge {
  native: boolean;
  load(): Promise<SettingsSnapshot>;
  setUpdatesEnabled(enabled: boolean): Promise<SettingsSnapshot>;
  chooseExportDirectory(): Promise<SettingsSnapshot | null>;
  clearExportDirectory(): Promise<SettingsSnapshot>;
  recover(): Promise<SettingsSnapshot>;
}
