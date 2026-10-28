import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Keyboard,
  Monitor,
  RefreshCw,
  Settings2,
  Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Appearance, WorkspaceStyle } from "@/lib/preferences";
import type { SettingsBridge } from "@/lib/settings-contract";
import type { UpdatesBridge } from "@/lib/updates-contract";
import { useAppSettings } from "./useAppSettings";
import {
  GeneralSettings,
  AppearanceSettings,
  ShortcutHelp,
  Diagnostics,
} from "./SettingsSections";
import { UpdateSettings } from "./SettingsUpdates";
import { RecoveryAction } from "./SettingsRecovery";
import "./settings.css";

const categories = [
  {
    key: "general",
    label: "General",
    description: "Manage your workspace layout and report exports.",
    icon: Settings2,
  },
  {
    key: "appearance",
    label: "Appearance",
    description: "Choose the appearance of your workspace and editor.",
    icon: Monitor,
  },
  {
    key: "updates",
    label: "Updates",
    description: "Review public releases only when you choose to check.",
    icon: RefreshCw,
  },
  {
    key: "shortcuts",
    label: "Keyboard shortcuts",
    description:
      "A quick reference to the workspace commands you can use today.",
    icon: Keyboard,
  },
  {
    key: "diagnostics",
    label: "Diagnostics",
    description: "Inspect your local installation and bundled resources.",
    icon: Activity,
  },
] as const;

/** Existing saved preferences and native boundaries, plus navigation back to the preserved workspace. */
export interface SettingsPageProps {
  appearance: Appearance;
  workspaceStyle: WorkspaceStyle;
  onAppearanceChange(value: Appearance): void;
  onWorkspaceStyleChange?: (value: WorkspaceStyle) => void;
  onReviewSetup(): void;
  onClose(): void;
  project?: { name: string; root: string } | null;
  bridge: SettingsBridge;
  updatesBridge: UpdatesBridge;
}

/** Present full-page preferences without taking ownership of editor state or replacing durable stores. */
export function SettingsPage(props: SettingsPageProps) {
  const [category, setCategory] =
    useState<(typeof categories)[number]["key"]>("general");
  const controller = useAppSettings(props.bridge, props.updatesBridge, true);
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const selected = categories.find((item) => item.key === category)!;
  useEffect(() => {
    content.current?.scrollTo?.({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [category]);
  return (
    <section className="app-settings-page" aria-label="Workspace settings">
      <aside className="app-settings-sidebar">
        <div className="app-settings-sidebar__heading">
          <h2>Settings</h2>
          <p className="app-settings-note">Application preferences</p>
        </div>
        <nav
          className="app-settings-categories"
          aria-label="Settings categories"
        >
          <p className="app-settings-categories__label">Application</p>
          {categories.map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              size="sm"
              variant={category === key ? "secondary" : "ghost"}
              aria-current={category === key ? "page" : undefined}
              onClick={() => setCategory(key)}
            >
              <Icon aria-hidden="true" />
              {label}
            </Button>
          ))}
        </nav>
        <div className="app-settings-sidebar__back">
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            <ArrowLeft aria-hidden="true" />
            Back to workspace
          </Button>
        </div>
      </aside>
      <div className="app-settings-body" ref={content}>
        <div className="app-settings-content">
          <header className="app-settings-heading">
            <h1 ref={heading} tabIndex={-1}>
              {selected.label}
            </h1>
            <p>{selected.description}</p>
          </header>
          {category === "general" && (
            <GeneralSettings {...props} controller={controller} />
          )}
          {category === "appearance" && (
            <AppearanceSettings
              appearance={props.appearance}
              onAppearanceChange={props.onAppearanceChange}
            />
          )}
          {category === "updates" && (
            <UpdateSettings
              controller={controller}
              native={props.bridge.native}
            />
          )}
          {category === "shortcuts" && <ShortcutHelp />}
          {category === "diagnostics" &&
            (controller.snapshot ? (
              <Diagnostics value={controller.snapshot.diagnostics} />
            ) : (
              <p className="app-settings-note">
                Open the desktop app to inspect local installation diagnostics.
              </p>
            ))}
          {controller.snapshot?.state === "corrupt" && (
            <section
              className="app-settings-recovery"
              aria-label="Application settings recovery"
            >
              <p className="app-settings-error" role="alert">
                {controller.snapshot.problem}
              </p>
              <RecoveryAction
                controller={controller}
                disabled={controller.phase !== "idle"}
              />
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
      </div>
    </section>
  );
}
