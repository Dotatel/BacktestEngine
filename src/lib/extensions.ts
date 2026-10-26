import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ExtensionsBridge } from "./extensions-contract";

/** App-only declarative extensions surface trusted report handlers, never JavaScript or native code. */
export const extensions: ExtensionsBridge = {
  native: isTauri(),
  list: () => invoke("app_extensions_list"),
  importFolder: () => invoke("app_extensions_import"),
  setEnabled: (id, manifestSha256, enabled) =>
    invoke("app_extensions_set_enabled", { id, manifestSha256, enabled }),
  exportReport: (extension, command, report) =>
    invoke("app_extensions_export", {
      request: {
        extensionId: extension.id,
        manifestSha256: extension.manifestSha256,
        command,
        projectRoot: report.projectRoot,
        runId: report.runId,
        reportSha256: report.reportSha256,
      },
    }),
};
