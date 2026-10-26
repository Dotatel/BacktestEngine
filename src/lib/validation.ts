import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ValidationBridge } from "./validation-contract";

export type * from "./validation-contract";

/** Browser previews cannot run Python or invent validation results. */
export const validation: ValidationBridge = {
  native: isTauri(),
  run: (request) => {
    if (!isTauri())
      return Promise.reject(
        new Error("Validating a saved report requires the desktop app."),
      );
    return invoke("validation_run", { request });
  },
  cancel: () => {
    if (!isTauri()) return Promise.resolve();
    return invoke("validation_cancel");
  },
  lastGoodResult: () => {
    if (!isTauri()) return Promise.resolve(null);
    return invoke("validation_last_good_result");
  },
};
