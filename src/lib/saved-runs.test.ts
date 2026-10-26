import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => api);
import { savedRuns } from "./saved-runs";

beforeEach(() => {
  vi.clearAllMocks();
  api.isTauri.mockReturnValue(true);
  api.invoke.mockResolvedValue(null);
});

it("uses exact typed native request envelopes without supplying paths to source artifacts", async () => {
  await savedRuns.list("project-a", "opaque", 25);
  expect(api.invoke).toHaveBeenLastCalledWith("saved_runs_list", {
    request: { projectRoot: "project-a", cursor: "opaque", limit: 25 },
  });
  await savedRuns.select("project-a", "run-id", "completion-hash");
  expect(api.invoke).toHaveBeenLastCalledWith("saved_runs_select", {
    request: {
      projectRoot: "project-a",
      runId: "run-id",
      completionSha256: "completion-hash",
    },
  });
  await savedRuns.restoreSelected("project-a");
  expect(api.invoke).toHaveBeenLastCalledWith("saved_runs_restore_selected", {
    request: { projectRoot: "project-a" },
  });
});

it("never claims a native catalogue or restoration in browser preview", async () => {
  api.isTauri.mockReturnValue(false);
  await expect(savedRuns.list("project-a", null, 25)).rejects.toThrow(
    "desktop app",
  );
  await expect(savedRuns.select("project-a", "run", "hash")).rejects.toThrow(
    "desktop app",
  );
  await expect(savedRuns.restoreSelected("project-a")).rejects.toThrow(
    "desktop app",
  );
  expect(api.invoke).not.toHaveBeenCalled();
});
