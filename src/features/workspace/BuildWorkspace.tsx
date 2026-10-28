import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  X,
} from "lucide-react";
import type { Appearance, WorkspaceStyle } from "@/lib/preferences";
import type { BuildWorkspaceProps } from "@/lib/workspace-contract";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  usePanelRef,
  type Layout,
  type LayoutChangedMeta,
  type PanelImperativeHandle,
} from "react-resizable-panels";
import { useWorkspace } from "./hooks/useWorkspace";
import { compactPanelDecision, type PanelVisibilityIntent } from "./lib/panels";
import { BuildResults } from "./components/BuildResults";
import { EditorWorkspace } from "./components/EditorWorkspace";
import { ParameterInspector } from "./components/ParameterInspector";
import { ProjectExplorer } from "./components/ProjectExplorer";
import { WorkspaceDialogs } from "./components/WorkspaceDialogs";
import { WorkspaceEmpty } from "./components/WorkspaceEmpty";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { WorkspaceRail } from "./components/WorkspaceRail";
import { WorkspaceStatus } from "./components/WorkspaceStatus";
import { BacktestStage } from "@/features/execution/BacktestStage";
import { execution } from "@/lib/execution";
import { ReportsStage } from "@/features/reports/ReportsStage";
import { reports } from "@/lib/reports";
import { ValidationStage } from "@/features/validation/ValidationStage";
import { validation } from "@/lib/validation";
import { OptimizeStage } from "@/features/optimization/OptimizeStage";
import { optimization } from "@/lib/optimization";
import { AssistantPanel } from "@/features/assistant/AssistantPanel";
import { assistant } from "@/lib/assistant";
import { savedRuns } from "@/lib/saved-runs";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { ExtensionsPage } from "@/features/extensions/ExtensionsPage";
import { extensions } from "@/lib/extensions";
import { settings } from "@/lib/settings";
import { updates } from "@/lib/updates";
import type { SavedRunSelection } from "@/lib/saved-runs-contract";
import { useWorkspaceFlush } from "./hooks/useWorkspaceFlush";
import { useWorkspaceMenu } from "./hooks/useWorkspaceMenu";
import type { editor } from "monaco-editor";
import "./workspace.css";
import "@/features/execution/execution.css";

/** The mutually exclusive stage rendered under the persistent header and rail. */
type Stage = "session-error" | "loading" | "empty" | "project";

/**
 * Compose the Build workspace from real bridge-backed hooks: project explorer, local editor,
 * compiler evidence and reflected parameters. The section's label is the public boundary used by
 * app routing, accessibility checks and native window lifecycle tests.
 */
export function BuildWorkspace(props: BuildWorkspaceProps) {
  const persistence = useWorkspaceFlush(props.onFlushChange);
  const workspace = useWorkspace({
    ...props,
    onFlushChange: persistence.registerWorkspace,
  });
  const { session, project, documents, build } = workspace;
  const dark = useResolvedDark(props.appearance);
  const explorerPanel = usePanelRef();
  const inspectorPanel = usePanelRef();
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [activeStage, setActiveStage] = useState<
    "build" | "backtest" | "optimize" | "validate" | "report"
  >("build");
  const [backtestBusy, setBacktestBusy] = useState(false);
  const [optimizationBusy, setOptimizationBusy] = useState(false);
  const [validationBusy, setValidationBusy] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [utilityPage, setUtilityPage] = useState<
    "settings" | "extensions" | null
  >(null);
  const settingsOpen = utilityPage === "settings";
  const extensionsOpen = utilityPage === "extensions";
  const utilityOpen = utilityPage !== null;
  const settingsButton = useRef<HTMLButtonElement>(null);
  const extensionsButton = useRef<HTMLButtonElement>(null);
  const [editorInstance, setEditorInstance] =
    useState<editor.IStandaloneCodeEditor | null>(null);
  const [commandError, setCommandError] = useState("");
  const [savedSelection, setSavedSelection] =
    useState<SavedRunSelection | null>(null);
  useEffect(() => {
    setSavedSelection(null);
  }, [project.project?.root]);
  const inspectorIntent = useRef<PanelVisibilityIntent>({
    userCollapsed: false,
    autoCollapsed: false,
  });
  useCompactInspector(
    inspectorPanel,
    Boolean(project.project),
    inspectorIntent,
    setInspectorCollapsed,
  );
  useWorkspaceStyle(
    props.workspaceStyle,
    Boolean(project.project),
    inspectorPanel,
    inspectorIntent,
    setInspectorCollapsed,
  );

  const stage = stageFor(workspace);
  const openingStoredProject =
    !project.project && Boolean(session.session?.lastProject) && !project.error;

  const collapseExplorer = useCallback(() => {
    explorerPanel.current?.collapse();
    setExplorerCollapsed(true);
  }, [explorerPanel]);

  const collapseInspector = useCallback(() => {
    inspectorIntent.current = { userCollapsed: true, autoCollapsed: false };
    inspectorPanel.current?.collapse();
    setInspectorCollapsed(true);
  }, [inspectorPanel]);

  /** Remember an explicit drag or keyboard collapse so the breakpoint cannot reopen the panel. */
  const noteInspectorLayout = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      const collapsed = layout.inspector === 0;
      inspectorIntent.current = {
        userCollapsed: collapsed,
        autoCollapsed: false,
      };
    },
    [],
  );

  /** Toggle the explorer between its remembered width and a zero-width collapsed track. */
  function toggleExplorer() {
    if (explorerCollapsed) explorerPanel.current?.expand();
    else explorerPanel.current?.collapse();
    setExplorerCollapsed(!explorerCollapsed);
  }

  /** Toggle the inspector, keeping an explicit user choice ahead of the breakpoint. */
  function toggleInspector() {
    if (!inspectorCollapsed) {
      collapseInspector();
      return;
    }
    inspectorIntent.current = { userCollapsed: false, autoCollapsed: false };
    inspectorPanel.current?.expand();
    setInspectorCollapsed(false);
  }

  /** Retry the latest durable session snapshot after a visible write failure. */
  function retrySessionSave() {
    void session.flush().catch(() => undefined);
  }

  /** Restore keyboard focus to the persistent settings entry without remounting the workspace. */
  function closeSettings() {
    setUtilityPage(null);
    settingsButton.current?.focus();
  }

  /** Restore the original puzzle entry's focus while retaining editor and workflow state. */
  function closeExtensions() {
    setUtilityPage(null);
    extensionsButton.current?.focus();
  }

  useWorkspaceMenu({
    workspace,
    editor: editorInstance,
    buildVisible: !utilityOpen && activeStage === "build",
    executionBusy:
      utilityOpen || backtestBusy || optimizationBusy || validationBusy,
    native: props.bridge.native,
    explorerVisible:
      !utilityOpen && activeStage === "build" && !explorerCollapsed,
    parametersVisible:
      !utilityOpen && activeStage === "build" && !inspectorCollapsed,
    assistantVisible: !utilityOpen && assistantOpen,
    toggleExplorer: () => {
      if (activeStage === "build" || explorerCollapsed) toggleExplorer();
      setActiveStage("build");
    },
    toggleParameters: () => {
      if (activeStage === "build" || inspectorCollapsed) toggleInspector();
      setActiveStage("build");
    },
    toggleAssistant: () => {
      setUtilityPage(null);
      setAssistantOpen((open) => !open);
    },
    reportError: setCommandError,
    register: props.onMenuChange,
  });

  return (
    <section
      className="build-workspace"
      aria-label="Build workspace"
      aria-busy={session.loading || project.busy || build.phase !== "idle"}
    >
      <div className="workspace-header-host" hidden={utilityOpen}>
        <WorkspaceHeader
          projectName={
            project.project?.name ??
            (openingStoredProject ? "Opening project" : "Build workspace")
          }
          projectRoot={
            project.project?.root ?? session.session?.lastProject ?? ""
          }
          phase={build.phase}
          stage={activeStage}
          executionBusy={backtestBusy || optimizationBusy || validationBusy}
          assistantOpen={assistantOpen}
          onToggleAssistant={() => setAssistantOpen((open) => !open)}
          canOptimize={Boolean(project.project && props.bridge.native)}
          canReport={Boolean(project.project && props.bridge.native)}
          canValidate={Boolean(project.project && props.bridge.native)}
          canSave={documents.dirtyPaths.length > 0 && !project.busy}
          canBuild={Boolean(project.project) && !project.busy}
          canBacktest={Boolean(project.project && props.bridge.native)}
          onSaveAll={() => void workspace.saveAll()}
          onBuild={() => void workspace.buildProject()}
          onCancel={() => void workspace.cancelBuild()}
          onSelectStage={setActiveStage}
        />
      </div>
      <div className="workspace-body">
        <WorkspaceRail
          settingsOpen={settingsOpen}
          extensionsOpen={extensionsOpen}
          settingsButtonRef={settingsButton}
          extensionsButtonRef={extensionsButton}
          onOpenSettings={() => setUtilityPage("settings")}
          onOpenExtensions={() => setUtilityPage("extensions")}
          onOpenExplorer={() => {
            setUtilityPage(null);
            setActiveStage("build");
          }}
        />
        {settingsOpen && (
          <SettingsPage
            appearance={props.appearance}
            workspaceStyle={props.workspaceStyle}
            onAppearanceChange={props.onAppearanceChange}
            onWorkspaceStyleChange={props.onWorkspaceStyleChange}
            onReviewSetup={props.onReviewSetup}
            onClose={closeSettings}
            project={project.project}
            bridge={settings}
            updatesBridge={updates}
          />
        )}
        {extensionsOpen && (
          <ExtensionsPage
            bridge={extensions}
            reportsBridge={reports}
            projectRoot={project.project?.root ?? null}
            onClose={closeExtensions}
            onGoToReports={() => {
              setUtilityPage(null);
              setActiveStage("report");
            }}
            onOpenAssistant={() => {
              setUtilityPage(null);
              setAssistantOpen(true);
            }}
          />
        )}
        <div className="workspace-main" hidden={utilityOpen}>
          <WorkspaceBanners
            notice={
              commandError
                ? { text: commandError, tone: "error" }
                : workspace.notice
            }
            saveError={session.saveError}
            projectError={project.error}
            onDismissNotice={() => {
              setCommandError("");
              workspace.dismissNotice();
            }}
            onRetrySave={retrySessionSave}
            onDismissProjectError={project.clearError}
            onRetryProject={workspace.retryStoredProject}
          />
          <div className="workspace-stage">
            {stage === "session-error" && (
              <WorkspaceFailure
                title="Workspace state could not be loaded"
                message={session.error}
                onRetry={() => void workspace.retrySession()}
              />
            )}
            {stage === "loading" && <WorkspaceLoading />}
            {stage === "empty" && (
              <WorkspaceEmpty
                native={props.bridge.native}
                busy={project.busy}
                onOpenFolder={workspace.openFolder}
                onUseExample={workspace.useExample}
              />
            )}
            {stage === "project" && project.project && (
              <div
                className="workspace-project-view"
                style={{
                  display: activeStage === "build" ? undefined : "none",
                }}
              >
                <WorkspaceToolbar
                  activePath={documents.activePath}
                  explorerCollapsed={explorerCollapsed}
                  inspectorCollapsed={inspectorCollapsed}
                  onToggleExplorer={toggleExplorer}
                  onToggleInspector={toggleInspector}
                  onRefresh={() => void workspace.refreshProject()}
                />
                <ResizablePanelGroup
                  orientation="horizontal"
                  className="workspace-panels"
                  onLayoutChanged={noteInspectorLayout}
                >
                  <ResizablePanel
                    id="explorer"
                    defaultSize={244}
                    minSize={180}
                    maxSize={420}
                    groupResizeBehavior="preserve-pixel-size"
                    collapsible
                    collapsedSize={0}
                    panelRef={explorerPanel}
                    onResize={(size) =>
                      setExplorerCollapsed(size.inPixels < 24)
                    }
                  >
                    <ProjectExplorer
                      project={project.project}
                      activePath={documents.activePath}
                      documents={documents}
                      dirty={workspace.dirty}
                      busy={project.busy}
                      onCreate={workspace.requestCreate}
                      onRename={workspace.requestRename}
                      onMove={workspace.requestMove}
                      onDrop={workspace.requestMove}
                      onRefresh={() => void workspace.refreshProject()}
                      onCollapse={collapseExplorer}
                    />
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="center" minSize={320}>
                    <ResizablePanelGroup
                      orientation="vertical"
                      className="workspace-center"
                    >
                      <ResizablePanel id="editor" minSize={160}>
                        <EditorWorkspace
                          root={project.project.root}
                          documents={documents}
                          dark={dark}
                          onCloseTab={workspace.requestClose}
                          onCloseTabs={workspace.requestCloseTabs}
                          onEditorReady={setEditorInstance}
                          onSave={() => void workspace.saveActive()}
                        />
                      </ResizablePanel>
                      <ResizableHandle />
                      <ResizablePanel
                        id="results"
                        defaultSize="32%"
                        minSize={96}
                        maxSize="60%"
                      >
                        <BuildResults
                          build={build}
                          onOpenDiagnostic={(diagnostic) =>
                            void workspace.openDiagnostic(diagnostic)
                          }
                        />
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    id="inspector"
                    defaultSize={280}
                    minSize={220}
                    maxSize={380}
                    groupResizeBehavior="preserve-pixel-size"
                    collapsible
                    collapsedSize={0}
                    panelRef={inspectorPanel}
                    onResize={(size) =>
                      setInspectorCollapsed(size.inPixels < 24)
                    }
                  >
                    <ParameterInspector
                      parameters={workspace.parameters}
                      build={build}
                      onCollapse={collapseInspector}
                    />
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>
            )}
            {project.project && (
              <div
                className="workspace-backtest-view"
                style={{
                  display: activeStage === "backtest" ? undefined : "none",
                  height: "100%",
                }}
              >
                <BacktestStage
                  savedSelection={
                    savedSelection?.projectRoot === project.project.root
                      ? savedSelection
                      : null
                  }
                  bridge={execution}
                  build={build.result ?? null}
                  stale={build.stale}
                  parameters={workspace.parameters}
                  projectRoot={project.project?.root ?? null}
                  onBuild={() => setActiveStage("build")}
                  onBusyChange={setBacktestBusy}
                />
              </div>
            )}
            {project.project && (
              <div
                style={{
                  display: activeStage === "optimize" ? undefined : "none",
                  height: "100%",
                }}
              >
                <OptimizeStage
                  bridge={optimization}
                  executionBridge={execution}
                  projectRoot={project.project.root}
                  build={build.result ?? null}
                  stale={build.stale}
                  parameters={workspace.parameters}
                  active={activeStage === "optimize"}
                  onBusyChange={setOptimizationBusy}
                />
              </div>
            )}
            {project.project && (
              <div
                style={{
                  display: activeStage === "report" ? undefined : "none",
                  height: "100%",
                }}
              >
                <ReportsStage
                  bridge={reports}
                  historyBridge={savedRuns}
                  onSavedRunSelected={setSavedSelection}
                  executionBusy={
                    backtestBusy ||
                    optimizationBusy ||
                    validationBusy ||
                    build.phase !== "idle"
                  }
                  projectRoot={project.project.root}
                  active={activeStage === "report"}
                />
              </div>
            )}
            {project.project && (
              <div
                style={{
                  display: activeStage === "validate" ? undefined : "none",
                  height: "100%",
                }}
              >
                <ValidationStage
                  bridge={validation}
                  reportsBridge={reports}
                  projectRoot={project.project.root}
                  active={activeStage === "validate"}
                  onBusyChange={setValidationBusy}
                />
              </div>
            )}
          </div>
          {project.project && stage === "project" && (
            <WorkspaceStatus
              project={project.project}
              activePath={documents.activePath}
              dirtyCount={documents.dirtyPaths.length}
              build={build}
              native={props.bridge.native}
            />
          )}
        </div>
        <aside
          className="workspace-assistant-dock"
          hidden={!assistantOpen || utilityOpen}
          aria-label="Assistant panel"
        >
          <AssistantPanel
            bridge={assistant}
            onClose={() => setAssistantOpen(false)}
            onFlushChange={persistence.registerAssistant}
          />
        </aside>
      </div>
      <WorkspaceDialogs controller={workspace} />
    </section>
  );
}

/** Choose exactly one stage from session, project and boot state without overlapping screens. */
function stageFor(workspace: ReturnType<typeof useWorkspace>): Stage {
  if (workspace.session.error) return "session-error";
  if (workspace.session.loading) return "loading";
  if (workspace.project.project) return "project";
  if (workspace.session.session?.lastProject && !workspace.project.error)
    return "loading";
  return "empty";
}

/** Inputs for the compact path bar and secondary-panel toggles. */
interface WorkspaceToolbarProps {
  activePath: string | null;
  explorerCollapsed: boolean;
  inspectorCollapsed: boolean;
  onToggleExplorer(): void;
  onToggleInspector(): void;
  onRefresh(): void;
}

/** Render the active file path with explicit show/hide controls for secondary panels. */
function WorkspaceToolbar({
  activePath,
  explorerCollapsed,
  inspectorCollapsed,
  onToggleExplorer,
  onToggleInspector,
  onRefresh,
}: WorkspaceToolbarProps) {
  return (
    <div className="workspace-toolbar">
      <span className="workspace-toolbar__path" title={activePath ?? undefined}>
        {activePath ?? "No file selected"}
      </span>
      <span className="workspace-toolbar__spacer" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={explorerCollapsed ? "Show explorer" : "Hide explorer"}
        aria-pressed={explorerCollapsed}
        onClick={onToggleExplorer}
      >
        {explorerCollapsed ? (
          <PanelLeftOpen aria-hidden="true" />
        ) : (
          <PanelLeftClose aria-hidden="true" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={inspectorCollapsed ? "Show parameters" : "Hide parameters"}
        aria-pressed={inspectorCollapsed}
        onClick={onToggleInspector}
      >
        {inspectorCollapsed ? (
          <PanelRightOpen aria-hidden="true" />
        ) : (
          <PanelRightClose aria-hidden="true" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Refresh project tree"
        onClick={onRefresh}
      >
        <RefreshCw aria-hidden="true" />
      </Button>
    </div>
  );
}

/** Inputs for the transient message area above the stage. */
interface WorkspaceBannersProps {
  notice: ReturnType<typeof useWorkspace>["notice"];
  saveError: string;
  projectError: string;
  onDismissNotice(): void;
  onRetrySave(): void;
  onDismissProjectError(): void;
  onRetryProject(): void;
}

/** Render only real, current errors and the latest transient action result. */
function WorkspaceBanners({
  notice,
  saveError,
  projectError,
  onDismissNotice,
  onRetrySave,
  onDismissProjectError,
  onRetryProject,
}: WorkspaceBannersProps) {
  return (
    <div className="workspace-banners" aria-live="polite">
      {saveError && (
        <WorkspaceBanner
          tone="error"
          message={`Workspace state is not saved: ${saveError}`}
          onDismiss={onRetrySave}
          dismissLabel="Retry save"
        />
      )}
      {projectError && (
        <WorkspaceBanner
          tone="error"
          message={projectError}
          onDismiss={onDismissProjectError}
          dismissLabel="Dismiss"
          onClose={onDismissProjectError}
          secondary={onRetryProject}
        />
      )}
      {notice && (
        <WorkspaceBanner
          tone={notice.tone}
          message={notice.text}
          onDismiss={onDismissNotice}
          dismissLabel="Dismiss"
          onClose={onDismissNotice}
        />
      )}
    </div>
  );
}

/** Inputs for one dismissible workspace message. */
interface WorkspaceBannerProps {
  tone: "info" | "error";
  message: string;
  onDismiss(): void;
  dismissLabel: string;
  onClose?(): void;
  secondary?(): void;
}

/** Render a plain message with one explicit recovery or dismissal action. */
function WorkspaceBanner({
  tone,
  message,
  onDismiss,
  dismissLabel,
  onClose,
  secondary,
}: WorkspaceBannerProps) {
  return (
    <div className="workspace-banner" data-tone={tone}>
      <CircleAlert aria-hidden="true" />
      <span className="workspace-banner__text">{message}</span>
      {secondary && (
        <Button variant="outline" size="xs" onClick={secondary}>
          Retry project
        </Button>
      )}
      <Button variant="ghost" size="xs" onClick={onDismiss}>
        {dismissLabel}
      </Button>
      {onClose && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss message"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

/** Render an honest session failure with a real retry that re-reads stored state. */
function WorkspaceFailure({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry(): void;
}) {
  return (
    <div className="workspace-failure" role="alert">
      <CircleAlert aria-hidden="true" />
      <h1>{title}</h1>
      <p>{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Retry loading
      </Button>
    </div>
  );
}

/** Render a quiet status while the stored session or project is being opened. */
function WorkspaceLoading() {
  return (
    <div className="workspace-loading" role="status">
      <LoaderCircle className="spinner" aria-hidden="true" />
      Opening your saved workspace...
    </div>
  );
}

/** Observe the resolved system appearance so Monaco follows the app theme. */
function useResolvedDark(appearance: Appearance): boolean {
  const [dark, setDark] = useState(() => resolveDark(appearance, false));
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    /** Re-resolve whenever the explicit theme or system preference changes. */
    function update() {
      setDark(resolveDark(appearance, media.matches));
    }
    update();
    if (appearance !== "system") return;
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [appearance]);
  return dark;
}

/** Resolve an explicit appearance or the current system preference. */
function resolveDark(appearance: Appearance, systemDark: boolean): boolean {
  if (appearance === "dark") return true;
  if (appearance === "light") return false;
  return systemDark;
}

/**
 * Collapse the parameter inspector below the supported compact width and restore it when there
 * is room again, unless the user explicitly collapsed it.
 */
function useCompactInspector(
  panel: React.RefObject<PanelImperativeHandle | null>,
  active: boolean,
  intent: React.RefObject<PanelVisibilityIntent>,
  setCollapsed: (collapsed: boolean) => void,
) {
  useEffect(() => {
    if (!active) return;
    const media = window.matchMedia("(max-width: 1120px)");
    /** Apply one breakpoint result through the library's own collapse/expand API. */
    function apply(compact: boolean) {
      const decision = compactPanelDecision(compact, intent.current);
      intent.current = decision.intent;
      if (!decision.action) return;
      if (decision.action === "collapse") panel.current?.collapse();
      else panel.current?.expand();
      setCollapsed(decision.action === "collapse");
    }
    apply(media.matches);
    /** React to live window resizing without polling. */
    function onChange(event: MediaQueryListEvent) {
      apply(event.matches);
    }
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [active, intent, panel, setCollapsed]);
}

/** Apply saved layout choices through the existing panel without replacing editor or draft state. */
function useWorkspaceStyle(
  style: WorkspaceStyle,
  active: boolean,
  panel: React.RefObject<PanelImperativeHandle | null>,
  intent: React.RefObject<PanelVisibilityIntent>,
  setCollapsed: (collapsed: boolean) => void,
) {
  useEffect(() => {
    if (!active) return;
    const compact = window.matchMedia("(max-width: 1120px)").matches;
    const collapsed = style === "simple" || compact;
    intent.current = {
      userCollapsed: style === "simple",
      autoCollapsed: style === "advanced" && compact,
    };
    if (collapsed) panel.current?.collapse();
    else panel.current?.expand();
    setCollapsed(collapsed);
  }, [style, active, panel, intent, setCollapsed]);
}
