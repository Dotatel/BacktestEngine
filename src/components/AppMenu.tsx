import { useEffect, useRef, useState } from "react";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "./ui/menubar";
import {
  appMenuLabels,
  type AppMenuCommand,
  type AppMenuController,
} from "@/lib/app-menu-contract";
import { AppMenuHelp } from "./AppMenuHelp";

/** Caption-owned native operations reuse the exact same error handling and unsaved-close guard as its buttons. */
export interface AppMenuWindowActions {
  native: boolean;
  maximized: boolean;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
}

const fileGroups: AppMenuCommand[][] = [
  ["newFile", "newFolder", "openFolder"],
  ["save", "saveAll"],
  ["closeEditor", "closeAll"],
];
const editGroups: AppMenuCommand[][] = [
  ["undo", "redo"],
  ["cut", "copy", "paste"],
  ["find", "replace", "selectAll"],
];
const menuKeys: Record<string, string> = {
  f: "file",
  e: "edit",
  v: "view",
  w: "window",
  h: "help",
};

/** Standard Radix menu semantics with real injected workspace callbacks; no caption drag handler surrounds menu hits. */
export function AppMenu({
  controller,
  windowActions,
  perform,
}: {
  controller: AppMenuController;
  windowActions: AppMenuWindowActions;
  perform(action: () => void | Promise<void>): void;
}) {
  const [value, setValue] = useState("");
  const [help, setHelp] = useState<"shortcuts" | "about" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    /** Support conventional Windows access keys without intercepting AltGr or text editing shortcuts. */
    function accessMenu(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.shiftKey || help) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      )
        return;
      const key = event.key.toLowerCase();
      const selected = event.altKey ? menuKeys[key] : undefined;
      if (!selected && key !== "f10") return;
      event.preventDefault();
      const target = selected ?? "file";
      const trigger = root.current?.querySelector<HTMLButtonElement>(
        `[data-app-menu="${target}"]`,
      );
      trigger?.focus();
      if (selected)
        trigger?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
      else setValue("");
    }
    window.addEventListener("keydown", accessMenu);
    return () => window.removeEventListener("keydown", accessMenu);
  }, [help]);

  /** Missing registrations stay disabled; command failures use the caption's existing visible error channel. */
  function commandItem(command: AppMenuCommand) {
    const action = controller.actions[command];
    return (
      <MenubarItem
        key={command}
        disabled={!action?.enabled}
        onSelect={() => {
          if (action?.enabled) perform(action.run);
        }}
      >
        {appMenuLabels[command]}
        {action?.shortcut ? (
          <>
            {" "}
            <MenubarShortcut>{action.shortcut}</MenubarShortcut>
          </>
        ) : null}
      </MenubarItem>
    );
  }

  /** Group related operations with the upstream separator instead of custom control styling. */
  function commandGroups(groups: AppMenuCommand[][]) {
    return groups.map((group, index) => (
      <div key={index}>
        {index > 0 ? <MenubarSeparator /> : null}
        {group.map(commandItem)}
      </div>
    ));
  }

  return (
    <>
      <Menubar
        ref={root}
        value={value}
        onValueChange={setValue}
        aria-label="Application menu"
        className="border-transparent bg-transparent shadow-none"
      >
        <MenubarMenu value="file">
          <MenubarTrigger data-app-menu="file">File</MenubarTrigger>
          <MenubarContent className="border-transparent shadow-none">
            {commandGroups(fileGroups)}
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu value="edit">
          <MenubarTrigger data-app-menu="edit">Edit</MenubarTrigger>
          <MenubarContent className="border-transparent shadow-none">
            {commandGroups(editGroups)}
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu value="view">
          <MenubarTrigger data-app-menu="view">View</MenubarTrigger>
          <MenubarContent className="border-transparent shadow-none">
            {(
              [
                ["toggleExplorer", "explorer"],
                ["toggleParameters", "parameters"],
                ["toggleAssistant", "assistant"],
              ] as const
            ).map(([command, state]) => (
              <MenubarCheckboxItem
                key={command}
                checked={controller.view[state]}
                disabled={!controller.actions[command]?.enabled}
                onCheckedChange={() => {
                  const action = controller.actions[command];
                  if (action?.enabled) perform(action.run);
                }}
              >
                {appMenuLabels[command]}
              </MenubarCheckboxItem>
            ))}
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu value="window">
          <MenubarTrigger data-app-menu="window">Window</MenubarTrigger>
          <MenubarContent className="border-transparent shadow-none">
            <MenubarItem
              disabled={!windowActions.native}
              onSelect={windowActions.minimize}
            >
              Minimize
            </MenubarItem>
            <MenubarItem
              disabled={!windowActions.native}
              onSelect={windowActions.toggleMaximize}
            >
              {windowActions.maximized ? "Restore" : "Maximize"}
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem
              disabled={!windowActions.native}
              onSelect={windowActions.close}
            >
              Close window
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu value="help">
          <MenubarTrigger data-app-menu="help">Help</MenubarTrigger>
          <MenubarContent className="border-transparent shadow-none">
            <MenubarItem onSelect={() => setHelp("shortcuts")}>
              Keyboard shortcuts
            </MenubarItem>
            <MenubarItem onSelect={() => setHelp("about")}>
              About BacktestEngine
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <AppMenuHelp
        page={help}
        onClose={() => setHelp(null)}
        controller={controller}
      />
    </>
  );
}
