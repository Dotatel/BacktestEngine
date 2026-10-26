import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExecutionBridge,
  ExecutionRunResult,
} from "@/lib/execution-contract";
import type { SelectedReport } from "@/lib/reports-contract";
import type {
  FullValidationBridge,
  FullValidationResult,
} from "@/lib/full-validation";
import { errorMessage } from "@/lib/preferences";
import {
  fullValidationDefaults,
  fullValidationRequest,
} from "./full-validation-form";

/** Bind retained scenario work to the currently reviewed native run; ignore every late response. */
export function useFullValidation(
  bridge: FullValidationBridge,
  executions: ExecutionBridge,
  source: SelectedReport | null,
) {
  const [form, setForm] = useState({ ...fullValidationDefaults });
  const [baseline, setBaseline] = useState<ExecutionRunResult | null>(null);
  const [result, setResult] = useState<FullValidationResult | null>(null);
  const [phase, setPhase] = useState<
    "loading" | "idle" | "running" | "cancelling"
  >("idle");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const flight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (flight.current) void bridge.cancel().catch(() => {});
    };
  }, [bridge]);
  useEffect(() => {
    const token = ++generation.current;
    setBaseline(null);
    setResult(null);
    setError("");
    if (!flight.current) setPhase("idle");
    if (flight.current) {
      setPhase("cancelling");
      void bridge.cancel().catch((failure) => {
        if (token !== generation.current || !flight.current) return;
        setError(errorMessage(failure));
        setPhase("running");
      });
    }
    if (!source || !bridge.native || !executions.native) return;
    if (!flight.current) setPhase("loading");
    void Promise.all([executions.lastGoodResult(), bridge.lastGoodResult()])
      .then(([run, saved]) => {
        if (token !== generation.current) return;
        if (
          !run ||
          !run.success ||
          run.runId !== source.runId ||
          run.reportSha256 !== source.reportSha256
        )
          throw new Error(
            "The saved baseline changed. Refresh saved evidence before engine validation.",
          );
        setBaseline(run);
        if (saved && matchingFullResult(saved, source, run)) setResult(saved);
      })
      .catch((failure) => {
        if (token === generation.current) setError(errorMessage(failure));
      })
      .finally(() => {
        if (token === generation.current && !flight.current) setPhase("idle");
      });
    return () => {
      generation.current += 1;
    };
  }, [bridge, executions, source]);

  /** Submit only the exact frozen baseline and preserve prior evidence on any failure. */
  const run = useCallback(async () => {
    if (
      flight.current ||
      phase !== "idle" ||
      !source ||
      !baseline?.replayReceiptSha256
    )
      return;
    setError("");
    let request;
    try {
      request = fullValidationRequest(
        form,
        baseline.runId,
        baseline.replayReceiptSha256,
      );
    } catch (failure) {
      setError(errorMessage(failure));
      return;
    }
    const token = generation.current;
    flight.current = true;
    setPhase("running");
    try {
      const completed = await bridge.run(request);
      if (token !== generation.current) return;
      const current = await executions.lastGoodResult();
      if (token !== generation.current) return;
      if (!current || !matchingFullResult(completed, source, current))
        throw new Error(
          "The selected baseline changed while validation ran. Refresh saved evidence.",
        );
      setResult(completed);
    } catch (failure) {
      if (token === generation.current) setError(errorMessage(failure));
    } finally {
      flight.current = false;
      if (mounted.current) setPhase("idle");
    }
  }, [baseline, bridge, executions, form, phase, source]);

  /** Keep cancellation visible until the owning native run actually returns. */
  const cancel = useCallback(async () => {
    if (!flight.current || phase !== "running") return;
    const token = generation.current;
    setPhase("cancelling");
    try {
      await bridge.cancel();
    } catch (failure) {
      if (token !== generation.current || !flight.current) return;
      setError(errorMessage(failure));
      setPhase("running");
    }
  }, [bridge, phase]);
  return { form, setForm, baseline, result, phase, error, run, cancel };
}

/** Every displayed full result must retain the reviewed report and replay receipt identities. */
function matchingFullResult(
  result: FullValidationResult,
  source: SelectedReport,
  baseline: ExecutionRunResult,
): boolean {
  return (
    result.projectRoot === source.projectRoot &&
    result.executionRunId === source.runId &&
    result.sourceReportSha256 === source.reportSha256 &&
    baseline.runId === source.runId &&
    baseline.reportSha256 === source.reportSha256 &&
    result.replayReceiptSha256 === baseline.replayReceiptSha256
  );
}
