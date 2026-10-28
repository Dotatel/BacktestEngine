import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsBridge, SettingsSnapshot } from "@/lib/settings-contract";
import type { ReleaseCheck, UpdatesBridge } from "@/lib/updates-contract";
import { errorMessage } from "@/lib/preferences";

/** Native application settings state; the existing preference controller still owns appearance/style. */
export function useAppSettings(
  bridge: SettingsBridge,
  updates: UpdatesBridge,
  active: boolean,
) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [release, setRelease] = useState<ReleaseCheck | null>(null);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const pending = useRef(false);

  /** Run one explicit action and suppress responses belonging to a closed or replaced settings page. */
  const perform = useCallback(
    async <T>(
      phase: string,
      operation: () => Promise<T>,
      accept: (value: T) => void,
    ) => {
      if (pending.current || !bridge.native) return;
      pending.current = true;
      const current = generation.current;
      setPhase(phase);
      setError("");
      setMessage("");
      try {
        const value = await operation();
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

  const load = useCallback(
    () => perform("loading", () => bridge.load(), setSnapshot),
    [bridge, perform],
  );
  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setPhase("idle");
    if (active) void load();
    return () => {
      generation.current += 1;
      pending.current = false;
    };
  }, [active, load]);

  /** Enabling only saves consent; a release request happens solely through checkNow. */
  function setUpdatesEnabled(enabled: boolean) {
    return perform(
      "saving",
      () => bridge.setUpdatesEnabled(enabled),
      (next) => {
        setSnapshot(next);
        if (!enabled) setRelease(null);
        setMessage("Manual check preference saved.");
      },
    );
  }

  /** A canceled native picker changes no settings and produces no false success message. */
  function chooseExportDirectory() {
    return perform(
      "saving",
      () => bridge.chooseExportDirectory(),
      (next) => {
        if (!next) return;
        setSnapshot(next);
        setMessage("Default export folder saved.");
      },
    );
  }

  /** Clear the folder suggestion while leaving every actual export under the native save dialog. */
  function clearExportDirectory() {
    return perform(
      "saving",
      () => bridge.clearExportDirectory(),
      (next) => {
        setSnapshot(next);
        setMessage("Default export folder cleared.");
      },
    );
  }

  /** Recovery is called only after the UI's separate explicit backup/reset confirmation. */
  function recover() {
    return perform(
      "saving",
      () => bridge.recover(),
      (next) => {
        setSnapshot(next);
        setRelease(null);
        setMessage(
          `Application settings recovered. Backup: ${next.recoveredBackupPath ?? "path unavailable"}`,
        );
      },
    );
  }

  /** No effect or initial loader calls this manual network action. */
  function checkNow() {
    if (!snapshot?.settings?.updates.enabled || !updates.native)
      return Promise.resolve();
    setRelease(null);
    return perform(
      "checking",
      async () => ({
        release: await updates.checkNow(),
        snapshot: await bridge.load(),
      }),
      (result) => {
        setRelease(result.release);
        setSnapshot(result.snapshot);
      },
    );
  }

  /** Reflect a dismissal only after the native atomic store accepts it. */
  function dismiss(version: string) {
    return perform(
      "saving",
      () => updates.dismiss(version),
      () => {
        setRelease((current) =>
          current?.latestVersion === version
            ? { ...current, dismissed: true }
            : current,
        );
        setMessage(`Dismissed version ${version}.`);
      },
    );
  }

  /** Open only a host-validated project release URL after an explicit button click. */
  function openRelease(url: string) {
    return perform(
      "opening",
      () => updates.openRelease(url),
      () => setMessage("Release link opened in your browser."),
    );
  }

  return {
    snapshot,
    release,
    phase,
    error,
    message,
    load,
    setUpdatesEnabled,
    chooseExportDirectory,
    clearExportDirectory,
    recover,
    checkNow,
    dismiss,
    openRelease,
  };
}
