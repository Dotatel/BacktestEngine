import { useState, type FormEvent } from "react";
import { CircleAlert, FolderInput, LoaderCircle } from "lucide-react";
import type { WorkspaceEntry } from "@/lib/workspace-contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  collectFolders,
  directoryOf,
  displayPath,
  findEntry,
  hasSiblingName,
  isPathWithin,
  nameOf,
} from "../lib/paths";
import type {
  WorkspaceController,
  WorkspaceDialog,
} from "../hooks/useWorkspace";

const rootValue = "__project_root__";

/** Inputs for every decision dialog owned by the workspace controller. */
export interface WorkspaceDialogsProps {
  controller: WorkspaceController;
}

/** Render the active create, rename, move, close, conflict or unsaved decision dialog. */
export function WorkspaceDialogs({ controller }: WorkspaceDialogsProps) {
  const dialog = controller.dialog;
  return (
    <Dialog
      open={Boolean(dialog)}
      onOpenChange={(open) => {
        if (!open && !controller.dialogBusy) controller.dismissDialog();
      }}
    >
      <DialogContent showCloseButton={false}>
        {dialog && (
          <DialogBody
            key={dialogKey(dialog)}
            dialog={dialog}
            controller={controller}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Keep one stable remount key per dialog target so form state resets between operations. */
function dialogKey(dialog: WorkspaceDialog): string {
  if (dialog.kind === "create")
    return `create-${dialog.entryKind}-${dialog.parent}`;
  if (dialog.kind === "unsaved") return `unsaved-${dialog.intent}`;
  return `${dialog.kind}-${dialog.path}`;
}

/** Choose the body for the current dialog kind without a nested conditional expression. */
function DialogBody({
  dialog,
  controller,
}: {
  dialog: WorkspaceDialog;
  controller: WorkspaceController;
}) {
  if (dialog.kind === "create")
    return <CreateBody dialog={dialog} controller={controller} />;
  if (dialog.kind === "rename")
    return <RenameBody dialog={dialog} controller={controller} />;
  if (dialog.kind === "move")
    return <MoveBody dialog={dialog} controller={controller} />;
  if (dialog.kind === "close-tab")
    return <CloseBody dialog={dialog} controller={controller} />;
  if (dialog.kind === "conflict")
    return <ConflictBody dialog={dialog} controller={controller} />;
  return <UnsavedBody dialog={dialog} controller={controller} />;
}

/** Props carried by every dialog body. */
interface DialogBodyProps<T extends WorkspaceDialog> {
  dialog: T;
  controller: WorkspaceController;
}

/** Render an actionable dialog error inside a live region. */
function DialogError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p className="dialog-error" role="alert">
      <CircleAlert aria-hidden="true" />
      {message}
    </p>
  );
}

/** Create a file or folder in the selected project directory. */
function CreateBody({
  dialog,
  controller,
}: DialogBodyProps<Extract<WorkspaceDialog, { kind: "create" }>>) {
  const entries = controller.project.project?.entries ?? [];
  const [name, setName] = useState(() =>
    availableName(entries, dialog.parent, dialog.entryKind),
  );
  const [working, setWorking] = useState(false);
  const label = dialog.entryKind === "file" ? "File name" : "Folder name";

  /** Submit the validated name and leave the dialog open with the host error on failure. */
  async function submit(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    await controller.submitCreate(name);
    setWorking(false);
  }

  return (
    <form className="dialog-form" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>
          New {dialog.entryKind === "file" ? "file" : "folder"}
        </DialogTitle>
        <DialogDescription>
          Create inside {displayPath(dialog.parent)}. Names must be valid on
          Windows.
        </DialogDescription>
      </DialogHeader>
      <div className="dialog-field">
        <Label htmlFor="create-name">{label}</Label>
        <Input
          id="create-name"
          value={name}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>
      <DialogError message={controller.dialogError} />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={controller.dismissDialog}
          disabled={working}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={working || !name.trim()}>
          {working && <LoaderCircle className="spinner" aria-hidden="true" />}
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Rename the selected project entry and validate against siblings. */
function RenameBody({
  dialog,
  controller,
}: DialogBodyProps<Extract<WorkspaceDialog, { kind: "rename" }>>) {
  const [name, setName] = useState(nameOf(dialog.path));
  const [working, setWorking] = useState(false);

  /** Submit the new name and keep host errors visible for a retry. */
  async function submit(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    await controller.submitRename(name);
    setWorking(false);
  }

  return (
    <form className="dialog-form" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>Rename</DialogTitle>
        <DialogDescription>
          Rename {dialog.path}. Open editor tabs follow the new path.
        </DialogDescription>
      </DialogHeader>
      <div className="dialog-field">
        <Label htmlFor="rename-name">New name</Label>
        <Input
          id="rename-name"
          value={name}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>
      <DialogError message={controller.dialogError} />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={controller.dismissDialog}
          disabled={working}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={working || !name.trim()}>
          {working && <LoaderCircle className="spinner" aria-hidden="true" />}
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Move an entry to an existing project folder, including the root. */
function MoveBody({
  dialog,
  controller,
}: DialogBodyProps<Extract<WorkspaceDialog, { kind: "move" }>>) {
  const entries = controller.project.project?.entries ?? [];
  const entry = findEntry(entries, dialog.path);
  const [parent, setParent] = useState(
    dialog.parent ?? directoryOf(dialog.path),
  );
  const [working, setWorking] = useState(false);
  const folders = collectFolders(entries).filter(
    (folder) =>
      entry?.kind !== "folder" || !isPathWithin(folder.id, dialog.path),
  );

  /** Submit the chosen destination and keep validation errors available. */
  async function submit(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    await controller.submitMove(parent);
    setWorking(false);
  }

  return (
    <form className="dialog-form" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>Move {nameOf(dialog.path)}</DialogTitle>
        <DialogDescription>
          Choose an existing folder. A folder cannot move inside itself, and
          names must stay unique.
        </DialogDescription>
      </DialogHeader>
      <div className="dialog-field">
        <Label htmlFor="move-parent">Destination</Label>
        <Select
          value={parent ? parent : rootValue}
          onValueChange={(value) => setParent(value === rootValue ? "" : value)}
        >
          <SelectTrigger id="move-parent" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={rootValue}>Project root</SelectItem>
            {folders.map((folder) => (
              <SelectItem key={folder.id} value={folder.id}>
                {folder.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DialogError message={controller.dialogError} />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={controller.dismissDialog}
          disabled={working}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={working}>
          {working ? (
            <LoaderCircle className="spinner" aria-hidden="true" />
          ) : (
            <FolderInput aria-hidden="true" />
          )}
          Move
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Choose whether a dirty tab is saved or discarded before closing. */
function CloseBody({
  dialog,
  controller,
}: DialogBodyProps<Extract<WorkspaceDialog, { kind: "close-tab" }>>) {
  const [working, setWorking] = useState(false);

  /** Finish the explicit close choice and keep the dialog open if saving fails. */
  async function choose(choice: "save" | "discard") {
    setWorking(true);
    await controller.resolveCloseTab(choice);
    setWorking(false);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Close {nameOf(dialog.path)}?</DialogTitle>
        <DialogDescription>
          This file has unsaved changes. Save them before closing the tab, or
          discard the draft.
        </DialogDescription>
      </DialogHeader>
      <DialogError message={controller.dialogError} />
      <DialogFooter>
        <Button
          variant="outline"
          onClick={controller.dismissDialog}
          disabled={working}
        >
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={() => void choose("discard")}
          disabled={working}
        >
          Discard
        </Button>
        <Button onClick={() => void choose("save")} disabled={working}>
          {working ? (
            <LoaderCircle className="spinner" aria-hidden="true" />
          ) : null}
          Save and close
        </Button>
      </DialogFooter>
    </>
  );
}

/** Resolve a project/structure action that would replace dirty drafts. */
function UnsavedBody({
  dialog,
  controller,
}: DialogBodyProps<Extract<WorkspaceDialog, { kind: "unsaved" }>>) {
  const [working, setWorking] = useState(false);

  /** Continue only after saving every draft or after an explicit discard. */
  async function choose(choice: "save" | "discard") {
    setWorking(true);
    await controller.resolveUnsaved(choice);
    setWorking(false);
  }

  const target =
    dialog.intent === "project"
      ? "opening another project"
      : "changing project files";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Save changes first?</DialogTitle>
        <DialogDescription>
          You have unsaved files. Save them before {target}, or discard the
          drafts. Discarded drafts cannot be recovered from the editor.
        </DialogDescription>
      </DialogHeader>
      <DialogError message={controller.dialogError} />
      <DialogFooter>
        <Button
          variant="outline"
          onClick={controller.dismissDialog}
          disabled={working}
        >
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={() => void choose("discard")}
          disabled={working}
        >
          Discard and continue
        </Button>
        <Button onClick={() => void choose("save")} disabled={working}>
          {working ? (
            <LoaderCircle className="spinner" aria-hidden="true" />
          ) : null}
          Save all and continue
        </Button>
      </DialogFooter>
    </>
  );
}

/** Let the user keep a conflicting draft or reload the host's current file. */
function ConflictBody({
  dialog,
  controller,
}: DialogBodyProps<Extract<WorkspaceDialog, { kind: "conflict" }>>) {
  const [working, setWorking] = useState(false);

  /** Reload the disk version only after the explicit choice. */
  async function reload() {
    setWorking(true);
    await controller.reloadConflict();
    setWorking(false);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>File changed on disk</DialogTitle>
        <DialogDescription>
          {dialog.path} changed after it was opened. Saving the current draft
          would overwrite the external change.
        </DialogDescription>
      </DialogHeader>
      <DialogError message={controller.dialogError} />
      <DialogFooter>
        <Button
          variant="outline"
          onClick={controller.keepConflictDraft}
          disabled={working}
        >
          Keep my draft
        </Button>
        <Button onClick={() => void reload()} disabled={working}>
          {working ? (
            <LoaderCircle className="spinner" aria-hidden="true" />
          ) : null}
          Reload from disk
        </Button>
      </DialogFooter>
    </>
  );
}

/** Build an unused default name so the create form starts with a valid value. */
function availableName(
  entries: WorkspaceEntry[],
  parent: string,
  kind: "file" | "folder",
): string {
  const base = kind === "file" ? "NewFile.cs" : "NewFolder";
  if (!hasSiblingName(entries, parent, base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : "";
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${stem}${index}${extension}`;
    if (!hasSiblingName(entries, parent, candidate)) return candidate;
  }
  return base;
}
