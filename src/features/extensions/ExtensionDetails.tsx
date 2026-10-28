import { ChevronRight, ArrowRight, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ExtensionCommandId } from "@/lib/extensions-contract";
import type { ExtensionCatalogItem } from "./extension-catalog";
import type { useExtensions } from "./useExtensions";
import { ExtensionIcon } from "./ExtensionIcon";
import { extensionOrigin } from "./extension-catalog";

/** Inspector content and the existing guarded report actions available to the selected extension. */
export interface ExtensionDetailsProps {
  item: ExtensionCatalogItem;
  controller: ReturnType<typeof useExtensions>;
  native: boolean;
  canGoToReports: boolean;
  onGoToReports(): void;
}

/** Show real registration/command authority separately from preview-only provider artwork. */
export function ExtensionDetails({
  item,
  controller,
  native,
  canGoToReports,
  onGoToReports,
  id,
  onClose,
  compact,
  feedback,
}: ExtensionDetailsProps & {
  id: string;
  onClose(): void;
  compact: boolean;
  feedback?: ReactNode;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (compact) close.current?.focus({ preventScroll: true });
  }, [compact]);
  const installed = item.installed;
  const busy = controller.phase !== "idle";
  const canExport = Boolean(
    installed?.enabled && installed.compatible && controller.report && !busy,
  );
  return (
    <aside className="extension-details-panel" aria-label="Extension inspector">
      <header className="extension-details-panel__heading">
        <ExtensionIcon item={item} />
        <div>
          <h2>{item.name}</h2>
          <p className="app-extensions-note">
            {extensionOrigin(item)} · {item.version}
          </p>
        </div>
        <Button
          ref={close}
          size="icon-sm"
          variant="ghost"
          aria-label="Close extension details"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      {feedback}
      <section
        className="extension-details"
        aria-label="Extension details"
        id={id}
      >
        <p className="extension-description">{item.description}</p>
        {installed?.issue && (
          <p className="app-extensions-error" role="alert">
            {installed.issue}
          </p>
        )}
        {item.category === "assistants" ? (
          <section className="extension-detail-section">
            <h3>Integration</h3>
            {item.assistant === "opencode" ? (
              <>
                <p className="app-extensions-note">
                  Uses the existing optional assistant. Opening it does not
                  connect to a service or send a prompt.
                </p>
              </>
            ) : (
              <>
                <p className="app-extensions-note">
                  Preview only. This app does not connect to {item.name},
                  install a connector or send data to it.
                </p>
              </>
            )}
          </section>
        ) : (
          <>
            <section className="extension-detail-section">
              <h3>Included commands</h3>
              <ul className="app-extension-commands">
                {item.commands.map((command) => (
                  <li key={command.id}>
                    <span>{command.title}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canExport}
                      onClick={() =>
                        installed &&
                        void controller.exportReport(installed, command.id)
                      }
                    >
                      {commandLabel(command.id)}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
            <section className="extension-detail-section">
              <h3>Access</h3>
              <p>Saved report exports</p>
              <p className="app-extensions-note">
                No scripts or network access.
              </p>
            </section>
            <section className="extension-detail-section">
              <h3>Export source</h3>
              {controller.report ? (
                <>
                  <p>
                    {controller.report.strategy} · {controller.report.symbol} ·{" "}
                    {controller.report.timeframe}
                  </p>
                  <p className="app-extensions-note">
                    Run {controller.report.runId}
                  </p>
                </>
              ) : (
                <p className="app-extensions-note">
                  Select a completed saved run to use these commands.
                </p>
              )}
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onGoToReports}
                  disabled={!canGoToReports}
                  title={
                    canGoToReports
                      ? "Review saved runs"
                      : "Open a project to review its saved runs"
                  }
                >
                  Go to Reports
                  <ArrowRight aria-hidden="true" />
                </Button>
              </div>
            </section>
            {installed && (
              <details className="extension-manifest-details">
                <summary>
                  <ChevronRight aria-hidden="true" />
                  Manifest details
                </summary>
                <dl>
                  <div>
                    <dt>ID</dt>
                    <dd>{installed.id}</dd>
                  </div>
                  <div>
                    <dt>API version</dt>
                    <dd>{installed.apiVersion ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Permissions</dt>
                    <dd>{installed.permissions.join(", ") || "none"}</dd>
                  </div>
                  <div>
                    <dt>Manifest SHA-256</dt>
                    <dd>{installed.manifestSha256 ?? "Unavailable"}</dd>
                  </div>
                  {controller.report && (
                    <div>
                      <dt>Report SHA-256</dt>
                      <dd>{controller.report.reportSha256}</dd>
                    </div>
                  )}
                </dl>
              </details>
            )}
          </>
        )}
        {!native && (
          <p className="app-extensions-note">
            Open the desktop app to install examples, import folders and manage
            local extensions.
          </p>
        )}
      </section>
    </aside>
  );
}

/** Keep export labels aligned with the three trusted native handlers. */
function commandLabel(command: ExtensionCommandId) {
  if (command === "report.export-csv") return "Export CSV";
  return command === "report.export-json" ? "Export JSON" : "Export HTML";
}
