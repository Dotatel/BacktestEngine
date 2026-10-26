import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssistantSendResult } from "@/lib/assistant-contract";
import {
  syntheticAssistant,
  syntheticConversation,
} from "./assistant-fixtures.test-support";
import { useAssistant } from "./useAssistant";

describe("assistant lifecycle (synthetic injected services only)", () => {
  it("loads local drafts without connecting, listing models or sending", async () => {
    const bridge = syntheticAssistant();
    const hook = renderHook(() => useAssistant(bridge));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    expect(hook.result.current.draft.message).toBe(
      "Synthetic explicit question",
    );
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.send).not.toHaveBeenCalled();
  });
  it("creates an initially empty local conversation without a phantom draft-save failure", async () => {
    const bridge = syntheticAssistant(null);
    const hook = renderHook(() => useAssistant(bridge));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.newConversation());
    expect(hook.result.current.conversation).not.toBeNull();
    expect(hook.result.current.error).toBe("");
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.send).not.toHaveBeenCalled();
  });
  it("saves the exact latest draft before preview and sends only its revision and hash", async () => {
    const bridge = syntheticAssistant();
    const hook = renderHook(() => useAssistant(bridge));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.connect());
    act(() =>
      hook.result.current.updateDraft({
        ...hook.result.current.draft,
        message: "User-reviewed exact text",
      }),
    );
    await act(async () => hook.result.current.review());
    expect(hook.result.current.reviewed?.preview.text).toBe(
      "User-reviewed exact text",
    );
    const reviewed = hook.result.current.reviewed!;
    await act(async () => hook.result.current.send());
    expect(bridge.send).toHaveBeenCalledWith({
      conversationId: reviewed.id,
      expectedRevision: reviewed.revision,
      previewSha256: reviewed.preview.sha256,
    });
  });
  it("revokes review synchronously when text/context changes, including a same-tick old send callback", async () => {
    const bridge = syntheticAssistant();
    const hook = renderHook(() => useAssistant(bridge));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.connect());
    await act(async () => hook.result.current.review());
    const oldSend = hook.result.current.send;
    act(() => {
      hook.result.current.updateDraft({
        ...hook.result.current.draft,
        context: [
          { label: "New explicit context", text: "Changed after review" },
        ],
      });
      void oldSend();
    });
    expect(bridge.send).not.toHaveBeenCalled();
    expect(hook.result.current.reviewed).toBeNull();
  });
  it("latches duplicate sends and stays cancelling until the original native response settles", async () => {
    const bridge = syntheticAssistant();
    let finish!: (value: AssistantSendResult) => void;
    vi.mocked(bridge.send).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const hook = renderHook(() => useAssistant(bridge));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.connect());
    await act(async () => hook.result.current.review());
    act(() => {
      void hook.result.current.send();
      void hook.result.current.send();
    });
    expect(bridge.send).toHaveBeenCalledTimes(1);
    await act(async () => hook.result.current.cancel());
    expect(hook.result.current.phase).toBe("cancelling");
    await act(async () =>
      finish({
        status: "cancelled",
        conversation: syntheticConversation(),
        cancellationUnconfirmed: false,
        problem: null,
      }),
    );
    expect(hook.result.current.phase).toBe("idle");
  });
  it("keeps a failed interrupt blocked and preserves draft/history until retry cancellation confirms idle", async () => {
    const bridge = syntheticAssistant();
    vi.mocked(bridge.send).mockResolvedValue({
      status: "unconfirmed",
      conversation: syntheticConversation(),
      cancellationUnconfirmed: true,
      problem: "Synthetic interruption unconfirmed",
    });
    const hook = renderHook(() => useAssistant(bridge));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    await act(async () => hook.result.current.connect());
    await act(async () => hook.result.current.review());
    await act(async () => hook.result.current.send());
    expect(hook.result.current.phase).toBe("unconfirmed");
    expect(hook.result.current.draft.message).toContain("Synthetic explicit");
    await act(async () => hook.result.current.send());
    expect(bridge.send).toHaveBeenCalledTimes(1);
    await act(async () => hook.result.current.cancel());
    expect(hook.result.current.phase).toBe("idle");
  });
  it("keeps unsaved text visible when local persistence fails and refuses a review", async () => {
    const bridge = syntheticAssistant();
    vi.mocked(bridge.saveDraft).mockRejectedValue(
      new Error("Synthetic disk unavailable"),
    );
    const hook = renderHook(() => useAssistant(bridge));
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
    act(() =>
      hook.result.current.updateDraft({
        ...hook.result.current.draft,
        message: "Preserve this local draft",
      }),
    );
    await act(async () => hook.result.current.review());
    expect(hook.result.current.reviewed).toBeNull();
    expect(hook.result.current.draft.message).toBe("Preserve this local draft");
    expect(hook.result.current.error).toContain("disk unavailable");
    expect(bridge.send).not.toHaveBeenCalled();
  });
});
