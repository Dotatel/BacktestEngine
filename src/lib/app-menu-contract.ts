/** Workspace-owned commands; menu presentation never reads files or edits Monaco itself. */
export type AppMenuCommand =
  | "openFolder"
  | "newFile"
  | "newFolder"
  | "save"
  | "saveAll"
  | "closeEditor"
  | "closeAll"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "find"
  | "replace"
  | "selectAll"
  | "toggleExplorer"
  | "toggleParameters"
  | "toggleAssistant";

/** The workspace supplies current availability, the real action and only shortcuts it actually binds. */
export interface AppMenuAction {
  enabled: boolean;
  run(): void | Promise<void>;
  shortcut?: string;
}

/** Register this controller while the workspace is mounted; absence preserves the onboarding caption. */
export interface AppMenuController {
  actions: Partial<Record<AppMenuCommand, AppMenuAction>>;
  view: { explorer: boolean; parameters: boolean; assistant: boolean };
}

/** Fixed user-facing names shared by menu groups and the built-in keyboard reference. */
export const appMenuLabels: Record<AppMenuCommand, string> = {
  openFolder: "Open folder…",
  newFile: "New file…",
  newFolder: "New folder…",
  save: "Save",
  saveAll: "Save all",
  closeEditor: "Close editor",
  closeAll: "Close all editors",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  find: "Find",
  replace: "Replace",
  selectAll: "Select all",
  toggleExplorer: "Explorer",
  toggleParameters: "Parameters",
  toggleAssistant: "Assistant",
};
