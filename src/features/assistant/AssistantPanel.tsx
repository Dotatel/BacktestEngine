import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  AssistantBridge,
  AssistantContext,
} from "@/lib/assistant-contract";
import { bytes } from "./assistant-draft";
import { useAssistant } from "./useAssistant";
import "./assistant.css";

/** Context candidates are existing in-memory text; only a user click adds a bounded block to the reviewed draft. */
export interface AssistantPanelProps {
  bridge: AssistantBridge;
  contextOptions?: AssistantContext[];
  onClose?(): void;
  onFlushChange?(flush: (() => Promise<void>) | null): void;
}

/** Optional proposal-only conversation pane with durable local drafts and explicit privacy review before every send. */
export function AssistantPanel({
  bridge,
  contextOptions = [],
  onClose,
  onFlushChange,
}: AssistantPanelProps) {
  const controller = useAssistant(bridge);
  const { conversation, draft, status, phase, reviewed } = controller;
  const pending =
    phase === "sending" || phase === "cancelling" || phase === "unconfirmed";
  const busy = phase !== "idle";
  const offers = status?.models ?? [];
  const selectedOffer = offers.find(
    (offer) =>
      offer.model.id === draft.model?.id &&
      offer.model.providerId === draft.model.providerId,
  );
  useEffect(() => {
    onFlushChange?.(controller.flush);
    return () => onFlushChange?.(null);
  }, [controller.flush, onFlushChange]);

  /** Capture exactly this displayed text block; no source file, report path or dataset is opened by the assistant. */
  function addContext(item: AssistantContext) {
    if (busy || draft.context.length >= 4) return;
    controller.updateDraft({
      ...draft,
      context: [...draft.context, { ...item }],
    });
  }

  /** Update one local context block and revoke the earlier send review. */
  function editContext(
    index: number,
    field: keyof AssistantContext,
    value: string,
  ) {
    controller.updateDraft({
      ...draft,
      context: draft.context.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    });
  }

  return (
    <aside
      className="assistant-panel"
      aria-label="Optional assistant"
      aria-busy={busy}
    >
      <header className="assistant-header">
        <h2>Assistant</h2>
        {onClose ? (
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </header>
      <p className="assistant-muted">
        Optional OpenCode connection. Answers are proposals; they do not edit
        files, run tools, or establish trading validity.
      </p>
      {!bridge.native ? (
        <p>
          Browser preview cannot connect or send a model prompt. Local
          backtesting does not need an assistant.
        </p>
      ) : null}
      <div className="assistant-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={(busy && phase !== "unconfirmed") || !bridge.native}
          onClick={() => void controller.connect()}
        >
          {status?.connected ? "Refresh free models" : "Connect OpenCode"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !bridge.native}
          onClick={() => void controller.newConversation()}
        >
          New conversation
        </Button>
      </div>
      {status?.connected ? (
        <p className="assistant-muted">
          OpenCode {status.version} · Proposal-only agent verified. Only
          currently enabled zero-cost offers appear below; no paid fallback is
          selected.
        </p>
      ) : null}
      {status?.connected && !offers.length ? (
        <p>
          No supported zero-cost model is currently available. Retry in OpenCode
          Desktop or continue offline.
        </p>
      ) : null}
      {controller.error ? (
        <p role="alert" className="assistant-error">
          {controller.error}
        </p>
      ) : null}
      {phase === "loading" ? (
        <p role="status">Loading local conversation…</p>
      ) : null}
      {controller.history.length ? (
        <div className="assistant-field">
          <Label htmlFor="assistant-history">Local conversations</Label>
          <Select
            value={conversation?.id ?? ""}
            disabled={busy}
            onValueChange={(id) => void controller.selectConversation(id)}
          >
            <SelectTrigger id="assistant-history" size="sm">
              <SelectValue placeholder="Choose a conversation" />
            </SelectTrigger>
            <SelectContent>
              {controller.history.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {!conversation ? (
        <p className="assistant-muted">
          Create a local conversation to write a question. Connecting only
          checks the existing service; a model receives text only after review
          and Send.
        </p>
      ) : (
        <>
          <div className="assistant-field">
            <Label htmlFor="assistant-model">Free model</Label>
            <Select
              value={selectedOffer?.model.id ?? ""}
              disabled={
                busy || !offers.length || conversation.messages.length > 0
              }
              onValueChange={(id) => {
                const offer = offers.find((item) => item.model.id === id);
                if (offer)
                  controller.updateDraft({ ...draft, model: offer.model });
              }}
            >
              <SelectTrigger id="assistant-model" size="sm">
                <SelectValue
                  placeholder={
                    draft.model?.id ?? "Explicitly select a free model"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {offers.map((offer) => (
                  <SelectItem key={offer.model.id} value={offer.model.id}>
                    {offer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {conversation.messages.length > 0 ? (
            <p className="assistant-muted">
              This conversation keeps its selected model. Start a new
              conversation to choose another.
            </p>
          ) : null}
          <section
            className="assistant-history"
            aria-label="Saved proposal conversation"
            aria-live="polite"
          >
            {conversation.messages.map((message) => (
              <article className="assistant-message" key={message.id}>
                <h3>
                  {message.role === "user" ? "You" : "Assistant proposal"}{" "}
                  <span className="assistant-muted">· {message.status}</span>
                </h3>
                <p className="assistant-text">{message.text}</p>
              </article>
            ))}
            {!conversation.messages.length ? (
              <p className="assistant-muted">No messages have been sent.</p>
            ) : null}
          </section>
          <div className="assistant-field">
            <Label htmlFor="assistant-question">Your question</Label>
            <Textarea
              id="assistant-question"
              disabled={busy}
              value={draft.message}
              onChange={(event) =>
                controller.updateDraft({
                  ...draft,
                  message: event.target.value,
                })
              }
              placeholder="Ask about strategy code, build diagnostics, or a result you choose to share."
            />
            <p className="assistant-muted">
              {bytes(draft.message).toLocaleString()} / 8,000 UTF-8 bytes ·{" "}
              {draftStatus(controller.saving, controller.dirty)}
            </p>
          </div>
          <section
            className="assistant-section"
            aria-label="Context you choose to share"
          >
            <h3>Context you choose to share</h3>
            <p className="assistant-muted">
              Nothing is collected automatically. Paste text or explicitly add a
              displayed summary. Review every block before sending.
            </p>
            {draft.context.map((item, index) => (
              <div className="assistant-context" key={index}>
                <div className="assistant-field">
                  <Label htmlFor={`assistant-context-label-${index}`}>
                    Context {index + 1} label
                  </Label>
                  <Input
                    id={`assistant-context-label-${index}`}
                    value={item.label}
                    disabled={busy}
                    onChange={(event) =>
                      editContext(index, "label", event.target.value)
                    }
                  />
                </div>
                <div className="assistant-field">
                  <Label htmlFor={`assistant-context-text-${index}`}>
                    Exact plain text
                  </Label>
                  <Textarea
                    id={`assistant-context-text-${index}`}
                    value={item.text}
                    disabled={busy}
                    onChange={(event) =>
                      editContext(index, "text", event.target.value)
                    }
                  />
                  <span className="assistant-muted">
                    {bytes(item.text)} / 2,000 UTF-8 bytes
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    controller.updateDraft({
                      ...draft,
                      context: draft.context.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                >
                  Remove context {index + 1}
                </Button>
              </div>
            ))}
            <div className="assistant-actions">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || draft.context.length >= 4}
                onClick={() =>
                  addContext({ label: "Pasted context", text: "" })
                }
              >
                Add plain-text context
              </Button>
              {contextOptions.map((item) => (
                <Button
                  key={item.label}
                  variant="outline"
                  size="sm"
                  disabled={
                    busy || draft.context.length >= 4 || bytes(item.text) > 2000
                  }
                  onClick={() => addContext(item)}
                >
                  Add {item.label}
                </Button>
              ))}
            </div>
          </section>
          <p className="assistant-muted">
            OpenCode and the selected provider receive your message and the
            exact previewed application text. Earlier approved messages in this
            conversation may remain in provider context. OpenCode may apply
            existing global instructions; this panel cannot show all provider
            context.
          </p>
          <div className="assistant-actions">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !selectedOffer || !draft.message.trim()}
              onClick={() => void controller.review()}
            >
              Review outgoing text
            </Button>
            {pending ? (
              <Button
                size="sm"
                variant="outline"
                disabled={phase === "cancelling"}
                onClick={() => void controller.cancel()}
              >
                {phase === "unconfirmed" ? "Retry cancellation" : "Cancel send"}
              </Button>
            ) : null}
          </div>
          {reviewed ? (
            <section
              className="assistant-section"
              aria-label="Exact outgoing text review"
            >
              <h3>Exact outgoing application text</h3>
              <pre className="assistant-preview">{reviewed.preview.text}</pre>
              <p className="assistant-muted">
                Destination: {reviewed.draft.model?.providerId}/
                {reviewed.draft.model?.id}. No file attachments or tools. Fresh
                price and permission checks run again before sending.
              </p>
              <Button
                size="sm"
                disabled={busy || !selectedOffer}
                onClick={() => void controller.send()}
              >
                Send reviewed text
              </Button>
            </section>
          ) : null}
          {pending ? <p role="status">{pendingLabel(phase)}</p> : null}
        </>
      )}
    </aside>
  );
}

/** Describe provider lifecycle honestly, including a stop that has not been confirmed by the service. */
function pendingLabel(phase: string): string {
  if (phase === "unconfirmed")
    return "Provider stop is unconfirmed. Another send remains blocked; retry cancellation.";
  if (phase === "cancelling")
    return "Cancelling the app-owned inbox input and waiting for OpenCode to become idle…";
  return "Waiting for the selected free model. Cancellation keeps the local draft.";
}

/** Keep unsaved and in-flight persistence distinct without hiding a failed local write. */
function draftStatus(saving: boolean, dirty: boolean): string {
  if (saving) return "Saving locally…";
  if (dirty) return "Draft not yet saved";
  return "Draft saved locally";
}
