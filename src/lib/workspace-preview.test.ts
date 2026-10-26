import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { previewWorkspace as bridge } from "./workspace-preview";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("the isolated example uses real retained source and never claims a native compiler", async () => {
  const project = await bridge.createProject();
  expect(project.root).toMatch(/^preview:\/\//);
  expect((await bridge.readDocument("ExampleStrategy.cs")).content).toContain(
    "class ExampleStrategy : Robot",
  );
  expect(bridge.native).toBe(false);
  const build = await bridge.build();
  expect(build.success).toBe(false);
  expect(build.strategies).toEqual([]);
  expect(build.artifactPath).toBeNull();
  expect(build.diagnostics[0].message).toContain("desktop app");
});

test("creating, saving, renaming and moving a subtree preserves actual file contents", async () => {
  await bridge.createProject();
  await bridge.createEntry("", "Strategies", "folder");
  await bridge.createEntry("Strategies", "Helpers", "folder");
  await bridge.createEntry("Strategies/Helpers", "Helper.cs", "file");
  const document = await bridge.readDocument("Strategies/Helpers/Helper.cs");
  await bridge.saveDocument(
    document.path,
    "// retained helper",
    document.revision,
  );
  await bridge.renameEntry("Strategies", "Bots");
  await bridge.moveEntry("Bots/Helpers", "");
  expect((await bridge.readDocument("Helpers/Helper.cs")).content).toBe(
    "// retained helper",
  );
  expect(
    (await bridge.refreshProject()).entries.find(
      (entry) => entry.id === "Helpers",
    )?.children?.[0].id,
  ).toBe("Helpers/Helper.cs");
  await expect(bridge.readDocument(document.path)).rejects.toThrow(
    "no longer exists",
  );
});

test("cycle and collision failures leave the project intact", async () => {
  await bridge.createProject();
  await bridge.createEntry("", "Folder", "folder");
  await bridge.createEntry("Folder", "Child", "folder");
  const before = await bridge.refreshProject();
  await expect(bridge.moveEntry("Folder", "Folder/Child")).rejects.toThrow(
    "inside itself",
  );
  await expect(
    bridge.createEntry("", "ExampleStrategy.cs", "file"),
  ).rejects.toThrow("already exists");
  expect(await bridge.refreshProject()).toEqual(before);
});

test.each(["../outside.cs", "a/b.cs", "CON.cs", "trailing."])(
  "rejects invalid filename %s without creating an entry",
  async (name) => {
    await bridge.createProject();
    await expect(bridge.createEntry("", name, "file")).rejects.toThrow(
      "valid file or folder name",
    );
    expect((await bridge.refreshProject()).entries).toHaveLength(1);
  },
);

test("external revision conflicts preserve the newer saved content", async () => {
  await bridge.createProject();
  const old = await bridge.readDocument("ExampleStrategy.cs");
  await bridge.saveDocument(old.path, "// external edit", old.revision);
  await expect(
    bridge.saveDocument(old.path, "// stale editor draft", old.revision),
  ).rejects.toThrow("draft is preserved");
  expect((await bridge.readDocument(old.path)).content).toBe(
    "// external edit",
  );
});

test("storage failure rejects a write without losing the previously durable source", async () => {
  await bridge.createProject();
  const original = await bridge.readDocument("ExampleStrategy.cs");
  vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new Error("Storage full");
  });
  await expect(
    bridge.saveDocument(original.path, "// unsaved draft", original.revision),
  ).rejects.toThrow("Storage full");
  expect(await bridge.readDocument(original.path)).toEqual(original);
});

test("corrupt preview settings are reported and retained", async () => {
  localStorage.setItem("dotatel-workspace-browser-preview-v1", "{broken");
  await expect(bridge.loadSession()).rejects.toThrow("settings are damaged");
  expect(localStorage.getItem("dotatel-workspace-browser-preview-v1")).toBe(
    "{broken",
  );
});
