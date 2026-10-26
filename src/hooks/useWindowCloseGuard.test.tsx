import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { DesktopBridge } from "@/lib/desktop";
import { useWindowCloseGuard } from "./useWindowCloseGuard";

/** Expose only the native close subscription exercised by this hook, without claiming full native-window coverage. */
function closeBridge() {
  let guard: (() => Promise<boolean>) | undefined;
  const cleanup = vi.fn();
  const observeCloseRequested = vi.fn(
    async (listener: () => Promise<boolean>) => {
      guard = listener;
      return cleanup;
    },
  );
  return {
    bridge: { observeCloseRequested },
    cleanup,
    nativeGuard: () => guard,
  };
}

test("custom and native close retain dirty drafts, then flush before allowing a clean exit", async () => {
  const { bridge, cleanup, nativeGuard } = closeBridge();
  const flush = vi.fn().mockResolvedValue(undefined);
  const error = vi.fn();
  const view = renderHook(
    ({ dirty }) => useWindowCloseGuard(bridge, dirty, flush, error),
    { initialProps: { dirty: true } },
  );
  await waitFor(() => expect(nativeGuard()).toBeDefined());
  expect(await view.result.current()).toBe(false);
  expect(await nativeGuard()!()).toBe(false);
  expect(flush).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("Save your changes"),
  );
  view.rerender({ dirty: false });
  expect(await nativeGuard()!()).toBe(true);
  expect(flush).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test("closing a browser preview is prevented only while a draft is dirty", () => {
  const { bridge } = closeBridge();
  const flush = vi.fn().mockResolvedValue(undefined);
  const error = vi.fn();
  const view = renderHook(
    ({ dirty }) => useWindowCloseGuard(bridge, dirty, flush, error),
    { initialProps: { dirty: true } },
  );
  const dirtyClose = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirtyClose);
  expect(dirtyClose.defaultPrevented).toBe(true);
  view.rerender({ dirty: false });
  const cleanClose = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(cleanClose);
  expect(cleanClose.defaultPrevented).toBe(false);
});

test("failed durable writes block native close and surface the actual recovery error", async () => {
  const { bridge, nativeGuard } = closeBridge();
  const flush = vi
    .fn()
    .mockRejectedValue(
      new Error("Preset could not be saved. Retry saving before closing."),
    );
  const error = vi.fn();
  renderHook(() => useWindowCloseGuard(bridge, false, flush, error));
  await waitFor(() => expect(nativeGuard()).toBeDefined());
  expect(await nativeGuard()!()).toBe(false);
  expect(error).toHaveBeenCalledWith(
    "Preset could not be saved. Retry saving before closing.",
  );
});

test("a native subscription arriving after unmount is still released", async () => {
  let register!: (cleanup: () => void) => void;
  const cleanup = vi.fn();
  const bridge: Pick<DesktopBridge, "observeCloseRequested"> = {
    observeCloseRequested: () =>
      new Promise<() => void>((resolve) => {
        register = resolve;
      }),
  };
  const flush = vi.fn().mockResolvedValue(undefined);
  const error = vi.fn();
  const view = renderHook(() =>
    useWindowCloseGuard(bridge, false, flush, error),
  );
  view.unmount();
  await act(async () => {
    register(cleanup);
  });
  expect(cleanup).toHaveBeenCalledTimes(1);
});
