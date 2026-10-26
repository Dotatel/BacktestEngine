import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CompiledStrategy,
  WorkspaceBuild,
  WorkspacePreset,
  StrategyParameter,
} from "@/lib/workspace-contract";
import { errorMessage } from "@/lib/preferences";
import {
  coercePresetValues,
  defaultsFor,
  validateParameterValue,
} from "../lib/parameters";

/** Reflected strategy values, validation and named presets scoped to the project and robot. */
export interface WorkspaceParametersController {
  strategies: CompiledStrategy[];
  activeStrategy: CompiledStrategy | null;
  values: Record<string, unknown>;
  invalidNames: string[];
  presets: WorkspacePreset[];
  message: string;
  messageTone: "info" | "error";
  selectStrategy(name: string): void;
  setValue(name: string, value: unknown): void;
  resetDefaults(): void;
  loadPreset(name: string): void;
  savePreset(name: string): Promise<string | null>;
  clearMessage(): void;
}

/**
 * Keep parameter values separate from source text and presets. A rebuild preserves values that
 * still satisfy the reflected schema and resets only invalid ones, so no stale input is disguised.
 */
export function useWorkspaceParameters(
  projectRoot: string | null,
  result: WorkspaceBuild | null,
  presets: WorkspacePreset[],
  onPresetsChange: (presets: WorkspacePreset[]) => Promise<void>,
): WorkspaceParametersController {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [valuesByStrategy, setValuesByStrategy] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"info" | "error">("info");
  const strategies = useMemo(() => result?.strategies ?? [], [result]);

  useEffect(() => {
    if (strategies.length === 0) {
      setActiveKey(null);
      return;
    }
    setActiveKey((current) =>
      current && strategies.some((strategy) => strategy.strategy === current)
        ? current
        : strategies[0].strategy,
    );
    setValuesByStrategy((previous) => {
      const next = { ...previous };
      for (const strategy of strategies)
        next[strategy.strategy] = mergeSchemaValues(
          strategy,
          previous[strategy.strategy],
        );
      return next;
    });
    setMessage("");
  }, [strategies]);

  const activeStrategy = useMemo(
    () =>
      strategies.find((strategy) => strategy.strategy === activeKey) ??
      strategies[0] ??
      null,
    [activeKey, strategies],
  );

  const values = useMemo(
    () =>
      activeStrategy
        ? (valuesByStrategy[activeStrategy.strategy] ??
          defaultsFor(activeStrategy))
        : {},
    [activeStrategy, valuesByStrategy],
  );

  const currentPresets = useMemo(() => {
    if (!projectRoot || !activeStrategy) return [];
    return presets.filter(
      (preset) =>
        sameRoot(preset.projectRoot, projectRoot) &&
        preset.strategy === activeStrategy.strategy,
    );
  }, [activeStrategy, presets, projectRoot]);

  const invalidNames = useMemo(
    () =>
      activeStrategy
        ? activeStrategy.parameters
            .filter(
              (parameter) =>
                validateParameterValue(parameter, values[parameter.name]) !==
                null,
            )
            .map((parameter) => parameter.displayName || parameter.name)
        : [],
    [activeStrategy, values],
  );

  const selectStrategy = useCallback((name: string) => {
    setActiveKey(name);
    setMessage("");
  }, []);

  const setValue = useCallback(
    (name: string, value: unknown) => {
      if (!activeStrategy) return;
      setValuesByStrategy((previous) => ({
        ...previous,
        [activeStrategy.strategy]: {
          ...(previous[activeStrategy.strategy] ?? defaultsFor(activeStrategy)),
          [name]: value,
        },
      }));
      setMessage("");
    },
    [activeStrategy],
  );

  const resetDefaults = useCallback(() => {
    if (!activeStrategy) return;
    setValuesByStrategy((previous) => ({
      ...previous,
      [activeStrategy.strategy]: defaultsFor(activeStrategy),
    }));
    setMessage("Parameter values reset to the compiled defaults.");
    setMessageTone("info");
  }, [activeStrategy]);

  const loadPreset = useCallback(
    (name: string) => {
      if (!activeStrategy) return;
      const preset = currentPresets.find(
        (candidate) => candidate.name === name,
      );
      if (!preset) {
        setMessage("That preset is no longer available for this strategy.");
        setMessageTone("error");
        return;
      }
      const applied = coercePresetValues(activeStrategy, preset.values);
      setValuesByStrategy((previous) => ({
        ...previous,
        [activeStrategy.strategy]: applied.values,
      }));
      setMessage(
        applied.skipped.length
          ? `Loaded ${preset.name}. Skipped ${applied.skipped.join(", ")} because the schema changed.`
          : `Loaded ${preset.name}.`,
      );
      setMessageTone(applied.skipped.length ? "error" : "info");
    },
    [activeStrategy, currentPresets],
  );

  /** Validate a preset name and current values, then persist only after the host accepts it. */
  const savePreset = useCallback(
    async (name: string): Promise<string | null> => {
      if (!projectRoot || !activeStrategy) return "Build the project first.";
      const trimmed = name.trim();
      if (!trimmed) return "Enter a preset name.";
      const duplicate = currentPresets.some(
        (preset) =>
          preset.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
      );
      if (duplicate) return "A preset with this name already exists.";
      if (invalidNames.length)
        return `Fix these values first: ${invalidNames.join(", ")}.`;
      const preset: WorkspacePreset = {
        projectRoot,
        strategy: activeStrategy.strategy,
        name: trimmed,
        values: { ...values },
      };
      try {
        await onPresetsChange([...presets, preset]);
      } catch (failure) {
        const message = `Preset not saved: ${errorMessage(failure)}`;
        setMessage(message);
        setMessageTone("error");
        return message;
      }
      setMessage(`Saved preset ${trimmed}.`);
      setMessageTone("info");
      return null;
    },
    [
      activeStrategy,
      currentPresets,
      invalidNames,
      onPresetsChange,
      presets,
      projectRoot,
      values,
    ],
  );

  const clearMessage = useCallback(() => setMessage(""), []);

  return {
    strategies,
    activeStrategy,
    values,
    invalidNames,
    presets: currentPresets,
    message,
    messageTone,
    selectStrategy,
    setValue,
    resetDefaults,
    loadPreset,
    savePreset,
    clearMessage,
  };
}

/** Preserve values that still validate, and restore defaults for removed or changed parameters. */
function mergeSchemaValues(
  strategy: CompiledStrategy,
  previous: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = defaultsFor(strategy);
  const existing = previous ?? {};
  for (const parameter of strategy.parameters) {
    if (
      parameter.name in existing &&
      validateParameterValue(parameter, existing[parameter.name]) === null
    )
      next[parameter.name] = existing[parameter.name];
  }
  return next;
}

/** Compare project roots leniently for Windows paths while keeping stored values untouched. */
function sameRoot(left: string, right: string): boolean {
  return (
    left.replaceAll("\\", "/").toLocaleLowerCase() ===
    right.replaceAll("\\", "/").toLocaleLowerCase()
  );
}

/** Re-export the schema type used by parameter presentation without reaching into the bridge. */
export type WorkspaceParameter = StrategyParameter;
