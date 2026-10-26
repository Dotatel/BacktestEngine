//! Strict no-tools, no-paid-fallback and explicit-text policies for the existing OpenCode service.
use super::contract::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(super) const AGENT_ID: &str = "backtest-proposal-assistant";
pub(super) const OWNER: &str = "dotatel-backtest-assistant-v1";
pub(super) const MAX_MESSAGE_BYTES: usize = 8_000;
pub(super) const MAX_PROMPT_BYTES: usize = 20_000;
pub(super) const MAX_ANSWER_BYTES: usize = 32_000;
pub(super) const MAX_MESSAGES: usize = 100;
pub(super) const MAX_CONVERSATIONS: usize = 20;
const SYSTEM: &str = "You are the optional BacktestEngine proposal assistant. Answer only from the user's text and explicitly attached plain-text context. Never use tools, read or edit files, run commands, create agents, browse, or execute proposed code. All suggestions are unverified proposals; do not claim backtest or trading validation. Return plain text.";

/// Fixed primary agent with a single wildcard deny; steps=1 removes tools on its final model step in V2.
pub(super) fn agent_config() -> Value {
    json!({"agents":{(AGENT_ID):{"description":"Optional BacktestEngine proposal-only assistant","mode":"primary","steps":1,"system":SYSTEM,"permissions":deny_all()}}})
}

/// The only accepted ruleset has one three-field wildcard deny, without later allows, asks or unknown fields.
pub(super) fn deny_all() -> Value {
    json!([{"action":"*","resource":"*","effect":"deny"}])
}

/// Fail closed when a service/profile reports anything other than the exact supported deny-all ruleset.
pub(super) fn exact_deny_all(value: &Value) -> bool {
    value == &deny_all()
}

/// Agent.Info contains composed builtin/global/agent rules; a universal deny followed only by denies proves no tool can pass.
pub(super) fn effective_agent_deny_all(value: &Value) -> bool {
    let Some(rules) = value
        .as_array()
        .filter(|rules| !rules.is_empty() && rules.len() <= 128)
    else {
        return false;
    };
    if !rules.iter().all(valid_composed_rule) {
        return false;
    }
    let Some(index) = rules.iter().position(|rule| {
        rule["action"] == "*" && rule["resource"] == "*" && rule["effect"] == "deny"
    }) else {
        return false;
    };
    rules[index..].iter().all(|rule| rule["effect"] == "deny")
}

/// Only bounded exact three-string V2 rules are understood; unknown structure/effects never prove a restriction.
fn valid_composed_rule(value: &Value) -> bool {
    let Some(rule) = value.as_object().filter(|rule| rule.len() == 3) else {
        return false;
    };
    let action = rule.get("action").and_then(Value::as_str);
    let resource = rule.get("resource").and_then(Value::as_str);
    action.is_some_and(|text| !text.is_empty() && text.len() <= 128)
        && resource.is_some_and(|text| !text.is_empty() && text.len() <= 2048)
        && rule
            .get("effect")
            .and_then(Value::as_str)
            .is_some_and(|effect| ["allow", "ask", "deny"].contains(&effect))
}

/// The optional assistant offers only these already allowed free routes, never Go/paid/default selection.
pub(super) fn allowed_model(model: &AssistantModelRef) -> bool {
    model.provider_id == "opencode"
        && matches!(
            model.id.as_str(),
            "glm-5.3-flash-free" | "deepseek-v4.1-flash-free"
        )
}

/// Validate a model from live metadata: exact ID, enabled/active, and every required price in every tier is zero.
pub(super) fn require_free_model(
    payload: &Value,
    model: &AssistantModelRef,
    directory: &Path,
) -> Result<AssistantModelOffer, String> {
    verify_location(payload.get("location"), directory)?;
    if !allowed_model(model) {
        return Err("Choose one of the explicitly offered free OpenCode models. No paid fallback is available.".into());
    }
    let entries = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or("OpenCode model metadata is incomplete.")?;
    let entry = entries.iter().find(|entry|entry["providerID"] == model.provider_id && entry["id"] == model.id).ok_or("The selected free model is unavailable in this location. Refresh models or retry later.")?;
    if entry["enabled"] != true || entry["status"] != "active" {
        return Err(
            "The selected free model is not enabled and active. Refresh models or retry later."
                .into(),
        );
    }
    let tiers = entry["cost"]
        .as_array()
        .filter(|tiers| !tiers.is_empty())
        .ok_or("The selected model has no verifiable zero-cost metadata.")?;
    if !tiers.iter().all(zero_cost_tier) {
        return Err("The selected model is not verified zero-cost for every input, output and cache tier. No prompt was sent.".into());
    }
    let name = entry["name"]
        .as_str()
        .filter(|name| !name.is_empty() && name.len() <= 160)
        .unwrap_or(&model.id);
    Ok(AssistantModelOffer {
        model: model.clone(),
        name: name.into(),
        checked_at: chrono::Utc::now().to_rfc3339(),
        zero_cost_verified: true,
    })
}

/// Missing/null/non-finite prices never count as free; cache reads and writes are charged dimensions too.
fn zero_cost_tier(tier: &Value) -> bool {
    let Some(fields) = tier.as_object() else {
        return false;
    };
    if fields
        .keys()
        .any(|key| !["input", "output", "cache", "tier"].contains(&key.as_str()))
    {
        return false;
    }
    let Some(cache) = tier["cache"].as_object() else {
        return false;
    };
    if cache.len() != 2
        || cache
            .keys()
            .any(|key| !["read", "write"].contains(&key.as_str()))
    {
        return false;
    }
    ["/input", "/output", "/cache/read", "/cache/write"]
        .iter()
        .all(|path| tier.pointer(path).and_then(Value::as_f64) == Some(0.0))
}

/// Project only the two permitted offers; provider headers/settings/body/raw model metadata never leave this module.
pub(super) fn free_offers(
    payload: &Value,
    directory: &Path,
) -> Result<Vec<AssistantModelOffer>, String> {
    verify_location(payload.get("location"), directory)?;
    let mut offers = Vec::new();
    for id in ["glm-5.3-flash-free", "deepseek-v4.1-flash-free"] {
        let model = AssistantModelRef {
            provider_id: "opencode".into(),
            id: id.into(),
        };
        if let Ok(offer) = require_free_model(payload, &model, directory) {
            offers.push(offer);
        }
    }
    Ok(offers)
}

/// Provider-owned global instructions can exist, but this registered agent must still be our exact no-tools profile.
pub(super) fn verify_agent(payload: &Value, directory: &Path) -> Result<(), String> {
    verify_location(payload.get("location"), directory)?;
    let agent = payload
        .get("data")
        .ok_or("OpenCode did not return the registered assistant agent.")?;
    if agent["id"] != AGENT_ID
        || agent["mode"] != "primary"
        || agent["steps"] != 1
        || agent["system"] != SYSTEM
        || !effective_agent_deny_all(&agent["permissions"])
        || agent.get("model").is_some_and(|value| !value.is_null())
    {
        return Err("The registered assistant agent is not the exact proposal-only profile. Nothing was sent; reconnect without changing global permissions.".into());
    }
    Ok(())
}

/// A stored session ID is usable only when the service proves native ownership, exact selected model and no-tools rules.
pub(super) fn verify_session(
    payload: &Value,
    id: &str,
    conversation: &str,
    model: &AssistantModelRef,
    directory: &Path,
) -> Result<(), String> {
    verify_owned_session(payload, id, conversation, directory)?;
    let session = payload.get("data").unwrap_or(payload);
    if session["agent"] != AGENT_ID
        || session["model"]["providerID"] != model.provider_id
        || session["model"]["id"] != model.id
        || !exact_deny_all(&session["permissions"])
    {
        return Err("The provider session no longer proves this app's exact ownership, selected free model and deny-all policy. No prompt was sent.".into());
    }
    Ok(())
}

/// Stopping a proven app-owned session remains possible after policy/model drift; foreign sessions still fail closed.
pub(super) fn verify_owned_session(
    payload: &Value,
    id: &str,
    conversation: &str,
    directory: &Path,
) -> Result<(), String> {
    let session = payload.get("data").unwrap_or(payload);
    verify_location(session.get("location"), directory)?;
    if session["id"] != id
        || session
            .get("parentID")
            .is_some_and(|value| !value.is_null())
        || session["metadata"]["ownedBy"] != OWNER
        || session["metadata"]["conversationId"] != conversation
    {
        return Err("The provider session does not prove this app's ownership. No provider mutation was attempted.".into());
    }
    Ok(())
}

/// Require the echoed absolute location, because CLI cwd alone does not reliably bind model/agent API requests.
pub(super) fn verify_location(location: Option<&Value>, directory: &Path) -> Result<(), String> {
    let reported = location
        .and_then(|value| value.get("directory"))
        .and_then(Value::as_str)
        .ok_or("OpenCode did not confirm the owned assistant location.")?;
    let canonical = Path::new(reported)
        .canonicalize()
        .map_err(|_| "OpenCode returned an unavailable assistant location.")?;
    if canonical
        != directory
            .canonicalize()
            .map_err(|_| "The owned assistant location is unavailable.")?
    {
        return Err("OpenCode metadata belongs to another location. Nothing was sent.".into());
    }
    Ok(())
}

/// Preserve editable local drafts while bounding all explicitly attachable plain text.
pub(super) fn validate_draft(draft: &AssistantDraft) -> Result<(), String> {
    if draft.message.len() > MAX_MESSAGE_BYTES || draft.context.len() > 4 {
        return Err("Use at most 8,000 UTF-8 bytes per message and four context blocks.".into());
    }
    if draft
        .model
        .as_ref()
        .is_some_and(|model| !allowed_model(model))
    {
        return Err("The selected assistant model is outside the supported free routes.".into());
    }
    for item in &draft.context {
        if item.label.len() > 100 || item.text.len() > 2_000 {
            return Err(
                "Each context block supports at most 100 label bytes and 2,000 plain-text bytes."
                    .into(),
            );
        }
    }
    Ok(())
}

/// Incomplete local drafts may persist, but sending requires explicit text/model and nonempty reviewed context blocks.
pub(super) fn validate_send_draft(draft: &AssistantDraft) -> Result<(), String> {
    validate_draft(draft)?;
    if draft.message.trim().is_empty() || draft.model.is_none() {
        return Err(
            "Enter a message and explicitly select an available free model before sending.".into(),
        );
    }
    if draft
        .context
        .iter()
        .any(|item| item.label.trim().is_empty() || item.text.trim().is_empty())
    {
        return Err("Complete or remove empty context blocks before reviewing and sending.".into());
    }
    Ok(())
}

/// Compose the exact application text for preview; earlier approved provider history is disclosed separately by the UI.
pub(super) fn preview(draft: &AssistantDraft) -> Result<AssistantPreview, String> {
    validate_draft(draft)?;
    let mut text = draft.message.clone();
    for item in &draft.context {
        text.push_str(&format!("\n\n---\n[{}]\n{}", item.label, item.text));
    }
    if text.len() > MAX_PROMPT_BYTES {
        return Err("The composed assistant prompt exceeds 20,000 UTF-8 bytes.".into());
    }
    Ok(AssistantPreview {
        sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
        text,
    })
}

/// Provider IDs are native observations and never path segments supplied by a renderer.
pub(super) fn provider_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() > prefix.len()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}
