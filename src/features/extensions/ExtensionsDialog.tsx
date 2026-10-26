import { useState, type ReactNode } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type {
  AppExtension,
  ExtensionCommandId,
  ExtensionsBridge,
} from "@/lib/extensions-contract";
import type { ReportsBridge } from "@/lib/reports-contract";
import { useExtensions } from "./useExtensions";
import "./extensions.css";

/** Explicit app-only manifest management; no external source receives native execution authority. */
export interface ExtensionsDialogProps {
  bridge: ExtensionsBridge;
  reportsBridge: ReportsBridge;
  projectRoot: string | null;
  trigger: ReactNode;
}

/** Retain the workspace while reviewing manifest permissions and exporting its selected saved run. */
export function ExtensionsDialog({
  bridge,
  reportsBridge,
  projectRoot,
  trigger,
}: ExtensionsDialogProps) {
  const [open, setOpen] = useState(false);
  const controller = useExtensions(bridge, reportsBridge, projectRoot, open);
  const busy = controller.phase !== "idle";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>App extensions · experimental</DialogTitle>
          <DialogDescription>
            Import declarative report commands for this app. Review each
            manifest before enabling it.
          </DialogDescription>
        </DialogHeader>
        <div className="app-extensions-body">
          <p className="app-extensions-note">
            Extensions contribute names for trusted JSON, CSV and HTML exports.
            They cannot run scripts, access arbitrary files or request network
            permissions.
          </p>
          <div className="app-extensions-actions">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !bridge.native}
              onClick={() => void controller.importFolder()}
            >
              <FolderOpen aria-hidden="true" />
              Import folder
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !bridge.native}
              onClick={() => void controller.refresh()}
            >
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          </div>
          {!bridge.native && (
            <p className="app-extensions-note">
              Open the desktop app to import and manage local extensions.
            </p>
          )}
          {controller.phase === "loading" && (
            <p role="status" className="app-extensions-note">
              Reading imported manifests and the selected saved report…
            </p>
          )}
          {controller.error && (
            <p role="alert" className="app-extensions-error">
              {controller.error}
            </p>
          )}
          {controller.message && (
            <p role="status" className="app-extensions-note">
              {controller.message}
            </p>
          )}
          <section
            className="app-extensions-report"
            aria-label="Extension export source"
          >
            <h3>Saved report for exports</h3>
            {controller.report ? (
              <>
                <p>
                  {controller.report.strategy} · {controller.report.symbol} ·{" "}
                  {controller.report.timeframe}
                </p>
                <dl>
                  <div>
                    <dt>Run</dt>
                    <dd>{controller.report.runId}</dd>
                  </div>
                  <div>
                    <dt>Report SHA-256</dt>
                    <dd>{controller.report.reportSha256}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="app-extensions-note">
                Complete a successful backtest in the selected project, then
                refresh. Report commands require a saved run.
              </p>
            )}
          </section>
          <section
            aria-label="Imported extensions"
            className="app-extensions-list"
          >
            {controller.entries.map((entry) => (
              <ExtensionEntry
                key={entry.id}
                entry={entry}
                controller={controller}
              />
            ))}
            {bridge.native && !busy && controller.entries.length === 0 && (
              <p className="app-extensions-note">
                No extensions imported. Choose a local folder containing
                manifest.json to review its commands.
              </p>
            )}
          </section>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button size="sm">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A damaged entry stays isolated and can have its durable registration disabled explicitly. */
function ExtensionEntry({
  entry,
  controller,
}: {
  entry: AppExtension;
  controller: ReturnType<typeof useExtensions>;
}) {
  const busy = controller.phase !== "idle";
  const canExport =
    entry.enabled && entry.compatible && Boolean(controller.report) && !busy;
  return (
    <article className="app-extension" aria-label={entry.name}>
      <div className="app-extension-heading">
        <div>
          <h3>{entry.name}</h3>
          <p className="app-extensions-note">
            {entry.id}
            {entry.version ? ` · ${entry.version}` : ""}
            {entry.apiVersion ? ` · API ${entry.apiVersion}` : ""} ·{" "}
            {entry.enabled ? "Enabled" : "Disabled"}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || (!entry.compatible && !entry.issue)}
          onClick={() =>
            void controller.setEnabled(
              entry,
              entry.compatible && !entry.enabled,
            )
          }
        >
          {toggleLabel(entry)}
        </Button>
      </div>
      {entry.description && <p>{entry.description}</p>}
      <p className="app-extensions-note">
        Permissions:{" "}
        {entry.permissions.length ? entry.permissions.join(", ") : "none"}
      </p>
      {entry.issue && (
        <p className="app-extensions-error" role="alert">
          {entry.issue}
        </p>
      )}
      {entry.commands.length > 0 && (
        <ul className="app-extension-commands">
          {entry.commands.map((command) => (
            <li key={command.id}>
              <span>
                {command.title}
                <small>{command.id}</small>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!canExport}
                onClick={() => void controller.exportReport(entry, command.id)}
              >
                {commandLabel(command.id)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {entry.manifestSha256 && (
        <details>
          <summary>Imported manifest identity</summary>
          <p className="app-extensions-hash">{entry.manifestSha256}</p>
        </details>
      )}
    </article>
  );
}

/** Invalid entries can only lose authority; valid entries expose the next durable toggle action. */
function toggleLabel(entry: AppExtension): string {
  if (!entry.compatible) return "Disable registration";
  return entry.enabled ? "Disable" : "Enable";
}

/** Keep visible actions aligned with the native API's three literal report commands. */
function commandLabel(command: ExtensionCommandId): string {
  if (command === "report.export-csv") return "Export CSV";
  if (command === "report.export-json") return "Export JSON";
  return "Export HTML";
}
