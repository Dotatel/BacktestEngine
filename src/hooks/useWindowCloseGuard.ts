import { useCallback, useEffect, useRef } from "react";
import type { DesktopBridge } from "@/lib/desktop";
import { errorMessage } from "@/lib/preferences";

/** Preserve editor drafts across custom/native close and browser unload; flush only after the app is safe to leave. */
export function useWindowCloseGuard(
  bridge: Pick<DesktopBridge, "observeCloseRequested">,
  dirty: boolean,
  flush: () => Promise<void>,
  onError: (message: string) => void,
) {
  const current = useRef({ dirty, flush });
  current.current = { dirty, flush };

  /** Refuse silent draft loss and surface a direct save/discard recovery path before closing. */
  const canClose = useCallback(async () => {
    if (current.current.dirty) {
      onError(
        "Save your changes or discard them by closing their editor tabs before leaving the workspace.",
      );
      return false;
    }
    try {
      await current.current.flush();
      return true;
    } catch (error) {
      onError(errorMessage(error));
      return false;
    }
  }, [onError]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    bridge
      .observeCloseRequested?.(canClose)
      .then((cleanup) => {
        if (disposed) cleanup();
        else unsubscribe = cleanup;
      })
      .catch((error) => onError(errorMessage(error)));
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [bridge, canClose, onError]);

  useEffect(() => {
    /** Browser tab/navigation close must not silently discard a live editor buffer either. */
    function preserveDraft(event: BeforeUnloadEvent) {
      if (!current.current.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", preserveDraft);
    return () => window.removeEventListener("beforeunload", preserveDraft);
  }, []);
  return canClose;
}
