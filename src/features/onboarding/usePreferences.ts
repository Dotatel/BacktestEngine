import { useCallback, useRef, useState } from "react";
import type { DesktopBridge } from "@/lib/desktop";
import {
  defaultPreferences,
  errorMessage,
  type Preferences,
} from "@/lib/preferences";

type LoadState = "loading" | "ready" | "recovery";
type Failure = { kind: "load" | "save"; message: string } | null;

/** Own setup snapshots and serialized persistence; failed writes retain choices and never silently replace damaged storage. */
export function usePreferences(bridge: DesktopBridge) {
  const [preferences, setPreferences] =
    useState<Preferences>(defaultPreferences);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [failure, setFailure] = useState<Failure>(null);
  const [saving, setSaving] = useState(false);
  const snapshot = useRef(preferences);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const revision = useRef(0);
  const pendingWrites = useRef(0);

  /** Reflect a known snapshot in React and the synchronous event-handler view without writing storage. */
  const reflect = useCallback((next: Preferences) => {
    snapshot.current = next;
    setPreferences(next);
  }, []);

  /** Read validated settings; return null and preserve the original file on a recoverable load failure. */
  const load = useCallback(async () => {
    setLoadState("loading");
    setFailure(null);
    try {
      const saved = await bridge.loadPreferences();
      reflect(saved);
      setLoadState("ready");
      return saved;
    } catch (error) {
      setFailure({ kind: "load", message: errorMessage(error) });
      setLoadState("recovery");
      return null;
    }
  }, [bridge, reflect]);

  /** Queue one durable write and commit only the latest snapshot; report failure without rejecting callers or losing selections. */
  const save = useCallback(
    async (next: Preferences): Promise<boolean> => {
      const writeRevision = ++revision.current;
      pendingWrites.current += 1;
      setSaving(true);
      const operation = queue.current.then(() => bridge.savePreferences(next));
      queue.current = operation.catch(() => {});
      try {
        await operation;
        if (writeRevision === revision.current) reflect(next);
        setFailure(null);
        return true;
      } catch (error) {
        setFailure({ kind: "save", message: errorMessage(error) });
        return false;
      } finally {
        pendingWrites.current -= 1;
        setSaving(pendingWrites.current > 0);
      }
    },
    [bridge, reflect],
  );

  /** Display a choice immediately and persist it in order; an error leaves the selected value available for retry. */
  const update = useCallback(
    (patch: Partial<Preferences>) => {
      const next = { ...snapshot.current, ...patch };
      reflect(next);
      return save(next);
    },
    [reflect, save],
  );

  /** Explicitly back up and reset setup; keep recovery active if the host cannot preserve the old settings. */
  const reset = useCallback(async () => {
    setSaving(true);
    try {
      reflect(await bridge.resetPreferences());
      setFailure(null);
      setLoadState("ready");
      return true;
    } catch (error) {
      setFailure({ kind: "load", message: errorMessage(error) });
      return false;
    } finally {
      setSaving(false);
    }
  }, [bridge, reflect]);

  /** Read the latest selection synchronously so back-to-back actions never construct a stale write. */
  const read = useCallback(() => snapshot.current, []);

  /** Wait for in-flight writes before closing the native window; save errors remain visible through failure state. */
  const flush = useCallback(() => queue.current, []);

  /** Retry the latest selected snapshot after a recoverable storage error. */
  const retry = useCallback(() => save(snapshot.current), [save]);

  return {
    preferences,
    loadState,
    failure,
    saving,
    load,
    save,
    update,
    reset,
    read,
    flush,
    retry,
  };
}
