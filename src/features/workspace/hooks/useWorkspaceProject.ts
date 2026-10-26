import { useCallback, useState } from "react";
import type {
  WorkspaceBridge,
  WorkspaceProject,
} from "@/lib/workspace-contract";
import { errorMessage } from "@/lib/preferences";

/** Real project selection, tree mutations and their in-flight/error state. */
export interface WorkspaceProjectController {
  project: WorkspaceProject | null;
  busy: boolean;
  error: string;
  clearError(): void;
  createExample(): Promise<WorkspaceProject>;
  pickFolder(): Promise<WorkspaceProject | null>;
  open(root: string): Promise<WorkspaceProject>;
  refresh(): Promise<WorkspaceProject>;
  createEntry(
    parent: string,
    name: string,
    kind: "file" | "folder",
  ): Promise<WorkspaceProject>;
  renameEntry(path: string, name: string): Promise<WorkspaceProject>;
  moveEntry(path: string, parent: string): Promise<WorkspaceProject>;
  clearProject(): void;
}

/**
 * Keep every bridge filesystem operation behind one focused controller. Each mutation returns
 * the authoritative project tree; failures stay visible and are rethrown to the action boundary.
 */
export function useWorkspaceProject(
  bridge: WorkspaceBridge,
): WorkspaceProjectController {
  const [project, setProject] = useState<WorkspaceProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /** Run a project-returning bridge operation with one busy/error boundary. */
  const perform = useCallback(
    async (
      operation: () => Promise<WorkspaceProject>,
    ): Promise<WorkspaceProject> => {
      setBusy(true);
      setError("");
      try {
        const next = await operation();
        setProject(next);
        return next;
      } catch (failure) {
        setError(errorMessage(failure));
        throw failure;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const createExample = useCallback(
    () => perform(() => bridge.createProject()),
    [bridge, perform],
  );

  /** Reveal the native picker; a canceled pick is not an error and leaves the current project intact. */
  const pickFolder = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const next = await bridge.pickProject();
      if (next) setProject(next);
      return next;
    } catch (failure) {
      setError(errorMessage(failure));
      throw failure;
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const open = useCallback(
    (root: string) => perform(() => bridge.openProject(root)),
    [bridge, perform],
  );
  const refresh = useCallback(
    () => perform(() => bridge.refreshProject()),
    [bridge, perform],
  );
  const createEntry = useCallback(
    (parent: string, name: string, kind: "file" | "folder") =>
      perform(() => bridge.createEntry(parent, name, kind)),
    [bridge, perform],
  );
  const renameEntry = useCallback(
    (path: string, name: string) =>
      perform(() => bridge.renameEntry(path, name)),
    [bridge, perform],
  );
  const moveEntry = useCallback(
    (path: string, parent: string) =>
      perform(() => bridge.moveEntry(path, parent)),
    [bridge, perform],
  );

  const clearError = useCallback(() => setError(""), []);
  const clearProject = useCallback(() => setProject(null), []);

  return {
    project,
    busy,
    error,
    clearError,
    createExample,
    pickFolder,
    open,
    refresh,
    createEntry,
    renameEntry,
    moveEntry,
    clearProject,
  };
}
