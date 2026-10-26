import { useEffect, useState } from "react";
import type { DesktopBridge } from "@/lib/desktop";
import { errorMessage } from "@/lib/preferences";

/** Observe native maximize state, releasing even late-created listeners on unmount; report registration failures to the shell. */
export function useMaximizedWindow(
  bridge: DesktopBridge,
  onError: (message: string) => void,
) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    bridge
      .observeMaximized((value) => {
        if (!disposed) setMaximized(value);
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unsubscribe = cleanup;
      })
      .catch((error) => onError(errorMessage(error)));
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [bridge, onError]);
  return maximized;
}
