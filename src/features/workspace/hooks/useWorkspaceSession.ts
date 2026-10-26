import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkspaceBridge,
  WorkspaceSession,
} from "@/lib/workspace-contract";
import { errorMessage } from "@/lib/preferences";
import { emptySession, mergeSession, normalizeSession } from "../lib/session";

/** Durable workspace view state and its serialized, retryable save queue. */
export interface WorkspaceSessionController {
  session: WorkspaceSession | null;
  loading: boolean;
  error: string;
  saveError: string;
  reload(): Promise<void>;
  persist(patch: Partial<WorkspaceSession>): Promise<void>;
  flush(): Promise<void>;
}

/**
 * Load and persist the bridge-owned workspace session. Patches merge into the latest snapshot and
 * write serially. A failed write stays visible, later writes retry the newest snapshot, and flush
 * rejects while the latest snapshot is not durable so native close cannot lose presets silently.
 */
export function useWorkspaceSession(
  bridge: WorkspaceBridge,
): WorkspaceSessionController {
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const latest = useRef<WorkspaceSession>(emptySession());
  const durable = useRef<WorkspaceSession | null>(null);
  const loaded = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const saveErrorRef = useRef("");

  /** Read one validated session snapshot; failures remain visible instead of overwriting stored state. */
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    setSaveError("");
    saveErrorRef.current = "";
    loaded.current = false;
    durable.current = null;
    try {
      const stored = normalizeSession(await bridge.loadSession());
      latest.current = stored;
      durable.current = stored;
      setSession(stored);
      loaded.current = true;
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Save one complete snapshot and keep the failure visible until a later write succeeds. */
  const write = useCallback(
    async (snapshot: WorkspaceSession): Promise<void> => {
      const task = queue.current.then(() => bridge.saveSession(snapshot));
      queue.current = task.then(
        () => {
          durable.current = snapshot;
          if (!saveErrorRef.current) return;
          saveErrorRef.current = "";
          setSaveError("");
        },
        (failure) => {
          const message = errorMessage(failure);
          saveErrorRef.current = message;
          setSaveError(message);
        },
      );
      await task;
    },
    [bridge],
  );

  /** Track a view-state patch immediately and resolve once that snapshot is durable. */
  const persist = useCallback(
    (patch: Partial<WorkspaceSession>): Promise<void> => {
      const next = mergeSession(latest.current, patch);
      latest.current = next;
      setSession(next);
      if (!loaded.current) return Promise.resolve();
      return write(next);
    },
    [write],
  );

  /** Wait for queued writes, retry the latest snapshot once, and reject if it is still not durable. */
  const flush = useCallback(async (): Promise<void> => {
    await queue.current;
    if (!loaded.current || durable.current === latest.current) return;
    await write(latest.current);
  }, [write]);

  return { session, loading, error, saveError, reload, persist, flush };
}
