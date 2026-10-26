import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceBridge, WorkspaceBuild } from "@/lib/workspace-contract";
import { errorMessage } from "@/lib/preferences";
import type { SaveOutcome } from "./useWorkspaceDocuments";

/** The visible phase of the single allowed build request. */
export type BuildPhase = "idle" | "saving" | "building" | "cancelling";

/** Real compiler evidence, cancellation and stale-after-edit reporting. */
export interface WorkspaceBuildController {
  result: WorkspaceBuild | null;
  phase: BuildPhase;
  error: string;
  notice: string;
  stale: boolean;
  build(): Promise<void>;
  cancel(): Promise<void>;
  reset(): void;
}

/**
 * Save every draft before asking the host to compile, reject overlapping requests, support a real
 * cancel request and mark a retained result stale as soon as source is edited or saved again.
 */
export function useWorkspaceBuild(
  bridge: WorkspaceBridge,
  saveAll: () => Promise<SaveOutcome>,
  savedEpoch: number,
  dirty: boolean,
): WorkspaceBuildController {
  const [result, setResult] = useState<WorkspaceBuild | null>(null);
  const [phase, setPhase] = useState<BuildPhase>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [builtEpoch, setBuiltEpoch] = useState(-1);
  const phaseRef = useRef<BuildPhase>("idle");
  const epochRef = useRef(savedEpoch);
  const canceled = useRef(false);

  useEffect(() => {
    epochRef.current = savedEpoch;
  }, [savedEpoch]);

  /** Keep the synchronous request guard and the rendered phase in one step. */
  const changePhase = useCallback((next: BuildPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const build = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    canceled.current = false;
    setError("");
    setNotice("");
    setResult(null);
    changePhase("saving");
    const saved = await saveAll();
    if (!saved.ok) {
      setError(saved.message ?? "Save the changed files before building.");
      changePhase("idle");
      return;
    }
    if (canceled.current) {
      canceled.current = false;
      setNotice("Build canceled before compilation started.");
      changePhase("idle");
      return;
    }
    const epoch = saved.epoch ?? epochRef.current;
    changePhase("building");
    try {
      const outcome = await bridge.build();
      if (canceled.current) {
        setNotice("Build canceled.");
        setResult(null);
      } else {
        setResult(outcome);
        setBuiltEpoch(epoch);
        setNotice(outcome.success ? "Build succeeded." : "Build failed.");
      }
    } catch (failure) {
      setResult(null);
      if (canceled.current) setNotice("Build canceled.");
      else setError(errorMessage(failure));
    } finally {
      canceled.current = false;
      changePhase("idle");
    }
  }, [bridge, changePhase, saveAll]);

  /** Ask the host to stop the running compiler; the promise above settles the visible phase. */
  const cancel = useCallback(async () => {
    if (phaseRef.current === "idle") return;
    canceled.current = true;
    changePhase("cancelling");
    try {
      await bridge.cancelBuild();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, [bridge, changePhase]);

  const reset = useCallback(() => {
    canceled.current = false;
    setResult(null);
    setError("");
    setNotice("");
    setBuiltEpoch(-1);
    changePhase("idle");
  }, [changePhase]);

  const stale = useMemo(
    () => Boolean(result?.success) && (dirty || savedEpoch !== builtEpoch),
    [builtEpoch, dirty, result, savedEpoch],
  );

  return { result, phase, error, notice, stale, build, cancel, reset };
}
