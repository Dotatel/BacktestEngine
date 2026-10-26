import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type {
  WorkspaceBridge,
  WorkspaceBuild,
  WorkspaceDocument,
  WorkspaceProject,
  WorkspaceSession,
} from "@/lib/workspace-contract";
import {
  useWorkspaceDocuments,
  type SaveOutcome,
} from "./useWorkspaceDocuments";

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

const buildResult: WorkspaceBuild = {
  success: true,
  diagnostics: [],
  output: "ok",
  durationMs: 1,
  strategies: [],
  artifactPath: null,
};

/** Build a complete bridge whose unused operations still return honest shapes. */
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
    saveDocument: async (path, content) => ({
      path,
      content,
      revision: "r2",
    }),
    createEntry: async () => project,
    renameEntry: async () => project,
    moveEntry: async () => project,
    build: async () => buildResult,
    cancelBuild: async () => undefined,
    ...overrides,
  };
}

/** A promise whose settlement the test controls precisely. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Build one host document with explicit content and revision. */
function document(
  path: string,
  content: string,
  revision: string,
): WorkspaceDocument {
  return { path, content, revision };
}

test("a late read from an old project generation cannot overwrite the new buffer", async () => {
  const reads: Array<ReturnType<typeof deferred<WorkspaceDocument>>> = [];
  const readDocument = vi.fn(() => {
    const read = deferred<WorkspaceDocument>();
    reads.push(read);
    return read.promise;
  });
  const bridge = createBridge({ readDocument });
  const { result } = renderHook(() => useWorkspaceDocuments(bridge));

  let firstRestore!: Promise<void>;
  act(() => {
    firstRestore = result.current.restore(["A.cs"], "A.cs");
  });
  let secondRestore!: Promise<void>;
  act(() => {
    secondRestore = result.current.restore(["A.cs"], "A.cs");
  });
  expect(reads).toHaveLength(2);

  await act(async () => {
    reads[1].resolve(document("A.cs", "new project", "r2"));
    await secondRestore;
  });
  await act(async () => {
    reads[0].resolve(document("A.cs", "old project", "r1"));
    await firstRestore;
  });

  expect(result.current.documents["A.cs"].draft).toBe("new project");
  expect(result.current.documents["A.cs"].saved).toBe("new project");
});

test("save waits for the pending write and preserves edits typed during it", async () => {
  const firstWrite = deferred<WorkspaceDocument>();
  const secondWrite = deferred<WorkspaceDocument>();
  const saveDocument = vi
    .fn()
    .mockImplementationOnce(() => firstWrite.promise)
    .mockImplementationOnce(() => secondWrite.promise);
  const bridge = createBridge({
    readDocument: async (path) => document(path, "one", "r1"),
    saveDocument,
  });
  const { result } = renderHook(() => useWorkspaceDocuments(bridge));
  await act(async () => {
    await result.current.restore(["A.cs"], "A.cs");
  });

  act(() => result.current.update("A.cs", "two"));
  let save!: Promise<SaveOutcome>;
  act(() => {
    save = result.current.save("A.cs");
  });
  let saveAll!: Promise<SaveOutcome>;
  act(() => {
    saveAll = result.current.saveAll();
  });
  act(() => result.current.update("A.cs", "three"));
  expect(saveDocument).toHaveBeenCalledTimes(1);

  await act(async () => {
    firstWrite.resolve(document("A.cs", "two", "r2"));
    secondWrite.resolve(document("A.cs", "three", "r3"));
    await Promise.all([save, saveAll]);
  });

  expect(saveDocument).toHaveBeenCalledTimes(2);
  expect(result.current.documents["A.cs"].draft).toBe("three");
  expect(result.current.documents["A.cs"].saved).toBe("three");
  expect(result.current.dirtyPaths).toEqual([]);
});

test("save never claims success for a loading or failed document", async () => {
  const read = deferred<WorkspaceDocument>();
  const readDocument = vi.fn(() => read.promise);
  const bridge = createBridge({ readDocument });
  const { result } = renderHook(() => useWorkspaceDocuments(bridge));

  let restore!: Promise<void>;
  act(() => {
    restore = result.current.restore(["A.cs"], "A.cs");
  });
  const loading = await act(async () => result.current.save("A.cs"));
  expect(loading.ok).toBe(false);
  expect(loading.message).toContain("still loading");

  read.reject(new Error("read failed"));
  await act(async () => {
    await restore;
  });
  const failed = await act(async () => result.current.save("A.cs"));
  expect(failed.ok).toBe(false);
  expect(failed.message).toContain("could not be loaded");
});
