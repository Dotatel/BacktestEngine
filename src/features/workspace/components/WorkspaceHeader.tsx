import {
  CheckCheck,
  FolderKanban,
  MessageSquare,
  Play,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BuildPhase } from "../hooks/useWorkspaceBuild";

const stages = ["Build", "Backtest", "Optimize", "Validate", "Report"] as const;
type WorkflowStage = "build" | "backtest" | "optimize" | "validate" | "report";

/** Inputs for the workflow header, stage tabs and primary build actions. */
export interface WorkspaceHeaderProps {
  projectName: string;
  projectRoot: string;
  phase: BuildPhase;
  stage: WorkflowStage;
  canSave: boolean;
  canBuild: boolean;
  canBacktest: boolean;
  canReport?: boolean;
  canValidate?: boolean;
  canOptimize?: boolean;
  executionBusy?: boolean;
  assistantOpen?: boolean;
  onToggleAssistant?(): void;
  onSaveAll(): void;
  onBuild(): void;
  onCancel(): void;
  onSelectStage(stage: WorkflowStage): void;
}

/** Render the stage-navigation header with honest unavailable stages and real build actions. */
export function WorkspaceHeader({
  projectName,
  projectRoot,
  phase,
  stage,
  canSave,
  canBuild,
  canBacktest,
  canReport = false,
  canValidate = false,
  canOptimize = false,
  executionBusy = false,
  assistantOpen = false,
  onToggleAssistant,
  onSaveAll,
  onBuild,
  onCancel,
  onSelectStage,
}: WorkspaceHeaderProps) {
  const busy = phase !== "idle" || executionBusy;
  return (
    <header className="workspace-header">
      <div className="workspace-project" title={projectRoot || projectName}>
        <FolderKanban className="workspace-project__icon" aria-hidden="true" />
        <span className="workspace-project__name">{projectName}</span>
        <span className="workspace-project__stage">
          {stage.charAt(0).toUpperCase() + stage.slice(1)}
        </span>
      </div>
      <nav className="workspace-stages" aria-label="Research workflow">
        {stages.map((item) => {
          const stageKeys: Partial<Record<typeof item, WorkflowStage>> = {
            Build: "build",
            Backtest: "backtest",
            Report: "report",
            Validate: "validate",
            Optimize: "optimize",
          };
          const itemStage = stageKeys[item] ?? null;
          const active = itemStage !== null && itemStage === stage;
          const enabled =
            itemStage === "build" ||
            (itemStage === "backtest" && canBacktest) ||
            (itemStage === "report" && canReport) ||
            (itemStage === "validate" && canValidate) ||
            (itemStage === "optimize" && canOptimize);
          const title = stageTitle(
            item,
            itemStage,
            canBacktest,
            canReport,
            canValidate,
            canOptimize,
          );
          return (
            <Button
              key={item}
              type="button"
              size="sm"
              variant={active ? "secondary" : "ghost"}
              aria-current={active ? "page" : undefined}
              disabled={!enabled || busy}
              title={title}
              onClick={() => {
                if (itemStage) onSelectStage(itemStage);
              }}
            >
              {item}
            </Button>
          );
        })}
      </nav>
      <div
        className="workspace-header__actions"
        role="group"
        aria-label="Build actions"
      >
        {onToggleAssistant ? (
          <Button
            variant={assistantOpen ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Toggle assistant"
            aria-pressed={assistantOpen}
            onClick={onToggleAssistant}
          >
            <MessageSquare aria-hidden="true" />
          </Button>
        ) : null}
        <TooltipProvider delayDuration={500}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onSaveAll}
                  disabled={!canSave || busy}
                >
                  <CheckCheck aria-hidden="true" />
                  Save all
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Save every modified file before compiling
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {stage === "build" ? (
          busy ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={phase === "cancelling"}
            >
              <Square aria-hidden="true" />
              {phaseLabel(phase)}
            </Button>
          ) : (
            <Button size="sm" onClick={onBuild} disabled={!canBuild}>
              <Play aria-hidden="true" />
              Build
            </Button>
          )
        ) : null}
      </div>
    </header>
  );
}

/** Describe the active build phase without claiming completion before it happens. */
function phaseLabel(phase: BuildPhase): string {
  if (phase === "cancelling") return "Cancelling...";
  return "Cancel build";
}

/** Build one honest tooltip for a workflow stage without nested conditional expressions. */
function stageTitle(
  item: string,
  itemStage: WorkflowStage | null,
  canBacktest: boolean,
  canReport: boolean,
  canValidate: boolean,
  canOptimize: boolean,
): string {
  if (itemStage === null) return `${item} arrives in a later milestone`;
  if (itemStage === "backtest" && !canBacktest)
    return "Open a project in the desktop app to inspect history and backtest";
  if (itemStage === "report" && !canReport)
    return "Open a project in the desktop app to review reports";
  if (itemStage === "validate" && !canValidate)
    return "Open a project in the desktop app to validate a saved run";
  if (itemStage === "optimize" && !canOptimize)
    return "Open a project in the desktop app to optimize a compiled strategy";
  return `${item} workspace`;
}
