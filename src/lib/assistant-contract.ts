/** Explicit free route; current location-specific metadata must confirm every price tier is zero before sending. */
export interface AssistantModelRef {
  providerId: "opencode";
  id: string;
}

/** Safe projected model offer; no provider headers, request settings, credentials or raw metadata. */
export interface AssistantModelOffer {
  model: AssistantModelRef;
  name: string;
  checkedAt: string;
  zeroCostVerified: boolean;
}

/** Plain text pasted or explicitly captured by the user and shown exactly in the outgoing preview. */
export interface AssistantContext {
  label: string;
  text: string;
}

/** Local draft remains available across disconnects, failed sends and cancellation. */
export interface AssistantDraft {
  message: string;
  context: AssistantContext[];
  model: AssistantModelRef | null;
}

/** Actual persisted safe text; a proposal never becomes executable source through this contract. */
export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: string;
  createdAt: string;
  model: AssistantModelRef;
}

/** Native-composed application text only; inherited service/provider instructions are outside this preview. */
export interface AssistantPreview {
  text: string;
  sha256: string;
}

/** Native provider session IDs remain private; public history contains only local conversation identity. */
export interface AssistantConversation {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  draft: AssistantDraft;
  messages: AssistantMessage[];
  preview: AssistantPreview;
}

/** The local list can be loaded without service discovery or any network request. */
export interface AssistantHistoryEntry {
  id: string;
  title: string;
  updatedAt: string;
}

/** Pending/unconfirmed work survives restart and blocks another model send until its stop is confirmed. */
export interface AssistantSnapshot {
  conversations: AssistantHistoryEntry[];
  selected: AssistantConversation | null;
  busy: boolean;
  cancellationUnconfirmed: boolean;
}

/** Only explicit Connect/Refresh fetches safe current service/model capability. */
export interface AssistantStatus {
  connected: boolean;
  version: string | null;
  toolsDisabledVerified: boolean;
  models: AssistantModelOffer[];
  problem: string | null;
}

/** A send references one persisted reviewed draft, never a renderer-created provider session or executable path. */
export interface AssistantSendRequest {
  conversationId: string;
  expectedRevision: number;
  previewSha256: string;
}

/** Lifecycle status is independent from availability of a completed proposal. */
export interface AssistantSendResult {
  status: string;
  conversation: AssistantConversation;
  cancellationUnconfirmed: boolean;
  problem: string | null;
}

/** Narrow optional native integration; browser mode never invents a connected service or a model answer. */
export interface AssistantBridge {
  native: boolean;
  load(conversationId?: string): Promise<AssistantSnapshot>;
  newConversation(): Promise<AssistantConversation>;
  saveDraft(
    conversationId: string,
    expectedRevision: number,
    draft: AssistantDraft,
  ): Promise<AssistantConversation>;
  status(): Promise<AssistantStatus>;
  send(request: AssistantSendRequest): Promise<AssistantSendResult>;
  cancel(conversationId: string): Promise<AssistantSendResult>;
}
