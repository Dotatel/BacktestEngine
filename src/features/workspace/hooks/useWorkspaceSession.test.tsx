import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type {
  WorkspaceBridge,
  WorkspaceBuild,
  WorkspaceProject,
  WorkspaceSession,
} from "@/lib/workspace-contract";
import { useWorkspaceSession } from "./useWorkspaceSession";

const emptySession: WorkspaceSession = {
  lastProject: null,
  activeFile: null,
  openFiles: [],
  presets: [],
};

const project: WorkspaceProject = { root: "C:/p", name: "p", entries: [] };

const build: WorkspaceBuild = {
  success: false,
  diagnostics: [],
  output: "",
  durationMs: 0,
  strategies: [],
  artifactPath: null,
};

/** Build a complete bridge whose session calls the test can replace. */
function createBridge(
  overrides: Partial<WorkspaceBridge> = {},
): WorkspaceBridge {
  return {
    native: true,
    loadSession: async () => ({ ...emptySession }),
    saveSession: async () => undefined,
    createProject: async () => project,
    pickProject: async () => null,
    openProject: async () => project,
    refreshProject: async () => project,
    readDocument: async (path) => ({ path, content: "", revision: "r1" }),
    saveDocument: async (path, content) => ({ path, content, revision: "r2" }),
    createEntry: async () => project,
    renameEntry: async () => project,
    moveEntry: async () => project,
    build: async () => build,
    cancelBuild: async () => undefined,
    ...overrides,
  };
}

test("flush rejects while the latest snapshot is not durable and keeps the failure visible", async () => {
  const saveSession = vi.fn(async () => {
    throw new Error("disk full");
  });
  const bridge = createBridge({ saveSession });
  const { result } = renderHook(() => useWorkspaceSession(bridge));
  await waitFor(() => expect(result.current.loading).toBe(false));

  await act(async () => {
    await result.current.persist({ presets: [] }).catch(() => undefined);
  });
  await waitFor(() => expect(result.current.saveError).toBe("disk full"));
  await act(async () => {
    await expect(result.current.flush()).rejects.toThrow("disk full");
  });
  expect(saveSession).toHaveBeenCalledTimes(2);
});

test("flush retries the latest snapshot and clears the failure after a later successful write", async () => {
  const saveSession = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary write failure"))
    .mockResolvedValue(undefined);
  const bridge = createBridge({ saveSession });
  const { result } = renderHook(() => useWorkspaceSession(bridge));
  await waitFor(() => expect(result.current.loading).toBe(false));

  await act(async () => {
    await result.current.persist({ activeFile: "A.cs" }).catch(() => undefined);
  });
  await waitFor(() => expect(result.current.saveError).not.toBe(""));

  await act(async () => {
    await result.current.flush();
  });
  expect(saveSession).toHaveBeenCalledTimes(2);
  expect(result.current.saveError).toBe("");
  expect(result.current.session?.activeFile).toBe("A.cs");
});

test("a damaged stored session is rejected instead of being silently replaced", async () => {
  const saveSession = vi.fn(async () => undefined);
  const bridge = createBridge({
    loadSession: async () =>
      ({ lastProject: 42 }) as unknown as WorkspaceSession,
    saveSession,
  });
  const { result } = renderHook(() => useWorkspaceSession(bridge));

  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toContain("damaged");
  expect(result.current.error).toContain("stored file has not been changed");
  expect(result.current.session).toBeNull();
  expect(saveSession).not.toHaveBeenCalled();
});
