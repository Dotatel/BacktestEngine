import { useCallback, useMemo, useRef, useState } from "react";
import type {
  WorkspaceBridge,
  WorkspaceDocument,
} from "@/lib/workspace-contract";
import { errorMessage } from "@/lib/preferences";
import { remapPath } from "../lib/paths";

/** The result of one save attempt, including a host-revision conflict and the saved-source epoch. */
export interface SaveOutcome {
  ok: boolean;
  conflict: boolean;
  path?: string;
  message?: string;
  epoch?: number;
}

/** One open editor document with its savepoint, revision and honest loading/conflict state. */
export interface WorkspaceDocumentView {
  path: string;
  draft: string;
  saved: string;
  revision: string;
  /** Changes only after an authoritative read/reload, independently of saves and local typing. */
  readVersion: number;
  status: "loading" | "ready" | "error";
  error: string;
  conflict: boolean;
  saving: boolean;
  dirty: boolean;
}

/** A request to reveal a compiler diagnostic in the active Monaco model. */
export interface RevealRequest {
  path: string;
  line: number;
  column: number;
  nonce: number;
}

/** Open tabs, drafts, save/conflict handling and diagnostic reveal requests. */
export interface WorkspaceDocumentsController {
  documents: Record<string, WorkspaceDocumentView>;
  openPaths: string[];
  activePath: string | null;
  dirtyPaths: string[];
  savedEpoch: number;
  reveal: RevealRequest | null;
  open(path: string): Promise<void>;
  restore(paths: string[], active: string | null): Promise<void>;
  activate(path: string): void;
  close(path: string): void;
  closeMany(paths: string[], discardDrafts?: boolean): boolean;
  update(path: string, draft: string): void;
  save(path: string): Promise<SaveOutcome>;
  saveAll(): Promise<SaveOutcome>;
  saveSelected(paths: string[]): Promise<SaveOutcome>;
  reload(path: string): Promise<SaveOutcome>;
  remap(from: string, to: string, isFolder: boolean): void;
  requestReveal(path: string, line: number, column: number): void;
  clearReveal(): void;
}

interface DocumentRecord {
  draft: string;
  saved: string;
  revision: string;
  readVersion: number;
  status: "loading" | "ready" | "error";
  error: string;
  conflict: boolean;
  saving: boolean;
}

const emptyRecord: DocumentRecord = {
  draft: "",
  saved: "",
  revision: "",
  readVersion: 0,
  status: "loading",
  error: "",
  conflict: false,
  saving: false,
};

/**
 * Own editor drafts and host revisions. Drafts are never cleared by a failed save, a rejected
 * save is checked against a fresh read, project switches invalidate late reads/saves, and callers
 * awaiting a save always wait for the actual write rather than an optimistic success.
 */
export function useWorkspaceDocuments(
  bridge: WorkspaceBridge,
): WorkspaceDocumentsController {
  const [records, setRecords] = useState<Record<string, DocumentRecord>>({});
  const [openPaths, setOpenPathsState] = useState<string[]>([]);
  const [activePath, setActivePathState] = useState<string | null>(null);
  const [savedEpoch, setSavedEpoch] = useState(0);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const recordsRef = useRef<Record<string, DocumentRecord>>({});
  const openRef = useRef<string[]>([]);
  const activeRef = useRef<string | null>(null);
  const loadTokens = useRef<Record<string, number>>({});
  const readVersion = useRef(0);
  const generation = useRef(0);
  const savedEpochRef = useRef(0);
  const pendingSaves = useRef<Map<string, Promise<SaveOutcome>>>(new Map());

  /** Commit record state and its synchronous ref together for save/load operations. */
  const commit = useCallback(
    (
      update: (
        previous: Record<string, DocumentRecord>,
      ) => Record<string, DocumentRecord>,
    ) => {
      const next = update(recordsRef.current);
      recordsRef.current = next;
      setRecords(next);
    },
    [],
  );

  const setOpenPaths = useCallback((next: string[]) => {
    openRef.current = next;
    setOpenPathsState(next);
  }, []);

  const setActivePath = useCallback((next: string | null) => {
    activeRef.current = next;
    setActivePathState(next);
  }, []);

  /** Test whether a load started before the latest project restore. */
  const isStaleLoad = useCallback(
    (path: string, token: number, loadGeneration: number) =>
      generation.current !== loadGeneration ||
      token !== loadTokens.current[path],
    [],
  );

  /** Read one document and replace its savepoint unless a newer read superseded it. */
  const readDocument = useCallback(
    async (path: string): Promise<boolean> => {
      const token = (loadTokens.current[path] ?? 0) + 1;
      const loadGeneration = generation.current;
      loadTokens.current[path] = token;
      commit((previous) => {
        const current = previous[path] ?? emptyRecord;
        return {
          ...previous,
          [path]: { ...current, status: "loading", error: "" },
        };
      });
      try {
        const document = await bridge.readDocument(path);
        if (isStaleLoad(path, token, loadGeneration)) return false;
        readVersion.current += 1;
        commit((previous) => ({
          ...previous,
          [path]: recordFromDocument(document, readVersion.current),
        }));
        return true;
      } catch (failure) {
        if (isStaleLoad(path, token, loadGeneration)) return false;
        commit((previous) => ({
          ...previous,
          [path]: {
            ...(previous[path] ?? emptyRecord),
            status: "error",
            error: errorMessage(failure),
          },
        }));
        return false;
      }
    },
    [bridge, commit, isStaleLoad],
  );

  /** Open a tab and load it once; an existing ready draft is never re-read behind the user. */
  const open = useCallback(
    async (path: string) => {
      if (!openRef.current.includes(path))
        setOpenPaths([...openRef.current, path]);
      setActivePath(path);
      if (recordsRef.current[path]?.status === "ready") return;
      await readDocument(path);
    },
    [readDocument, setActivePath, setOpenPaths],
  );

  /** Replace tabs after a project switch and invalidate every read/save from the old project. */
  const restore = useCallback(
    async (paths: string[], active: string | null) => {
      generation.current += 1;
      const unique = [...new Set(paths)];
      commit(() => ({}));
      savedEpochRef.current = 0;
      setSavedEpoch(0);
      setReveal(null);
      setOpenPaths(unique);
      setActivePath(
        active && unique.includes(active) ? active : (unique[0] ?? null),
      );
      await Promise.all(unique.map((path) => readDocument(path)));
    },
    [commit, readDocument, setActivePath, setOpenPaths],
  );

  const activate = useCallback(
    (path: string) => {
      if (openRef.current.includes(path)) setActivePath(path);
    },
    [setActivePath],
  );

  /** Close one clean tab, choosing a neighboring tab as the new active editor. */
  const close = useCallback(
    (path: string) => {
      const paths = openRef.current;
      const index = paths.indexOf(path);
      const next = paths.filter((candidate) => candidate !== path);
      delete loadTokens.current[path];
      commit((previous) => {
        const copy = { ...previous };
        delete copy[path];
        return copy;
      });
      setOpenPaths(next);
      if (activeRef.current === path)
        setActivePath(next[Math.max(0, index - 1)] ?? null);
      setReveal((current) => (current?.path === path ? null : current));
    },
    [commit, setActivePath, setOpenPaths],
  );

  /** Close a captured set atomically; pending writes and unapproved dirty drafts leave every tab intact. */
  const closeMany = useCallback(
    (paths: string[], discardDrafts = false): boolean => {
      const selected = new Set(paths);
      const targets = openRef.current.filter((path) => selected.has(path));
      if (targets.some((path) => recordsRef.current[path]?.saving))
        return false;
      if (!discardDrafts && hasDirtyDrafts(targets, recordsRef.current))
        return false;
      const oldPaths = openRef.current;
      const next = oldPaths.filter((path) => !selected.has(path));
      const activeIndex = oldPaths.indexOf(activeRef.current ?? "");
      for (const path of targets) delete loadTokens.current[path];
      commit((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([path]) => !selected.has(path)),
        ),
      );
      setOpenPaths(next);
      if (activeRef.current && selected.has(activeRef.current)) {
        const preceding = oldPaths
          .slice(0, activeIndex)
          .filter((path) => !selected.has(path));
        setActivePath(preceding.at(-1) ?? next[0] ?? null);
      }
      setReveal((current) =>
        current && selected.has(current.path) ? null : current,
      );
      return true;
    },
    [commit, setActivePath, setOpenPaths],
  );

  /** Record every edit locally without touching the savepoint or destroying a conflict flag. */
  const update = useCallback(
    (path: string, draft: string) => {
      commit((previous) => {
        const current = previous[path];
        if (!current || current.status !== "ready") return previous;
        return { ...previous, [path]: { ...current, draft } };
      });
    },
    [commit],
  );

  /** Write one captured draft and preserve any newer edits made while the write was pending. */
  const runSave = useCallback(
    async (path: string): Promise<SaveOutcome> => {
      const record = recordsRef.current[path];
      if (!record)
        return {
          ok: false,
          conflict: false,
          path,
          message: "Open the file before saving it.",
        };
      if (record.status === "loading")
        return {
          ok: false,
          conflict: false,
          path,
          message: "This file is still loading. Wait, then save again.",
        };
      if (record.status === "error")
        return {
          ok: false,
          conflict: false,
          path,
          message:
            "This file could not be loaded. Retry loading it before saving.",
        };
      if (record.draft === record.saved)
        return {
          ok: true,
          conflict: false,
          path,
          epoch: savedEpochRef.current,
        };
      const draft = record.draft;
      const revision = record.revision;
      const saveGeneration = generation.current;
      commit((previous) => {
        const current = previous[path];
        if (!current) return previous;
        return { ...previous, [path]: { ...current, saving: true, error: "" } };
      });
      try {
        const saved = await bridge.saveDocument(path, draft, revision);
        if (isStaleSave(path, saveGeneration)) return staleSave(path);
        commit((previous) => {
          const current = previous[path];
          if (!current) return previous;
          return {
            ...previous,
            [path]: {
              ...current,
              draft: current.draft === draft ? saved.content : current.draft,
              saved: saved.content,
              revision: saved.revision,
              status: "ready",
              saving: false,
              conflict: false,
              error: "",
            },
          };
        });
        savedEpochRef.current += 1;
        setSavedEpoch(savedEpochRef.current);
        return {
          ok: true,
          conflict: false,
          path,
          epoch: savedEpochRef.current,
        };
      } catch (failure) {
        if (isStaleSave(path, saveGeneration)) return staleSave(path);
        const conflict = await hasExternalRevision(bridge, path, revision);
        const message = errorMessage(failure);
        commit((previous) => {
          const current = previous[path];
          if (!current) return previous;
          return {
            ...previous,
            [path]: { ...current, saving: false, conflict, error: message },
          };
        });
        return { ok: false, conflict, path, message };
      }
    },
    [bridge, commit],
  );

  /** A save is stale when the project changed or its tab closed before the host answered. */
  const isStaleSave = useCallback(
    (path: string, saveGeneration: number) =>
      generation.current !== saveGeneration || !openRef.current.includes(path),
    [],
  );

  /** Queue one save per path and wait for the actual write, including a newer draft typed meanwhile. */
  const save = useCallback(
    async (path: string): Promise<SaveOutcome> => {
      for (;;) {
        const pending = pendingSaves.current.get(path);
        if (pending) {
          await pending;
          continue;
        }
        const operation = runSave(path);
        pendingSaves.current.set(path, operation);
        const outcome = await operation.finally(() =>
          pendingSaves.current.delete(path),
        );
        if (!outcome.ok) return outcome;
        if (!isRecordDirty(recordsRef.current[path]))
          return {
            ok: true,
            conflict: false,
            path,
            epoch: savedEpochRef.current,
          };
      }
    },
    [runSave],
  );

  /** Save every dirty tab, repeating passes if edits arrive while an earlier write is pending. */
  const saveAll = useCallback(async (): Promise<SaveOutcome> => {
    for (let pass = 0; pass < 3; pass += 1) {
      const failure = await savePaths([...openRef.current], save);
      if (failure) return failure;
      if (!hasDirtyDrafts(openRef.current, recordsRef.current))
        return {
          ok: true,
          conflict: false,
          epoch: savedEpochRef.current,
        };
    }
    return {
      ok: false,
      conflict: false,
      message:
        "Files kept changing while they were being saved. Save all again before building.",
    };
  }, [save]);

  /** Save only a captured tab set, rechecking earlier files for edits and rejecting a changed project generation. */
  const saveSelected = useCallback(
    async (paths: string[]): Promise<SaveOutcome> => {
      const targets = [...new Set(paths)].filter((path) =>
        openRef.current.includes(path),
      );
      const saveGeneration = generation.current;
      for (let pass = 0; pass < 3; pass += 1) {
        if (generation.current !== saveGeneration)
          return staleSave(targets[0] ?? "");
        const failure = await savePaths(targets, save);
        if (failure) return failure;
        if (generation.current !== saveGeneration)
          return staleSave(targets[0] ?? "");
        if (!hasDirtyDrafts(targets, recordsRef.current))
          return { ok: true, conflict: false, epoch: savedEpochRef.current };
      }
      return {
        ok: false,
        conflict: false,
        message:
          "Files kept changing while being saved. Review their drafts before closing.",
      };
    },
    [save],
  );

  /** Explicitly discard a draft after a conflict by reading the host's current content. */
  const reload = useCallback(
    async (path: string): Promise<SaveOutcome> => {
      const loaded = await readDocument(path);
      if (!loaded)
        return {
          ok: false,
          conflict: false,
          path,
          message: "The file could not be read again. Retry reload.",
        };
      savedEpochRef.current += 1;
      setSavedEpoch(savedEpochRef.current);
      return {
        ok: true,
        conflict: false,
        path,
        epoch: savedEpochRef.current,
      };
    },
    [readDocument],
  );

  /** Keep open documents attached to renamed or moved entries. */
  const remap = useCallback(
    (from: string, to: string, isFolder: boolean) => {
      const remapRecord = (path: string, record: DocumentRecord) =>
        [remapPath(path, from, to, isFolder), record] as const;
      commit((previous) =>
        Object.fromEntries(
          Object.entries(previous).map(([path, record]) =>
            remapRecord(path, record),
          ),
        ),
      );
      setOpenPaths(
        openRef.current.map((path) => remapPath(path, from, to, isFolder)),
      );
      setActivePath(
        activeRef.current
          ? remapPath(activeRef.current, from, to, isFolder)
          : null,
      );
      setReveal((current) =>
        current
          ? { ...current, path: remapPath(current.path, from, to, isFolder) }
          : null,
      );
    },
    [commit, setActivePath, setOpenPaths],
  );

  const requestReveal = useCallback(
    (path: string, line: number, column: number) => {
      setReveal({ path, line, column, nonce: Date.now() });
    },
    [],
  );

  const clearReveal = useCallback(() => setReveal(null), []);

  const views = useMemo(() => {
    const entries = Object.entries(records).map(([path, record]) => [
      path,
      documentView(path, record),
    ]);
    return Object.fromEntries(entries);
  }, [records]);

  const dirtyPaths = useMemo(
    () => openPaths.filter((path) => views[path]?.dirty),
    [openPaths, views],
  );

  return {
    documents: views,
    openPaths,
    activePath,
    dirtyPaths,
    savedEpoch,
    reveal,
    open,
    restore,
    activate,
    close,
    closeMany,
    update,
    save,
    saveAll,
    saveSelected,
    reload,
    remap,
    requestReveal,
    clearReveal,
  };
}

/** Build the presentational view from a stored record without mutating it. */
function documentView(
  path: string,
  record: DocumentRecord,
): WorkspaceDocumentView {
  return {
    path,
    draft: record.draft,
    saved: record.saved,
    revision: record.revision,
    readVersion: record.readVersion,
    status: record.status,
    error: record.error,
    conflict: record.conflict,
    saving: record.saving,
    dirty: record.status === "ready" && record.draft !== record.saved,
  };
}

/** Convert an authoritative read into a savepoint and an explicit editor-reset identity. */
function recordFromDocument(
  document: WorkspaceDocument,
  readVersion: number,
): DocumentRecord {
  return {
    draft: document.content,
    saved: document.content,
    revision: document.revision,
    readVersion,
    status: "ready",
    error: "",
    conflict: false,
    saving: false,
  };
}

/** Check whether a rejected save was caused by a host revision that changed after the read. */
async function hasExternalRevision(
  bridge: WorkspaceBridge,
  path: string,
  revision: string,
): Promise<boolean> {
  try {
    const current = await bridge.readDocument(path);
    return current.revision !== revision;
  } catch {
    return false;
  }
}

/** Report a write that completed after its project or tab was replaced without mutating new state. */
function staleSave(path: string): SaveOutcome {
  return {
    ok: false,
    conflict: false,
    path,
    message:
      "The project changed before this save completed. Reopen the file to save it again.",
  };
}

/** Check the open tabs for a draft that is newer than its last durable save. */
function hasDirtyDrafts(
  paths: string[],
  records: Record<string, DocumentRecord>,
): boolean {
  return paths.some((path) => isRecordDirty(records[path]));
}

/** Test one record for a ready draft that differs from its savepoint. */
function isRecordDirty(record: DocumentRecord | undefined): boolean {
  return Boolean(
    record && record.status === "ready" && record.draft !== record.saved,
  );
}

/** Save tabs in order and return the first real failure, if any. */
async function savePaths(
  paths: string[],
  save: (path: string) => Promise<SaveOutcome>,
): Promise<SaveOutcome | null> {
  for (const path of paths) {
    const outcome = await save(path);
    if (!outcome.ok) return outcome;
  }
  return null;
}
