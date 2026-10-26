import type { Appearance, WorkspaceStyle } from "./preferences";

/** One project-relative explorer item; identifiers use forward slashes and never escape the selected root. */
export interface WorkspaceEntry {
  id: string;
  name: string;
  kind: "file" | "folder";
  children?: WorkspaceEntry[];
}

/** A real selected project and its current tree; root is for display, not a renderer filesystem authority. */
export interface WorkspaceProject {
  root: string;
  name: string;
  entries: WorkspaceEntry[];
}

/** Text plus a host-issued content revision used to reject overwriting externally changed files. */
export interface WorkspaceDocument {
  path: string;
  content: string;
  revision: string;
}

/** Durable view state, independent of source contents and the onboarding preference schema. */
export interface WorkspaceSession {
  lastProject: string | null;
  activeFile: string | null;
  openFiles: string[];
  presets: WorkspacePreset[];
}

/** A named parameter choice tied to its project and compiled robot, independent from editor text. */
export interface WorkspacePreset {
  projectRoot: string;
  strategy: string;
  name: string;
  values: Record<string, unknown>;
}

/** A compiler-produced diagnostic; line/column are one-based, and absent when the failure has no source span. */
export interface BuildDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
  path?: string;
  line?: number;
  column?: number;
}

/** Reflection evidence from an actually compiled strategy, never inferred by parsing editor text. */
export interface StrategyParameter {
  name: string;
  displayName: string;
  group: string;
  valueType: "integer" | "number" | "boolean" | "enum" | "timeframe" | "string";
  default: unknown;
  min: number | null;
  max: number | null;
  step: number | null;
  options: string[] | null;
}

/** The preserved engine's reflected schema for a compiled robot type. */
export interface CompiledStrategy {
  strategy: string;
  strategyType: string;
  parameters: StrategyParameter[];
}

/** Actual compiler outcome with honest capability failures; successful artifacts identify the saved source revision. */
export interface WorkspaceBuild {
  success: boolean;
  diagnostics: BuildDiagnostic[];
  output: string;
  durationMs: number;
  strategies: CompiledStrategy[];
  artifactPath: string | null;
}

/** Scoped native operations; the browser implementation is explicitly an isolated preview and never fabricates builds. */
export interface WorkspaceBridge {
  native: boolean;
  loadSession(): Promise<WorkspaceSession>;
  saveSession(session: WorkspaceSession): Promise<void>;
  createProject(): Promise<WorkspaceProject>;
  pickProject(): Promise<WorkspaceProject | null>;
  openProject(root: string): Promise<WorkspaceProject>;
  refreshProject(): Promise<WorkspaceProject>;
  readDocument(path: string): Promise<WorkspaceDocument>;
  saveDocument(
    path: string,
    content: string,
    revision: string,
  ): Promise<WorkspaceDocument>;
  createEntry(
    parent: string,
    name: string,
    kind: "file" | "folder",
  ): Promise<WorkspaceProject>;
  renameEntry(path: string, name: string): Promise<WorkspaceProject>;
  moveEntry(path: string, parent: string): Promise<WorkspaceProject>;
  build(): Promise<WorkspaceBuild>;
  cancelBuild(): Promise<void>;
}

/** Workspace composition inputs; onboarding remains the sole owner of its existing persisted preferences. */
export interface BuildWorkspaceProps {
  bridge: WorkspaceBridge;
  appearance: Appearance;
  workspaceStyle: WorkspaceStyle;
  onAppearanceChange(appearance: Appearance): void;
  onWorkspaceStyleChange?(workspaceStyle: WorkspaceStyle): void;
  onReviewSetup(): void;
  onDirtyChange?(dirty: boolean): void;
  onFlushChange?(flush: (() => Promise<void>) | null): void;
}
