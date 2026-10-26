import { FolderOpen, FlaskConical, Laptop, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Inputs for the first-run project chooser inside the Build stage. */
export interface WorkspaceEmptyProps {
  native: boolean;
  busy: boolean;
  onOpenFolder(): void;
  onUseExample(): void;
}

/** Render the empty workspace with the two real ways to obtain a project. */
export function WorkspaceEmpty({
  native,
  busy,
  onOpenFolder,
  onUseExample,
}: WorkspaceEmptyProps) {
  return (
    <div className="workspace-empty">
      <div className="workspace-empty__body">
        <span className="workspace-empty__mark" aria-hidden="true">
          <FolderOpen />
        </span>
        <h1 className="workspace-empty__title">Open a strategy project</h1>
        <p className="workspace-empty__copy">
          Edit real C# strategy files, compile them with the installed .NET SDK
          and read the reflected parameter schema. Open a folder to begin, or
          start from the example project.
        </p>
        <div className="workspace-empty__actions">
          <Button size="lg" onClick={onOpenFolder} disabled={busy}>
            {busy ? (
              <LoaderCircle className="spinner" aria-hidden="true" />
            ) : (
              <FolderOpen aria-hidden="true" />
            )}
            Open folder
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={onUseExample}
            disabled={busy}
          >
            <FlaskConical aria-hidden="true" />
            Use example project
          </Button>
        </div>
        <p className="workspace-empty__meta">
          {native ? (
            <>
              <Laptop aria-hidden="true" />
              Projects stay in their original folder. Build artifacts are
              written to the app's own cache.
            </>
          ) : (
            <>
              <Laptop aria-hidden="true" />
              Browser preview stores a separate example project in this browser.
              Disk folders and the C# compiler require the desktop app.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
