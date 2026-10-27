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

test("authoritative reload resets the editor identity even with the same revision; typing and save do not", async () => {
  const bridge = createBridge({
    readDocument: async (path) => ({
      path,
      content: "saved source",
      revision: "same",
    }),
  });
  const hook = renderHook(() => useWorkspaceDocuments(bridge));
  await act(() => hook.result.current.open("A.cs"));
  const first = hook.result.current.documents["A.cs"].readVersion;
  act(() => hook.result.current.update("A.cs", "local edit"));
  expect(hook.result.current.documents["A.cs"].readVersion).toBe(first);
  await act(() => hook.result.current.save("A.cs"));
  expect(hook.result.current.documents["A.cs"].readVersion).toBe(first);
  act(() => hook.result.current.update("A.cs", "discard this draft"));
  await act(() => hook.result.current.reload("A.cs"));
  expect(hook.result.current.documents["A.cs"].readVersion).toBeGreaterThan(
    first,
  );
  expect(hook.result.current.documents["A.cs"].draft).toBe("saved source");
});

test("reloading a renamed document gets a new editor identity", async () => {
  const hook = renderHook(() => useWorkspaceDocuments(createBridge()));
  await act(() => hook.result.current.open("A.cs"));
  const first = hook.result.current.documents["A.cs"].readVersion;
  act(() => hook.result.current.remap("A.cs", "B.cs", false));
  expect(hook.result.current.documents["B.cs"].readVersion).toBe(first);
  await act(() => hook.result.current.reload("B.cs"));
  expect(hook.result.current.documents["B.cs"].readVersion).toBeGreaterThan(
    first,
  );
});

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

test("atomic close refuses dirty or saving tabs without removing any other selected tab", async () => {
  const pending = deferred<WorkspaceDocument>();
  const { result } = renderHook(() =>
    useWorkspaceDocuments(
      createBridge({ saveDocument: () => pending.promise }),
    ),
  );
  await act(async () =>
    result.current.restore(["A.cs", "B.cs", "C.cs"], "B.cs"),
  );
  act(() => result.current.update("B.cs", "draft"));
  let closed = true;
  act(() => {
    closed = result.current.closeMany(["A.cs", "B.cs"]);
  });
  expect(closed).toBe(false);
  expect(result.current.openPaths).toEqual(["A.cs", "B.cs", "C.cs"]);
  let saving!: Promise<SaveOutcome>;
  act(() => {
    saving = result.current.save("B.cs");
  });
  act(() => {
    closed = result.current.closeMany(["A.cs", "B.cs"], true);
  });
  expect(closed).toBe(false);
  await act(async () => {
    pending.resolve(document("B.cs", "draft", "r2"));
    await saving;
  });
  act(() => result.current.closeMany(["A.cs", "B.cs"]));
  expect(result.current.openPaths).toEqual(["C.cs"]);
  expect(result.current.activePath).toBe("C.cs");
});

test("targeted saving repeats an earlier file edited while another selected file saves", async () => {
  const pending = deferred<WorkspaceDocument>();
  const saveDocument = vi.fn(async (path: string, content: string) =>
    path === "B.cs" ? pending.promise : document(path, content, "r2"),
  );
  const { result } = renderHook(() =>
    useWorkspaceDocuments(createBridge({ saveDocument })),
  );
  await act(async () =>
    result.current.restore(["A.cs", "B.cs", "C.cs"], "B.cs"),
  );
  act(() => {
    result.current.update("A.cs", "first A");
    result.current.update("B.cs", "first B");
    result.current.update("C.cs", "unrelated C");
  });
  let saving!: Promise<SaveOutcome>;
  act(() => {
    saving = result.current.saveSelected(["A.cs", "B.cs"]);
  });
  await act(async () => {
    await Promise.resolve();
  });
  act(() => result.current.update("A.cs", "newer A"));
  await act(async () => {
    pending.resolve(document("B.cs", "first B", "r2"));
    await saving;
  });
  expect(result.current.documents["A.cs"].saved).toBe("newer A");
  expect(result.current.documents["C.cs"].dirty).toBe(true);
  expect(saveDocument).not.toHaveBeenCalledWith(
    "C.cs",
    expect.anything(),
    expect.anything(),
  );
});

test("a targeted save from the previous project cannot approve closing replacement buffers", async () => {
  const pending = deferred<WorkspaceDocument>();
  const { result } = renderHook(() =>
    useWorkspaceDocuments(
      createBridge({ saveDocument: () => pending.promise }),
    ),
  );
  await act(async () => result.current.restore(["A.cs"], "A.cs"));
  act(() => result.current.update("A.cs", "old project draft"));
  let saving!: Promise<SaveOutcome>;
  act(() => {
    saving = result.current.saveSelected(["A.cs"]);
  });
  await act(async () => result.current.restore(["A.cs"], "A.cs"));
  act(() => result.current.update("A.cs", "new project draft"));
  let outcome!: SaveOutcome;
  await act(async () => {
    pending.resolve(document("A.cs", "old project draft", "old-r2"));
    outcome = await saving;
  });
  expect(outcome.ok).toBe(false);
  expect(result.current.documents["A.cs"].draft).toBe("new project draft");
});
