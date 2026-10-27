import type { ReactElement } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/** Actions target the clicked tab's displayed order, independently of the active editor. */
export interface EditorTabMenuProps {
  path: string;
  paths: string[];
  children: ReactElement;
  onClose(path: string): void;
  onCloseTabs(paths: string[]): void;
}

/** Use Radix's portal, dismissal and menu keyboard behavior for the standard file-tab close actions. */
export function EditorTabMenu({
  path,
  paths,
  children,
  onClose,
  onCloseTabs,
}: EditorTabMenuProps) {
  const others = paths.filter((candidate) => candidate !== path);
  const right = paths.slice(paths.indexOf(path) + 1);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onClose(path)}>Close</ContextMenuItem>
        <ContextMenuItem
          disabled={others.length === 0}
          onSelect={() => onCloseTabs(others)}
        >
          Close Others
        </ContextMenuItem>
        <ContextMenuItem
          disabled={right.length === 0}
          onSelect={() => onCloseTabs(right)}
        >
          Close to Right
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCloseTabs([...paths])}>
          Close All
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
