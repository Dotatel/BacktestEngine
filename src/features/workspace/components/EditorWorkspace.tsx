import { lazy, Suspense } from "react";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { languageForPath, nameOf } from "../lib/paths";
import type {
  WorkspaceDocumentView,
  WorkspaceDocumentsController,
} from "../hooks/useWorkspaceDocuments";

const CodeEditor = lazy(() => import("./CodeEditor"));
const noFileValue = "__no_file__";

/** Inputs for open editor tabs and the Monaco source surface. */
export interface EditorWorkspaceProps {
  root: string;
  documents: WorkspaceDocumentsController;
  dark: boolean;
  onCloseTab(path: string): void;
  onSave(): void;
}

/** Render open file tabs and the real source editor, including loading and conflict states. */
export function EditorWorkspace({
  root,
  documents,
  dark,
  onCloseTab,
  onSave,
}: EditorWorkspaceProps) {
  const active = documents.activePath
    ? (documents.documents[documents.activePath] ?? null)
    : null;
  const reveal =
    documents.reveal && documents.reveal.path === documents.activePath
      ? documents.reveal
      : null;

  return (
    <section
      className="workspace-panel editor-panel"
      aria-label="Source editor"
    >
      <Tabs
        value={documents.activePath ?? noFileValue}
        onValueChange={documents.activate}
        className="editor-tabs"
      >
        <div className="file-tabs">
          {documents.openPaths.length > 0 ? (
            <TabsList
              variant="line"
              className="file-tabs__list"
              aria-label="Open files"
            >
              {documents.openPaths.map((path) => (
                <div
                  key={path}
                  className="file-tab"
                  data-active={path === documents.activePath}
                >
                  <TabsTrigger
                    value={path}
                    className="file-tab__label"
                    title={path}
                    onKeyDown={(event) => {
                      if (event.key !== "Delete") return;
                      event.preventDefault();
                      onCloseTab(path);
                    }}
                  >
                    <span className="file-tab__name">{nameOf(path)}</span>
                    {documents.documents[path]?.dirty && (
                      <>
                        <span className="file-tab__dirty" aria-hidden="true">
                          ●
                        </span>
                        <span className="sr-only">Unsaved changes</span>
                      </>
                    )}
                  </TabsTrigger>
                </div>
              ))}
            </TabsList>
          ) : (
            <span className="file-tabs__empty">No files open</span>
          )}
          {documents.activePath && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="file-tab__close"
              aria-label={`Close ${nameOf(documents.activePath)}`}
              onClick={() => onCloseTab(documents.activePath!)}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
        {active?.conflict && (
          <p className="editor-conflict" role="alert">
            This file changed on disk after it was opened. Your draft is
            preserved; saving will be rejected until you reload the file or keep
            the draft.
          </p>
        )}
        {documents.openPaths.map((path) => (
          <TabsContent
            key={path}
            value={path}
            className="editor-tab-content"
            aria-label={`Source of ${nameOf(path)}`}
          >
            <EditorSurface
              root={root}
              document={documents.documents[path] ?? null}
              dark={dark}
              reveal={path === documents.activePath ? reveal : null}
              onDraft={(value) => documents.update(path, value)}
              onRetry={() => void documents.reload(path)}
              onSave={onSave}
            />
          </TabsContent>
        ))}
        {documents.openPaths.length === 0 && (
          <div className="editor-tab-content">
            <EditorSurface
              root={root}
              document={null}
              dark={dark}
              reveal={null}
              onDraft={() => undefined}
              onRetry={() => undefined}
              onSave={onSave}
            />
          </div>
        )}
      </Tabs>
    </section>
  );
}

/** Props for the active document's load/edit state. */
interface EditorSurfaceProps {
  root: string;
  document: WorkspaceDocumentView | null;
  dark: boolean;
  reveal: { line: number; column: number; nonce: number } | null;
  onDraft(value: string): void;
  onRetry(): void;
  onSave(): void;
}

/** Render loading, error, empty and ready editor states without inventing file contents. */
function EditorSurface({
  root,
  document,
  dark,
  reveal,
  onDraft,
  onRetry,
  onSave,
}: EditorSurfaceProps) {
  if (!document) {
    return (
      <div className="editor-empty">
        <p>No file is open.</p>
        <p>Choose a file in the explorer to edit its saved source.</p>
      </div>
    );
  }
  if (document.status === "loading") {
    return (
      <div className="editor-loading" role="status">
        <LoaderCircle className="spinner" aria-hidden="true" />
        Loading {nameOf(document.path)}...
      </div>
    );
  }
  if (document.status === "error") {
    return (
      <div className="editor-error" role="alert">
        <CircleAlert aria-hidden="true" />
        <p>{document.error}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <div className="editor-loading">Loading the local editor...</div>
      }
    >
      <CodeEditor
        path={`${root.replaceAll("\\", "/")}/${document.path}`}
        value={document.draft}
        language={languageForPath(document.path)}
        dark={dark}
        readOnly={false}
        ariaLabel={`Source of ${nameOf(document.path)}`}
        revealLine={reveal}
        onChange={onDraft}
        onSave={onSave}
      />
    </Suspense>
  );
}
