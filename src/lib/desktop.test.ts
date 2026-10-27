import { beforeEach, expect, test, vi } from "vitest";
import { desktop } from "./desktop";

const host = vi.hoisted(() => ({
  isMaximized: vi.fn(),
  onResized: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => host }));

beforeEach(() => vi.resetAllMocks());

/** Control the completion order of real observer queries without timing-based sleeps. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("startup maximize during subscription is included in the initial snapshot", async () => {
  let maximized = false;
  host.isMaximized.mockImplementation(async () => maximized);
  const unlisten = vi.fn();
  host.onResized.mockImplementation(async () => {
    maximized = true;
    return unlisten;
  });
  const listener = vi.fn();
  const stop = await desktop.observeMaximized(listener, vi.fn());
  expect(listener).toHaveBeenLastCalledWith(true);
  stop();
  expect(unlisten).toHaveBeenCalledOnce();
});

test("stale and disposed resize queries cannot overwrite the current caption state", async () => {
  let resize!: () => void;
  host.onResized.mockImplementation(async (callback) => {
    resize = callback;
    return vi.fn();
  });
  host.isMaximized.mockResolvedValueOnce(false);
  const listener = vi.fn();
  const stop = await desktop.observeMaximized(listener, vi.fn());
  const stale = deferred<boolean>();
  const current = deferred<boolean>();
  host.isMaximized
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(current.promise);
  resize();
  resize();
  current.resolve(true);
  await current.promise;
  stale.resolve(false);
  await stale.promise;
  expect(listener.mock.calls.map(([value]) => value)).toEqual([false, true]);
  const late = deferred<boolean>();
  host.isMaximized.mockReturnValueOnce(late.promise);
  resize();
  stop();
  late.resolve(false);
  await late.promise;
  expect(listener.mock.calls.map(([value]) => value)).toEqual([false, true]);
});

test("a failed initial query releases the native subscription", async () => {
  const unlisten = vi.fn();
  host.onResized.mockResolvedValue(unlisten);
  host.isMaximized.mockRejectedValue(new Error("Native query failed"));
  await expect(desktop.observeMaximized(vi.fn(), vi.fn())).rejects.toThrow(
    "Native query failed",
  );
  expect(unlisten).toHaveBeenCalledOnce();
});

test("resize-query failures reach the existing visible error channel", async () => {
  let resize!: () => void;
  host.onResized.mockImplementation(async (callback) => {
    resize = callback;
    return vi.fn();
  });
  host.isMaximized.mockResolvedValueOnce(false);
  const reportError = vi.fn();
  const stop = await desktop.observeMaximized(vi.fn(), reportError);
  const query = deferred<boolean>();
  host.isMaximized.mockReturnValueOnce(query.promise);
  resize();
  const failure = new Error("Resize query failed");
  query.reject(failure);
  await query.promise.catch(() => undefined);
  await Promise.resolve();
  expect(reportError).toHaveBeenCalledWith(failure);
  stop();
});
