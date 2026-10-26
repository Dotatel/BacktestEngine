import { vi } from "vitest";
import type {
  AssistantBridge,
  AssistantConversation,
  AssistantDraft,
  AssistantStatus,
} from "@/lib/assistant-contract";

// Synthetic local adapter fixtures only. No OpenCode service, session or model is contacted.
export const syntheticModel = {
  providerId: "opencode" as const,
  id: "glm-5.3-flash-free",
};
export const syntheticStatus: AssistantStatus = {
  connected: true,
  version: "synthetic",
  toolsDisabledVerified: true,
  models: [
    {
      model: syntheticModel,
      name: "Synthetic free model",
      zeroCostVerified: true,
      checkedAt: "2026-10-24T12:00:00Z",
    },
  ],
  problem: null,
};

/** Create a local-looking record with a deliberately synthetic preview hash. */
export function syntheticConversation(
  draft?: AssistantDraft,
): AssistantConversation {
  const initial = draft ?? {
    message: "Synthetic explicit question",
    context: [],
    model: syntheticModel,
  };
  return {
    id: "synthetic-local-a",
    title: "Synthetic conversation",
    revision: 0,
    updatedAt: "2026-10-24T12:00:00Z",
    draft: initial,
    messages: [],
    preview: { text: initial.message, sha256: "a".repeat(64) },
  };
}

/** Preserve optimistic revision semantics in the fake store so race tests exercise the controller's real ordering. */
export function syntheticAssistant(
  initial: AssistantConversation | null = syntheticConversation(),
) {
  let saved = initial;
  const bridge: AssistantBridge = {
    native: true,
    load: vi.fn().mockImplementation(async () => ({
      conversations: saved
        ? [{ id: saved.id, title: saved.title, updatedAt: saved.updatedAt }]
        : [],
      selected: saved,
      busy: false,
      cancellationUnconfirmed: false,
    })),
    newConversation: vi.fn().mockImplementation(async () => {
      saved = syntheticConversation({ message: "", context: [], model: null });
      return saved;
    }),
    saveDraft: vi
      .fn()
      .mockImplementation(
        async (id: string, expected: number, draft: AssistantDraft) => {
          if (!saved || saved.id !== id || saved.revision !== expected)
            throw new Error("Synthetic stale revision");
          saved = {
            ...saved,
            revision: expected + 1,
            draft,
            preview: {
              text: `${draft.message}${draft.context.map((item) => `\n\n---\n[${item.label}]\n${item.text}`).join("")}`,
              sha256: "b".repeat(64),
            },
          };
          return saved;
        },
      ),
    status: vi.fn().mockResolvedValue(syntheticStatus),
    send: vi.fn().mockImplementation(async () => ({
      status: "completed",
      conversation: saved,
      cancellationUnconfirmed: false,
      problem: null,
    })),
    cancel: vi.fn().mockImplementation(async () => ({
      status: "cancelled",
      conversation: saved,
      cancellationUnconfirmed: false,
      problem: null,
    })),
  };
  return bridge;
}
