import type { AssistantDraft } from "@/lib/assistant-contract";

/** Browser drafts are editable but never a connected/sending fallback. Native storage remains authoritative. */
export const emptyAssistantDraft: AssistantDraft = {
  message: "",
  context: [],
  model: null,
};

/** Match native UTF-8 limits rather than JavaScript character count, preserving invalid drafts visibly in the panel. */
export function assistantDraftProblem(draft: AssistantDraft): string | null {
  if (!draft.message.trim()) return "Enter a question before reviewing it.";
  if (bytes(draft.message) > 8000)
    return "The message exceeds 8,000 UTF-8 bytes.";
  if (!draft.model) return "Explicitly choose an available free model.";
  if (draft.context.length > 4) return "Use at most four context blocks.";
  for (const item of draft.context) {
    if (!item.label.trim() || !item.text.trim())
      return "Complete or remove empty context blocks.";
    if (bytes(item.label) > 100 || bytes(item.text) > 2000)
      return "Each context block allows 100 label bytes and 2,000 text bytes.";
  }
  return null;
}

/** Compare drafts without including a provider session ID or deriving upload context from project state. */
export function draftKey(draft: AssistantDraft): string {
  return JSON.stringify(draft);
}

/** Count UTF-8 bytes for explicit context-size feedback. */
export function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
