import { useState, type ReactNode } from "react";
import type { Appearance, WorkspaceStyle } from "@/lib/preferences";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

const appearanceOptions: Array<{ value: Appearance; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Inputs for the small workspace settings dialog shared with setup preferences. */
export interface WorkspaceSettingsProps {
  appearance: Appearance;
  workspaceStyle: WorkspaceStyle;
  onAppearanceChange(appearance: Appearance): void;
  onReviewSetup(): void;
  trigger: ReactNode;
}

/** Render the dialog that changes shared appearance and returns to setup for further changes. */
export function WorkspaceSettings({
  appearance,
  workspaceStyle,
  onAppearanceChange,
  onReviewSetup,
  trigger,
}: WorkspaceSettingsProps) {
  const [open, setOpen] = useState(false);

  /** Apply only known appearance values emitted by the select. */
  function chooseAppearance(value: string) {
    const option = appearanceOptions.find((item) => item.value === value);
    if (option) onAppearanceChange(option.value);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Workspace settings</DialogTitle>
          <DialogDescription>
            Appearance is shared with setup. Layout, project files and presets
            stay local to this workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="settings-form">
          <Label htmlFor="workspace-appearance">Appearance</Label>
          <Select value={appearance} onValueChange={chooseAppearance}>
            <SelectTrigger id="workspace-appearance" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {appearanceOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="settings-hint">
            System follows the operating-system theme, including the editor.
          </p>
          <Separator />
          <div className="settings-readout">
            <span>Workspace style</span>
            <span className="settings-value">{workspaceStyle}</span>
          </div>
          <p className="settings-hint">
            Review setup to change workspace style, connection choices or other
            saved preferences.
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              onReviewSetup();
            }}
          >
            Review setup
          </Button>
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
