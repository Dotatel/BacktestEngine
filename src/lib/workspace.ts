import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { WorkspaceBridge } from "./workspace-contract";
import { previewWorkspace } from "./workspace-preview";
export type { WorkspaceBridge } from "./workspace-contract";

/** Native workspace commands are fixed and root-scoped; previews cannot claim native filesystem or compiler access. */
const nativeWorkspace: WorkspaceBridge = {
  native: true,
  /** Read durable workspace/preset state, preserving corrupt state for explicit recovery. */
  loadSession: () => invoke("workspace_load_session"),
  /** Save a validated workspace snapshot atomically without touching onboarding preferences. */
  saveSession: (session) => invoke("workspace_save_session", { session }),
  /** Create a new app-managed example project without overwriting any existing directory. */
  createProject: () => invoke("workspace_create_project"),
  /** Let the user select a native project root; cancellation leaves the current project unchanged. */
  async pickProject() {
    const root = await open({
      directory: true,
      multiple: false,
      title: "Open strategy project",
    });
    if (!root) return null;
    return invoke("workspace_open_project", { root });
  },
  /** Restore a previously selected project through the same validated host boundary. */
  openProject: (root) => invoke("workspace_open_project", { root }),
  /** Re-read the current root without replacing unsaved editor buffers. */
  refreshProject: () => invoke("workspace_refresh_project"),
  /** Read bounded text with the host revision required for safe writes. */
  readDocument: (path) => invoke("workspace_read_document", { path }),
  /** Reject stale revisions rather than silently overwriting an external edit. */
  saveDocument: (path, content, revision) =>
    invoke("workspace_save_document", { path, content, revision }),
  /** Create a new file/folder inside an existing project directory, refusing collisions. */
  createEntry: (parent, name, kind) =>
    invoke("workspace_create_entry", { parent, name, kind }),
  /** Rename a project item without clobbering a sibling. */
  renameEntry: (path, name) => invoke("workspace_rename_entry", { path, name }),
  /** Move an item within the selected project, rejecting escape/cycle/collision attempts. */
  moveEntry: (path, parent) => invoke("workspace_move_entry", { path, parent }),
  /** Compile saved project sources and return real diagnostics/reflected schemas. */
  build: () => invoke("workspace_build"),
  /** Stop the host's current compiler process and invalidate its pending result. */
  cancelBuild: () => invoke("workspace_cancel_build"),
};

/** Choose the actual desktop host or an explicitly isolated browser preview at startup. */
export const workspace: WorkspaceBridge = isTauri()
  ? nativeWorkspace
  : previewWorkspace;
