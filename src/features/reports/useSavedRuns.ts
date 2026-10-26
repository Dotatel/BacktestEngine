import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SavedRunPage,
  SavedRunSelection,
  SavedRunsBridge,
  SavedRunSummary,
} from "@/lib/saved-runs-contract";

/** Share restoration/selection lifecycle with Reports without putting native persistence in presentation. */
export interface SavedRunHistoryOptions {
  bridge?: SavedRunsBridge;
  projectRoot: string | null;
  active: boolean;
  blocked: boolean;
  onSelected?: (selection: SavedRunSelection) => void;
}

/** Restore only the explicit project pointer, then browse bounded metadata pages and verify user selections. */
export function useSavedRuns({
  bridge,
  projectRoot,
  active,
  blocked,
  onSelected,
}: SavedRunHistoryOptions) {
  const [page, setPage] = useState<SavedRunPage | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "restoring" | "listing" | "opening"
  >("idle");
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [loadedProject, setLoadedProject] = useState(projectRoot);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const project = useRef(projectRoot);
  const restoreAttempt = useRef<string | null>(null);
  const inFlight = useRef(false);
  const callback = useRef(onSelected);
  project.current = projectRoot;
  callback.current = onSelected;

  /** Publish only a same-project, successfully reparsed native result; never inspect catalogue metrics. */
  const accept = useCallback(
    (selection: SavedRunSelection | null, row?: SavedRunSummary) => {
      if (!selection) return;
      verifySelection(selection, projectRoot, row);
      callback.current?.(selection);
      setRevision((value) => value + 1);
    },
    [projectRoot],
  );

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    restoreAttempt.current = null;
    setPage(null);
    setError("");
    setRestoreError("");
    setLoadedProject(projectRoot);
    setPhase("idle");
    setRestored(false);
    return () => {
      generation.current += 1;
    };
  }, [bridge, projectRoot]);

  /** A failed pointer remains recoverable by explicit retry; it never falls back to a different recorded row. */
  const restore = useCallback(async () => {
    if (!bridge?.native || !projectRoot || blocked || inFlight.current) return;
    const request = generation.current;
    restoreAttempt.current = projectRoot;
    inFlight.current = true;
    setPhase("restoring");
    setRestoreError("");
    try {
      const selection = await bridge.restoreSelected(projectRoot);
      if (request !== generation.current || project.current !== projectRoot)
        return;
      accept(selection);
    } catch (failure) {
      if (request === generation.current)
        setRestoreError(historyError(failure));
    } finally {
      if (request === generation.current) {
        inFlight.current = false;
        setPhase("idle");
        setRestored(true);
      }
    }
  }, [accept, blocked, bridge, projectRoot]);

  useEffect(() => {
    if (restoreAttempt.current !== projectRoot) void restore();
  }, [projectRoot, restore]);

  /** Replace a page instead of accumulating unbounded rows; opaque native cursors expire and support forward browsing. */
  const browse = useCallback(
    async (cursor: string | null = null) => {
      if (!bridge?.native || !projectRoot || blocked || inFlight.current)
        return;
      const request = generation.current;
      inFlight.current = true;
      setPhase("listing");
      setError("");
      try {
        const next = await bridge.list(projectRoot, cursor, 25);
        if (request !== generation.current || project.current !== projectRoot)
          return;
        verifyPage(next, projectRoot);
        setPage(next);
      } catch (failure) {
        if (request === generation.current) setError(historyError(failure));
      } finally {
        if (request === generation.current) {
          inFlight.current = false;
          setPhase("idle");
        }
      }
    },
    [blocked, bridge, projectRoot],
  );

  useEffect(() => {
    if (active && restored && !page) void browse();
  }, [active, browse, page, restored]);

  /** Revalidate a specific native-issued row before updating the selected report or any workspace result. */
  const open = useCallback(
    async (row: SavedRunSummary) => {
      if (!bridge?.native || !projectRoot || blocked || inFlight.current)
        return;
      const request = generation.current;
      inFlight.current = true;
      setPhase("opening");
      setError("");
      try {
        const selection = await bridge.select(
          projectRoot,
          row.runId,
          row.completionSha256,
        );
        if (request !== generation.current || project.current !== projectRoot)
          return;
        accept(selection, row);
        setRestoreError("");
      } catch (failure) {
        if (request === generation.current) setError(historyError(failure));
      } finally {
        if (request === generation.current) {
          inFlight.current = false;
          setPhase("idle");
        }
      }
    },
    [accept, blocked, bridge, projectRoot],
  );

  const sameProject = loadedProject === projectRoot;
  const ready = !bridge?.native || !projectRoot || (sameProject && restored);
  return {
    page: sameProject ? page : null,
    phase,
    error: sameProject ? error : "",
    restoreError: sameProject ? restoreError : "",
    ready,
    revision,
    restore,
    browse,
    open,
  };
}

/** Reject mismatched bridge responses before exposing their metrics to other workspace stages. */
function verifySelection(
  selection: SavedRunSelection,
  projectRoot: string | null,
  row?: SavedRunSummary,
) {
  if (
    selection.projectRoot !== projectRoot ||
    !selection.run.success ||
    selection.run.status !== "completed" ||
    !selection.run.reportSha256 ||
    !selection.run.replayReceiptSha256
  )
    throw new Error(
      "Saved evidence does not match this project or a completed verified run. Refresh history.",
    );
  if (
    row &&
    (selection.run.runId !== row.runId ||
      selection.completionSha256 !== row.completionSha256)
  )
    throw new Error(
      "Saved evidence does not match the selected run. Refresh history.",
    );
}

/** Bound displayed pages and reject foreign project metadata; native verification remains authoritative. */
function verifyPage(page: SavedRunPage, projectRoot: string) {
  if (
    page.rows.length > 25 ||
    page.rows.some(
      (row) =>
        row.projectRoot !== projectRoot ||
        row.verification !== "recordedNotOpened",
    )
  )
    throw new Error(
      "Saved history returned an invalid page for this project. Refresh history.",
    );
}

/** Preserve the native recovery diagnostic without claiming that damaged evidence was restored. */
function historyError(failure: unknown) {
  return failure instanceof Error ? failure.message : String(failure);
}
