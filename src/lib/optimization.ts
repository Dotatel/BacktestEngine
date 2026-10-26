import { invoke, isTauri } from "@tauri-apps/api/core";
import type { OptimizationBridge } from "./optimization-contract";
export type * from "./optimization-contract";

/** Keep native IPC outside presentation and reject browser attempts rather than fabricate candidates. */
export const optimization: OptimizationBridge = {
  native: isTauri(),
  run: (request) => {
    if (!isTauri())
      return Promise.reject(
        new Error(
          "Optimization requires the desktop app and real imported inputs.",
        ),
      );
    return invoke("optimization_run", { request });
  },
  cancel: () => (isTauri() ? invoke("optimization_cancel") : Promise.resolve()),
  lastGoodResult: () =>
    isTauri() ? invoke("optimization_last_good_result") : Promise.resolve(null),
};
