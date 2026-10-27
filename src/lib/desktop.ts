import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  defaultPreferences,
  parsePreferences,
  type AgentProvider,
  type Preferences,
} from "./preferences";

const previewStorageKey = "dotatel-onboarding-browser-preview-v1";

/** Current provider evidence returned by the host after a successful local probe. */
export interface AgentConnection {
  provider: AgentProvider;
  version: string;
}
/** Scoped host operations; preview mode cannot create connections or manipulate a native window. */
export interface DesktopBridge {
  native: boolean;
  loadPreferences(): Promise<Preferences>;
  savePreferences(preferences: Preferences): Promise<void>;
  resetPreferences(): Promise<Preferences>;
  connectAgent(provider: AgentProvider): Promise<AgentConnection>;
  cancelConnection(): Promise<void>;
  presentWindow(expanded: boolean): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  startDragging(): Promise<void>;
  close(): Promise<void>;
  observeMaximized(
    listener: (maximized: boolean) => void,
    onError: (error: unknown) => void,
  ): Promise<() => void>;
  observeCloseRequested?(guard: () => Promise<boolean>): Promise<() => void>;
}

/** Native IPC stays behind one boundary; browser previews use isolated local storage and cannot claim an agent connection. */
export const desktop: DesktopBridge = {
  native: isTauri(),
  /** Read validated disk settings in Tauri, or isolated preview storage; reject corrupt or inaccessible state. */
  async loadPreferences() {
    if (isTauri()) return parsePreferences(await invoke("load_preferences"));
    const stored = localStorage.getItem(previewStorageKey);
    return stored
      ? parsePreferences(JSON.parse(stored))
      : { ...defaultPreferences };
  },
  /** Persist a validated snapshot; native writes are atomic and storage failures reject without clearing the selection. */
  async savePreferences(preferences) {
    parsePreferences(preferences);
    if (isTauri()) return invoke("save_preferences", { preferences });
    localStorage.setItem(previewStorageKey, JSON.stringify(preferences));
  },
  /** Back up prior setup after explicit confirmation and return fresh defaults; never access project files. */
  async resetPreferences() {
    if (isTauri()) return parsePreferences(await invoke("reset_preferences"));
    const existing = localStorage.getItem(previewStorageKey);
    if (existing)
      localStorage.setItem(
        `${previewStorageKey}-backup-${Date.now()}`,
        existing,
      );
    localStorage.setItem(previewStorageKey, JSON.stringify(defaultPreferences));
    return { ...defaultPreferences };
  },
  /** Verify an existing local provider through scoped IPC; browser previews and unavailable providers reject honestly. */
  async connectAgent(provider) {
    if (!isTauri())
      throw new Error(
        "Agent connections are available in the desktop app. You can skip this step in the browser preview.",
      );
    return invoke("connect_agent", { provider });
  },
  /** Cancel the current native probe without creating a provider task; no effect in a browser preview. */
  async cancelConnection() {
    if (isTauri()) await invoke("cancel_agent_connection");
  },
  /** Reveal compact Welcome or expanded setup through the host; reject native sizing errors. */
  async presentWindow(expanded) {
    if (isTauri()) await invoke("present_window", { expanded });
  },
  /** Minimize the real native window; previews do nothing and native failures reject. */
  async minimize() {
    if (isTauri()) await getCurrentWindow().minimize();
  },
  /** Toggle the real native window's maximized state; previews do nothing and native failures reject. */
  async toggleMaximize() {
    if (isTauri()) await getCurrentWindow().toggleMaximize();
  },
  /** Begin a caption drag on the native window thread; browser previews do nothing and native failures reject. */
  async startDragging() {
    if (isTauri()) await invoke("start_window_drag");
  },
  /** Close the native app after the caller has flushed pending saves; browser previews do nothing. */
  async close() {
    if (isTauri()) await getCurrentWindow().close();
  },
  /** Report current and subsequent native maximize state; return cleanup for the resize listener or reject registration errors. */
  async observeMaximized(listener, onError) {
    if (!isTauri()) return () => {};
    const window = getCurrentWindow();
    let disposed = false;
    let query = 0;
    /** Publish only the newest native query while this subscription is still owned. */
    async function refresh() {
      const current = ++query;
      const maximized = await window.isMaximized();
      if (!disposed && current === query) listener(maximized);
    }
    const unlisten = await window.onResized(() => {
      void refresh().catch((error) => {
        if (!disposed) onError(error);
      });
    });
    /** Release the host listener and suppress results from queries already in flight. */
    function stop() {
      disposed = true;
      unlisten();
    }
    try {
      await refresh();
      return stop;
    } catch (error) {
      stop();
      throw error;
    }
  },
  /** Protect Alt+F4/taskbar close with the same awaited guard as the custom caption button. */
  async observeCloseRequested(guard) {
    if (!isTauri()) return () => {};
    return getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await guard())) event.preventDefault();
    });
  },
};
