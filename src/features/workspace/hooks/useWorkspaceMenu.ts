import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import type {
  AppMenuCommand,
  AppMenuController,
} from "@/lib/app-menu-contract";
import { errorMessage } from "@/lib/preferences";
import type { WorkspaceController } from "./useWorkspace";

/** Register the current workspace's real commands without moving native/editor ownership into the caption. */
export interface WorkspaceMenuOptions {
  workspace: WorkspaceController;
  editor: editor.IStandaloneCodeEditor | null;
  buildVisible: boolean;
  executionBusy: boolean;
  native: boolean;
  explorerVisible: boolean;
  parametersVisible: boolean;
  assistantVisible: boolean;
  toggleExplorer(): void;
  toggleParameters(): void;
  toggleAssistant(): void;
  reportError(message: string): void;
  register?(controller: AppMenuController | null): void;
}

/** Publish only when availability changes; action closures always read the latest project and editor. */
export function useWorkspaceMenu(options: WorkspaceMenuOptions) {
  const latest = useRef(options);
  latest.current = options;
  const flags = availability(options);
  const { register, explorerVisible, parametersVisible, assistantVisible } =
    options;
  useEffect(() => {
    register?.(menuController(latest, flags));
  }, [
    register,
    flags.blocked,
    flags.project,
    flags.editor,
    flags.active,
    flags.dirty,
    flags.dirtyActive,
    flags.open,
    flags.native,
    explorerVisible,
    parametersVisible,
    assistantVisible,
  ]);
  useEffect(() => () => register?.(null), [register]);
  useEffect(() => {
    /** Reserve familiar file shortcuts for this app while leaving text-edit shortcuts with Monaco/inputs. */
    function onKeyDown(event: KeyboardEvent) {
      const command = fileShortcut(event);
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      if (
        event.repeat ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      )
        return;
      void runMenuCommand(latest.current, command).catch((failure) =>
        latest.current.reportError(errorMessage(failure)),
      );
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

/** Capture only availability primitives, so a parent caption update cannot create a registration loop. */
function availability(options: WorkspaceMenuOptions) {
  const { workspace } = options;
  const active = workspace.documents.activePath;
  const document = active ? workspace.documents.documents[active] : null;
  const blocked =
    options.executionBusy ||
    workspace.build.phase !== "idle" ||
    workspace.project.busy ||
    workspace.session.loading ||
    Boolean(workspace.dialog);
  return {
    blocked,
    project: Boolean(workspace.project.project),
    editor: Boolean(
      options.editor &&
      options.buildVisible &&
      document?.status === "ready" &&
      !document.saving,
    ),
    active: Boolean(active),
    dirty: workspace.documents.dirtyPaths.length > 0,
    dirtyActive: Boolean(
      document?.dirty && document.status === "ready" && !document.saving,
    ),
    open: workspace.documents.openPaths.length > 0,
    native: options.native,
  };
}

/** Keep menu enablement and keyboard dispatch under the same current lifecycle guards. */
function enabledCommands(
  flags: ReturnType<typeof availability>,
): Record<AppMenuCommand, boolean> {
  const project = flags.project && !flags.blocked;
  const edit = flags.editor && !flags.blocked;
  return {
    openFolder: flags.native && !flags.blocked,
    newFile: project,
    newFolder: project,
    save: project && flags.active && flags.dirtyActive,
    saveAll: project && flags.dirty,
    closeEditor: project && flags.active,
    closeAll: project && flags.open,
    undo: edit,
    redo: edit,
    cut: edit,
    copy: edit,
    paste: edit,
    find: edit,
    replace: edit,
    selectAll: edit,
    toggleExplorer: project,
    toggleParameters: project,
    toggleAssistant: true,
  };
}

/** Assemble a compact controller from existing actions rather than duplicating persistence or editor commands. */
function menuController(
  latest: React.RefObject<WorkspaceMenuOptions>,
  flags: ReturnType<typeof availability>,
): AppMenuController {
  const enabled = enabledCommands(flags);
  const action = (command: AppMenuCommand, shortcut?: string) => ({
    enabled: enabled[command],
    shortcut,
    run: () => runMenuCommand(latest.current, command),
  });
  return {
    actions: {
      openFolder: action("openFolder", "Ctrl+O"),
      newFile: action("newFile", "Ctrl+N"),
      newFolder: action("newFolder"),
      save: action("save", "Ctrl+S"),
      saveAll: action("saveAll", "Ctrl+Shift+S"),
      closeEditor: action("closeEditor", "Ctrl+W"),
      closeAll: action("closeAll"),
      undo: action("undo", "Ctrl+Z"),
      redo: action("redo", "Ctrl+Y"),
      cut: action("cut", "Ctrl+X"),
      copy: action("copy", "Ctrl+C"),
      paste: action("paste", "Ctrl+V"),
      find: action("find", "Ctrl+F"),
      replace: action("replace", "Ctrl+H"),
      selectAll: action("selectAll", "Ctrl+A"),
      toggleExplorer: action("toggleExplorer"),
      toggleParameters: action("toggleParameters"),
      toggleAssistant: action("toggleAssistant"),
    },
    view: {
      explorer: latest.current.explorerVisible,
      parameters: latest.current.parametersVisible,
      assistant: latest.current.assistantVisible,
    },
  };
}

/** Dispatch a menu selection against fresh state; stale menu availability cannot bypass busy/unsaved guards. */
async function runMenuCommand(
  options: WorkspaceMenuOptions,
  command: AppMenuCommand,
): Promise<void> {
  if (!enabledCommands(availability(options))[command]) return;
  const { workspace } = options;
  const actions: Partial<Record<AppMenuCommand, () => void | Promise<void>>> = {
    openFolder: workspace.openFolder,
    newFile: () => workspace.requestCreate("file", ""),
    newFolder: () => workspace.requestCreate("folder", ""),
    save: workspace.saveActive,
    saveAll: workspace.saveAll,
    closeEditor: () => workspace.requestClose(workspace.documents.activePath!),
    closeAll: () => workspace.requestCloseTabs(workspace.documents.openPaths),
    toggleExplorer: options.toggleExplorer,
    toggleParameters: options.toggleParameters,
    toggleAssistant: options.toggleAssistant,
  };
  if (actions[command]) {
    await actions[command]();
    return;
  }
  await runEditorCommand(options.editor, command);
}

/** Use Monaco's public action/trigger APIs, preserving selections, undo history and clipboard handling. */
async function runEditorCommand(
  instance: editor.IStandaloneCodeEditor | null,
  command: AppMenuCommand,
): Promise<void> {
  if (!instance || !instance.getModel()) return;
  const ids: Partial<Record<AppMenuCommand, string>> = {
    undo: "undo",
    redo: "redo",
    cut: "editor.action.clipboardCutAction",
    copy: "editor.action.clipboardCopyAction",
    paste: "editor.action.clipboardPasteAction",
    find: "actions.find",
    replace: "editor.action.startFindReplaceAction",
    selectAll: "editor.action.selectAll",
  };
  const id = ids[command];
  if (!id) return;
  instance.focus();
  const action = instance.getAction(id);
  if (action) {
    await action.run();
    return;
  }
  instance.trigger("app-menu", id, null);
}

/** Resolve file commands without intercepting Alt, composition or normal editing in text fields. */
function fileShortcut(event: KeyboardEvent): AppMenuCommand | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing)
    return null;
  const key = event.key.toLowerCase();
  if (key === "s") return event.shiftKey ? "saveAll" : "save";
  if (event.shiftKey) return null;
  const shortcuts: Record<string, AppMenuCommand> = {
    n: "newFile",
    o: "openFolder",
    w: "closeEditor",
  };
  return shortcuts[key] ?? null;
}
