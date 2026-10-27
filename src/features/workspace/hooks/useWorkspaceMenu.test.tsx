import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import type { AppMenuController } from "@/lib/app-menu-contract";
import { useWorkspace } from "./useWorkspace";
import { useWorkspaceMenu } from "./useWorkspaceMenu";
import { tabProject, tabsBridge } from "./workspace-tabs.test-support";

/** Exercise registration against real workspace guards with an explicit synthetic editor boundary. */
function fixture() {
  const bridge = tabsBridge();
  const register = vi.fn<(menu: AppMenuController | null) => void>();
  const editorAction = vi.fn().mockResolvedValue(undefined);
  const instance = {
    getModel: () => ({}),
    focus: vi.fn(),
    getAction: vi.fn(() => ({ run: editorAction })),
    trigger: vi.fn(),
  } as unknown as editor.IStandaloneCodeEditor;
  const props = {
    bridge,
    appearance: "dark" as const,
    workspaceStyle: "advanced" as const,
    onAppearanceChange: vi.fn(),
    onReviewSetup: vi.fn(),
  };
  const view = renderHook(
    ({ buildVisible }) => {
      const workspace = useWorkspace(props);
      useWorkspaceMenu({
        workspace,
        editor: instance,
        buildVisible,
        executionBusy: false,
        native: false,
        explorerVisible: true,
        parametersVisible: true,
        assistantVisible: false,
        toggleExplorer: vi.fn(),
        toggleParameters: vi.fn(),
        toggleAssistant: vi.fn(),
        reportError: vi.fn(),
        register,
      });
      return workspace;
    },
    { initialProps: { buildVisible: true } },
  );
  return { view, register, instance, editorAction };
}

/** Read the most recent complete caption registration, ignoring the explicit unmount clearing. */
function latestMenu(
  register: ReturnType<typeof fixture>["register"],
): AppMenuController {
  const menu = register.mock.calls.at(-1)?.[0];
  if (!menu) throw new Error("No workspace menu registration.");
  return menu;
}

describe("workspace menu wiring", () => {
  it("registers current availability without a render loop and clears on unmount", async () => {
    const { view, register } = fixture();
    await waitFor(() =>
      expect(view.result.current.documents.openPaths).toHaveLength(3),
    );
    expect(latestMenu(register).actions.newFile?.enabled).toBe(true);
    expect(latestMenu(register).actions.openFolder?.enabled).toBe(false);
    expect(register.mock.calls.length).toBeLessThan(10);
    view.unmount();
    expect(register).toHaveBeenLastCalledWith(null);
  });
  it("File Close All goes through the atomic unsaved decision", async () => {
    const { view, register } = fixture();
    await waitFor(() =>
      expect(view.result.current.documents.documents["B.cs"]?.status).toBe(
        "ready",
      ),
    );
    act(() =>
      view.result.current.documents.update("B.cs", "unsaved local edit"),
    );
    await act(() => latestMenu(register).actions.closeAll!.run());
    expect(view.result.current.dialog?.kind).toBe("close-tab");
    expect(view.result.current.documents.openPaths).toHaveLength(3);
    await act(() => view.result.current.resolveCloseTab("cancel"));
    expect(view.result.current.documents.documents["B.cs"].draft).toBe(
      "unsaved local edit",
    );
  });
  it("routes Find to the real editor action and rejects a stale menu after leaving Build", async () => {
    const { view, register, instance, editorAction } = fixture();
    await waitFor(() =>
      expect(latestMenu(register).actions.find?.enabled).toBe(true),
    );
    const find = latestMenu(register).actions.find!;
    await act(() => find.run());
    expect(instance.focus).toHaveBeenCalledOnce();
    expect(instance.getAction).toHaveBeenCalledWith("actions.find");
    expect(editorAction).toHaveBeenCalledOnce();
    view.rerender({ buildVisible: false });
    expect(latestMenu(register).actions.find?.enabled).toBe(false);
    await act(() => find.run());
    expect(editorAction).toHaveBeenCalledOnce();
  });
  it("Ctrl+W protects a dirty active tab and ignores file commands while its dialog is open", async () => {
    const { view } = fixture();
    await waitFor(() =>
      expect(view.result.current.documents.documents["B.cs"]?.status).toBe(
        "ready",
      ),
    );
    act(() => view.result.current.documents.update("B.cs", "keep this draft"));
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(view.result.current.dialog?.kind).toBe("close-tab");
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(view.result.current.dialog?.kind).toBe("close-tab");
    expect(view.result.current.project.project?.root).toBe(tabProject.root);
    expect(view.result.current.documents.openPaths).toHaveLength(3);
  });
});
