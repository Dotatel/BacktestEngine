import { useState, type ReactNode } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Appearance, WorkspaceStyle } from "@/lib/preferences";
import type {
  SettingsBridge,
  SettingsDiagnostics,
} from "@/lib/settings-contract";
import type { UpdatesBridge } from "@/lib/updates-contract";
import { useAppSettings } from "./useAppSettings";
import "./settings.css";

/** Settings compose existing saved setup choices with missing native application preferences. */
export interface SettingsDialogProps {
  appearance: Appearance;
  workspaceStyle: WorkspaceStyle;
  onAppearanceChange(value: Appearance): void;
  onWorkspaceStyleChange?: (value: WorkspaceStyle) => void;
  onReviewSetup(): void;
  bridge: SettingsBridge;
  updatesBridge: UpdatesBridge;
  trigger: ReactNode;
}

/** Keep the workspace/editor mounted while changing preferences or performing explicit local actions. */
export function SettingsDialog(props: SettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const controller = useAppSettings(props.bridge, props.updatesBridge, open);
  const busy = controller.phase !== "idle";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{props.trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Workspace settings</DialogTitle>
          <DialogDescription>
            Adjust your workspace, local report exports and manual release
            checks.
          </DialogDescription>
        </DialogHeader>
        <div className="app-settings-body">
          <Tabs defaultValue="general">
            <div className="workspace-tabs-scroll">
              <TabsList variant="line" aria-label="Settings sections">
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="updates">Updates</TabsTrigger>
                <TabsTrigger value="shortcuts">Shortcuts</TabsTrigger>
                <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="general">
              <GeneralSettings {...props} controller={controller} />
            </TabsContent>
            <TabsContent value="updates">
              <UpdateSettings
                controller={controller}
                native={props.bridge.native}
              />
            </TabsContent>
            <TabsContent value="shortcuts">
              <ShortcutHelp />
            </TabsContent>
            <TabsContent value="diagnostics">
              {controller.snapshot ? (
                <Diagnostics value={controller.snapshot.diagnostics} />
              ) : (
                <p className="app-settings-note">
                  Open the desktop app to inspect local installation
                  diagnostics.
                </p>
              )}
            </TabsContent>
          </Tabs>
          {controller.snapshot?.state === "corrupt" && (
            <section
              className="app-settings-section"
              aria-label="Application settings recovery"
            >
              <p className="app-settings-error" role="alert">
                {controller.snapshot.problem}
              </p>
              <RecoveryAction controller={controller} disabled={busy} />
            </section>
          )}
          {controller.error && (
            <p className="app-settings-error" role="alert">
              {controller.error}
            </p>
          )}
          {controller.message && (
            <p className="app-settings-note" role="status">
              {controller.message}
            </p>
          )}
          {controller.phase === "loading" && (
            <p className="app-settings-note" role="status">
              Reading local application settings…
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOpen(false);
              props.onReviewSetup();
            }}
          >
            Review setup
          </Button>
          <DialogClose asChild>
            <Button size="sm">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reuse the original preference callbacks rather than creating a second theme/style store. */
function GeneralSettings({
  appearance,
  workspaceStyle,
  onAppearanceChange,
  onWorkspaceStyleChange,
  controller,
  bridge,
}: SettingsDialogProps & { controller: ReturnType<typeof useAppSettings> }) {
  const busy = controller.phase !== "idle";
  const settings = controller.snapshot?.settings;
  return (
    <div className="app-settings-section">
      <div className="app-settings-field">
        <Label htmlFor="workspace-appearance">Appearance</Label>
        <Select value={appearance} onValueChange={onAppearanceChange}>
          <SelectTrigger id="workspace-appearance">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
          </SelectContent>
        </Select>
        <p className="app-settings-note">
          System follows the operating-system theme, including the editor.
        </p>
      </div>
      <div className="app-settings-field">
        <Label htmlFor="settings-workspace-style">Workspace style</Label>
        <Select
          value={workspaceStyle}
          onValueChange={onWorkspaceStyleChange}
          disabled={!onWorkspaceStyleChange}
        >
          <SelectTrigger id="settings-workspace-style">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="simple">Simple</SelectItem>
            <SelectItem value="advanced">Advanced</SelectItem>
          </SelectContent>
        </Select>
        <p className="app-settings-note">
          Simple collapses the Build parameter panel. Advanced reveals it when
          space allows. The same tools remain available.
        </p>
      </div>
      <section
        className="app-settings-section"
        aria-labelledby="export-folder-title"
      >
        <h3 id="export-folder-title">Default report folder</h3>
        <p className="app-settings-path">
          {settings?.defaultExportDirectory ||
            "Choose the destination in each export dialog"}
        </p>
        <div className="app-settings-actions">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !bridge.native || !settings}
            onClick={() => void controller.chooseExportDirectory()}
          >
            <FolderOpen aria-hidden="true" />
            Choose folder
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !settings?.defaultExportDirectory}
            onClick={() => void controller.clearExportDirectory()}
          >
            Clear
          </Button>
        </div>
        <p className="app-settings-note">
          Reports start the native save dialog in this folder. Each export still
          asks you to choose a new file.
        </p>
      </section>
      {!bridge.native && (
        <p className="app-settings-note">
          Local folders, application settings and release checks are available
          in the desktop app.
        </p>
      )}
    </div>
  );
}

/** Release metadata is fetched only by Check now after durable explicit opt-in. */
function UpdateSettings({
  controller,
  native,
}: {
  controller: ReturnType<typeof useAppSettings>;
  native: boolean;
}) {
  const busy = controller.phase !== "idle";
  const settings = controller.snapshot?.settings;
  const release = controller.release;
  return (
    <div className="app-settings-section">
      <div className="app-settings-field">
        <Label htmlFor="manual-release-checks">Manual release checks</Label>
        <Select
          value={settings?.updates.enabled ? "enabled" : "disabled"}
          disabled={busy || !native || !settings}
          onValueChange={(value) =>
            void controller.setUpdatesEnabled(value === "enabled")
          }
        >
          <SelectTrigger id="manual-release-checks">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">Disabled</SelectItem>
            <SelectItem value="enabled">Enabled — manual only</SelectItem>
          </SelectContent>
        </Select>
        <p className="app-settings-note">
          Check now requests public release information from the
          Dotatel/BacktestEngine GitHub repository. Installation stays under
          your control.
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !settings?.updates.enabled || !native}
        onClick={() => void controller.checkNow()}
      >
        <RefreshCw
          className={controller.phase === "checking" ? "spinner" : undefined}
          aria-hidden="true"
        />
        {controller.phase === "checking" ? "Checking…" : "Check now"}
      </Button>
      <p className="app-settings-note">
        Last valid release check:{" "}
        {settings?.updates.lastSuccessfulCheckAt || "Never"}
      </p>
      {release && (
        <section
          className="app-settings-section"
          aria-label="Manual release check result"
          role="status"
        >
          <p>{release.message}</p>
          {release.latestVersion && (
            <p>
              Installed {release.currentVersion} · Release{" "}
              {release.latestVersion}
              {release.dismissed ? " · dismissed" : ""}
            </p>
          )}
          {release.checkedAt && (
            <p className="app-settings-note">Attempted {release.checkedAt}</p>
          )}
          {release.notes && (
            <pre className="app-settings-release-notes">{release.notes}</pre>
          )}
          <div className="app-settings-actions">
            {release.releaseUrl && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void controller.openRelease(release.releaseUrl!)}
              >
                View release
              </Button>
            )}
            {release.downloadUrl && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void controller.openRelease(release.downloadUrl!)
                }
              >
                View Windows download
              </Button>
            )}
            {release.status === "updateAvailable" &&
              release.latestVersion &&
              !release.dismissed && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void controller.dismiss(release.latestVersion!)
                  }
                >
                  Dismiss this version
                </Button>
              )}
          </div>
        </section>
      )}
    </div>
  );
}

/** Document only shortcuts implemented by the existing editor, tabs and dialogs. */
function ShortcutHelp() {
  const shortcuts = [
    ["Ctrl / Cmd + S", "Save the active file"],
    ["Ctrl / Cmd + F", "Find in the focused editor"],
    ["Ctrl / Cmd + H", "Replace in the focused editor"],
    ["Arrow keys", "Navigate focused file tabs"],
    ["Delete", "Close the focused file tab"],
    ["Escape", "Close the active dialog"],
  ];
  return (
    <section className="app-settings-section">
      <h3>Keyboard shortcuts</h3>
      <dl className="app-settings-diagnostics">
        {shortcuts.map(([key, purpose]) => (
          <div key={key}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{purpose}</dd>
          </div>
        ))}
      </dl>
      <p className="app-settings-note">
        Editor shortcuts apply while the editor has focus. Shortcuts are
        read-only.
      </p>
    </section>
  );
}

/** Expose actual local paths and bundle presence for installation troubleshooting. */
function Diagnostics({ value }: { value: SettingsDiagnostics }) {
  const entries = [
    ["App version", value.appVersion],
    ["Platform", `${value.platform} · ${value.architecture}`],
    ["Settings", value.settingsPath],
    ["Extensions", value.extensionsDirectory],
    ["Resources", value.resourceDirectory],
    ["Engine bundle", value.engineBundlePresent ? "Present" : "Missing"],
    ["Python bundle", value.pythonBundlePresent ? "Present" : "Missing"],
    ["Experimental extension API", value.extensionApiVersion],
  ];
  return (
    <section className="app-settings-section">
      <h3>Installation diagnostics</h3>
      <dl className="app-settings-diagnostics">
        {entries.map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <p className="app-settings-note">
        Bundle presence identifies local files. It does not establish runtime or
        trading compatibility.
      </p>
    </section>
  );
}

/** Protect corruption recovery with a separate explicit confirmation and a retained backup. */
function RecoveryAction({
  controller,
  disabled,
}: {
  controller: ReturnType<typeof useAppSettings>;
  disabled: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          Back up and reset app settings
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Back up and reset application settings?
          </AlertDialogTitle>
          <AlertDialogDescription>
            A backup preserves the damaged document before resetting
            report-folder, update and extension-enable choices. Onboarding
            preferences and project files remain available.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void controller.recover()}>
            Back up and reset
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
