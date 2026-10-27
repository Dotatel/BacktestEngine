import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BuildDiagnostic,
  BuildWorkspaceProps,
  WorkspaceEntry,
  WorkspacePreset,
  WorkspaceProject,
  WorkspaceSession,
} from "@/lib/workspace-contract";
import { errorMessage } from "@/lib/preferences";
import {
  childPath,
  directoryOf,
  findEntry,
  findPreferredFile,
  hasSiblingName,
  isPathWithin,
  nameOf,
  normalizeDiagnosticPath,
  validateEntryName,
} from "../lib/paths";
import { useWorkspaceSession } from "./useWorkspaceSession";
import { useWorkspaceProject } from "./useWorkspaceProject";
import {
  useWorkspaceDocuments,
  type SaveOutcome,
  type WorkspaceDocumentsController,
} from "./useWorkspaceDocuments";
import { useWorkspaceBuild } from "./useWorkspaceBuild";
import { useWorkspaceParameters } from "./useWorkspaceParameters";

/** A user-visible follow-up that needs an explicit decision before it can continue. */
export type WorkspaceDialog =
  | {
      kind: "create";
      entryKind: "file" | "folder";
      parent: string;
    }
  | { kind: "rename"; path: string }
  | { kind: "move"; path: string; parent?: string }
  | { kind: "close-tab"; path: string; paths?: string[] }
  | { kind: "conflict"; path: string }
  | { kind: "unsaved"; intent: "project" | "structure" };

/** A short, dismissible message that does not replace the build result. */
export interface WorkspaceNotice {
  tone: "info" | "error";
  text: string;
}

/**
 * Coordinate session, project, documents, build and reflected parameters. Presentation receives
 * these actions; bridge access and durable session writes remain in the focused hooks.
 */
export function useWorkspace(props: BuildWorkspaceProps) {
  const { bridge, onDirtyChange, onFlushChange } = props;
  const session = useWorkspaceSession(bridge);
  const project = useWorkspaceProject(bridge);
  const documents = useWorkspaceDocuments(bridge);
  const [dialog, setDialog] = useState<WorkspaceDialog | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null);
  const [closingTabs, setClosingTabs] = useState(false);
  const closeInFlight = useRef(false);
  const pendingAction = useRef<(() => Promise<void>) | null>(null);
  const booted = useRef(false);
  const viewRoot = useRef<string | null>(null);
  const sessionState = useRef(session.session);
  const dirty = documents.dirtyPaths.length > 0;
  const sourceFile = project.project
    ? findPreferredFile(project.project.entries)
    : null;
  sessionState.current = session.session;

  /** Replace transient feedback without hiding the actual build output. */
  const announce = useCallback(
    (text: string, tone: "info" | "error" = "info") => {
      setNotice({ text, tone });
    },
    [],
  );

  /** Open one decision dialog with a clean error slot. */
  const openDialog = useCallback((next: WorkspaceDialog) => {
    setDialogError("");
    setDialog(next);
  }, []);

  const dismissDialog = useCallback(() => {
    if (project.busy || closeInFlight.current) return;
    pendingAction.current = null;
    setDialog(null);
    setDialogError("");
  }, [project.busy]);

  /** Block an action behind explicit save/discard/cancel when drafts are dirty. */
  const guardUnsaved = useCallback(
    (intent: "project" | "structure", action: () => Promise<void>) => {
      if (!dirty) {
        void action();
        return;
      }
      pendingAction.current = action;
      openDialog({ kind: "unsaved", intent });
    },
    [dirty, openDialog],
  );

  /** Surface a failed save honestly; conflicts offer the host's current content instead of overwriting. */
  const handleSaveFailure = useCallback(
    (outcome: SaveOutcome) => {
      if (outcome.conflict && outcome.path) {
        openDialog({ kind: "conflict", path: outcome.path });
        return;
      }
      const text =
        outcome.message ??
        "The file could not be saved. Your draft is preserved.";
      announce(text, "error");
    },
    [announce, openDialog],
  );

  /** Save all drafts before a build and keep conflict handling at the action boundary. */
  const saveAllForBuild = useCallback(async () => {
    const outcome = await documents.saveAll();
    if (!outcome.ok) handleSaveFailure(outcome);
    return outcome;
  }, [documents.saveAll, handleSaveFailure]);

  const build = useWorkspaceBuild(
    bridge,
    saveAllForBuild,
    documents.savedEpoch,
    dirty,
  );

  /** Persist a view-state patch in the background; failed writes remain in session.saveError. */
  const remember = useCallback(
    (patch: Partial<WorkspaceSession>) => {
      void session.persist(patch).catch(() => undefined);
    },
    [session.persist],
  );

  const updatePresets = useCallback(
    async (presets: WorkspacePreset[]): Promise<void> => {
      await session.persist({ presets });
    },
    [session.persist],
  );

  const parameters = useWorkspaceParameters(
    project.project?.root ?? null,
    build.result,
    session.session?.presets ?? [],
    updatePresets,
  );

  /** Restore tabs for one authoritative project and swap build evidence with the project. */
  const activateProject = useCallback(
    async (next: WorkspaceProject) => {
      const stored = sessionState.current;
      const sameProject = stored?.lastProject === next.root;
      const restored = stored && sameProject ? stored.openFiles : [];
      const valid = restored.filter(
        (path) => findEntry(next.entries, path)?.kind === "file",
      );
      const fallback = findPreferredFile(next.entries);
      const fallbackPaths = fallback ? [fallback.id] : [];
      const paths = valid.length ? valid : fallbackPaths;
      const active =
        stored && sameProject && stored.activeFile
          ? stored.activeFile
          : (paths[0] ?? null);
      viewRoot.current = next.root;
      build.reset();
      await documents.restore(
        paths,
        paths.includes(active ?? "") ? active : null,
      );
      remember({
        lastProject: next.root,
        openFiles: paths,
        activeFile: active,
      });
      if (restored.length > valid.length)
        announce("Some saved tabs were not found in this project.", "info");
    },
    [announce, build.reset, documents.restore, remember],
  );

  /** Reopen a recorded project without clearing session state when it has disappeared. */
  const openStoredProject = useCallback(
    async (root: string) => {
      try {
        const next = await project.open(root);
        if (!next)
          throw new Error("The host did not return the selected project.");
        await activateProject(next);
      } catch (failure) {
        announce(errorMessage(failure), "error");
      }
    },
    [activateProject, announce, project.open],
  );

  useEffect(() => {
    if (booted.current || session.loading || session.error || !session.session)
      return;
    booted.current = true;
    const root = session.session.lastProject;
    if (root) void openStoredProject(root);
  }, [openStoredProject, session.error, session.loading, session.session]);

  useEffect(() => {
    if (!project.project || !sessionState.current) return;
    if (project.project.root !== viewRoot.current) return;
    remember({
      lastProject: project.project.root,
      openFiles: documents.openPaths,
      activeFile: documents.activePath,
    });
  }, [
    documents.activePath,
    documents.openPaths,
    project.project?.root,
    remember,
  ]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onFlushChange?.(session.flush);
    return () => onFlushChange?.(null);
  }, [onFlushChange, session.flush]);

  /** Ask the host to open a folder after resolving any unsaved drafts. */
  const openFolder = useCallback(() => {
    guardUnsaved("project", async () => {
      try {
        const next = await project.pickFolder();
        if (next) await activateProject(next);
      } catch (failure) {
        announce(errorMessage(failure), "error");
      }
    });
  }, [activateProject, announce, guardUnsaved, project.pickFolder]);

  /** Create the host's real example project only after unsaved drafts are resolved. */
  const useExample = useCallback(() => {
    guardUnsaved("project", async () => {
      try {
        const next = await project.createExample();
        if (!next)
          throw new Error("The host did not create an example project.");
        await activateProject(next);
      } catch (failure) {
        announce(errorMessage(failure), "error");
      }
    });
  }, [activateProject, announce, guardUnsaved, project.createExample]);

  const retrySession = useCallback(async () => {
    booted.current = false;
    await session.reload();
  }, [session.reload]);

  const retryStoredProject = useCallback(() => {
    const root = sessionState.current?.lastProject;
    if (root) void openStoredProject(root);
  }, [openStoredProject]);

  /** Refresh the host tree and close only clean tabs for files that disappeared. */
  const refreshProject = useCallback(async () => {
    try {
      const next = await project.refresh();
      reconcileMissingTabs(next.entries, documents, announce);
    } catch (failure) {
      announce(errorMessage(failure), "error");
    }
  }, [announce, documents, project.refresh]);

  const requestCreate = useCallback(
    (entryKind: "file" | "folder", parent: string) => {
      guardUnsaved("structure", async () => {
        openDialog({ kind: "create", entryKind, parent });
      });
    },
    [guardUnsaved, openDialog],
  );

  const requestRename = useCallback(
    (path: string) => {
      guardUnsaved("structure", async () => {
        openDialog({ kind: "rename", path });
      });
    },
    [guardUnsaved, openDialog],
  );

  const requestMove = useCallback(
    (path: string, parent?: string) => {
      guardUnsaved("structure", async () => {
        openDialog({ kind: "move", path, parent });
      });
    },
    [guardUnsaved, openDialog],
  );

  /** Snapshot requested open tabs; dirty files share one explicit decision and clean files close atomically. */
  const requestCloseTabs = useCallback(
    (paths: string[]) => {
      if (dialog || closeInFlight.current || project.busy) return;
      const targets = documents.openPaths.filter((path) =>
        paths.includes(path),
      );
      if (!targets.length) return;
      if (targets.some((path) => documents.documents[path]?.dirty)) {
        openDialog({ kind: "close-tab", path: targets[0], paths: targets });
        return;
      }
      if (!documents.closeMany(targets))
        announce(
          "Wait for the files to finish saving before closing their tabs.",
          "error",
        );
    },
    [announce, dialog, documents, openDialog, project.busy],
  );

  /** Use the same guarded close transaction for a tab's button, Delete key and context-menu Close. */
  const requestClose = useCallback(
    (path: string) => requestCloseTabs([path]),
    [requestCloseTabs],
  );

  /** Resolve the unsaved-changes gate with an explicit save or discard choice. */
  const resolveUnsaved = useCallback(
    async (choice: "save" | "discard" | "cancel") => {
      if (choice === "cancel") {
        dismissDialog();
        return;
      }
      if (choice === "save") {
        const outcome = await documents.saveAll();
        if (!outcome.ok) {
          setDialogError(
            outcome.message ??
              "Not all changes could be saved. Resolve the problem, then retry.",
          );
          handleSaveFailure(outcome);
          return;
        }
      }
      const action = pendingAction.current;
      pendingAction.current = null;
      setDialog(null);
      if (action) await action();
    },
    [dismissDialog, documents.saveAll, handleSaveFailure],
  );

  /** Save only the closing tabs and preserve the normal external-revision conflict recovery. */
  const saveClosingTabs = useCallback(
    async (paths: string[]) => {
      const outcome = await documents.saveSelected(paths);
      if (outcome.ok) return true;
      setDialogError(
        outcome.message ??
          "The files could not be saved. Your drafts are preserved.",
      );
      handleSaveFailure(outcome);
      return false;
    },
    [documents.saveSelected, handleSaveFailure],
  );

  /** Commit the whole close set only after save or explicit discard; cancellation and conflicts remove no tabs. */
  const resolveCloseTab = useCallback(
    async (choice: "save" | "discard" | "cancel") => {
      if (dialog?.kind !== "close-tab" || closeInFlight.current) return;
      if (choice === "cancel") {
        dismissDialog();
        return;
      }
      const paths = dialog.paths ?? [dialog.path];
      const root = viewRoot.current;
      closeInFlight.current = true;
      setClosingTabs(true);
      try {
        const saved = choice === "discard" || (await saveClosingTabs(paths));
        if (!saved || root !== viewRoot.current) return;
        if (!documents.closeMany(paths, choice === "discard")) {
          setDialogError(
            "Files are still saving or changed again. Review their drafts before closing.",
          );
          return;
        }
        setDialog(null);
      } finally {
        closeInFlight.current = false;
        setClosingTabs(false);
      }
    },
    [dialog, dismissDialog, documents.closeMany, saveClosingTabs],
  );

  /** Validate and create one entry, then open a new file without inventing content. */
  const submitCreate = useCallback(
    async (name: string) => {
      if (dialog?.kind !== "create") return;
      const parentEntry = dialog.parent
        ? findEntry(project.project?.entries ?? [], dialog.parent)
        : null;
      if (dialog.parent && parentEntry?.kind !== "folder") {
        setDialogError("Choose an existing project folder.");
        return;
      }
      const nameError = validateEntryName(name);
      if (nameError) {
        setDialogError(nameError);
        return;
      }
      if (hasSiblingName(project.project?.entries ?? [], dialog.parent, name)) {
        setDialogError("An item with that name already exists here.");
        return;
      }
      const path = childPath(dialog.parent, name);
      try {
        await project.createEntry(dialog.parent, name, dialog.entryKind);
        if (dialog.entryKind === "file") await documents.open(path);
        setDialog(null);
        announce(`${name} created.`, "info");
      } catch (failure) {
        setDialogError(errorMessage(failure));
      }
    },
    [announce, dialog, documents.open, project.createEntry, project.project],
  );

  /** Rename an entry and keep its open tabs attached to the new path. */
  const submitRename = useCallback(
    async (name: string) => {
      if (dialog?.kind !== "rename") return;
      const entry = findEntry(project.project?.entries ?? [], dialog.path);
      if (!entry) {
        setDialogError("That entry is no longer in the project.");
        return;
      }
      const nameError = validateEntryName(name);
      if (nameError) {
        setDialogError(nameError);
        return;
      }
      if (
        hasSiblingName(
          project.project?.entries ?? [],
          directoryOf(dialog.path),
          name,
          dialog.path,
        )
      ) {
        setDialogError("An item with that name already exists here.");
        return;
      }
      const nextPath = childPath(directoryOf(dialog.path), name);
      try {
        await project.renameEntry(dialog.path, name);
        documents.remap(dialog.path, nextPath, entry.kind === "folder");
        setDialog(null);
        announce(`Renamed to ${name}.`, "info");
      } catch (failure) {
        setDialogError(errorMessage(failure));
      }
    },
    [announce, dialog, documents.remap, project.project, project.renameEntry],
  );

  /** Move an entry, rejecting ancestor cycles and collisions before the host is asked. */
  const submitMove = useCallback(
    async (parent: string) => {
      if (dialog?.kind !== "move") return;
      const entry = findEntry(project.project?.entries ?? [], dialog.path);
      if (!entry) {
        setDialogError("That entry is no longer in the project.");
        return;
      }
      if (entry.kind === "folder" && isPathWithin(parent, dialog.path)) {
        setDialogError("A folder cannot be moved inside itself.");
        return;
      }
      if (parent === directoryOf(dialog.path)) {
        setDialog(null);
        return;
      }
      if (
        hasSiblingName(
          project.project?.entries ?? [],
          parent,
          entry.name,
          dialog.path,
        )
      ) {
        setDialogError("An item with that name already exists in that folder.");
        return;
      }
      const nextPath = childPath(parent, entry.name);
      try {
        await project.moveEntry(dialog.path, parent);
        documents.remap(dialog.path, nextPath, entry.kind === "folder");
        setDialog(null);
        announce(`${entry.name} moved.`, "info");
      } catch (failure) {
        setDialogError(errorMessage(failure));
      }
    },
    [announce, dialog, documents.remap, project.moveEntry, project.project],
  );

  /** Reload a conflicting file only after the user explicitly chooses the host version. */
  const reloadConflict = useCallback(async () => {
    if (dialog?.kind !== "conflict") return;
    const outcome = await documents.reload(dialog.path);
    if (!outcome.ok) {
      setDialogError(outcome.message ?? "The file could not be reloaded.");
      return;
    }
    setDialog(null);
    announce("Reloaded the file from disk.", "info");
  }, [announce, dialog, documents.reload]);

  const keepConflictDraft = useCallback(() => {
    setDialog(null);
    announce(
      "Your draft is preserved. Saving again will still require the file on disk to match.",
      "info",
    );
  }, [announce]);

  const saveActive = useCallback(async () => {
    if (!documents.activePath) return;
    const outcome = await documents.save(documents.activePath);
    if (!outcome.ok) handleSaveFailure(outcome);
  }, [documents.activePath, documents.save, handleSaveFailure]);

  const saveAll = useCallback(async () => {
    const outcome = await documents.saveAll();
    if (!outcome.ok) handleSaveFailure(outcome);
  }, [documents.saveAll, handleSaveFailure]);

  const buildProject = useCallback(() => build.build(), [build.build]);
  const cancelBuild = useCallback(() => build.cancel(), [build.cancel]);

  /** Open the diagnostic's actual source file and ask Monaco to reveal its line. */
  const openDiagnostic = useCallback(
    async (diagnostic: BuildDiagnostic) => {
      if (!project.project) return;
      if (!diagnostic.path) {
        announce("This diagnostic has no source location.", "info");
        return;
      }
      const path = normalizeDiagnosticPath(
        diagnostic.path,
        project.project.root,
      );
      if (!path) {
        announce("This diagnostic points outside the project tree.", "error");
        return;
      }
      if (!findEntry(project.project.entries, path)) {
        announce(
          "The diagnostic source file is not in the project tree.",
          "error",
        );
        return;
      }
      await documents.open(path);
      if (diagnostic.line)
        documents.requestReveal(path, diagnostic.line, diagnostic.column ?? 1);
    },
    [announce, documents, project.project],
  );

  /** Close every tab; only reached after the user explicitly confirms discarding. */
  const discardAll = useCallback(() => {
    for (const path of documents.openPaths) documents.close(path);
  }, [documents]);

  return {
    project,
    session,
    documents,
    build,
    parameters,
    dialog,
    dialogError,
    dialogBusy: project.busy || closingTabs,
    notice,
    dirty,
    sourceFile,
    openFolder,
    useExample,
    refreshProject,
    retrySession,
    retryStoredProject,
    requestCreate,
    requestRename,
    requestMove,
    requestClose,
    requestCloseTabs,
    resolveUnsaved,
    resolveCloseTab,
    submitCreate,
    submitRename,
    submitMove,
    reloadConflict,
    keepConflictDraft,
    saveActive,
    saveAll,
    buildProject,
    cancelBuild,
    openDiagnostic,
    dismissDialog,
    dismissNotice: () => setNotice(null),
    clearDialogError: () => setDialogError(""),
    discardAll,
  };
}

/** The controller shape consumed by the workspace presentation components. */
export type WorkspaceController = ReturnType<typeof useWorkspace>;

/** Close tabs whose files disappeared after a refresh, preserving any dirty draft. */
function reconcileMissingTabs(
  entries: WorkspaceEntry[],
  documents: WorkspaceDocumentsController,
  announce: (text: string, tone: "info" | "error") => void,
) {
  for (const path of documents.openPaths) {
    if (findEntry(entries, path)) continue;
    if (documents.documents[path]?.dirty) {
      announce(
        `${nameOf(path)} is no longer in the project. Your draft is preserved.`,
        "error",
      );
      continue;
    }
    documents.close(path);
  }
}
