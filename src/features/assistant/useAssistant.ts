import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssistantBridge,
  AssistantConversation,
  AssistantDraft,
  AssistantHistoryEntry,
  AssistantStatus,
} from "@/lib/assistant-contract";
import { errorMessage } from "@/lib/preferences";
import {
  assistantDraftProblem,
  draftKey,
  emptyAssistantDraft,
} from "./assistant-draft";

/** Local drafts, serialized persistence and explicit existing-service actions stay outside panel presentation. */
export function useAssistant(bridge: AssistantBridge) {
  const [conversation, setConversation] =
    useState<AssistantConversation | null>(null);
  const [history, setHistory] = useState<AssistantHistoryEntry[]>([]);
  const [draft, setDraft] = useState<AssistantDraft>({
    ...emptyAssistantDraft,
  });
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [reviewed, setReviewed] = useState<AssistantConversation | null>(null);
  const [phase, setPhase] = useState<
    | "loading"
    | "idle"
    | "checking"
    | "reviewing"
    | "sending"
    | "cancelling"
    | "unconfirmed"
  >("loading");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0),
    flight = useRef(false),
    action = useRef(false);
  const recordRef = useRef(conversation),
    draftRef = useRef(draft),
    durableKey = useRef(draftKey(emptyAssistantDraft));
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

  /** Install a native local record and invalidate any earlier send review. */
  const install = useCallback((record: AssistantConversation | null) => {
    recordRef.current = record;
    const next = record?.draft ?? { ...emptyAssistantDraft };
    draftRef.current = next;
    durableKey.current = draftKey(next);
    setConversation(record);
    setDraft(next);
    setDirty(false);
    setReviewed(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const token = ++generation.current;
    void bridge
      .load()
      .then((snapshot) => {
        if (!mounted.current || token !== generation.current) return;
        setHistory(snapshot.conversations);
        install(snapshot.selected);
        setPhase(snapshot.busy ? "unconfirmed" : "idle");
        if (snapshot.busy)
          setError(
            "A previous assistant send needs cancellation confirmation before another send.",
          );
      })
      .catch((failure) => {
        if (mounted.current) {
          setError(errorMessage(failure));
          setPhase("idle");
        }
      });
    return () => {
      mounted.current = false;
      generation.current += 1;
      if (flight.current && recordRef.current)
        void bridge.cancel(recordRef.current.id).catch(() => {});
    };
  }, [bridge, install]);

  /** Serialize native optimistic writes; late acknowledgements update revisions without overwriting newer editor text. */
  const persist = useCallback(
    (snapshot: AssistantDraft): Promise<AssistantConversation> => {
      const id = recordRef.current?.id,
        token = generation.current;
      if (!id)
        return Promise.reject(
          new Error("Create a local conversation before saving a draft."),
        );
      setSaving(true);
      const operation = queue.current.then(async () => {
        const current = recordRef.current;
        if (!current || current.id !== id || token !== generation.current)
          throw new Error(
            "Conversation changed before this draft could be saved.",
          );
        const saved = await bridge.saveDraft(id, current.revision, snapshot);
        if (saved.id !== id)
          throw new Error("The saved draft belongs to another conversation.");
        if (token === generation.current && mounted.current) {
          recordRef.current = saved;
          durableKey.current = draftKey(saved.draft);
          setConversation(saved);
          setDirty(draftKey(draftRef.current) !== durableKey.current);
        }
        return saved;
      });
      queue.current = operation.then(
        () => {},
        () => {},
      );
      void queue.current.then(() => {
        if (mounted.current) setSaving(false);
      });
      return operation;
    },
    [bridge],
  );

  useEffect(() => {
    if (!dirty || !conversation || !bridge.native || phase !== "idle") return;
    const timer = window.setTimeout(() => {
      void persist(draftRef.current).catch((failure) => {
        if (mounted.current) setError(errorMessage(failure));
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [bridge.native, conversation, dirty, draft, persist, phase]);

  /** Preserve all explicit edits locally and invalidate review immediately, before a React render can enable Send. */
  const updateDraft = useCallback((next: AssistantDraft) => {
    if (flight.current || action.current) return;
    draftRef.current = next;
    setDraft(next);
    setDirty(draftKey(next) !== durableKey.current);
    setReviewed(null);
    setError("");
  }, []);

  /** Flush the latest local text before switching conversations; failed persistence keeps the current draft visible. */
  const flush = useCallback(async () => {
    await queue.current;
    if (draftKey(draftRef.current) !== durableKey.current)
      await persist(draftRef.current);
  }, [persist]);

  /** Create a local draft only; connection, provider sessions and models remain untouched until explicit actions. */
  const newConversation = useCallback(async () => {
    if (
      action.current ||
      flight.current ||
      phase === "unconfirmed" ||
      !bridge.native
    )
      return;
    action.current = true;
    setPhase("loading");
    setError("");
    try {
      await flush();
      const record = await bridge.newConversation();
      generation.current += 1;
      install(record);
      setHistory((current) => [
        { id: record.id, title: record.title, updatedAt: record.updatedAt },
        ...current,
      ]);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      action.current = false;
      setPhase("idle");
    }
  }, [bridge, flush, install, phase]);

  /** Select a local conversation after the active draft is durable; never infer or create provider history. */
  const selectConversation = useCallback(
    async (id: string) => {
      if (action.current || flight.current || phase === "unconfirmed") return;
      action.current = true;
      setPhase("loading");
      setError("");
      try {
        await flush();
        const snapshot = await bridge.load(id);
        if (snapshot.selected?.id !== id)
          throw new Error("The requested local conversation was not returned.");
        generation.current += 1;
        install(snapshot.selected);
        setHistory(snapshot.conversations);
        if (snapshot.busy) {
          setPhase("unconfirmed");
          return;
        }
        setPhase("idle");
      } catch (failure) {
        setError(errorMessage(failure));
        setPhase("idle");
      } finally {
        action.current = false;
      }
    },
    [bridge, flush, install, phase],
  );

  /** Explicitly inspect existing service/free-model metadata; mounting the panel performs no provider requests. */
  const connect = useCallback(async () => {
    if (action.current || flight.current || !bridge.native) return;
    action.current = true;
    const previous = phase;
    setPhase("checking");
    setError("");
    setReviewed(null);
    try {
      const current = await bridge.status();
      setStatus(current);
      if (current.problem) setError(current.problem);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      action.current = false;
      setPhase(previous === "unconfirmed" ? "unconfirmed" : "idle");
    }
  }, [bridge, phase]);

  /** Review the native-composed text from the exact persisted draft; changes revoke the review. */
  const review = useCallback(async () => {
    if (
      action.current ||
      flight.current ||
      phase !== "idle" ||
      !recordRef.current
    )
      return;
    const problem = assistantDraftProblem(draftRef.current);
    if (problem) {
      setError(problem);
      return;
    }
    action.current = true;
    setPhase("reviewing");
    setError("");
    try {
      await flush();
      const saved = recordRef.current;
      if (saved) setReviewed(saved);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      action.current = false;
      setPhase("idle");
    }
  }, [flush, phase]);

  /** One explicit Send consumes a reviewed revision/hash; no text or model can be substituted through this command. */
  const send = useCallback(async () => {
    const current = recordRef.current;
    if (
      action.current ||
      flight.current ||
      phase !== "idle" ||
      !reviewed ||
      !current ||
      !status?.connected ||
      !status.toolsDisabledVerified
    )
      return;
    if (
      reviewed.id !== current.id ||
      reviewed.revision !== current.revision ||
      draftKey(draftRef.current) !== draftKey(reviewed.draft)
    ) {
      setReviewed(null);
      setError("The draft changed. Review its exact outgoing text again.");
      return;
    }
    flight.current = true;
    const token = generation.current;
    setPhase("sending");
    setError("");
    setReviewed(null);
    try {
      const result = await bridge.send({
        conversationId: current.id,
        expectedRevision: reviewed.revision,
        previewSha256: reviewed.preview.sha256,
      });
      if (!mounted.current || token !== generation.current) return;
      if (result.conversation.id !== current.id)
        throw new Error(
          "The assistant response belongs to another conversation.",
        );
      install(result.conversation);
      if (result.problem) setError(result.problem);
      setPhase(result.cancellationUnconfirmed ? "unconfirmed" : "idle");
      setHistory((history) => [
        {
          id: result.conversation.id,
          title: result.conversation.title,
          updatedAt: result.conversation.updatedAt,
        },
        ...history.filter((item) => item.id !== current.id),
      ]);
    } catch (failure) {
      if (mounted.current && token === generation.current) {
        setError(errorMessage(failure));
        setPhase("unconfirmed");
      }
    } finally {
      flight.current = false;
    }
  }, [bridge, install, phase, reviewed, status]);

  /** Cancellation remains busy while the original send settles; failed provider interruption blocks another send. */
  const cancel = useCallback(async () => {
    const current = recordRef.current;
    if (
      !current ||
      action.current ||
      !["sending", "unconfirmed"].includes(phase)
    )
      return;
    action.current = true;
    setPhase("cancelling");
    setReviewed(null);
    try {
      const result = await bridge.cancel(current.id);
      if (!mounted.current || result.conversation.id !== current.id) return;
      if (flight.current) return;
      install(result.conversation);
      setPhase(result.cancellationUnconfirmed ? "unconfirmed" : "idle");
      setError(result.problem ?? "");
    } catch (failure) {
      setError(errorMessage(failure));
      setPhase("unconfirmed");
    } finally {
      action.current = false;
    }
  }, [bridge, install, phase]);

  return {
    conversation,
    history,
    draft,
    status,
    reviewed,
    phase,
    error,
    dirty,
    saving,
    updateDraft,
    newConversation,
    selectConversation,
    connect,
    review,
    send,
    cancel,
    flush,
  };
}
