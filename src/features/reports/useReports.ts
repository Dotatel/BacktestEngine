import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ReportFormat,
  ReportsBridge,
  SelectedReport,
} from "@/lib/reports-contract";

/** Keep report selection, stale-response protection and native export lifecycle out of presentation. */
export function useReports(
  bridge: ReportsBridge,
  projectRoot: string | null,
  active: boolean,
  selectionRevision = 0,
) {
  const [report, setReport] = useState<SelectedReport | null>(null);
  const [phase, setPhase] = useState<"loading" | "idle" | "exporting">(
    "loading",
  );
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const currentProject = useRef(projectRoot);
  currentProject.current = projectRoot;

  /** Refresh the host-selected source; failures remove old evidence instead of showing it as current. */
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setReport(null);
    setError("");
    setMessage("");
    if (!projectRoot) {
      setPhase("idle");
      return;
    }
    setPhase("loading");
    try {
      const selected = await bridge.selected(projectRoot);
      if (
        request !== generation.current ||
        currentProject.current !== projectRoot
      )
        return;
      if (selected && selected.projectRoot !== projectRoot)
        throw new Error(
          "The report belongs to another project. Refresh Reports.",
        );
      setReport(selected);
    } catch (failure) {
      if (request === generation.current) setError(reportError(failure));
    } finally {
      if (request === generation.current) setPhase("idle");
    }
  }, [bridge, projectRoot]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [active, refresh, selectionRevision]);

  /** Export exactly the reviewed source; suppress receipts that arrive after a project change. */
  const exportSaved = useCallback(
    async (format: ReportFormat) => {
      if (!report || !projectRoot || phase !== "idle") return;
      const request = generation.current;
      setPhase("exporting");
      setError("");
      setMessage("");
      try {
        const receipt = await bridge.exportSaved(
          projectRoot,
          report.runId,
          report.reportSha256,
          format,
        );
        if (
          request !== generation.current ||
          currentProject.current !== projectRoot
        )
          return;
        if (
          receipt &&
          (receipt.runId !== report.runId ||
            receipt.reportSha256 !== report.reportSha256)
        )
          throw new Error(
            "The export receipt does not match the selected run. Refresh Reports.",
          );
        setMessage(
          receipt
            ? `Saved ${receipt.path}`
            : "Export canceled. No file was written.",
        );
      } catch (failure) {
        if (request === generation.current) setError(reportError(failure));
      } finally {
        if (request === generation.current) setPhase("idle");
      }
    },
    [bridge, phase, projectRoot, report],
  );

  const selected = report?.projectRoot === projectRoot ? report : null;
  return { report: selected, phase, error, message, refresh, exportSaved };
}

/** Normalize actionable bridge failures without discarding the native diagnostic. */
function reportError(failure: unknown): string {
  if (failure instanceof Error) return failure.message;
  return String(failure);
}
