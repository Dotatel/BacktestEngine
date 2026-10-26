import { useCallback, useEffect, useRef } from "react";

/** Combine independently mounted workspace and assistant persistence before window close. */
export function useWorkspaceFlush(
  register?: (flush: (() => Promise<void>) | null) => void,
) {
  const workspace = useRef<(() => Promise<void>) | null>(null);
  const assistant = useRef<(() => Promise<void>) | null>(null);
  const registerWorkspace = useCallback(
    (flush: (() => Promise<void>) | null) => {
      workspace.current = flush;
    },
    [],
  );
  const registerAssistant = useCallback(
    (flush: (() => Promise<void>) | null) => {
      assistant.current = flush;
    },
    [],
  );
  useEffect(() => {
    register?.(async () => {
      await workspace.current?.();
      await assistant.current?.();
    });
    return () => register?.(null);
  }, [register]);
  return { registerWorkspace, registerAssistant };
}
