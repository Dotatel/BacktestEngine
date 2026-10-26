import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ExecutionBridge } from "./execution-contract";
import { previewExecution } from "./execution-preview";

export * from "./execution-contract";

/** Use the official native dialog to select a CSV, keeping file picking out of presentation. */
export async function pickHistoricalCsv(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error(
      "Importing historical data requires the desktop app. Use the browser preview for UI checks only.",
    );
  }
  const selected = await open({
    multiple: false,
    title: "Import historical market data",
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!selected || Array.isArray(selected)) return null;
  return selected;
}

/** Use the official native dialog to select a symbol specification JSON file. */
export async function pickSymbolSpec(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error(
      "Importing symbol specifications requires the desktop app. Use the browser preview for UI checks only.",
    );
  }
  const selected = await open({
    multiple: false,
    title: "Import symbol specification",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!selected || Array.isArray(selected)) return null;
  return selected;
}

const nativeExecution: ExecutionBridge = {
  native: true,
  importHistoricalCsv: (path, kind) =>
    invoke("execution_import_market_data", { path, kind }),
  listDatasets: () => invoke("execution_list_market_data"),
  importSymbolSpec: (path) => invoke("execution_import_symbol_spec", { path }),
  listSymbolSpecs: () => invoke("execution_list_symbol_specs"),
  run: (request) => invoke("execution_run", { request }),
  cancel: () => invoke("execution_cancel"),
  lastGoodResult: () => invoke("execution_last_good_result"),
};

export const execution: ExecutionBridge = isTauri()
  ? nativeExecution
  : previewExecution;
