import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ReportsBridge } from "./reports-contract";

export type * from "./reports-contract";

/** Use native host selection and its save dialog; browser previews carry no engine evidence. */
export const reports: ReportsBridge = {
  native: isTauri(),
  selected: (projectRoot) => {
    if (!isTauri()) return Promise.resolve(null);
    return invoke("reports_selected", { projectRoot });
  },
  exportSaved: (projectRoot, runId, reportSha256, format) => {
    if (!isTauri())
      return Promise.reject(
        new Error("Exporting saved reports requires the desktop app."),
      );
    return invoke("reports_export", {
      projectRoot,
      runId,
      reportSha256,
      format,
    });
  },
};
