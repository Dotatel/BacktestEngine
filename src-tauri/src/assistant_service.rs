//! Proposal-only send orchestration over injected existing-service transport; never execute an answer or retry a prompt.
use super::{
    cli::{ApiCall, AssistantTransport},
    contract::*,
    policy, response,
    store::{self, StoredConversation},
    AssistantState,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

/// Preflight, admit one known user ID, await its own answer, and durably preserve failures/drafts/cancellation state.
pub(super) async fn send(
    state: &AssistantState,
    mut record: StoredConversation,
    transport: &dyn AssistantTransport,
    directory: &Path,
    cancel: &AtomicBool,
) -> Result<AssistantSendResult, String> {
    let attempt = tokio::time::timeout(
        Duration::from_secs(120),
        send_once(state, &mut record, transport, directory, cancel),
    )
    .await;
    match attempt {
        Ok(Ok(answer)) => complete(state, record, answer),
        Ok(Err(problem)) => {
            let status = if cancel.load(Ordering::SeqCst) {
                "cancelled"
            } else {
                "failed"
            };
            failed(state, record, transport, directory, status, problem).await
        }
        Err(_) => {
            failed(
                state,
                record,
                transport,
                directory,
                "timeout",
                "The assistant send exceeded 120 seconds. No retry or fallback was selected."
                    .into(),
            )
            .await
        }
    }
}

/// Recheck the exact registered agent and fresh zero-cost model before every send, including a conversation continuation.
async fn send_once(
    state: &AssistantState,
    record: &mut StoredConversation,
    transport: &dyn AssistantTransport,
    directory: &Path,
    cancel: &AtomicBool,
) -> Result<response::Answer, String> {
    let model = record
        .draft
        .model
        .clone()
        .ok_or("Explicitly choose a supported free model.")?;
    let models = transport.call(ApiCall::Models, cancel).await?;
    policy::require_free_model(&models, &model, directory)?;
    let registered = transport.call(ApiCall::Agent, cancel).await?;
    policy::verify_agent(&registered, directory)?;
    ensure_session(state, record, transport, directory, &model, cancel).await?;
    let session = record
        .session
        .as_ref()
        .ok_or("The owned assistant session is unavailable.")?
        .id
        .clone();
    let verified = transport
        .call(ApiCall::Session(session.clone()), cancel)
        .await?;
    policy::verify_session(&verified, &session, &record.id, &model, directory)?;
    if cancel.load(Ordering::SeqCst) {
        return Err("Assistant request cancelled before prompt admission.".into());
    }
    let preview = policy::preview(&record.draft)?;
    let user_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    record.pending = Some(store::PendingSend {
        message_id: user_id.clone(),
        started_at: chrono::Utc::now().to_rfc3339(),
        admission: store::Admission::Unknown,
    });
    record.messages.push(AssistantMessage {
        id: user_id.clone(),
        role: "user".into(),
        text: preview.text.clone(),
        status: "pending".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        model: model.clone(),
    });
    if record.title == "New conversation" {
        record.title = record.draft.message.chars().take(40).collect();
    }
    save_record(state, record)?;
    let admitted=transport.call(ApiCall::Prompt(session.clone(),json!({"id":user_id,"text":preview.text,"files":[],"agents":[],"skills":[],"delivery":"steer"})),cancel).await;
    let admitted = match admitted {
        Ok(value) => value,
        Err(error) => {
            if !error.may_have_dispatched {
                record
                    .pending
                    .as_mut()
                    .ok_or("The pending input disappeared.")?
                    .admission = store::Admission::NotDispatched;
            }
            return Err(error.message);
        }
    };
    verify_admission(&admitted, &session, &user_id, &preview.text)?;
    record
        .pending
        .as_mut()
        .ok_or("The pending input disappeared.")?
        .admission = store::Admission::Confirmed;
    save_record(state, record)?;
    poll_answer(transport, &session, &user_id, &model, cancel).await
}

/// Only host-created sessions with an ownership marker and the exact agent/model/location/deny-all rules can be retained.
async fn ensure_session(
    state: &AssistantState,
    record: &mut StoredConversation,
    transport: &dyn AssistantTransport,
    directory: &Path,
    model: &AssistantModelRef,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if let Some(session) = &record.session {
        if &session.model != model {
            return Err(
                "Start a new conversation to change its selected model. No fallback was selected."
                    .into(),
            );
        }
        return Ok(());
    }
    let created=transport.call(ApiCall::Create(json!({"title":"BacktestEngine proposal assistant","agent":policy::AGENT_ID,"model":{"providerID":model.provider_id,"id":model.id},"permissions":policy::deny_all(),"location":{"directory":directory},"metadata":{"ownedBy":policy::OWNER,"conversationId":record.id}})),cancel).await?;
    let session = created.get("data").unwrap_or(&created);
    let id = session["id"]
        .as_str()
        .filter(|id| policy::provider_id(id, "ses_"))
        .ok_or("OpenCode did not return an owned session identity; no prompt was sent.")?
        .to_string();
    policy::verify_session(&created, &id, &record.id, model, directory)?;
    record.session = Some(store::ProviderSession {
        id,
        model: model.clone(),
    });
    save_record(state, record)
}

/// The acknowledged InboxUser must match the native-generated ID/session; ambiguous calls are never retried.
fn verify_admission(payload: &Value, session: &str, user: &str, text: &str) -> Result<(), String> {
    let admitted = payload.get("data").unwrap_or(payload);
    if admitted["id"] != user
        || admitted["sessionID"] != session
        || admitted["type"] != "user"
        || admitted["delivery"] != "steer"
        || admitted["payload"]["text"] != text
        || !empty_attachments(&admitted["payload"])
    {
        return Err("OpenCode did not confirm the exact reviewed user input. It was not resent; owned cancellation is required.".into());
    }
    Ok(())
}

/// A text-only acknowledgement may omit empty attachment arrays but must never add attachments or malformed values.
fn empty_attachments(payload: &Value) -> bool {
    ["files", "agents", "skills"].iter().all(|key| {
        payload
            .get(key)
            .is_none_or(|value| value.as_array().is_some_and(Vec::is_empty))
    })
}

/// Poll only this app's latest bounded timeline and require the exact user boundary plus a successful idle marker.
async fn poll_answer(
    transport: &dyn AssistantTransport,
    session: &str,
    user: &str,
    model: &AssistantModelRef,
    cancel: &AtomicBool,
) -> Result<response::Answer, String> {
    loop {
        let mut timeline = transport
            .call(ApiCall::Messages(session.into()), cancel)
            .await?;
        let entries = timeline
            .get_mut("data")
            .and_then(Value::as_array_mut)
            .ok_or("OpenCode did not return a valid assistant timeline.")?;
        entries.reverse();
        if let Some(answer) = response::answer(&timeline, user, model)? {
            return Ok(answer);
        }
        tokio::select! {()=tokio::time::sleep(Duration::from_millis(750))=>{},()=super::cli::cancelled(cancel)=>return Err("Assistant request cancelled.".into())}
    }
}

/// Persist the actual answer only after a verified idle boundary; clearing the draft happens only on success.
fn complete(
    state: &AssistantState,
    mut record: StoredConversation,
    answer: response::Answer,
) -> Result<AssistantSendResult, String> {
    let model = record
        .draft
        .model
        .clone()
        .ok_or("The selected assistant model is unavailable.")?;
    set_user_status(&mut record, "completed");
    record.messages.push(AssistantMessage {
        id: answer.id,
        role: "assistant".into(),
        text: answer.text,
        status: "completed".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        model,
    });
    record.pending = None;
    record.draft.message.clear();
    record.draft.context.clear();
    save_record(state, &mut record)?;
    Ok(AssistantSendResult {
        status: "completed".into(),
        conversation: store::public(&record)?,
        cancellation_unconfirmed: false,
        problem: None,
    })
}

/// Failures preserve drafts and history; a provider stop is never claimed merely because a CLI process was killed.
async fn failed(
    state: &AssistantState,
    mut record: StoredConversation,
    transport: &dyn AssistantTransport,
    directory: &Path,
    status: &str,
    problem: String,
) -> Result<AssistantSendResult, String> {
    let stopped = if record.pending.is_some() {
        stop_owned(&record, transport, directory).await.is_ok()
    } else {
        true
    };
    let final_status = if stopped { status } else { "unconfirmed" };
    set_user_status(&mut record, final_status);
    if stopped {
        record.pending = None;
    }
    save_record(state, &mut record)?;
    let problem = if stopped {
        problem
    } else {
        format!("{problem} Provider cancellation could not be confirmed. Another send remains blocked; reconnect and retry cancellation of this conversation.")
    };
    Ok(AssistantSendResult {
        status: final_status.into(),
        conversation: store::public(&record)?,
        cancellation_unconfirmed: !stopped,
        problem: Some(problem),
    })
}

/// Retry cancellation of a durably pending app-owned send after failure/restart; no prompt or model choice occurs.
pub(super) async fn recover_cancel(
    state: &AssistantState,
    mut record: StoredConversation,
    transport: &dyn AssistantTransport,
    directory: &Path,
) -> Result<AssistantSendResult, String> {
    match stop_owned(&record, transport, directory).await {
        Ok(()) => {
            set_user_status(&mut record, "cancelled");
            record.pending = None;
            save_record(state, &mut record)?;
            Ok(AssistantSendResult {
                status: "cancelled".into(),
                conversation: store::public(&record)?,
                cancellation_unconfirmed: false,
                problem: None,
            })
        }
        Err(problem) => Ok(AssistantSendResult {
            status: "unconfirmed".into(),
            conversation: store::public(&record)?,
            cancellation_unconfirmed: true,
            problem: Some(format!(
                "Cancellation remains unconfirmed: {problem} Another send is blocked."
            )),
        }),
    }
}

/// Verify ownership before any mutation, cancel the exact pending inbox item, interrupt without resume, then confirm idle.
async fn stop_owned(
    record: &StoredConversation,
    transport: &dyn AssistantTransport,
    directory: &Path,
) -> Result<(), String> {
    let pending = record
        .pending
        .as_ref()
        .ok_or("No app-owned pending input is available for cancellation.")?;
    if pending.admission == store::Admission::NotDispatched {
        return Ok(());
    }
    let session = record
        .session
        .as_ref()
        .ok_or("The owned provider session is unavailable.")?;
    let cleanup = AtomicBool::new(false);
    let verified = transport
        .call(ApiCall::Session(session.id.clone()), &cleanup)
        .await?;
    policy::verify_owned_session(&verified, &session.id, &record.id, directory)?;
    let admitted = if pending.admission == store::Admission::Confirmed {
        true
    } else {
        let text = pending_user_text(record, &pending.message_id)?;
        observe_admission(transport, &session.id, &pending.message_id, text, &cleanup).await?
    };
    transport
        .call(
            ApiCall::CancelInbox(session.id.clone(), pending.message_id.clone()),
            &cleanup,
        )
        .await?;
    let interrupted = transport
        .call(ApiCall::Interrupt(session.id.clone()), &cleanup)
        .await?;
    if !interrupted.get("data").unwrap_or(&interrupted)["interrupted"].is_boolean() {
        return Err("OpenCode did not confirm an interrupt result.".into());
    }
    let idle = transport
        .call(ApiCall::Wait(session.id.clone()), &cleanup)
        .await?;
    if !idle.is_null() {
        return Err("OpenCode did not confirm the expected idle response. Cancellation remains unconfirmed.".into());
    }
    if !admitted {
        return Err("Prompt admission is still ambiguous. The owned session was interrupted, but a delayed durable input cannot yet be excluded; retry cancellation after the service responds. Another send remains blocked.".into());
    }
    Ok(())
}

/// An ambiguous POST cannot be cleared by an idle/no-op interrupt until its exact input is observed in the service.
async fn observe_admission(
    transport: &dyn AssistantTransport,
    session: &str,
    message: &str,
    text: &str,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    let timeline = transport
        .call(ApiCall::Messages(session.into()), cancel)
        .await?;
    if let Some(input) = pending_input(&timeline, message)? {
        verify_timeline_input(input, text)?;
        return Ok(true);
    }
    let inbox = transport
        .call(ApiCall::Inbox(session.into()), cancel)
        .await?;
    let Some(input) = pending_input(&inbox, message)? else {
        return Ok(false);
    };
    verify_admission(input, session, message, text)?;
    Ok(true)
}

/// Recover reviewed text from the unique durable native user row, never from a subsequently edited draft.
fn pending_user_text<'a>(record: &'a StoredConversation, message: &str) -> Result<&'a str, String> {
    let mut users = record.messages.iter().filter(|entry| entry.id == message);
    let user = users
        .next()
        .ok_or("The saved pending user input is unavailable.")?;
    if user.role != "user" || users.next().is_some() {
        return Err("The saved pending user input has an ambiguous identity.".into());
    }
    Ok(&user.text)
}

/// Select at most one native-known input from a bounded service list; malformed or duplicate evidence cannot unlock a send.
fn pending_input<'a>(payload: &'a Value, message: &str) -> Result<Option<&'a Value>, String> {
    let entries = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or("OpenCode did not return a verifiable owned input list.")?;
    if entries.len() > 100 {
        return Err(
            "The owned provider input list exceeds the cancellation verification bound.".into(),
        );
    }
    let mut matches = entries.iter().filter(|entry| entry["id"] == message);
    let input = matches.next();
    if matches.next().is_some() {
        return Err("The provider returned duplicate pending-input identities.".into());
    }
    Ok(input)
}

/// V2 projected users carry text and attachments in the session-scoped timeline, without a sessionID field.
fn verify_timeline_input(input: &Value, text: &str) -> Result<(), String> {
    if input["type"] != "user"
        || input["text"] != text
        || input
            .pointer("/time/created")
            .and_then(Value::as_f64)
            .is_none()
        || !empty_attachments(input)
    {
        return Err("The provider timeline did not confirm the exact reviewed user input. Cancellation remains unconfirmed.".into());
    }
    Ok(())
}

/// Change only this native-known user's local lifecycle marker, never arbitrary earlier history.
fn set_user_status(record: &mut StoredConversation, status: &str) {
    let pending = record
        .pending
        .as_ref()
        .map(|pending| pending.message_id.clone());
    if let Some(message) = record
        .messages
        .iter_mut()
        .find(|message| Some(&message.id) == pending.as_ref())
    {
        message.status = status.into();
    }
}

/// Advance and save a bounded record atomically; no provider/session raw payload enters the local transcript.
fn save_record(state: &AssistantState, record: &mut StoredConversation) -> Result<(), String> {
    store::advance(record)?;
    state.storage()?.save(record)
}
