import { Circle, CircleCheck, CircleDot, TriangleAlert } from "lucide-react";
import type { WorkspaceProject } from "@/lib/workspace-contract";
import type { WorkspaceBuildController } from "../hooks/useWorkspaceBuild";

/** Inputs for the quiet bottom status bar. */
export interface WorkspaceStatusProps {
  project: WorkspaceProject;
  activePath: string | null;
  dirtyCount: number;
  build: WorkspaceBuildController;
  native: boolean;
}

/** Render durable save, compile and host facts without inventing progress. */
export function WorkspaceStatus({
  project,
  activePath,
  dirtyCount,
  build,
  native,
}: WorkspaceStatusProps) {
  const state = buildState(build);
  return (
    <footer className="workspace-status" aria-label="Workspace status">
      <span className="workspace-status__item" title={project.root}>
        {project.name}
        <span className="workspace-status__muted">{project.root}</span>
      </span>
      {activePath && (
        <span className="workspace-status__item workspace-status__file">
          {activePath}
        </span>
      )}
      <span className="workspace-status__spacer" />
      {!native && (
        <span className="workspace-status__badge">Browser preview</span>
      )}
      <span className="workspace-status__item" role="status" aria-live="polite">
        {dirtyCount === 0 ? (
          <>
            <CircleCheck aria-hidden="true" />
            All changes saved
          </>
        ) : (
          <>
            <CircleDot aria-hidden="true" />
            {dirtyCount} unsaved {dirtyCount === 1 ? "file" : "files"}
          </>
        )}
      </span>
      <span className="workspace-status__item" data-tone={state.tone}>
        <state.icon aria-hidden="true" />
        {state.label}
      </span>
    </footer>
  );
}

/** Choose the truthful build label and icon for the current phase and evidence. */
function buildState(build: WorkspaceBuildController): {
  label: string;
  tone: "quiet" | "busy" | "success" | "error";
  icon: typeof Circle;
} {
  if (build.phase !== "idle") {
    return { label: phaseText(build.phase), tone: "busy", icon: CircleDot };
  }
  if (build.error)
    return { label: "Build failed", tone: "error", icon: TriangleAlert };
  if (!build.result) return { label: "Not built", tone: "quiet", icon: Circle };
  if (build.result.success && build.stale)
    return {
      label: "Build stale after edits",
      tone: "error",
      icon: TriangleAlert,
    };
  if (build.result.success)
    return { label: "Build ready", tone: "success", icon: CircleCheck };
  return { label: "Build failed", tone: "error", icon: TriangleAlert };
}

/** Describe the phase that is actually running. */
function phaseText(phase: WorkspaceBuildController["phase"]): string {
  if (phase === "saving") return "Saving before build";
  if (phase === "cancelling") return "Cancelling build";
  return "Compiling";
}
