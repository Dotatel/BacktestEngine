import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TitleBar } from "@/components/TitleBar";
import { desktop, type DesktopBridge } from "@/lib/desktop";
import { SetupContent } from "@/features/onboarding/SetupContent";
import {
  SetupError,
  ResetSetupDialog,
} from "@/features/onboarding/SetupFeedback";
import { useOnboarding } from "@/features/onboarding/useOnboarding";
import { workspace, type WorkspaceBridge } from "@/lib/workspace";
import { useWindowCloseGuard } from "@/hooks/useWindowCloseGuard";
import type { AppMenuController } from "@/lib/app-menu-contract";

const BuildWorkspace = lazy(() =>
  import("@/features/workspace/BuildWorkspace").then((module) => ({
    default: module.BuildWorkspace,
  })),
);

/** Compose the desktop shell; focused owners handle persistence, connections and navigation. */
export function App({
  bridge = desktop,
  workspaceBridge = workspace,
}: {
  bridge?: DesktopBridge;
  workspaceBridge?: WorkspaceBridge;
}) {
  const setup = useOnboarding(bridge);
  const { preferences, loadState, saving } = setup.store;
  const heading = useRef<HTMLHeadingElement>(null);
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState<AppMenuController | null>(
    null,
  );
  const workspaceFlush = useRef<(() => Promise<void>) | null>(null);
  const registerWorkspaceFlush = useCallback(
    (flush: (() => Promise<void>) | null) => {
      workspaceFlush.current = flush;
    },
    [],
  );
  const showWorkspace = loadState === "ready" && preferences.completed;
  const flush = useCallback(async () => {
    await setup.store.flush();
    await workspaceFlush.current?.();
    if (showWorkspace) await workspaceBridge.cancelBuild();
  }, [setup.store.flush, showWorkspace, workspaceBridge]);
  const canLeave = useWindowCloseGuard(
    bridge,
    workspaceDirty,
    flush,
    setup.reportError,
  );

  /** Return to setup only after preserving editor drafts and ending any current compiler task. */
  async function reviewSetup() {
    if (!(await canLeave())) return;
    await setup.navigate(2);
  }
  const compact =
    loadState === "recovery" ||
    (!preferences.completed && preferences.step === 1);
  const showBack =
    loadState === "ready" && !preferences.completed && preferences.step > 1;
  const viewKey = `${loadState}-${preferences.step}-${preferences.completed}`;

  useEffect(() => {
    if (loadState === "ready") heading.current?.focus({ preventScroll: true });
  }, [loadState, preferences.step, preferences.completed]);

  return (
    <div
      className={`app-shell ${compact ? "compact" : "expanded"}${showWorkspace ? " app-shell--workspace" : ""}`}
    >
      <TitleBar
        bridge={bridge}
        onError={setup.reportError}
        beforeClose={canLeave}
        menu={showWorkspace ? (workspaceMenu ?? undefined) : undefined}
      />
      <main
        className={showWorkspace ? "workspace-host" : "onboarding"}
        aria-busy={loadState === "loading" || saving}
      >
        {showWorkspace ? (
          <Suspense
            fallback={
              <div className="loading-state" role="status">
                Opening Build workspace…
              </div>
            }
          >
            <BuildWorkspace
              bridge={workspaceBridge}
              appearance={preferences.appearance}
              workspaceStyle={preferences.workspaceStyle}
              onAppearanceChange={(appearance) => setup.choose({ appearance })}
              onWorkspaceStyleChange={(workspaceStyle) =>
                setup.choose({ workspaceStyle })
              }
              onReviewSetup={() => void reviewSetup()}
              onDirtyChange={setWorkspaceDirty}
              onFlushChange={registerWorkspaceFlush}
              onMenuChange={setWorkspaceMenu}
            />
          </Suspense>
        ) : (
          <div
            className="setup-pane"
            data-direction={setup.direction}
            key={viewKey}
          >
            <SetupContent setup={setup} headingRef={heading} />
            {showBack && (
              <Button
                variant="ghost"
                className="back-action"
                disabled={setup.busy}
                onClick={() => void setup.navigate(preferences.step - 1)}
              >
                <ArrowLeft aria-hidden="true" />
                Back
              </Button>
            )}
          </div>
        )}
        <SetupError setup={setup} />
        <span className="save-status" role="status" aria-live="polite">
          {saving ? "Saving your preferences…" : ""}
        </span>
      </main>
      <ResetSetupDialog setup={setup} />
    </div>
  );
}
