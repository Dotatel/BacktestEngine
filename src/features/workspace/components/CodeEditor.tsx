import { useCallback, useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import {
  configureMonaco,
  editorTheme,
  editorThemes,
} from "../lib/monaco-setup";

/** Inputs for the lazily loaded, locally bundled code editor. */
export interface CodeEditorProps {
  /** Project-relative path used as the Monaco model key so undo history stays per file. */
  path: string;
  value: string;
  language: string;
  dark: boolean;
  readOnly: boolean;
  ariaLabel: string;
  revealLine: { line: number; column: number; nonce: number } | null;
  onChange(value: string): void;
  onSave(): void;
}

/**
 * Render the locally bundled Monaco editor for one open document. The module is lazy-loaded by the
 * editor workspace; workers and themes are configured without a CDN request.
 */
export default function CodeEditor({
  path,
  value,
  language,
  dark,
  readOnly,
  ariaLabel,
  revealLine,
  onChange,
  onSave,
}: CodeEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  const handleMount = useCallback<OnMount>((instance, monaco) => {
    editorRef.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
  }, []);

  useEffect(() => {
    if (!revealLine || !editorRef.current) return;
    const position = {
      lineNumber: revealLine.line,
      column: Math.max(1, revealLine.column),
    };
    editorRef.current.setPosition(position);
    editorRef.current.revealPositionInCenter(position);
    editorRef.current.focus();
  }, [revealLine]);

  return (
    <div className="code-editor" data-language={language}>
      <Editor
        path={path}
        value={value}
        language={language}
        theme={editorTheme(dark)}
        beforeMount={() => configureMonaco()}
        onMount={handleMount}
        onChange={(next) => onChange(next ?? "")}
        loading={
          <div className="editor-loading">Loading the local editor...</div>
        }
        options={{
          readOnly,
          ariaLabel,
          fontFamily:
            "ui-monospace, 'Cascadia Mono', 'Segoe UI Mono', Consolas, monospace",
          fontSize: 13,
          lineHeight: 20,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling: false,
          automaticLayout: true,
          renderWhitespace: "selection",
          tabSize: 4,
          insertSpaces: true,
          padding: { top: 8, bottom: 8 },
          overviewRulerLanes: 0,
          renderLineHighlight: "line",
          wordWrap: "off",
          bracketPairColorization: { enabled: true },
          guides: { indentation: true },
          find: { addExtraSpaceOnTop: false },
          fixedOverflowWidgets: true,
          theme: dark ? editorThemes.dark : editorThemes.light,
        }}
      />
    </div>
  );
}
