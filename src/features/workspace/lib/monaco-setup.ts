import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";

/** Names of the two local editor themes that mirror the workspace palette. */
export const editorThemes = {
  dark: "dotatel-dark",
  light: "dotatel-light",
} as const;

/** Minimal worker environment used by Monaco instead of a CDN worker loader. */
interface MonacoWorkerEnvironment {
  getWorker(moduleId: string, label: string): Worker;
}

let configured = false;

/**
 * Bundle Monaco's editor and JSON workers locally and register the workspace themes once. The
 * loader is pointed at this bundled instance so no request leaves the desktop app.
 */
export function configureMonaco(): typeof monaco {
  if (configured) return monaco;
  (
    globalThis as unknown as { MonacoEnvironment: MonacoWorkerEnvironment }
  ).MonacoEnvironment = {
    /** Create the locally bundled worker for the requested language label. */
    getWorker(_moduleId, label) {
      return label === "json" ? new JsonWorker() : new EditorWorker();
    },
  };
  defineEditorThemes();
  loader.config({ monaco });
  configured = true;
  return monaco;
}

/** Choose the editor theme name for the current appearance, resolving the system preference. */
export function editorTheme(dark: boolean): string {
  return dark ? editorThemes.dark : editorThemes.light;
}

/* Configure the bundled loader during module evaluation: @monaco-editor/react calls loader.init()
 * before beforeMount, so configuring later could still request the default CDN loader. */
configureMonaco();

/** Define matching dark/light editor palettes from the approved semantic colors. */
function defineEditorThemes() {
  monaco.editor.defineTheme(editorThemes.dark, {
    base: "vs-dark",
    inherit: true,
    colors: {
      "editor.background": "#0C1811",
      "editor.foreground": "#F4F6EE",
      "editorLineNumber.foreground": "#6F8474",
      "editorLineNumber.activeForeground": "#F4F6EE",
      "editor.selectionBackground": "#294432",
      "editor.inactiveSelectionBackground": "#193322",
      "editor.lineHighlightBackground": "#102417",
      "editorCursor.foreground": "#C7FF1A",
      "editorIndentGuide.background1": "#1C3123",
      "editorIndentGuide.activeBackground1": "#3A5C46",
      "editorWidget.background": "#0C1811",
      "editorWidget.border": "#294432",
      "editorSuggestWidget.background": "#0C1811",
      "editorSuggestWidget.border": "#294432",
      "editorHoverWidget.background": "#102417",
      "input.background": "#102417",
    },
    rules: [
      { token: "comment", foreground: "7C9784", fontStyle: "italic" },
      { token: "keyword", foreground: "C7FF1A" },
      { token: "string", foreground: "CFEFA8" },
      { token: "number", foreground: "F2C879" },
      { token: "type", foreground: "8FD3FF" },
      { token: "identifier", foreground: "F4F6EE" },
      { token: "delimiter", foreground: "A4B5A9" },
    ],
  });
  monaco.editor.defineTheme(editorThemes.light, {
    base: "vs",
    inherit: true,
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#080D0A",
      "editorLineNumber.foreground": "#6B7A6F",
      "editorLineNumber.activeForeground": "#080D0A",
      "editor.selectionBackground": "#CFE4BC",
      "editor.inactiveSelectionBackground": "#E7EFDC",
      "editor.lineHighlightBackground": "#F4F6EE",
      "editorCursor.foreground": "#337229",
      "editorIndentGuide.background1": "#DCE7D6",
      "editorIndentGuide.activeBackground1": "#A9BDA4",
      "editorWidget.background": "#FFFFFF",
      "editorWidget.border": "#BDCBB9",
      "editorSuggestWidget.background": "#FFFFFF",
      "editorSuggestWidget.border": "#BDCBB9",
      "editorHoverWidget.background": "#F4F6EE",
      "input.background": "#F4F6EE",
    },
    rules: [
      { token: "comment", foreground: "5F7466", fontStyle: "italic" },
      { token: "keyword", foreground: "2E6B1F" },
      { token: "string", foreground: "3F6B2A" },
      { token: "number", foreground: "8A4B00" },
      { token: "type", foreground: "1F5E8A" },
      { token: "identifier", foreground: "080D0A" },
      { token: "delimiter", foreground: "526058" },
    ],
  });
}
