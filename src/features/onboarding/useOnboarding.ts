import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge } from "@/lib/desktop";
import { errorMessage, type Preferences } from "@/lib/preferences";
import { usePreferences } from "./usePreferences";
import { useAgentConnection } from "./useAgentConnection";
import { useAppearance } from "./useAppearance";

/** Coordinate setup progress, storage and optional connections; views receive state/actions without owning native IPC. */
export function useOnboarding(bridge: DesktopBridge) {
  const store = usePreferences(bridge);
  const agent = useAgentConnection(bridge);
  const [windowError, setWindowError] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [direction, setDirection] = useState("forward");
  const transitionPending = useRef(false);
  const reportError = useCallback(
    (message: string) => setWindowError(message),
    [],
  );
  useAppearance(store.preferences.appearance);

  /** Synchronize the visible window with setup mode while keeping native errors separate from damaged-storage recovery. */
  const presentWindow = useCallback(
    async (expanded: boolean) => {
      try {
        await bridge.presentWindow(expanded);
      } catch (failure) {
        setWindowError(errorMessage(failure));
      }
    },
    [bridge],
  );

  /** Load setup and reveal the appropriate native frame; a read failure still presents the recovery screen. */
  const reload = useCallback(async () => {
    setWindowError("");
    const saved = await store.load();
    await presentWindow(Boolean(saved && (saved.step > 1 || saved.completed)));
  }, [store.load, presentWindow]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Commit progress before changing screens; duplicate actions cannot bypass saves or overwrite newer choices. */
  async function saveNavigation(next: Preferences) {
    if (transitionPending.current) return;
    transitionPending.current = true;
    const previous = store.read();
    setDirection(next.step < previous.step ? "back" : "forward");
    setWindowError("");
    try {
      const saved = await store.save(next);
      if (saved && (previous.step === 1 || next.step === 1))
        await presentWindow(next.step > 1 || next.completed);
    } finally {
      transitionPending.current = false;
    }
  }

  /** Move to a setup step, retaining all selections and reopening completed setup when requested. */
  function navigate(step: number) {
    return saveNavigation({ ...store.read(), step, completed: false });
  }

  /** Persist final completion without creating a project or depending on any optional provider. */
  function finish() {
    return saveNavigation({ ...store.read(), step: 5, completed: true });
  }

  /** Update a selection and clear feedback that belongs to the previous provider choice. */
  function choose(patch: Partial<Preferences>) {
    agent.clear();
    void store.update(patch);
  }

  /** Store a connection flag only after the host returned current provider evidence. */
  async function connect() {
    const provider = store.read().agent;
    if (!provider) return;
    if (await agent.connect(provider))
      await store.update({ agentVerified: true });
  }

  /** Cancel optional work and atomically save skipped status with the next step. */
  async function skipAgent() {
    await agent.cancel();
    await saveNavigation({
      ...store.read(),
      agent: null,
      agentVerified: false,
      step: 5,
      completed: false,
    });
  }

  /** Recover settings only after the reset dialog confirms backup; project/engine files are outside this operation. */
  async function reset() {
    if (!(await store.reset())) return;
    agent.clear();
    setResetOpen(false);
    setWindowError("");
    await presentWindow(false);
  }

  return {
    store,
    agent,
    direction,
    resetOpen,
    setResetOpen,
    reportError,
    reload,
    navigate,
    finish,
    choose,
    connect,
    skipAgent,
    reset,
    busy: store.saving || agent.connecting,
    error: store.failure?.message || agent.error || windowError,
  };
}

/** Read-only view state and named setup actions shared by onboarding presentation components. */
export type OnboardingController = ReturnType<typeof useOnboarding>;
