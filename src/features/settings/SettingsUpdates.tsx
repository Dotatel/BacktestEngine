import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { useAppSettings } from "./useAppSettings";
import { SettingsSection, SettingsRow } from "./SettingsLayout";
/** Release metadata is fetched only by Check now after durable explicit opt-in. */
export function UpdateSettings({
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
    <SettingsSection
      title="Release checks"
      description="Decide when the app may request public release information."
    >
      <SettingsRow
        label="Manual release checks"
        description="Check now requests public release information from the Dotatel/BacktestEngine GitHub repository. Installation stays under your control."
        htmlFor="manual-release-checks"
      >
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
      </SettingsRow>
      <SettingsRow
        label="Check for a release"
        description="No scheduled or background checks."
      >
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
      </SettingsRow>
      <p className="app-settings-note">
        Last valid release check:{" "}
        {settings?.updates.lastSuccessfulCheckAt || "Never"}
      </p>
      {release && (
        <section
          className="app-settings-release-result"
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
    </SettingsSection>
  );
}
