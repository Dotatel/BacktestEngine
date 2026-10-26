import { act, renderHook } from "@testing-library/react";
import { useCallback } from "react";
import { expect, test, vi } from "vitest";
import type {
  WorkspaceBridge,
  WorkspaceBuild,
  WorkspaceDocument,
  WorkspaceProject,
  WorkspaceSession,
} from "@/lib/workspace-contract";
import { useWorkspaceBuild } from "./useWorkspaceBuild";
import { useWorkspaceDocuments } from "./useWorkspaceDocuments";

const emptySession: WorkspaceSession = {
  lastProject: null,
  activeFile: null,
  openFiles: [],
  presets: [],
};

const project: WorkspaceProject = {
  root: "C:/projects/example",
  name: "Example",
  entries: [{ id: "A.cs", name: "A.cs", kind: "file" }],
};

const success: WorkspaceBuild = {
  success: true,
  diagnostics: [],
  output: "Build succeeded",
  durationMs: 8,
  strategies: [],
  artifactPath: "C:/cache/example.dll",
};

/** Build a complete bridge with controllable document and build behavior. */
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
    readDocument: async (path: string) => ({
      path,
      content: "class A {}",
      revision: "r1",
    }),
    saveDocument: async (
      path: string,
      content: string,
    ): Promise<WorkspaceDocument> => ({ path, content, revision: "r2" }),
    createEntry: async () => project,
    renameEntry: async () => project,
    moveEntry: async () => project,
    build: async () => success,
    cancelBuild: async () => undefined,
    ...overrides,
  };
}

/** Compose the real document and build controllers exactly as the workspace does. */
function useHarness(bridge: WorkspaceBridge) {
  const documents = useWorkspaceDocuments(bridge);
  const saveAll = useCallback(() => documents.saveAll(), [documents.saveAll]);
  const build = useWorkspaceBuild(
    bridge,
    saveAll,
    documents.savedEpoch,
    documents.dirtyPaths.length > 0,
  );
  return { documents, build };
}

test("auto-save before build keeps the fresh result and a later edit makes it stale", async () => {
  const saveDocument = vi.fn(
    async (path: string, content: string): Promise<WorkspaceDocument> => ({
      path,
      content,
      revision: "r2",
    }),
  );
  const bridge = createBridge({ saveDocument });
  const { result } = renderHook(() => useHarness(bridge));

  await act(async () => {
    await result.current.documents.restore(["A.cs"], "A.cs");
  });
  act(() => result.current.documents.update("A.cs", "class A { int x; }"));

  await act(async () => {
    await result.current.build.build();
  });

  expect(saveDocument).toHaveBeenCalledTimes(1);
  expect(result.current.build.result?.success).toBe(true);
  expect(result.current.documents.dirtyPaths).toEqual([]);
  expect(result.current.build.stale).toBe(false);

  act(() => result.current.documents.update("A.cs", "class A { int y; }"));
  expect(result.current.build.stale).toBe(true);
});
