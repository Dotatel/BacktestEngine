//! Explicitly synthetic injected-transport tests; these never create real OpenCode sessions or model prompts.
use super::*;
use cli::{ApiCall, AssistantTransport, CallError};
use serde_json::{json, Value};
use std::{future::Future, path::Path, pin::Pin, sync::atomic::AtomicBool};

/// No live resolver is reachable in adapter fixtures.
fn unavailable_cli() -> Option<PathBuf> {
    None
}

/// Return one of the currently permitted free route identifiers without claiming live provider availability.
fn model() -> AssistantModelRef {
    AssistantModelRef {
        provider_id: "opencode".into(),
        id: "glm-5.3-flash-free".into(),
    }
}

/// Set up an isolated local draft and a synthetic existing-service transport.
fn fixture() -> (
    tempfile::TempDir,
    AssistantState,
    store::StoredConversation,
    SyntheticTransport,
) {
    let temporary = tempfile::tempdir().unwrap();
    let state = AssistantState::new(temporary.path().join("assistant"), unavailable_cli);
    let storage = state.storage().unwrap();
    let directory = storage.prepare_profile().unwrap();
    let mut record = storage.create().unwrap();
    record.draft = AssistantDraft {
        message: "Synthetic explicit question".into(),
        context: vec![AssistantContext {
            label: "Synthetic preview".into(),
            text: "UI/adapter fixture only; no trading evidence".into(),
        }],
        model: Some(model()),
    };
    storage.save(&record).unwrap();
    let transport = SyntheticTransport {
        directory,
        conversation_id: record.id.clone(),
        state: Mutex::new(Script::default()),
    };
    (temporary, state, record, transport)
}

/// Only explicit behavior flags are injected; calls are recorded to prove forbidden prompts/interrupts did not occur.
#[derive(Default)]
struct Script {
    calls: Vec<String>,
    user_id: String,
    user_text: String,
    paid: bool,
    deny_agent: bool,
    deny_session: bool,
    fail_prompt: bool,
    fail_interrupt: bool,
    tool: bool,
    foreign_user: bool,
    not_dispatched: bool,
    unobserved_admission: bool,
    changed_payload: bool,
    inbox: Option<Value>,
    timeline_override: Option<Value>,
}

/// Scripted metadata/session responses mirror public V2 schemas and contain no actual provider credentials.
struct SyntheticTransport {
    directory: PathBuf,
    conversation_id: String,
    state: Mutex<Script>,
}

impl AssistantTransport for SyntheticTransport {
    /// Respond synchronously inside a boxed future so tests never spawn a CLI or contact any service.
    fn call<'a>(
        &'a self,
        operation: ApiCall,
        _cancel: &'a AtomicBool,
    ) -> Pin<Box<dyn Future<Output = Result<Value, CallError>> + Send + 'a>> {
        Box::pin(async move {
            let mut script = self.state.lock().unwrap();
            script.calls.push(operation_name(&operation).into());
            match operation {
                ApiCall::Info => Ok(json!({"version":"synthetic-only"})),
                ApiCall::Agent => Ok(agent_payload(&self.directory, script.deny_agent)),
                ApiCall::Models => Ok(model_payload(&self.directory, script.paid)),
                ApiCall::Create(_) | ApiCall::Session(_) => Ok(session_payload(
                    &self.directory,
                    &self.conversation_id,
                    script.deny_session,
                )),
                ApiCall::Prompt(_, body) => {
                    script.user_id = body["id"].as_str().unwrap().into();
                    script.user_text = body["text"].as_str().unwrap().into();
                    if script.fail_prompt {
                        return Err(if script.not_dispatched {
                            CallError::not_dispatched("Synthetic local spawn failure")
                        } else {
                            CallError::ambiguous("Synthetic prompt transport failure")
                        });
                    }
                    let mut payload =
                        json!({"text":body["text"],"files":[],"agents":[],"skills":[]});
                    if script.changed_payload {
                        payload["text"] = json!("Synthetic unreviewed replacement");
                    }
                    Ok(
                        json!({"data":{"id":script.user_id,"sessionID":"ses_synthetic","type":"user","delivery":"steer","payload":payload}}),
                    )
                }
                ApiCall::Messages(_) => {
                    if let Some(timeline) = &script.timeline_override {
                        return Ok(timeline.clone());
                    }
                    if script.unobserved_admission {
                        return Ok(json!({"data":[]}));
                    }
                    Ok(timeline(
                        &script.user_id,
                        &script.user_text,
                        script.tool,
                        script.foreign_user,
                    ))
                }
                ApiCall::Inbox(_) => Ok(script.inbox.clone().unwrap_or_else(|| json!({"data":[]}))),
                ApiCall::CancelInbox(_, _) | ApiCall::Wait(_) => Ok(Value::Null),
                ApiCall::Interrupt(_) => {
                    if script.fail_interrupt {
                        Err(CallError::ambiguous("Synthetic interrupt unavailable"))
                    } else {
                        Ok(json!({"interrupted":true}))
                    }
                }
            }
        })
    }
}

/// Record only stable operation names, never prompt text or sensitive raw API bodies.
fn operation_name(operation: &ApiCall) -> &'static str {
    match operation {
        ApiCall::Info => "info",
        ApiCall::Agent => "agent",
        ApiCall::Models => "models",
        ApiCall::Create(_) => "create",
        ApiCall::Session(_) => "session",
        ApiCall::Prompt(_, _) => "prompt",
        ApiCall::Messages(_) => "messages",
        ApiCall::Inbox(_) => "inbox",
        ApiCall::CancelInbox(_, _) => "cancel-inbox",
        ApiCall::Interrupt(_) => "interrupt",
        ApiCall::Wait(_) => "wait",
    }
}

/// Exact owned-agent fixture; drift introduces an allow rule and must stop before prompt admission.
fn agent_payload(directory: &Path, drift: bool) -> Value {
    let mut agent = policy::agent_config()["agents"][policy::AGENT_ID].clone();
    agent["id"] = json!(policy::AGENT_ID);
    if drift {
        agent["permissions"]
            .as_array_mut()
            .unwrap()
            .push(json!({"action":"read","resource":"*","effect":"allow"}));
    }
    json!({"location":{"directory":directory},"data":agent})
}

/// All required prices exist, including cache reads/writes; paid fixtures differ in one explicit price only.
fn model_payload(directory: &Path, paid: bool) -> Value {
    json!({"location":{"directory":directory},"data":[{"providerID":"opencode","id":model().id,"name":"Synthetic free model","enabled":true,"status":"active","headers":{"Authorization":"SYNTHETIC_NEVER_EXPOSE"},"cost":[{"input":0,"output":if paid{1}else{0},"cache":{"read":0,"write":0}}]}]})
}

/// Session ownership is tied to the exact local UUID, model, no-tools agent and canonical location.
fn session_payload(directory: &Path, conversation: &str, drift: bool) -> Value {
    json!({"data":{"id":"ses_synthetic","agent":policy::AGENT_ID,"model":{"providerID":"opencode","id":model().id},"location":{"directory":directory},"permissions":if drift{json!([])}else{policy::deny_all()},"metadata":{"ownedBy":policy::OWNER,"conversationId":conversation}}})
}

/// Descending provider page includes an old answer; only the exact current user boundary may select the new answer.
fn timeline(user: &str, text: &str, tool: bool, foreign: bool) -> Value {
    let parts = if tool {
        json!([{"type":"tool","name":"synthetic-forbidden"}])
    } else {
        json!([{"type":"reasoning","text":"SYNTHETIC_PRIVATE_REASONING"},{"type":"text","text":"Synthetic proposal only"}])
    };
    let answer = json!({"id":"msg_answer","type":"assistant","agent":policy::AGENT_ID,"model":{"providerID":"opencode","id":model().id},"time":{"created":2,"completed":3},"finish":"stop","cost":0,"content":parts});
    let mut entries = vec![
        json!({"type":"idle","id":"msg_idle","outcome":"succeeded","time":{"created":4}}),
        answer,
    ];
    if foreign {
        entries.push(json!({"id":"msg_foreign","type":"user","text":"Unexpected other user"}));
    }
    entries.push(json!({"id":user,"type":"user","text":text,"time":{"created":1}}));
    entries.push(json!({"id":"msg_old_answer","type":"assistant","content":[{"type":"text","text":"Old answer must not be selected"}]}));
    json!({"data":entries,"cursor":{"next":"older-entries-not-needed-for-this-turn","previous":null}})
}

#[test]
fn exact_rules_and_all_prices_fail_closed_without_projecting_raw_model_fields() {
    let (_temporary, _state, _record, transport) = fixture();
    assert!(policy::exact_deny_all(&policy::deny_all()));
    assert!(!policy::exact_deny_all(&json!([])));
    assert!(!policy::exact_deny_all(
        &json!([{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"ask"}])
    ));
    let valid = model_payload(&transport.directory, false);
    let offer = policy::require_free_model(&valid, &model(), &transport.directory).unwrap();
    assert!(!serde_json::to_string(&offer)
        .unwrap()
        .contains("SYNTHETIC_NEVER_EXPOSE"));
    for pointer in [
        "/data/0/cost/0/input",
        "/data/0/cost/0/output",
        "/data/0/cost/0/cache/read",
        "/data/0/cost/0/cache/write",
    ] {
        let mut broken = valid.clone();
        *broken.pointer_mut(pointer).unwrap() = Value::Null;
        assert!(policy::require_free_model(&broken, &model(), &transport.directory).is_err());
    }
    assert!(policy::require_free_model(
        &model_payload(&transport.directory, true),
        &model(),
        &transport.directory
    )
    .is_err());
    let mut unknown_charge = valid.clone();
    unknown_charge["data"][0]["cost"][0]["futureFee"] = json!(1);
    assert!(policy::require_free_model(&unknown_charge, &model(), &transport.directory).is_err());
}

#[test]
fn composed_registered_agent_requires_universal_deny_and_no_later_allow_or_ask() {
    let deny = json!({"action":"*","resource":"*","effect":"deny"});
    let before = json!({"action":"*","resource":"*","effect":"allow"});
    let plugin = json!({"action":"browser","resource":"*","effect":"deny"});
    assert!(policy::effective_agent_deny_all(&json!([
        before, deny, plugin
    ])));
    assert!(!policy::effective_agent_deny_all(&json!([before, plugin])));
    assert!(policy::effective_agent_deny_all(
        &json!([{"action":"read","resource":"*","effect":"ask"},deny,plugin])
    ));
    for effect in ["allow", "ask", "unexpected"] {
        assert!(!policy::effective_agent_deny_all(
            &json!([deny,{"action":"read","resource":"*","effect":effect}])
        ));
    }
    for malformed in [
        json!({"action":"read","effect":"deny"}),
        json!({"action":"read","resource":"*","effect":"deny","future":"unknown"}),
        json!({"action":true,"resource":"*","effect":"deny"}),
    ] {
        assert!(!policy::effective_agent_deny_all(&json!([malformed, deny])));
    }
    assert!(!policy::exact_deny_all(&json!([before, deny, plugin])));
}

#[test]
fn native_send_latch_rejects_duplicate_launches_before_any_provider_await() {
    let (_temporary, state, record, _transport) = fixture();
    let request = AssistantSendRequest {
        conversation_id: record.id.clone(),
        expected_revision: record.revision,
        preview_sha256: policy::preview(&record.draft).unwrap().sha256,
    };
    let (_, _, guard) = reserve_send(&state, &request).unwrap();
    assert!(reserve_send(&state, &request).is_err());
    drop(guard);
    assert!(state.active.lock().unwrap().is_none());
}

#[test]
fn local_storage_preview_revision_ownership_and_profile_drift_are_preserved() {
    let (_temporary, state, mut record, transport) = fixture();
    let storage = state.storage().unwrap();
    let preview = policy::preview(&record.draft).unwrap();
    assert!(preview.text.contains("Synthetic preview"));
    let request = AssistantSendRequest {
        conversation_id: record.id.clone(),
        expected_revision: record.revision,
        preview_sha256: "0".repeat(64),
    };
    assert!(reserve_send(&state, &request).is_err());
    assert!(storage.load("../../foreign").is_err());
    record.owned_by = "foreign".into();
    assert!(storage.save(&record).is_err());
    assert_eq!(storage.load(&record.id).unwrap().owned_by, policy::OWNER);
    std::fs::write(transport.directory.join("opencode.json"), "{}").unwrap();
    assert!(storage.prepare_profile().is_err());
    assert_eq!(
        std::fs::read_to_string(transport.directory.join("opencode.json")).unwrap(),
        "{}"
    );
}

#[test]
fn draft_saves_allow_incomplete_edits_but_reject_stale_revision_and_send_after_review_change() {
    let (_temporary, state, record, _transport) = fixture();
    let mut draft = record.draft.clone();
    draft.context.push(AssistantContext {
        label: String::new(),
        text: String::new(),
    });
    let saved = save_local_draft(
        &state,
        AssistantSaveDraft {
            conversation_id: record.id.clone(),
            expected_revision: 0,
            draft: draft.clone(),
        },
    )
    .unwrap();
    assert_eq!(saved.revision, 1);
    assert!(save_local_draft(
        &state,
        AssistantSaveDraft {
            conversation_id: record.id.clone(),
            expected_revision: 0,
            draft
        }
    )
    .is_err());
    assert!(policy::validate_send_draft(&saved.draft).is_err());
    let request = AssistantSendRequest {
        conversation_id: record.id,
        expected_revision: 0,
        preview_sha256: policy::preview(&record.draft).unwrap().sha256,
    };
    assert!(reserve_send(&state, &request).is_err());
}

#[test]
fn local_history_caps_and_corruption_preserve_existing_files_without_eviction() {
    let (_temporary, state, record, _transport) = fixture();
    let storage = state.storage().unwrap();
    for _ in 1..policy::MAX_CONVERSATIONS {
        storage.create().unwrap();
    }
    assert!(storage.create().is_err());
    assert_eq!(storage.list().unwrap().len(), 20);
    let path = storage
        .directory
        .join("conversations")
        .join(format!("{}.json", record.id));
    std::fs::write(&path, b"{synthetic broken JSON").unwrap();
    assert!(storage.load(&record.id).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"{synthetic broken JSON");
}

#[test]
fn another_assistant_state_cannot_overwrite_the_same_profile_until_owner_exits() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("assistant");
    let first = AssistantState::new(directory.clone(), unavailable_cli);
    first.storage().unwrap().create().unwrap();
    let second = AssistantState::new(directory, unavailable_cli);
    assert!(second
        .storage()
        .unwrap()
        .list()
        .unwrap_err()
        .contains("Another app instance"));
    drop(first);
    assert_eq!(second.storage().unwrap().list().unwrap().len(), 1);
}

#[test]
fn pending_conversation_is_restored_before_newer_local_drafts_and_never_exposes_provider_id() {
    let (_temporary, state, mut record, _transport) = fixture();
    record.session = Some(store::ProviderSession {
        id: "ses_synthetic".into(),
        model: model(),
    });
    record.pending = Some(store::PendingSend {
        message_id: "msg_pending".into(),
        started_at: chrono::Utc::now().to_rfc3339(),
        admission: store::Admission::Unknown,
    });
    let storage = state.storage().unwrap();
    storage.save(&record).unwrap();
    storage.create().unwrap();
    let snapshot = load_local(&state, None).unwrap();
    assert_eq!(snapshot.selected.as_ref().unwrap().id, record.id);
    assert!(snapshot.cancellation_unconfirmed);
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("ses_synthetic"));
}

#[test]
fn only_fixed_cli_vectors_and_native_session_ids_are_possible() {
    let args = cli::arguments(&ApiCall::Models, "C:/Owned context & name").unwrap();
    assert_eq!(args[0], "api");
    assert!(args[2].contains("location%5Bdirectory%5D=C%3A%2FOwned%20context%20%26%20name"));
    for flag in ["--server", "--password", "--auto", "--standalone"] {
        assert!(!args.iter().any(|arg| arg == flag));
    }
    assert!(cli::arguments(&ApiCall::Session("ses_x/../../owner".into()), "owned").is_err());
    assert!(cli::arguments(
        &ApiCall::CancelInbox("ses_synthetic".into(), "msg_x?other=1".into()),
        "owned"
    )
    .is_err());
    let raw = json!({"conversationId":uuid::Uuid::new_v4().to_string(),"expectedRevision":0,"previewSha256":"a","providerSessionId":"ses_owner"});
    assert!(serde_json::from_value::<AssistantSendRequest>(raw).is_err());
}

#[tokio::test]
async fn send_verifies_policy_before_prompt_and_accepts_only_current_plain_text() {
    let (_temporary, state, record, transport) = fixture();
    let result = service::send(
        &state,
        record,
        &transport,
        &transport.directory,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "completed");
    assert_eq!(
        result.conversation.messages.last().unwrap().text,
        "Synthetic proposal only"
    );
    let serialized = serde_json::to_string(&result).unwrap();
    assert!(!serialized.contains("SYNTHETIC_PRIVATE_REASONING"));
    assert!(!serialized.contains("ses_synthetic"));
    assert!(!serialized.contains("Old answer must not be selected"));
    assert_eq!(
        transport.state.lock().unwrap().calls,
        vec!["models", "agent", "create", "session", "prompt", "messages"]
    );
}

#[tokio::test]
async fn paid_model_and_drifted_agent_stop_before_any_session_or_prompt() {
    let (_temporary, state, record, transport) = fixture();
    transport.state.lock().unwrap().paid = true;
    let result = service::send(
        &state,
        record.clone(),
        &transport,
        &transport.directory,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "failed");
    assert_eq!(result.conversation.draft, record.draft);
    assert!(!transport
        .state
        .lock()
        .unwrap()
        .calls
        .contains(&"prompt".into()));
    let (_temporary, state, record, transport) = fixture();
    transport.state.lock().unwrap().deny_agent = true;
    service::send(
        &state,
        record,
        &transport,
        &transport.directory,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(
        transport.state.lock().unwrap().calls,
        vec!["models", "agent"]
    );
}

#[tokio::test]
async fn continuation_reverifies_deny_all_and_never_prompts_a_drifted_session() {
    let (_temporary, state, mut record, transport) = fixture();
    record.session = Some(store::ProviderSession {
        id: "ses_synthetic".into(),
        model: model(),
    });
    transport.state.lock().unwrap().deny_session = true;
    let result = service::send(
        &state,
        record,
        &transport,
        &transport.directory,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "failed");
    assert_eq!(
        transport.state.lock().unwrap().calls,
        vec!["models", "agent", "session"]
    );
}

#[tokio::test]
async fn unknown_interrupt_preserves_draft_and_blocks_resend_until_owned_idle_confirmation() {
    let (_temporary, state, record, transport) = fixture();
    {
        let mut script = transport.state.lock().unwrap();
        script.fail_prompt = true;
        script.fail_interrupt = true;
    }
    let result = service::send(
        &state,
        record,
        &transport,
        &transport.directory,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "unconfirmed");
    assert!(result.cancellation_unconfirmed);
    let record = state
        .storage()
        .unwrap()
        .load(&result.conversation.id)
        .unwrap();
    assert!(record.pending.is_some());
    assert!(!record.draft.message.is_empty());
    let request = AssistantSendRequest {
        conversation_id: record.id.clone(),
        expected_revision: record.revision,
        preview_sha256: policy::preview(&record.draft).unwrap().sha256,
    };
    assert!(reserve_send(&state, &request).is_err());
    transport.state.lock().unwrap().fail_interrupt = false;
    let result = service::recover_cancel(&state, record, &transport, &transport.directory)
        .await
        .unwrap();
    assert_eq!(result.status, "cancelled");
    assert!(!state.has_pending().unwrap());
    let calls = &transport.state.lock().unwrap().calls;
    assert!(calls
        .windows(3)
        .any(|slice| slice == ["cancel-inbox", "interrupt", "wait"]));
}

#[tokio::test]
async fn ambiguous_prompt_cannot_unlock_on_idle_until_the_exact_input_is_observed() {
    let (_temporary, state, record, transport) = fixture();
    {
        let mut script = transport.state.lock().unwrap();
        script.fail_prompt = true;
        script.unobserved_admission = true;
    }
    let result = service::send(
        &state,
        record,
        &transport,
        &transport.directory,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "unconfirmed");
    assert!(state.has_pending().unwrap());
    assert!(transport
        .state
        .lock()
        .unwrap()
        .calls
        .contains(&"wait".into()));
    let record = state
        .storage()
        .unwrap()
        .load(&result.conversation.id)
        .unwrap();
    transport.state.lock().unwrap().unobserved_admission = false;
    let recovered = service::recover_cancel(&state, record, &transport, &transport.directory)
        .await
        .unwrap();
    assert_eq!(recovered.status, "cancelled");
    assert!(!state.has_pending().unwrap());
}

/// Preserve a synthetic ambiguous POST on disk, then reopen the same exclusive store as a restarted app.
async fn restarted_ambiguous_fixture() -> (
    tempfile::TempDir,
    AssistantState,
    store::StoredConversation,
    SyntheticTransport,
) {
    let (temporary, state, record, transport) = fixture();
    {
        let mut script = transport.state.lock().unwrap();
        script.fail_prompt = true;
        script.unobserved_admission = true;
    }
    let result = service::send(
        &state,
        record,
        &transport,
        &transport.directory,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "unconfirmed");
    let directory = state.storage().unwrap().directory;
    drop(state);
    let restarted = AssistantState::new(directory, unavailable_cli);
    let record = restarted
        .storage()
        .unwrap()
        .load(&result.conversation.id)
        .unwrap();
    assert!(record.pending.is_some());
    (temporary, restarted, record, transport)
}

/// Produce one schema-shaped owned inbox input from the immutable persisted user row, not the current draft.
fn pending_inbox_input(record: &store::StoredConversation) -> Value {
    let pending = record.pending.as_ref().unwrap();
    let user = record
        .messages
        .iter()
        .find(|entry| entry.id == pending.message_id)
        .unwrap();
    json!({"id":pending.message_id,"sessionID":"ses_synthetic","type":"user","delivery":"steer","time":{"created":1},"payload":{"text":user.text,"files":[],"agents":[],"skills":[]}})
}

/// Exercise each malformed or foreign admission against a restarted durable pending record; no transport can launch a CLI.
#[tokio::test]
async fn ambiguous_inbox_rejects_unowned_or_unreviewed_evidence_after_restart() {
    for (path, value) in [
        ("/sessionID", json!("ses_foreign")),
        ("/sessionID", Value::Null),
        ("/type", json!("synthetic")),
        ("/delivery", json!("queued")),
        ("/payload/text", json!("Unreviewed synthetic replacement")),
        ("/payload/files", json!([{"path":"synthetic-forbidden"}])),
        ("/payload/agents", json!([{"id":"synthetic-forbidden"}])),
        ("/payload/skills", json!([{"id":"synthetic-forbidden"}])),
        ("/payload/files", json!("malformed attachments")),
        ("/payload", Value::Null),
    ] {
        let (_temporary, state, record, transport) = restarted_ambiguous_fixture().await;
        let mut input = pending_inbox_input(&record);
        *input.pointer_mut(path).unwrap() = value;
        transport.state.lock().unwrap().inbox = Some(json!({"data":[input]}));
        assert_pending_recovery(&state, record, &transport).await;
    }
}

/// Invalid list shapes, over-limit pages and duplicate IDs never count as proof of a pending input.
#[tokio::test]
async fn ambiguous_recovery_rejects_malformed_or_oversized_service_lists() {
    for payload in [json!({"data":null}), json!({"data":vec![Value::Null;101]})] {
        let (_temporary, state, record, transport) = restarted_ambiguous_fixture().await;
        transport.state.lock().unwrap().inbox = Some(payload);
        assert_pending_recovery(&state, record, &transport).await;
    }
    let (_temporary, state, record, transport) = restarted_ambiguous_fixture().await;
    let input = pending_inbox_input(&record);
    transport.state.lock().unwrap().inbox = Some(json!({"data":[input.clone(),input]}));
    assert_pending_recovery(&state, record, &transport).await;
}

/// Projected V2 users have no sessionID; their known text, attachment emptiness and creation time still require proof.
#[tokio::test]
async fn ambiguous_timeline_rejects_changed_text_attachments_and_malformed_users() {
    for (field, value) in [
        ("text", json!("Unreviewed synthetic replacement")),
        ("files", json!([{"path":"synthetic-forbidden"}])),
        ("time", Value::Null),
        ("type", json!("synthetic")),
    ] {
        let (_temporary, state, record, transport) = restarted_ambiguous_fixture().await;
        let inbox = pending_inbox_input(&record);
        let mut user = json!({"id":inbox["id"],"type":"user","text":inbox["payload"]["text"],"time":{"created":1},"files":[]});
        user[field] = value;
        transport.state.lock().unwrap().timeline_override = Some(json!({"data":[user]}));
        assert_pending_recovery(&state, record, &transport).await;
    }
}

/// Exact inbox evidence permits owned cancellation after restart even if the separately editable draft differs.
#[tokio::test]
async fn exact_owned_inbox_recovers_using_persisted_pending_user_text() {
    let (_temporary, state, mut record, transport) = restarted_ambiguous_fixture().await;
    let input = pending_inbox_input(&record);
    record.draft.message = "A distinct synthetic unsent draft".into();
    state.storage().unwrap().save(&record).unwrap();
    transport.state.lock().unwrap().inbox = Some(json!({"data":[input]}));
    let recovered = service::recover_cancel(&state, record, &transport, &transport.directory)
        .await
        .unwrap();
    assert_eq!(recovered.status, "cancelled");
    assert!(!state.has_pending().unwrap());
    assert_eq!(
        recovered.conversation.draft.message,
        "A distinct synthetic unsent draft"
    );
    let calls = &transport.state.lock().unwrap().calls;
    assert_eq!(calls.iter().filter(|call| *call == "prompt").count(), 1);
    assert_eq!(calls.iter().filter(|call| *call == "create").count(), 1);
    assert!(calls
        .windows(3)
        .any(|slice| slice == ["cancel-inbox", "interrupt", "wait"]));
}

/// An invalid observation preserves durable pending state, reviewed text and the global resend block.
async fn assert_pending_recovery(
    state: &AssistantState,
    record: store::StoredConversation,
    transport: &SyntheticTransport,
) {
    let id = record.id.clone();
    let recovered = service::recover_cancel(state, record, transport, &transport.directory)
        .await
        .unwrap();
    assert_eq!(recovered.status, "unconfirmed");
    assert!(recovered.cancellation_unconfirmed);
    let persisted = state.storage().unwrap().load(&id).unwrap();
    assert!(persisted.pending.is_some());
    let request = AssistantSendRequest {
        conversation_id: id,
        expected_revision: persisted.revision,
        preview_sha256: policy::preview(&persisted.draft).unwrap().sha256,
    };
    assert!(reserve_send(state, &request).is_err());
    assert_eq!(
        transport
            .state
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|call| *call == "prompt")
            .count(),
        1
    );
}

#[tokio::test]
async fn proven_local_prompt_failure_does_not_claim_an_ambiguous_remote_send() {
    let (_temporary, state, record, transport) = fixture();
    {
        let mut script = transport.state.lock().unwrap();
        script.fail_prompt = true;
        script.not_dispatched = true;
    }
    let result = service::send(
        &state,
        record,
        &transport,
        &transport.directory,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "failed");
    assert!(!state.has_pending().unwrap());
    assert!(!transport
        .state
        .lock()
        .unwrap()
        .calls
        .contains(&"interrupt".into()));
}

#[tokio::test]
async fn changed_admission_payload_is_not_accepted_as_the_reviewed_prompt() {
    let (_temporary, state, record, transport) = fixture();
    transport.state.lock().unwrap().changed_payload = true;
    let result = service::send(
        &state,
        record,
        &transport,
        &transport.directory,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "failed");
    assert_eq!(result.conversation.messages.len(), 1);
    assert!(!result.conversation.draft.message.is_empty());
}

#[test]
fn cancellation_reservation_reloads_the_settled_record_instead_of_overwriting_it() {
    let (_temporary, state, mut record, _transport) = fixture();
    record.messages.push(AssistantMessage {
        id: "msg_settled".into(),
        role: "assistant".into(),
        text: "A newer completed proposal".into(),
        status: "completed".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        model: model(),
    });
    store::advance(&mut record).unwrap();
    state.storage().unwrap().save(&record).unwrap();
    let reservation = reserve_cancel(&state, &record.id).unwrap();
    let CancelReservation::Settled(latest, status) = reservation else {
        panic!("An already completed record must not recover stale pending work.")
    };
    assert_eq!(status, "idle");
    assert_eq!(latest.revision, record.revision);
    assert_eq!(
        latest.messages.last().unwrap().text,
        "A newer completed proposal"
    );
}

#[tokio::test]
async fn tool_activity_or_foreign_turn_is_rejected_and_owned_session_is_stopped() {
    for (tool, foreign) in [(true, false), (false, true)] {
        let (_temporary, state, record, transport) = fixture();
        {
            let mut script = transport.state.lock().unwrap();
            script.tool = tool;
            script.foreign_user = foreign;
        }
        let result = service::send(
            &state,
            record,
            &transport,
            &transport.directory,
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        assert_eq!(result.status, "failed");
        assert_eq!(result.conversation.messages.len(), 1);
        assert!(transport
            .state
            .lock()
            .unwrap()
            .calls
            .contains(&"interrupt".into()));
    }
}
