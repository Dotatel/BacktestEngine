import {
  Braces,
  ChartLine,
  Database,
  FolderOpen,
  Puzzle,
  Settings2,
} from "lucide-react";
import type { Appearance, WorkspaceStyle } from "@/lib/preferences";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { ExtensionsDialog } from "@/features/extensions/ExtensionsDialog";
import { settings } from "@/lib/settings";
import { updates } from "@/lib/updates";
import { extensions } from "@/lib/extensions";
import { reports } from "@/lib/reports";

const areas = [
  { label: "Explorer", icon: FolderOpen, available: true },
  { label: "Markets", icon: ChartLine, available: false },
  { label: "Data", icon: Database, available: false },
  { label: "Strategy", icon: Braces, available: false },
] as const;

/** Inputs for the global rail and its shared workspace settings dialog. */
export interface WorkspaceRailProps {
  appearance: Appearance;
  workspaceStyle: WorkspaceStyle;
  onAppearanceChange(appearance: Appearance): void;
  onWorkspaceStyleChange?: (style: WorkspaceStyle) => void;
  onReviewSetup(): void;
  projectRoot?: string | null;
}

/** Render the slim workspace rail with Explorer selected and one functional settings entry. */
export function WorkspaceRail({
  appearance,
  workspaceStyle,
  onAppearanceChange,
  onWorkspaceStyleChange,
  onReviewSetup,
  projectRoot = null,
}: WorkspaceRailProps) {
  return (
    <nav className="workspace-rail" aria-label="Workspace areas">
      {areas.map((area) => {
        const Icon = area.icon;
        return (
          <Button
            key={area.label}
            type="button"
            variant={area.available ? "secondary" : "ghost"}
            size="icon-sm"
            className="workspace-rail__button"
            aria-label={area.label}
            aria-current={area.available ? "page" : undefined}
            disabled={!area.available}
            title={
              area.available
                ? area.label
                : `${area.label} arrives in a later milestone`
            }
          >
            <Icon aria-hidden="true" />
          </Button>
        );
      })}
      <ExtensionsDialog
        bridge={extensions}
        reportsBridge={reports}
        projectRoot={projectRoot}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            className="workspace-rail__button"
            aria-label="Extensions"
            title="App extensions · experimental"
          >
            <Puzzle aria-hidden="true" />
          </Button>
        }
      />
      <span className="workspace-rail__spacer" />
      <SettingsDialog
        bridge={settings}
        updatesBridge={updates}
        appearance={appearance}
        workspaceStyle={workspaceStyle}
        onAppearanceChange={onAppearanceChange}
        onWorkspaceStyleChange={onWorkspaceStyleChange}
        onReviewSetup={onReviewSetup}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            className="workspace-rail__button"
            aria-label="Workspace settings"
            title="Workspace settings"
          >
            <Settings2 aria-hidden="true" />
          </Button>
        }
      />
    </nav>
  );
}
