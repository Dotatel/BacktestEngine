import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SavedRunSelection } from "@/lib/saved-runs-contract";
import { useSavedRuns } from "./useSavedRuns";
import {
  historyPage,
  historyRow,
  historySelection,
  syntheticHistoryBridge,
} from "./saved-runs.test-support";

describe("saved history lifecycle (synthetic DI only)", () => {
  it("restores the explicit project pointer while hidden and lists only on activation", async () => {
    const restoreSelected = vi.fn().mockResolvedValue(historySelection);
    const list = vi.fn().mockResolvedValue(historyPage);
    const onSelected = vi.fn();
    const bridge = syntheticHistoryBridge({ restoreSelected, list });
    const view = renderHook(
      ({ active }) =>
        useSavedRuns({
          bridge,
          projectRoot: "project-a",
          active,
          blocked: false,
          onSelected,
        }),
      { initialProps: { active: false } },
    );
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(onSelected).toHaveBeenCalledWith(historySelection);
    expect(list).not.toHaveBeenCalled();
    view.rerender({ active: true });
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith("project-a", null, 25),
    );
    view.rerender({ active: false });
    view.rerender({ active: true });
    expect(restoreSelected).toHaveBeenCalledTimes(1);
  });

  it("waits for the current engine/build operation before attempting restore", async () => {
    const restoreSelected = vi.fn().mockResolvedValue(null);
    const bridge = syntheticHistoryBridge({ restoreSelected });
    const view = renderHook(
      ({ blocked }) =>
        useSavedRuns({
          bridge,
          projectRoot: "project-a",
          active: true,
          blocked,
        }),
      { initialProps: { blocked: true } },
    );
    expect(restoreSelected).not.toHaveBeenCalled();
    view.rerender({ blocked: false });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(restoreSelected).toHaveBeenCalledTimes(1);
  });

  it("keeps a damaged pointer error visible after catalogue success and never chooses a fallback", async () => {
    const select = vi.fn();
    const restoreSelected = vi
      .fn()
      .mockRejectedValue("Saved selection pointer is corrupt.");
    const bridge = syntheticHistoryBridge({ restoreSelected, select });
    const { result } = renderHook(() =>
      useSavedRuns({
        bridge,
        projectRoot: "project-a",
        active: true,
        blocked: false,
      }),
    );
    await waitFor(() => expect(result.current.page).toEqual(historyPage));
    expect(result.current.restoreError).toContain("pointer is corrupt");
    expect(select).not.toHaveBeenCalled();
    restoreSelected.mockResolvedValueOnce(historySelection);
    await act(async () => result.current.restore());
    expect(result.current.restoreError).toBe("");
  });

  it("ignores an old project's late restore and restores only the new project", async () => {
    let finish: (value: SavedRunSelection) => void = () => {};
    const pending = new Promise<SavedRunSelection>((resolve) => {
      finish = resolve;
    });
    const onSelected = vi.fn();
    const bridge = syntheticHistoryBridge({
      restoreSelected: vi
        .fn()
        .mockImplementation((root: string) =>
          root === "project-a" ? pending : Promise.resolve(null),
        ),
      list: async () => ({ ...historyPage, rows: [] }),
    });
    const view = renderHook(
      ({ projectRoot }) =>
        useSavedRuns({
          bridge,
          projectRoot,
          active: true,
          blocked: false,
          onSelected,
        }),
      { initialProps: { projectRoot: "project-a" } },
    );
    view.rerender({ projectRoot: "project-b" });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    await act(async () => finish(historySelection));
    expect(onSelected).not.toHaveBeenCalled();
    expect(view.result.current.page?.rows).toEqual([]);
  });

  it("replaces bounded pages and preserves the opaque cursor exactly", async () => {
    const next = { ...historyRow, runId: "synthetic-next-run" };
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        ...historyPage,
        nextCursor: "native-opaque-cursor",
      })
      .mockResolvedValueOnce({ ...historyPage, rows: [next] });
    const bridge = syntheticHistoryBridge({ list });
    const { result } = renderHook(() =>
      useSavedRuns({
        bridge,
        projectRoot: "project-a",
        active: true,
        blocked: false,
      }),
    );
    await waitFor(() =>
      expect(result.current.page?.nextCursor).toBe("native-opaque-cursor"),
    );
    await act(async () =>
      result.current.browse(result.current.page?.nextCursor),
    );
    expect(list).toHaveBeenLastCalledWith(
      "project-a",
      "native-opaque-cursor",
      25,
    );
    expect(result.current.page?.rows).toEqual([next]);
  });

  it("rejects foreign metadata and mismatched verified selections without publishing metrics", async () => {
    const onSelected = vi.fn();
    const bridge = syntheticHistoryBridge({
      list: async () => ({
        ...historyPage,
        rows: [{ ...historyRow, projectRoot: "project-b" }],
      }),
      select: async () => ({ ...historySelection, completionSha256: "wrong" }),
    });
    const { result } = renderHook(() =>
      useSavedRuns({
        bridge,
        projectRoot: "project-a",
        active: true,
        blocked: false,
        onSelected,
      }),
    );
    await waitFor(() => expect(result.current.error).toContain("invalid page"));
    await act(async () => result.current.open(historyRow));
    expect(result.current.error).toContain("does not match the selected run");
    expect(onSelected).not.toHaveBeenCalled();
  });

  it("does not call native storage in browser preview or with no selected project", async () => {
    const restoreSelected = vi.fn();
    const list = vi.fn();
    const bridge = syntheticHistoryBridge({
      native: false,
      restoreSelected,
      list,
    });
    const { result } = renderHook(() =>
      useSavedRuns({
        bridge,
        projectRoot: "project-a",
        active: true,
        blocked: false,
      }),
    );
    expect(result.current.ready).toBe(true);
    expect(restoreSelected).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});
