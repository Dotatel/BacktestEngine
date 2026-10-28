import type { ReportExportReceipt, SelectedReport } from "./reports-contract";

/** The only extension-contributed commands implemented by trusted native handlers. */
export type ExtensionCommandId =
  "report.export-json" | "report.export-csv" | "report.export-html";

/** Bundled declarative report examples available offline; installation never enables them. */
export type ExampleExtensionId =
  "report-tools" | "trade-ledger-export" | "html-reports";

/** Experimental manifest contributes names only; it never contributes executable code. */
export interface AppExtension {
  id: string;
  name: string;
  version: string | null;
  apiVersion: string | null;
  description: string | null;
  manifestSha256: string | null;
  permissions: string[];
  commands: Array<{
    id: ExtensionCommandId;
    title: string;
    category: string | null;
  }>;
  compatible: boolean;
  enabled: boolean;
  issue: string | null;
}

/** Local manifest import and explicit report exports remain at the native trust boundary. */
export interface ExtensionsBridge {
  native: boolean;
  list(): Promise<AppExtension[]>;
  importFolder(): Promise<AppExtension | null>;
  installExample(id: ExampleExtensionId): Promise<AppExtension>;
  setEnabled(
    id: string,
    manifestSha256: string | null,
    enabled: boolean,
  ): Promise<AppExtension[]>;
  exportReport(
    extension: AppExtension,
    command: ExtensionCommandId,
    report: SelectedReport,
  ): Promise<ReportExportReceipt | null>;
}
