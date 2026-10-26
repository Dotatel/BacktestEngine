import { useCallback, useEffect, useRef, useState } from "react";
import type { ReportsBridge, SelectedReport } from "@/lib/reports-contract";
import type {
  ValidationBridge,
  ValidationRunResult,
} from "@/lib/validation-contract";
import {
  defaultValidationForm,
  invalidValidationFields,
  validationRequest,
  type ValidationForm,
} from "./validation-form";

/** Project/run-scoped validation lifecycle; native IPC and stale responses stay outside presentation. */
export function useValidation(
  bridge: ValidationBridge,
  reports: ReportsBridge,
  projectRoot: string | null,
  active: boolean,
) {
  const [source, setSource] = useState<SelectedReport | null>(null);
  const [result, setResult] = useState<ValidationRunResult | null>(null);
  const [lastGood, setLastGood] = useState<ValidationRunResult | null>(null);
  const [form, setForm] = useState<ValidationForm>({
    ...defaultValidationForm,
  });
  const [phase, setPhase] = useState<
    "loading" | "idle" | "running" | "cancelling"
  >("loading");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const flight = useRef(false);
  const currentProject = useRef(projectRoot);
  const activeRef = useRef(active);
  const previousActive = useRef(active);
  currentProject.current = projectRoot;
  activeRef.current = active;

  /** Load verified source and only matching native completed evidence; no result is inferred. */
  const refresh = useCallback(async () => {
    if (flight.current) return;
    const token = ++generation.current;
    setSource(null);
    setResult(null);
    setLastGood(null);
    setError("");
    if (!projectRoot) {
      setPhase("idle");
      return;
    }
    setPhase("loading");
    try {
      const [selected, saved] = await Promise.all([
        reports.selected(projectRoot),
        bridge.lastGoodResult(),
      ]);
      if (
        token !== generation.current ||
        currentProject.current !== projectRoot
      )
        return;
      assertProject(selected, projectRoot);
      setSource(selected);
      if (saved && !matchesSource(saved, selected))
        throw new Error(
          "Saved validation does not match the selected project and run. Refresh validation.",
        );
      setResult(saved);
      setLastGood(saved);
    } catch (failure) {
      if (token === generation.current) setError(validationError(failure));
    } finally {
      if (token === generation.current) setPhase("idle");
    }
  }, [bridge, projectRoot, reports]);

  useEffect(() => {
    if (activeRef.current) void refresh();
    else setPhase("idle");
    return () => {
      generation.current += 1;
      if (flight.current) void bridge.cancel().catch(() => {});
      flight.current = false;
    };
  }, [bridge, refresh]);

  useEffect(() => {
    const becameActive = active && !previousActive.current;
    previousActive.current = active;
    if (becameActive) void refresh();
  }, [active, refresh]);

  /** Start one job with synchronous duplicate protection and frozen source identity checks. */
  const run = useCallback(async () => {
    if (!source || !projectRoot || flight.current || phase !== "idle") return;
    setError("");
    let request;
    try {
      request = validationRequest(source.runId, form);
    } catch (failure) {
      setError(validationError(failure));
      return;
    }
    flight.current = true;
    const token = generation.current;
    setPhase("running");
    setResult(null);
    try {
      const completed = await bridge.run(request);
      if (
        token !== generation.current ||
        currentProject.current !== projectRoot
      )
        return;
      if (!matchesSource(completed, source))
        throw new Error(
          "The validation response belongs to another source. Refresh validation.",
        );
      const current = await reports.selected(projectRoot);
      if (
        token !== generation.current ||
        currentProject.current !== projectRoot
      )
        return;
      assertProject(current, projectRoot);
      if (!matchesSource(completed, current)) {
        setSource(current);
        setLastGood(null);
        throw new Error(
          "The selected backtest changed while validation ran. Refresh and validate the current saved run.",
        );
      }
      setResult(completed);
      if (completed.success) setLastGood(completed);
    } catch (failure) {
      if (token === generation.current) setError(validationError(failure));
    } finally {
      if (token === generation.current) {
        flight.current = false;
        setPhase("idle");
      }
    }
  }, [bridge, form, phase, projectRoot, reports, source]);

  /** Request native cancellation and retain a busy state until the actual subprocess response arrives. */
  const cancel = useCallback(async () => {
    if (!flight.current || phase !== "running") return;
    const token = generation.current;
    setPhase("cancelling");
    try {
      await bridge.cancel();
    } catch (failure) {
      if (token !== generation.current) return;
      setError(validationError(failure));
      setPhase("running");
    }
  }, [bridge, phase]);

  /** Update one editable setting without mutating the frozen saved execution result. */
  const setField = useCallback((name: keyof ValidationForm, value: string) => {
    setForm((current) => ({ ...current, [name]: value }));
  }, []);

  const visibleSource = source?.projectRoot === projectRoot ? source : null;
  return {
    source: visibleSource,
    result: matchesSource(result, visibleSource) ? result : null,
    lastGood: matchesSource(lastGood, visibleSource) ? lastGood : null,
    form,
    invalidFields: invalidValidationFields(form),
    phase,
    error,
    refresh,
    run,
    cancel,
    setField,
  };
}

/** Compare every provenance field needed to prevent cross-project or stale-run result display. */
function matchesSource(
  result: ValidationRunResult | null,
  source: SelectedReport | null,
): boolean {
  return Boolean(
    result &&
    source &&
    result.projectRoot === source.projectRoot &&
    result.executionRunId === source.runId &&
    result.sourceReportSha256 === source.reportSha256,
  );
}

/** Treat a bridge's foreign-project response as a boundary failure rather than displaying its paths. */
function assertProject(source: SelectedReport | null, project: string): void {
  if (source && source.projectRoot !== project)
    throw new Error(
      "The saved report belongs to another project. Refresh validation.",
    );
}

/** Preserve the native diagnostic in readable lifecycle feedback. */
function validationError(failure: unknown): string {
  if (failure instanceof Error) return failure.message;
  return String(failure);
}
