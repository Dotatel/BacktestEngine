import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useWorkspace } from "./useWorkspace";
import { tabPaths, tabsBridge } from "./workspace-tabs.test-support";
import type { WorkspaceBridge } from "@/lib/workspace-contract";

/** Boot the real coordinator against explicitly synthetic documents and wait for its restored tabs. */
async function openWorkspace(bridge: WorkspaceBridge) {
  const view = renderHook(() =>
    useWorkspace({
      bridge,
      appearance: "dark",
      workspaceStyle: "advanced",
      onAppearanceChange: () => {},
      onReviewSetup: () => {},
    }),
  );
  await waitFor(() =>
    expect(view.result.current.documents.documents["C.cs"]?.status).toBe(
      "ready",
    ),
  );
  return view;
}

test("bulk cancel keeps clean and dirty targeted tabs and their drafts intact", async () => {
  const { result } = await openWorkspace(tabsBridge());
  act(() => result.current.documents.update("B.cs", "unsaved B"));
  act(() => result.current.requestCloseTabs(["A.cs", "B.cs"]));
  expect(result.current.dialog).toMatchObject({
    kind: "close-tab",
    paths: ["A.cs", "B.cs"],
  });
  expect(result.current.documents.openPaths).toEqual(tabPaths);
  await act(async () => result.current.resolveCloseTab("cancel"));
  expect(result.current.documents.openPaths).toEqual(tabPaths);
  expect(result.current.documents.documents["B.cs"].draft).toBe("unsaved B");
});

test("save-and-close saves only the targeted files and preserves unrelated dirty drafts", async () => {
  const saveDocument = vi.fn(async (path: string, content: string) => ({
    path,
    content,
    revision: "r2",
  }));
  const { result } = await openWorkspace(tabsBridge({ saveDocument }));
  act(() => {
    result.current.documents.update("B.cs", "unsaved B");
    result.current.documents.update("C.cs", "unrelated C");
  });
  act(() => result.current.requestCloseTabs(["A.cs", "B.cs"]));
  await act(async () => result.current.resolveCloseTab("save"));
  expect(saveDocument).toHaveBeenCalledTimes(1);
  expect(saveDocument).toHaveBeenCalledWith("B.cs", "unsaved B", "r1");
  expect(result.current.documents.openPaths).toEqual(["C.cs"]);
  expect(result.current.documents.documents["C.cs"].draft).toBe("unrelated C");
  expect(result.current.documents.dirtyPaths).toEqual(["C.cs"]);
});

test("a bulk save conflict removes no tabs and retains existing conflict recovery", async () => {
  let external = false;
  const { result } = await openWorkspace(
    tabsBridge({
      readDocument: async (path) => ({
        path,
        content: `disk ${path}`,
        revision: external && path === "B.cs" ? "external" : "r1",
      }),
      saveDocument: async (path, content) => {
        if (path === "B.cs") {
          external = true;
          throw new Error("File changed on disk.");
        }
        return { path, content, revision: "r2" };
      },
    }),
  );
  act(() => {
    result.current.documents.update("A.cs", "draft A");
    result.current.documents.update("B.cs", "draft B");
  });
  act(() => result.current.requestCloseTabs(tabPaths));
  await act(async () => result.current.resolveCloseTab("save"));
  expect(result.current.documents.openPaths).toEqual(tabPaths);
  expect(result.current.dialog).toEqual({ kind: "conflict", path: "B.cs" });
  expect(result.current.documents.documents["B.cs"].draft).toBe("draft B");
  act(() => result.current.keepConflictDraft());
  expect(result.current.documents.openPaths).toEqual(tabPaths);
  expect(result.current.documents.documents["B.cs"].dirty).toBe(true);
});

test("explicit discard closes only selected tabs, choosing a surviving neighbor", async () => {
  const { result } = await openWorkspace(tabsBridge());
  act(() => {
    result.current.documents.update("B.cs", "discard B");
    result.current.documents.update("C.cs", "keep C");
  });
  act(() => result.current.requestCloseTabs(["B.cs"]));
  await act(async () => result.current.resolveCloseTab("discard"));
  expect(result.current.documents.openPaths).toEqual(["A.cs", "C.cs"]);
  expect(result.current.documents.activePath).toBe("A.cs");
  expect(result.current.documents.documents["C.cs"].draft).toBe("keep C");
});

test("a pending close save cannot be dismissed or dispatch a duplicate write", async () => {
  let finish: () => void = () => {};
  const saveDocument = vi.fn(
    (path: string, content: string) =>
      new Promise<{ path: string; content: string; revision: string }>(
        (resolve) => {
          finish = () => resolve({ path, content, revision: "r2" });
        },
      ),
  );
  const { result } = await openWorkspace(tabsBridge({ saveDocument }));
  act(() => result.current.documents.update("B.cs", "draft B"));
  act(() => result.current.requestCloseTabs(tabPaths));
  let saving: Promise<void>;
  act(() => {
    saving = result.current.resolveCloseTab("save");
  });
  expect(result.current.dialogBusy).toBe(true);
  act(() => result.current.dismissDialog());
  expect(result.current.dialog?.kind).toBe("close-tab");
  await act(async () => result.current.resolveCloseTab("save"));
  expect(saveDocument).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
    await saving;
  });
  expect(result.current.documents.openPaths).toEqual([]);
  expect(result.current.dialogBusy).toBe(false);
});
