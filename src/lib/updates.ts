import { invoke, isTauri } from "@tauri-apps/api/core";
import type { UpdatesBridge } from "./updates-contract";

/** Manual HTTPS release inspection only; native host validates opt-in and same-project links. */
export const updates: UpdatesBridge = {
  native: isTauri(),
  checkNow: () => invoke("app_updates_check"),
  dismiss: (version) => invoke("app_updates_dismiss", { version }),
  openRelease: (url) => invoke("app_updates_open_release", { url }),
};
