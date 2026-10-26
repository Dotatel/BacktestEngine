//! Bind projected provider text to the native-admitted user turn and reject tool/foreign-session evidence.
use super::{contract::AssistantModelRef, policy};
use serde_json::Value;

/// A completed answer has only safe plain text and the actual observed assistant message ID.
#[derive(Debug)]
pub(super) struct Answer {
    pub id: String,
    pub text: String,
}

/// One verified timeline entry either updates proposal text or closes this exact user turn.
enum Entry {
    Answer(Option<Answer>),
    Idle,
}

/// Inspect a bounded ascending session timeline only after this exact admitted user ID, never the last old answer.
pub(super) fn answer(
    payload: &Value,
    user_id: &str,
    model: &AssistantModelRef,
) -> Result<Option<Answer>, String> {
    let messages = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or("OpenCode did not return a readable assistant timeline.")?;
    if messages.len() > 100 {
        return Err("The provider conversation exceeds the 100-message verification bound. Start a new local conversation.".into());
    }
    let Some(index) = messages
        .iter()
        .position(|message| message["type"] == "user" && message["id"] == user_id)
    else {
        return Ok(None);
    };
    let mut completed = None;
    for message in &messages[index + 1..] {
        match timeline_entry(message, model)? {
            Entry::Answer(value) => completed = value,
            Entry::Idle => return Ok(completed),
        }
    }
    Ok(None)
}

/// Reject foreign user/control/tool activities and accept idle only when the service reports success.
fn timeline_entry(message: &Value, model: &AssistantModelRef) -> Result<Entry, String> {
    match message["type"].as_str(){
        Some("assistant")=>Ok(Entry::Answer(verified_answer(message,model)?)),
        Some("idle")=>{
            if message["outcome"]!="succeeded"{return Err("The provider stopped without a successful proposal. The local draft was preserved.".into());}
            Ok(Entry::Idle)
        },
        _=>Err("Unexpected provider activity appeared in the owned assistant turn. No proposal was accepted.".into()),
    }
}

/// Accept only completed text from the selected free model and exact no-tools agent, without tool/snapshot changes.
fn verified_answer(message: &Value, model: &AssistantModelRef) -> Result<Option<Answer>, String> {
    if message["agent"] != policy::AGENT_ID
        || message["model"]["providerID"] != model.provider_id
        || message["model"]["id"] != model.id
    {
        return Err(
            "The provider answered using another agent or model. No fallback answer was accepted."
                .into(),
        );
    }
    let parts = message["content"]
        .as_array()
        .ok_or("The provider answer has no valid content parts.")?;
    if parts.iter().any(|part| part["type"] == "tool")
        || message["finish"] == "tool-calls"
        || message
            .pointer("/snapshot/files")
            .and_then(Value::as_array)
            .is_some_and(|files| !files.is_empty())
    {
        return Err("Tool activity was detected in the proposal-only assistant. The session was stopped; no response was accepted.".into());
    }
    if message
        .get("cost")
        .is_some_and(|cost| cost.as_f64() != Some(0.0))
    {
        return Err("The provider reported an unexpected nonzero or unverifiable charge. No automatic retry or fallback was attempted.".into());
    }
    if message
        .pointer("/time/completed")
        .and_then(Value::as_f64)
        .is_none()
    {
        return Ok(None);
    }
    if message["finish"] != "stop" || message.get("error").is_some_and(|error| !error.is_null()) {
        return Err("The provider did not finish a usable proposal. Check its connection or free-model quota in OpenCode Desktop.".into());
    }
    let id = message["id"]
        .as_str()
        .filter(|id| policy::provider_id(id, "msg_"))
        .ok_or("The assistant answer has an invalid message identity.")?;
    let mut text = String::new();
    for part in parts {
        match part["type"].as_str() {
            Some("text") => text.push_str(
                part["text"]
                    .as_str()
                    .ok_or("The assistant text part is malformed.")?,
            ),
            Some("reasoning") => {}
            _ => return Err(
                "The assistant returned an unsupported content part; raw content was discarded."
                    .into(),
            ),
        }
        if text.len() > policy::MAX_ANSWER_BYTES {
            return Err("The assistant proposal exceeds the 32,000-byte local answer limit; raw output was discarded.".into());
        }
    }
    if text.trim().is_empty() {
        return Err(
            "The provider completed without proposal text. The local draft was preserved.".into(),
        );
    }
    Ok(Some(Answer {
        id: id.into(),
        text,
    }))
}
