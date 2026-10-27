import type {
  WorkspaceBridge,
  WorkspaceProject,
} from "@/lib/workspace-contract";

export const tabPaths = ["A.cs", "B.cs", "C.cs"];
export const tabProject: WorkspaceProject = {
  root: "C:/synthetic-tabs-project",
  name: "Synthetic tabs project",
  entries: tabPaths.map((id) => ({ id, name: id, kind: "file" })),
};

/** Inject synthetic documents and revisions only; these tests never claim a native save or compilation. */
export function tabsBridge(
  overrides: Partial<WorkspaceBridge> = {},
): WorkspaceBridge {
  return {
    native: false,
    loadSession: async () => ({
      lastProject: tabProject.root,
      activeFile: "B.cs",
      openFiles: [...tabPaths],
      presets: [],
    }),
    saveSession: async () => {},
    createProject: async () => tabProject,
    pickProject: async () => null,
    openProject: async () => tabProject,
    refreshProject: async () => tabProject,
    readDocument: async (path) => ({
      path,
      content: `saved ${path}`,
      revision: "r1",
    }),
    saveDocument: async (path, content) => ({ path, content, revision: "r2" }),
    createEntry: async () => tabProject,
    renameEntry: async () => tabProject,
    moveEntry: async () => tabProject,
    build: async () => {
      throw new Error("No compiler is part of this synthetic tabs fixture.");
    },
    cancelBuild: async () => {},
    ...overrides,
  };
}
