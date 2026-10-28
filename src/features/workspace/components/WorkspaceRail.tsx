import {
  Braces,
  ChartLine,
  Database,
  FolderOpen,
  Puzzle,
  Settings2,
} from "lucide-react";
import type { Ref } from "react";
import { Button } from "@/components/ui/button";

const areas = [
  { label: "Explorer", icon: FolderOpen, available: true },
  { label: "Markets", icon: ChartLine, available: false },
  { label: "Data", icon: Database, available: false },
  { label: "Strategy", icon: Braces, available: false },
] as const;

/** Inputs for the unchanged global rail icons and full-page settings navigation. */
export interface WorkspaceRailProps {
  settingsOpen: boolean;
  extensionsOpen: boolean;
  onOpenSettings(): void;
  onOpenExtensions(): void;
  onOpenExplorer(): void;
  settingsButtonRef: Ref<HTMLButtonElement>;
  extensionsButtonRef: Ref<HTMLButtonElement>;
}

/** Render the slim workspace rail with Explorer selected and one functional settings entry. */
export function WorkspaceRail({
  settingsOpen,
  extensionsOpen,
  onOpenSettings,
  onOpenExtensions,
  onOpenExplorer,
  settingsButtonRef,
  extensionsButtonRef,
}: WorkspaceRailProps) {
  return (
    <nav className="workspace-rail" aria-label="Workspace areas">
      {areas.map((area) => {
        const Icon = area.icon;
        return (
          <Button
            key={area.label}
            type="button"
            variant={
              area.available && !settingsOpen && !extensionsOpen
                ? "secondary"
                : "ghost"
            }
            size="icon-sm"
            className="workspace-rail__button"
            aria-label={area.label}
            aria-current={
              area.available && !settingsOpen && !extensionsOpen
                ? "page"
                : undefined
            }
            onClick={area.available ? onOpenExplorer : undefined}
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
      <Button
        ref={extensionsButtonRef}
        variant={extensionsOpen ? "secondary" : "ghost"}
        size="icon-sm"
        className="workspace-rail__button"
        aria-label="Extensions"
        title="App extensions · experimental"
        aria-current={extensionsOpen ? "page" : undefined}
        onClick={onOpenExtensions}
      >
        <Puzzle aria-hidden="true" />
      </Button>
      <span className="workspace-rail__spacer" />
      <Button
        ref={settingsButtonRef}
        variant={settingsOpen ? "secondary" : "ghost"}
        size="icon-sm"
        className="workspace-rail__button"
        aria-label="Workspace settings"
        title="Workspace settings"
        aria-current={settingsOpen ? "page" : undefined}
        onClick={onOpenSettings}
      >
        <Settings2 aria-hidden="true" />
      </Button>
    </nav>
  );
}
