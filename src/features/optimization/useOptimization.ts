import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExecutionBridge,
  ExecutionDataset,
  ExecutionSymbolSpec,
} from "@/lib/execution-contract";
import type {
  OptimizationBridge,
  OptimizationRunRequest,
  OptimizationRunResult,
} from "@/lib/optimization-contract";
import { errorMessage } from "@/lib/preferences";

/** Catalog and native process lifecycle stay separate from search-form presentation. */
export function useOptimization(
  bridge: OptimizationBridge,
  execution: ExecutionBridge,
  projectRoot: string | null,
  buildIdentity: string,
  active: boolean,
) {
  const [datasets, setDatasets] = useState<ExecutionDataset[]>([]);
  const [symbolSpecs, setSymbolSpecs] = useState<ExecutionSymbolSpec[]>([]);
  const [result, setResult] = useState<OptimizationRunResult | null>(null);
  const [lastGood, setLastGood] = useState<OptimizationRunResult | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "loading" | "running" | "cancelling"
  >("idle");
  const [error, setError] = useState("");
  const generation = useRef(0),
    flight = useRef(false);
  const identity = `${projectRoot ?? ""}\n${buildIdentity}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const previousActive = useRef(active);
  const evidenceIdentity = useRef("");
  const phaseRef = useRef(phase);

  /** Restore only a host-selected successful result; missing records never become inferred evidence. */
  const refresh = useCallback(async () => {
    if (flight.current || !projectRoot || !bridge.native) return;
    const token = ++generation.current;
    phaseRef.current = "loading";
    setPhase("loading");
    setError("");
    try {
      const [data, profiles, saved] = await Promise.all([
        execution.listDatasets(),
        execution.listSymbolSpecs(),
        bridge.lastGoodResult(),
      ]);
      if (token !== generation.current || currentIdentity.current !== identity)
        return;
      if (saved && saved.projectRoot !== projectRoot)
        throw new Error(
          "Saved optimization belongs to another project. Refresh the selected project.",
        );
      setDatasets(data);
      setSymbolSpecs(profiles);
      evidenceIdentity.current = identity;
      setResult(saved);
      setLastGood(saved);
    } catch (failure) {
      if (token === generation.current) setError(errorMessage(failure));
    } finally {
      if (token === generation.current) {
        phaseRef.current = "idle";
        setPhase("idle");
      }
    }
  }, [bridge, execution, identity, projectRoot]);

  useEffect(() => {
    generation.current += 1;
    setResult(null);
    setLastGood(null);
    setDatasets([]);
    setSymbolSpecs([]);
    if (flight.current) {
      phaseRef.current = "cancelling";
      setPhase("cancelling");
      void bridge.cancel().catch(() => {});
    } else if (active && projectRoot) void refresh();
    else {
      phaseRef.current = "idle";
      setPhase("idle");
    }
    return () => {
      generation.current += 1;
      if (flight.current) void bridge.cancel().catch(() => {});
    };
  }, [bridge, refresh]);

  useEffect(() => {
    const becameActive = active && !previousActive.current;
    previousActive.current = active;
    if (becameActive) void refresh();
  }, [active, refresh]);

  /** Synchronous latch prevents duplicate IPC; identity checks discard late responses after project/build changes. */
  const run = useCallback(
    async (request: OptimizationRunRequest) => {
      if (
        flight.current ||
        phaseRef.current !== "idle" ||
        !bridge.native ||
        !projectRoot
      )
        return;
      flight.current = true;
      phaseRef.current = "running";
      const token = generation.current;
      setPhase("running");
      setError("");
      setResult(null);
      try {
        const completed = await bridge.run(request);
        if (
          token !== generation.current ||
          currentIdentity.current !== identity
        )
          return;
        if (
          completed.projectRoot !== projectRoot ||
          completed.strategy !== request.strategy
        )
          throw new Error(
            "Optimization response does not match the selected project and strategy.",
          );
        setResult(completed);
        evidenceIdentity.current = identity;
        if (completed.success) setLastGood(completed);
      } catch (failure) {
        if (token === generation.current) setError(errorMessage(failure));
      } finally {
        flight.current = false;
        phaseRef.current = "idle";
        setPhase("idle");
      }
    },
    [bridge, identity, phase, projectRoot],
  );

  /** Cancellation remains busy until the actual host and its descendant processes have stopped. */
  const cancel = useCallback(async () => {
    if (!flight.current || phaseRef.current !== "running") return;
    phaseRef.current = "cancelling";
    setPhase("cancelling");
    try {
      await bridge.cancel();
    } catch (failure) {
      setError(errorMessage(failure));
      phaseRef.current = "running";
      setPhase("running");
    }
  }, [bridge, phase]);

  return {
    datasets,
    symbolSpecs,
    result: evidenceIdentity.current === identity ? result : null,
    lastGood: evidenceIdentity.current === identity ? lastGood : null,
    phase,
    error,
    refresh,
    run,
    cancel,
  };
}
