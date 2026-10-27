import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePlus2,
  Folder,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  RefreshCw,
} from "lucide-react";
import {
  Tree,
  type NodeApi,
  type NodeRendererProps,
  type RowRendererProps,
} from "react-arborist";
import type {
  WorkspaceEntry,
  WorkspaceProject,
} from "@/lib/workspace-contract";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { directoryOf, findEntry } from "../lib/paths";
import type { WorkspaceDocumentsController } from "../hooks/useWorkspaceDocuments";

/** An explorer entry extended only with the dirty marker needed by its row renderer. */
interface ExplorerEntry extends WorkspaceEntry {
  dirty?: boolean;
  children?: ExplorerEntry[];
}

/** Inputs for the real project tree and its accessible file actions. */
export interface ProjectExplorerProps {
  project: WorkspaceProject;
  activePath: string | null;
  documents: WorkspaceDocumentsController;
  dirty: boolean;
  busy: boolean;
  onCreate(kind: "file" | "folder", parent: string): void;
  onRename(path: string): void;
  onMove(path: string): void;
  onRefresh(): void;
  onDrop(path: string, parent: string): void;
  onCollapse(): void;
}

/** Render the project tree with real bridge entries, dirty markers and keyboard file actions. */
export function ProjectExplorer({
  project,
  activePath,
  documents,
  dirty,
  busy,
  onCreate,
  onRename,
  onMove,
  onRefresh,
  onDrop,
  onCollapse,
}: ProjectExplorerProps) {
  const [selected, setSelected] = useState<string | null>(activePath);
  const treeArea = useElementHeight<HTMLDivElement>();
  const entries = useMemo(
    () => decorateEntries(project.entries, documents),
    [documents, project.entries],
  );

  useEffect(() => {
    if (activePath) setSelected(activePath);
  }, [activePath]);

  const targetFolder = folderForTarget(project.entries, selected, activePath);
  const height = Math.max(0, Math.floor(treeArea.height));

  /** Treat activation as opening a file or toggling a folder while keeping one selected entry. */
  function activate(entry: ExplorerEntry, toggle: () => void) {
    setSelected(entry.id);
    if (entry.kind === "folder") {
      toggle();
      return;
    }
    void documents.open(entry.id);
  }

  /** Disable drops with no target or onto the dragged folder or one of its descendants. */
  function isInvalidDrop(args: {
    parentNode: NodeApi<ExplorerEntry> | null;
    dragNodes: NodeApi<ExplorerEntry>[];
  }): boolean {
    if (!args.parentNode) return true;
    const parent = args.parentNode;
    return args.dragNodes.some(
      (node) => node.id === parent.id || node.isAncestorOf(parent),
    );
  }

  return (
    <aside className="workspace-panel explorer" aria-label="Project explorer">
      <div className="panel-head">
        <h2 className="panel-title">Explorer</h2>
        <TooltipProvider delayDuration={500}>
          <div className="panel-actions">
            <ExplorerAction
              label={`New file in ${targetFolder || "project root"}`}
              onClick={() => onCreate("file", targetFolder)}
              disabled={busy}
            >
              <FilePlus2 aria-hidden="true" />
            </ExplorerAction>
            <ExplorerAction
              label={`New folder in ${targetFolder || "project root"}`}
              onClick={() => onCreate("folder", targetFolder)}
              disabled={busy}
            >
              <FolderPlus aria-hidden="true" />
            </ExplorerAction>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Explorer actions"
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => selected && onRename(selected)}
                  disabled={busy || !selected}
                >
                  <Pencil aria-hidden="true" />
                  Rename selected item
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => selected && onMove(selected)}
                  disabled={busy || !selected}
                >
                  <FolderInput aria-hidden="true" />
                  Move selected item
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onRefresh} disabled={busy}>
                  <RefreshCw aria-hidden="true" />
                  Refresh project tree
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onCollapse}>
                  <PanelLeftClose aria-hidden="true" />
                  Collapse project explorer
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TooltipProvider>
      </div>
      <div className="explorer-project" title={project.root}>
        <span className="explorer-project__name">{project.name}</span>
        <span className="explorer-project__root">{project.root}</span>
      </div>
      <div className="explorer-tree" ref={treeArea.ref}>
        {entries.length ? (
          <Tree<ExplorerEntry>
            data={entries}
            idAccessor="id"
            childrenAccessor="children"
            openByDefault
            width="100%"
            height={height}
            paddingTop={4}
            paddingBottom={4}
            renderRow={ExplorerRow}
            rowHeight={26}
            indent={14}
            selection={activePath ?? undefined}
            disableMultiSelection
            disableDrop={isInvalidDrop}
            onSelect={(nodes) => setSelected(nodes[0]?.data.id ?? null)}
            onActivate={(node) => activate(node.data, node.toggle)}
            onMove={(args) => {
              const path = args.dragIds[0];
              if (path) onDrop(path, args.parentId ?? "");
            }}
            aria-label="Project files"
          >
            {ExplorerNode}
          </Tree>
        ) : (
          <div className="explorer-empty">
            <p>This project folder is empty.</p>
            <p>Create a C# file to start a strategy.</p>
          </div>
        )}
      </div>
      <p className="explorer-hint">
        {dirty
          ? "Save or discard drafts before reorganizing files."
          : "Enter opens a file. Arrow keys navigate. Drag to move."}
      </p>
    </aside>
  );
}

/** Keep Arborist row semantics while allowing labels to shrink within the available viewport. */
function ExplorerRow({
  node,
  attrs,
  innerRef,
  children,
}: RowRendererProps<ExplorerEntry>) {
  return (
    <div
      {...attrs}
      ref={innerRef}
      style={{ ...attrs.style, minWidth: 0 }}
      onFocus={(event) => event.stopPropagation()}
      onClick={node.handleClick}
    >
      {children}
    </div>
  );
}

/** Render one tree row, attaching the tree's drag handle so rows can actually be dragged. */
function ExplorerNode({
  node,
  style,
  dragHandle,
}: NodeRendererProps<ExplorerEntry>) {
  const entry = node.data;
  const folder = entry.kind === "folder";
  return (
    <div
      ref={dragHandle}
      style={style}
      className="explorer-node"
      data-selected={node.isSelected}
      data-folder={folder}
    >
      <span className="explorer-twisty" aria-hidden="true">
        {folder && (node.isOpen ? <ChevronDown /> : <ChevronRight />)}
      </span>
      {folder ? (
        <Folder className="explorer-icon" aria-hidden="true" />
      ) : (
        <FileCode2 className="explorer-icon" aria-hidden="true" />
      )}
      <span className="explorer-name" title={entry.name}>
        {entry.name}
      </span>
      {entry.dirty && (
        <span className="explorer-dirty" aria-label="Unsaved changes" />
      )}
    </div>
  );
}

/** One tooltip-backed icon action keeps the explorer header compact and labelled. */
function ExplorerAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick(): void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Copy the tree with dirty flags so the row renderer stays a pure module-level component. */
function decorateEntries(
  entries: WorkspaceEntry[],
  documents: WorkspaceDocumentsController,
): ExplorerEntry[] {
  return entries.map((entry) => ({
    ...entry,
    dirty: documents.documents[entry.id]?.dirty ?? false,
    children:
      entry.kind === "folder"
        ? decorateEntries(entry.children ?? [], documents)
        : undefined,
  }));
}

/** Choose the folder that receives a new entry from the current tree selection. */
function folderForTarget(
  entries: WorkspaceEntry[],
  selected: string | null,
  activePath: string | null,
): string {
  const path = selected ?? activePath;
  if (!path) return "";
  if (findEntry(entries, path)?.kind === "folder") return path;
  return directoryOf(path);
}

/** Fit the virtualized list to the content height; Arborist alone owns its scrollbars and row padding. */
function useElementHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setHeight(element.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, height };
}
