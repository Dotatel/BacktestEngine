import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AssistantBridge } from "./assistant-contract";
export type * from "./assistant-contract";

/** Keep existing-service IPC outside presentation; a browser never starts or simulates a provider conversation. */
export const assistant: AssistantBridge = {
  native: isTauri(),
  load: (conversationId) =>
    isTauri()
      ? invoke("assistant_load", { conversationId: conversationId ?? null })
      : Promise.resolve({
          conversations: [],
          selected: null,
          busy: false,
          cancellationUnconfirmed: false,
        }),
  newConversation: () => desktop("assistant_new_conversation"),
  saveDraft: (conversationId, expectedRevision, draft) =>
    desktop("assistant_save_draft", {
      request: { conversationId, expectedRevision, draft },
    }),
  status: () => desktop("assistant_status"),
  send: (request) => desktop("assistant_send", { request }),
  cancel: (conversationId) => desktop("assistant_cancel", { conversationId }),
};

/** An explicit native capability error leaves browser drafts/history unsent, without a paid or fake local fallback. */
function desktop<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri())
    return Promise.reject(
      new Error(
        "The optional assistant requires the desktop app and an existing OpenCode service. Nothing was sent.",
      ),
    );
  return invoke<T>(command, args);
}
