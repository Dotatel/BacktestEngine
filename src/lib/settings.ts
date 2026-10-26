import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SettingsBridge } from "./settings-contract";

/** Narrow durable application operations; previews never claim native persistence. */
export const settings: SettingsBridge = {
  native: isTauri(),
  load: () => invoke("app_settings_load"),
  setUpdatesEnabled: (enabled) =>
    invoke("app_settings_set_updates", { enabled }),
  chooseExportDirectory: () => invoke("app_settings_choose_export_directory"),
  clearExportDirectory: () => invoke("app_settings_clear_export_directory"),
  recover: () => invoke("app_settings_recover"),
};
