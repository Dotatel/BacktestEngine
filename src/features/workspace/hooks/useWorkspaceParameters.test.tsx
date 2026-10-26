import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type {
  CompiledStrategy,
  StrategyParameter,
  WorkspaceBuild,
} from "@/lib/workspace-contract";
import { useWorkspaceParameters } from "./useWorkspaceParameters";

const parameter: StrategyParameter = {
  name: "fastPeriod",
  displayName: "Fast period",
  group: "Moving averages",
  valueType: "integer",
  default: 5,
  min: 1,
  max: 20,
  step: 1,
  options: null,
};

const strategy: CompiledStrategy = {
  strategy: "CrossOver",
  strategyType: "CrossOverStrategy",
  parameters: [parameter],
};

const result: WorkspaceBuild = {
  success: true,
  diagnostics: [],
  output: "",
  durationMs: 1,
  strategies: [strategy],
  artifactPath: null,
};

/** A promise whose settlement the test controls. */
function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("preset success is reported only after host persistence resolves", async () => {
  const write = deferred();
  const onPresetsChange = vi.fn(() => write.promise);
  const { result: hook } = renderHook(() =>
    useWorkspaceParameters("C:/p", result, [], onPresetsChange),
  );

  let saving!: Promise<string | null>;
  act(() => {
    saving = hook.current.savePreset("Fast");
  });
  expect(onPresetsChange).toHaveBeenCalledTimes(1);
  expect(hook.current.message).toBe("");

  await act(async () => {
    write.resolve();
    await saving;
  });
  expect(hook.current.message).toBe("Saved preset Fast.");
  expect(hook.current.messageTone).toBe("info");
});

test("a failed host write keeps the entered values and reports a real error", async () => {
  const onPresetsChange = vi.fn(async () => {
    throw new Error("quota exceeded");
  });
  const { result: hook } = renderHook(() =>
    useWorkspaceParameters("C:/p", result, [], onPresetsChange),
  );

  const failure = await act(async () => hook.current.savePreset("Fast"));
  expect(failure).toContain("Preset not saved: quota exceeded");
  expect(hook.current.messageTone).toBe("error");
  expect(hook.current.values.fastPeriod).toBe(5);
  expect(hook.current.invalidNames).toEqual([]);
});
