/** Saved workspace density, independent from the visual theme. */
export type WorkspaceStyle = "simple" | "advanced";
/** System appearance remains reactive to operating-system changes. */
export type Appearance = "system" | "light" | "dark";
/** Selectable providers; selection alone does not imply a verified connection. */
export type AgentProvider = "codex" | "claude" | "opencode";

/** Versioned durable setup state, validated at every storage boundary. */
export interface Preferences {
  version: 1;
  step: number;
  completed: boolean;
  workspaceStyle: WorkspaceStyle;
  appearance: Appearance;
  agent: AgentProvider | null;
  agentVerified: boolean;
}

export const defaultPreferences: Preferences = {
  version: 1,
  step: 1,
  completed: false,
  workspaceStyle: "simple",
  appearance: "system",
  agent: null,
  agentVerified: false,
};

/** Validate untrusted stored preferences, rejecting contradictory progress instead of silently resetting it. */
export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object")
    throw new Error("Your saved setup is damaged. Retry or reset setup.");
  const candidate = value as Preferences;
  const valid =
    candidate.version === 1 &&
    Number.isInteger(candidate.step) &&
    candidate.step >= 1 &&
    candidate.step <= 5 &&
    typeof candidate.completed === "boolean" &&
    (!candidate.completed || candidate.step === 5) &&
    ["simple", "advanced"].includes(candidate.workspaceStyle) &&
    ["system", "light", "dark"].includes(candidate.appearance) &&
    [null, "codex", "claude", "opencode"].includes(candidate.agent) &&
    typeof candidate.agentVerified === "boolean" &&
    (!candidate.agentVerified || candidate.agent === "opencode");
  if (!valid)
    throw new Error(
      "Your saved setup has unsupported values. Retry or reset setup.",
    );
  return candidate;
}

/** Turn native IPC and ordinary errors into bounded user-visible text without logging stored data. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong. Please retry.";
}

export const providerNames: Record<AgentProvider, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};
