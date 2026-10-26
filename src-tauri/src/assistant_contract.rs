//! Bounded optional-assistant contracts; provider sessions and command paths never come from the renderer.
use serde::{Deserialize, Serialize};

/// Explicit free model selection; availability and every cost tier are checked again before each send.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantModelRef {
    pub provider_id: String,
    pub id: String,
}

/// Safe projected offer; provider headers/settings/body/credentials are never retained or returned.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantModelOffer {
    pub model: AssistantModelRef,
    pub name: String,
    pub checked_at: String,
    pub zero_cost_verified: bool,
}

/// A user-pasted or explicitly captured plain-text block, with no source-file path or attachment instruction.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantContext {
    pub label: String,
    pub text: String,
}

/// Editable local state; changing any field invalidates the earlier preview revision/hash.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantDraft {
    pub message: String,
    pub context: Vec<AssistantContext>,
    pub model: Option<AssistantModelRef>,
}

/// Persisted proposal text and exact user-approved outgoing text; no reasoning/tool payload or raw CLI diagnostic.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub status: String,
    pub created_at: String,
    pub model: AssistantModelRef,
}

/// Host-composed outgoing text and its hash; this covers application text, not provider/global instructions.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPreview {
    pub text: String,
    pub sha256: String,
}

/// Public local conversation view; its private provider session ID stays exclusively on the native host.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantConversation {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub updated_at: String,
    pub draft: AssistantDraft,
    pub messages: Vec<AssistantMessage>,
    pub preview: AssistantPreview,
}

/// Local history list is metadata only; selecting one entry loads its bounded content without network calls.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantHistoryEntry {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

/// Loading local history is independent of OpenCode availability and never performs model discovery.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSnapshot {
    pub conversations: Vec<AssistantHistoryEntry>,
    pub selected: Option<AssistantConversation>,
    pub busy: bool,
    pub cancellation_unconfirmed: bool,
}

/// An explicit connection check exposes only version, exact no-tools capability and permitted free offers.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantStatus {
    pub connected: bool,
    pub version: Option<String>,
    pub tools_disabled_verified: bool,
    pub models: Vec<AssistantModelOffer>,
    pub problem: Option<String>,
}

/// Optimistic local edit; the host preserves a newer draft rather than overwriting it with stale async saves.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantSaveDraft {
    pub conversation_id: String,
    pub expected_revision: u64,
    pub draft: AssistantDraft,
}

/// Send only a previously persisted and exactly reviewed draft; callers cannot inject paths or provider session IDs.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantSendRequest {
    pub conversation_id: String,
    pub expected_revision: u64,
    pub preview_sha256: String,
}

/// Lifecycle completion is separate from a useful answer; unconfirmed cancellation blocks another send.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSendResult {
    pub status: String,
    pub conversation: AssistantConversation,
    pub cancellation_unconfirmed: bool,
    pub problem: Option<String>,
}
