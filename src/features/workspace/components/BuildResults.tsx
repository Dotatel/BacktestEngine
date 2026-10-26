import { CircleAlert, Info, RotateCcw, TriangleAlert } from "lucide-react";
import type { BuildDiagnostic } from "@/lib/workspace-contract";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { WorkspaceBuildController } from "../hooks/useWorkspaceBuild";

/** Inputs for the bottom compiler Problems and Output panel. */
export interface BuildResultsProps {
  build: WorkspaceBuildController;
  onOpenDiagnostic(diagnostic: BuildDiagnostic): void;
}

/** Render truthful compiler diagnostics and raw output from the latest saved-source build. */
export function BuildResults({ build, onOpenDiagnostic }: BuildResultsProps) {
  const result = build.result;
  const diagnostics = result?.diagnostics ?? [];
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter(
    (item) => item.severity === "warning",
  ).length;

  return (
    <section
      className="workspace-panel results-panel"
      aria-label="Build results"
    >
      <Tabs defaultValue="problems" className="results-tabs">
        <div className="results-bar">
          <TabsList variant="line" aria-label="Build results">
            <TabsTrigger value="problems">
              Problems
              <span
                className="results-count"
                aria-label={`${diagnostics.length} items`}
              >
                {diagnostics.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="output">Output</TabsTrigger>
          </TabsList>
          <div className="results-summary" role="status">
            {summaryText(build, errors, warnings)}
            {build.stale && (
              <span className="results-stale">
                Source changed after this build
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear build results"
            onClick={build.reset}
            disabled={!result && !build.error && !build.notice}
          >
            <RotateCcw aria-hidden="true" />
          </Button>
        </div>
        <TabsContent value="problems" className="results-content">
          <DiagnosticList
            build={build}
            diagnostics={diagnostics}
            onOpenDiagnostic={onOpenDiagnostic}
          />
        </TabsContent>
        <TabsContent value="output" className="results-content">
          <pre className="build-output">
            {result?.output || "Build output will appear here."}
          </pre>
        </TabsContent>
      </Tabs>
      {build.error && (
        <p className="results-message results-message--error" role="alert">
          {build.error}
        </p>
      )}
      {build.notice && !build.error && (
        <p className="results-message" role="status">
          {build.notice}
        </p>
      )}
      {result?.artifactPath && (
        <p className="results-artifact" title={result.artifactPath}>
          Artifact: {result.artifactPath}
        </p>
      )}
    </section>
  );
}

/** Summarize only evidence the host actually returned. */
function summaryText(
  build: WorkspaceBuildController,
  errors: number,
  warnings: number,
): string {
  if (build.phase === "saving") return "Saving modified files...";
  if (build.phase === "building") return "Compiling...";
  if (build.phase === "cancelling") return "Cancelling...";
  if (!build.result) return "No build yet";
  return `${errors} errors, ${warnings} warnings, ${Math.round(
    build.result.durationMs,
  )} ms`;
}

/** Props for one compiler diagnostic list. */
interface DiagnosticListProps {
  build: WorkspaceBuildController;
  diagnostics: BuildDiagnostic[];
  onOpenDiagnostic(diagnostic: BuildDiagnostic): void;
}

/** Render clickable source diagnostics, including severity and location. */
function DiagnosticList({
  build,
  diagnostics,
  onOpenDiagnostic,
}: DiagnosticListProps) {
  if (!diagnostics.length) {
    return (
      <div className="results-empty">
        {build.result
          ? "No compiler problems reported."
          : "Build the project to see compiler problems."}
      </div>
    );
  }
  return (
    <ul className="diagnostic-list" aria-label="Compiler problems">
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code ?? "diag"}-${index}`}>
          <button
            type="button"
            className="diagnostic"
            data-severity={diagnostic.severity}
            onClick={() => onOpenDiagnostic(diagnostic)}
            disabled={!diagnostic.path}
          >
            <DiagnosticIcon severity={diagnostic.severity} />
            <span className="diagnostic__message">{diagnostic.message}</span>
            <span className="diagnostic__meta">
              {diagnostic.code}
              {diagnostic.path ? ` · ${diagnostic.path}` : ""}
              {diagnostic.line ? `:${diagnostic.line}` : ""}
              {diagnostic.column ? `:${diagnostic.column}` : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Render the icon that matches a compiler severity. */
function DiagnosticIcon({
  severity,
}: {
  severity: BuildDiagnostic["severity"];
}) {
  if (severity === "error") {
    return <CircleAlert className="diagnostic__icon" aria-hidden="true" />;
  }
  if (severity === "warning") {
    return <TriangleAlert className="diagnostic__icon" aria-hidden="true" />;
  }
  return <Info className="diagnostic__icon" aria-hidden="true" />;
}
