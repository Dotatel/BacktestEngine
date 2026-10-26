import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppExtension,
  ExtensionCommandId,
  ExtensionsBridge,
} from "@/lib/extensions-contract";
import type { ReportsBridge, SelectedReport } from "@/lib/reports-contract";
import { errorMessage } from "@/lib/preferences";

/** Keep local registry actions and reviewed saved-run identity outside the manifest presentation. */
export function useExtensions(
  bridge: ExtensionsBridge,
  reports: ReportsBridge,
  projectRoot: string | null,
  active: boolean,
) {
  const [entries, setEntries] = useState<AppExtension[]>([]);
  const [report, setReport] = useState<SelectedReport | null>(null);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const pending = useRef(false);

  /** Serialize explicit UI operations and ignore receipts after the dialog or project changes. */
  const perform = useCallback(
    async <T>(
      phase: string,
      action: () => Promise<T>,
      accept: (value: T) => void,
    ) => {
      if (pending.current || !bridge.native) return;
      pending.current = true;
      const current = generation.current;
      setPhase(phase);
      setError("");
      setMessage("");
      try {
        const value = await action();
        if (generation.current === current) accept(value);
      } catch (failure) {
        if (generation.current === current) setError(errorMessage(failure));
      } finally {
        if (generation.current === current) {
          pending.current = false;
          setPhase("idle");
        }
      }
    },
    [bridge.native],
  );

  /** Registry failures remain visible independently of an unavailable saved report. */
  const refresh = useCallback(
    () =>
      perform(
        "loading",
        async () => {
          const results = await Promise.allSettled([
            bridge.list(),
            projectRoot && reports.native
              ? reports.selected(projectRoot)
              : Promise.resolve(null),
          ]);
          return results;
        },
        ([registry, selected]) => {
          setEntries(registry.status === "fulfilled" ? registry.value : []);
          setReport(
            selected.status === "fulfilled" &&
              selected.value?.projectRoot === projectRoot
              ? selected.value
              : null,
          );
          const failures = [registry, selected].filter(
            (result) => result.status === "rejected",
          );
          setError(
            failures
              .map((result) =>
                errorMessage((result as PromiseRejectedResult).reason),
              )
              .join(" "),
          );
        },
      ),
    [bridge, reports, projectRoot, perform],
  );

  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setPhase("idle");
    setReport(null);
    if (active) void refresh();
    return () => {
      generation.current += 1;
      pending.current = false;
    };
  }, [active, refresh]);

  /** Import only a native-picker-selected manifest; cancellation never claims registration success. */
  function importFolder() {
    return perform(
      "importing",
      async () => {
        const imported = await bridge.importFolder();
        return imported ? { imported, entries: await bridge.list() } : null;
      },
      (result) => {
        if (!result) {
          setMessage("Import canceled. No extension was added.");
          return;
        }
        setEntries(result.entries);
        setMessage(
          `Imported ${result.imported.name}. Review its commands before enabling.`,
        );
      },
    );
  }

  /** The host rechecks the imported hash before persisting an enable action. */
  function setEnabled(entry: AppExtension, enabled: boolean) {
    return perform(
      "saving",
      () => bridge.setEnabled(entry.id, entry.manifestSha256, enabled),
      (next) => {
        setEntries(next);
        setMessage(`${entry.name} ${enabled ? "enabled" : "disabled"}.`);
      },
    );
  }

  /** Export through a trusted host command using the exact reviewed manifest and saved source. */
  function exportReport(entry: AppExtension, command: ExtensionCommandId) {
    if (
      !report ||
      report.projectRoot !== projectRoot ||
      !entry.enabled ||
      !entry.compatible ||
      !entry.commands.some((item) => item.id === command)
    )
      return Promise.resolve();
    const selected = report;
    return perform(
      "exporting",
      async () => {
        const receipt = await bridge.exportReport(entry, command, selected);
        if (
          receipt &&
          (receipt.runId !== selected.runId ||
            receipt.reportSha256 !== selected.reportSha256)
        )
          throw new Error(
            "The export receipt does not match the reviewed run. Refresh extensions.",
          );
        return receipt;
      },
      (receipt) =>
        setMessage(
          receipt
            ? `Saved ${receipt.path}`
            : "Export canceled. No file was written.",
        ),
    );
  }

  return {
    entries,
    report: report?.projectRoot === projectRoot ? report : null,
    phase,
    error,
    message,
    refresh,
    importFolder,
    setEnabled,
    exportReport,
  };
}
