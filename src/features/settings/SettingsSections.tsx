import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SettingsDiagnostics } from "@/lib/settings-contract";
import type { SettingsPageProps } from "./SettingsPage";
import type { useAppSettings } from "./useAppSettings";
import { SettingsRow, SettingsSection } from "./SettingsLayout";

/** Reuse the workspace preference callback and native export-folder controller without parallel storage. */
export function GeneralSettings(
  props: SettingsPageProps & { controller: ReturnType<typeof useAppSettings> },
) {
  const { controller, bridge, project } = props;
  const busy = controller.phase !== "idle";
  const settings = controller.snapshot?.settings;
  return (
    <>
      <SettingsSection
        title="Workspace"
        description="Choose how your working panels are arranged."
      >
        <SettingsRow
          label="Workspace style"
          description="Simple collapses the Build parameter panel. Advanced reveals it when space allows. The same tools remain available."
          htmlFor="settings-workspace-style"
        >
          <Select
            value={props.workspaceStyle}
            onValueChange={props.onWorkspaceStyleChange}
            disabled={!props.onWorkspaceStyleChange}
          >
            <SelectTrigger id="settings-workspace-style">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="simple">Simple</SelectItem>
              <SelectItem value="advanced">Advanced</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Active project"
          description="The project currently open in your workspace."
        >
          <p className="app-settings-path" title={project?.root}>
            {project?.name ?? "No project open"}
          </p>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Report exports"
        description="Choose where report save dialogs begin."
      >
        <SettingsRow
          label="Default report folder"
          description="Choose the destination in each export dialog"
        >
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
        </SettingsRow>
        <p className="app-settings-path app-settings-note">
          {settings?.defaultExportDirectory || "No default folder selected"}
        </p>
        <p className="app-settings-note">
          Each export still asks you to choose a new file.
        </p>
      </SettingsSection>
      <SettingsSection
        title="Setup"
        description="Revisit your original setup preferences."
      >
        <SettingsRow
          label="Review setup"
          description="Review your appearance, workspace and optional agent choices."
        >
          <Button size="sm" variant="outline" onClick={props.onReviewSetup}>
            Review setup
          </Button>
        </SettingsRow>
      </SettingsSection>
      <p className="app-settings-note">Preferences save as you change them.</p>
      {!bridge.native && (
        <p className="app-settings-note">
          Local folders, application settings and release checks are available
          in the desktop app.
        </p>
      )}
    </>
  );
}

/** Change the original onboarding-owned appearance preference for both the app and editor. */
export function AppearanceSettings({
  appearance,
  onAppearanceChange,
}: Pick<SettingsPageProps, "appearance" | "onAppearanceChange">) {
  return (
    <SettingsSection
      title="Theme"
      description="Use the same appearance throughout your workspace."
    >
      <SettingsRow
        label="Appearance"
        description="System follows the operating-system theme, including the editor."
        htmlFor="workspace-appearance"
      >
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
      </SettingsRow>
    </SettingsSection>
  );
}

/** Document only shortcuts implemented by the existing workspace and editor. */
export function ShortcutHelp() {
  const shortcuts = [
    ["Ctrl / Cmd + N", "Create a file"],
    ["Ctrl / Cmd + O", "Open a project folder"],
    ["Ctrl / Cmd + S", "Save the active file"],
    ["Ctrl / Cmd + Shift + S", "Save all modified files"],
    ["Ctrl / Cmd + W", "Close the active file"],
    ["Ctrl / Cmd + F", "Find in the focused editor"],
    ["Ctrl / Cmd + H", "Replace in the focused editor"],
    ["Arrow keys", "Navigate focused file tabs"],
    ["Delete", "Close the focused file tab"],
    ["Escape", "Close the active dialog"],
  ];
  return (
    <SettingsSection
      title="Workspace commands"
      description="File commands apply in the workspace. Editor commands require editor focus."
    >
      <dl className="app-settings-diagnostics">
        {shortcuts.map(([key, purpose]) => (
          <div key={key}>
            <dt>{purpose}</dt>
            <dd>
              <kbd>{key}</kbd>
            </dd>
          </div>
        ))}
      </dl>
      <p className="app-settings-note">Shortcuts are read-only.</p>
    </SettingsSection>
  );
}

/** Expose actual native paths and bundle presence for installation troubleshooting. */
export function Diagnostics({ value }: { value: SettingsDiagnostics }) {
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
    <SettingsSection
      title="Installation"
      description="Local paths and bundled resources used by this application."
    >
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
    </SettingsSection>
  );
}
