import type {
  WorkspacePreset,
  WorkspaceSession,
} from "@/lib/workspace-contract";

/** Create a fresh session without sharing mutable arrays with a previous session. */
export function emptySession(): WorkspaceSession {
  return { lastProject: null, activeFile: null, openFiles: [], presets: [] };
}

/** Merge known view fields into a session snapshot while preserving any host-owned extra data. */
export function mergeSession(
  session: WorkspaceSession,
  patch: Partial<WorkspaceSession>,
): WorkspaceSession {
  return { ...session, ...patch };
}

/**
 * Validate a stored session before it reaches the editor. Damaged required fields are rejected
 * with an actionable message so the caller can offer a real retry instead of overwriting data.
 */
export function normalizeSession(value: unknown): WorkspaceSession {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw damagedSession();
  const candidate = value as WorkspaceSession;
  if (
    !isNullableText(candidate.lastProject) ||
    !isNullableText(candidate.activeFile)
  )
    throw damagedSession();
  if (!Array.isArray(candidate.openFiles) || !candidate.openFiles.every(isText))
    throw damagedSession();
  if (!Array.isArray(candidate.presets) || !candidate.presets.every(isPreset))
    throw damagedSession();
  return {
    ...candidate,
    openFiles: [...candidate.openFiles],
    presets: candidate.presets.map((preset) => ({
      ...preset,
      values: { ...preset.values },
    })),
  };
}

/** Build the one actionable error used for every malformed session field. */
function damagedSession(): Error {
  return new Error(
    "Your saved workspace state is damaged. Retry loading it; the stored file has not been changed.",
  );
}

/** Test that a session value is a non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Test that a session value is either absent or a usable string. */
function isNullableText(value: unknown): value is string | null {
  return value === null || isText(value);
}

/** Test that an untrusted preset has the complete shape required for durable preset storage. */
function isPreset(value: unknown): value is WorkspacePreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preset = value as WorkspacePreset;
  return (
    isText(preset.projectRoot) &&
    isText(preset.strategy) &&
    isText(preset.name) &&
    isValueRecord(preset.values)
  );
}

/** Reject arrays and null when a preset must carry a plain parameter-value record. */
function isValueRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
