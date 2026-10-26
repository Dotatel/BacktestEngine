import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SavedRunsBridge } from "./saved-runs-contract";

export type * from "./saved-runs-contract";

/** Connect only to the native saved-run catalogue; browser previews cannot restore engine evidence. */
export const savedRuns: SavedRunsBridge = {
  native: isTauri(),
  list: (projectRoot, cursor, limit) => {
    if (!isTauri()) return Promise.reject(desktopRequired());
    return invoke("saved_runs_list", {
      request: { projectRoot, cursor, limit },
    });
  },
  select: (projectRoot, runId, completionSha256) => {
    if (!isTauri()) return Promise.reject(desktopRequired());
    return invoke("saved_runs_select", {
      request: { projectRoot, runId, completionSha256 },
    });
  },
  restoreSelected: (projectRoot) => {
    if (!isTauri()) return Promise.reject(desktopRequired());
    return invoke("saved_runs_restore_selected", { request: { projectRoot } });
  },
};

/** Keep unavailable desktop storage explicit instead of fabricating an empty native catalogue. */
function desktopRequired() {
  return new Error("Saved-run history requires the desktop app.");
}
