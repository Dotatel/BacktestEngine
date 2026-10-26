//! Optional existing-service OpenCode assistant: local drafts, exact text review, verified deny-all and free-only sends.
#[path = "assistant_cli.rs"]
mod cli;
#[path = "assistant_contract.rs"]
mod contract;
#[path = "assistant_policy.rs"]
mod policy;
#[path = "assistant_response.rs"]
mod response;
#[path = "assistant_service.rs"]
mod service;
#[path = "assistant_store.rs"]
mod store;
use cli::{AssistantTransport, CliTransport};
pub use contract::*;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::State;

/// One in-flight app-owned send; the provider session ID stays in validated native storage.
struct ActiveSend {
    conversation_id: String,
    cancel: Arc<AtomicBool>,
}

/// Dedicated local store and registered CLI resolver; nothing depends on the assistant for offline core operation.
pub struct AssistantState {
    store: Mutex<store::AssistantStore>,
    active: Mutex<Option<ActiveSend>>,
    resolve_cli: fn() -> Option<PathBuf>,
}

impl AssistantState {
    /// Supply the existing agent discovery resolver at integration; no parallel CLI discovery or service startup exists here.
    pub fn new(directory: PathBuf, resolve_cli: fn() -> Option<PathBuf>) -> Self {
        Self {
            store: Mutex::new(store::AssistantStore::new(directory)),
            active: Mutex::new(None),
            resolve_cli,
        }
    }

    /// Return a store clone so synchronous filesystem locks never cross provider awaits.
    fn storage(&self) -> Result<store::AssistantStore, String> {
        Ok(self
            .store
            .lock()
            .map_err(|_| "Local assistant storage is busy.")?
            .clone())
    }

    /// Reverify the fixed local profile and use only the registered CLI, never a renderer executable path.
    fn transport(&self) -> Result<CliTransport, String> {
        let executable = (self.resolve_cli)().ok_or(
            "OpenCode Desktop is unavailable. Open it and connect, or continue working offline.",
        )?;
        let directory = self.storage()?.prepare_profile()?;
        Ok(CliTransport {
            executable,
            directory,
        })
    }

    /// All local pending records block a second send, including interrupted-unconfirmed work restored after restart.
    fn has_pending(&self) -> Result<bool, String> {
        Ok(self.pending_conversation()?.is_some())
    }

    /// Resume cancellation on the actual pending local conversation after restart, even when a newer draft also exists.
    fn pending_conversation(&self) -> Result<Option<String>, String> {
        let storage = self.storage()?;
        for entry in storage.list()? {
            if storage.load(&entry.id)?.pending.is_some() {
                return Ok(Some(entry.id));
            }
        }
        Ok(None)
    }
}

/// Clear the local flight after the send future settles; unresolved provider work remains durably blocked by pending state.
struct SendGuard<'a>(&'a AssistantState);
impl Drop for SendGuard<'_> {
    /// Drop only app-local ownership; this never claims that a provider stopped when confirmation failed.
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            active.take();
        }
    }
}

/// User-triggered read-only connection/model check; never creates a provider session or sends a model prompt.
#[tauri::command]
pub async fn assistant_status(state: State<'_, AssistantState>) -> Result<AssistantStatus, String> {
    Ok(match check_status(state.inner()).await {
        Ok(status) => status,
        Err(problem) => AssistantStatus {
            connected: false,
            version: None,
            tools_disabled_verified: false,
            models: Vec::new(),
            problem: Some(problem),
        },
    })
}

/// Check only the existing local service and safe metadata in the isolated app-owned location.
async fn check_status(state: &AssistantState) -> Result<AssistantStatus, String> {
    let transport = state.transport()?;
    let cancel = AtomicBool::new(false);
    let info = transport.call(cli::ApiCall::Info, &cancel).await?;
    let version = info.get("data").unwrap_or(&info)["version"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() < 100)
        .ok_or("OpenCode did not confirm a concrete service version.")?
        .to_string();
    let models = transport.call(cli::ApiCall::Models, &cancel).await?;
    let registered = transport.call(cli::ApiCall::Agent, &cancel).await?;
    policy::verify_agent(&registered, &transport.directory)?;
    Ok(AssistantStatus {
        connected: true,
        version: Some(version),
        tools_disabled_verified: true,
        models: policy::free_offers(&models, &transport.directory)?,
        problem: None,
    })
}

/// Load durable local history/drafts without provider calls or automatic context collection.
#[tauri::command]
pub fn assistant_load(
    state: State<AssistantState>,
    conversation_id: Option<String>,
) -> Result<AssistantSnapshot, String> {
    load_local(state.inner(), conversation_id)
}

/// Read only local owned state; a pending conversation takes precedence over newer unsent drafts after restart.
fn load_local(
    state: &AssistantState,
    conversation_id: Option<String>,
) -> Result<AssistantSnapshot, String> {
    let storage = state.storage()?;
    let conversations = storage.list()?;
    let pending_id = state.pending_conversation()?;
    if pending_id.is_some()
        && conversation_id
            .as_ref()
            .is_some_and(|id| Some(id) != pending_id.as_ref())
    {
        return Err(
            "Confirm cancellation of the pending local conversation before selecting another one."
                .into(),
        );
    }
    let selected_id = pending_id
        .or(conversation_id)
        .or_else(|| conversations.first().map(|entry| entry.id.clone()));
    let selected = selected_id
        .as_deref()
        .map(|id| storage.load(id).and_then(|record| store::public(&record)))
        .transpose()?;
    let pending = state.has_pending()?;
    let running = state
        .active
        .lock()
        .map_err(|_| "Assistant state is busy.")?
        .is_some();
    Ok(AssistantSnapshot {
        conversations,
        selected,
        busy: running || pending,
        cancellation_unconfirmed: pending && !running,
    })
}

/// Allocate only a local app-owned draft; this does not create a provider session.
#[tauri::command]
pub fn assistant_new_conversation(
    state: State<AssistantState>,
) -> Result<AssistantConversation, String> {
    let storage = state
        .store
        .lock()
        .map_err(|_| "Local assistant storage is busy.")?;
    store::public(&storage.create()?)
}

/// Persist one typed draft with optimistic revision protection and return the exact newly composed review text/hash.
#[tauri::command]
pub fn assistant_save_draft(
    state: State<AssistantState>,
    request: AssistantSaveDraft,
) -> Result<AssistantConversation, String> {
    save_local_draft(state.inner(), request)
}

/// Apply a renderer draft through the same optimistic ownership/revision checks exercised by native regression tests.
fn save_local_draft(
    state: &AssistantState,
    request: AssistantSaveDraft,
) -> Result<AssistantConversation, String> {
    let active = state
        .active
        .lock()
        .map_err(|_| "Assistant state is busy.")?;
    if active.is_some() {
        return Err(
            "Wait for the assistant send or cancellation to finish before changing its draft."
                .into(),
        );
    }
    let storage = state
        .store
        .lock()
        .map_err(|_| "Local assistant storage is busy.")?;
    let mut record = storage.load(&request.conversation_id)?;
    if record.revision != request.expected_revision {
        return Err("A newer assistant draft exists. Reload the conversation before saving; your current text remains in the panel.".into());
    }
    if record.pending.is_some() {
        return Err(
            "Confirm cancellation of the previous send before changing this conversation.".into(),
        );
    }
    if record
        .session
        .as_ref()
        .is_some_and(|session| Some(&session.model) != request.draft.model.as_ref())
    {
        return Err(
            "Start a new conversation to change its model. Existing local history was preserved."
                .into(),
        );
    }
    policy::validate_draft(&request.draft)?;
    record.draft = request.draft;
    store::advance(&mut record)?;
    storage.save(&record)?;
    store::public(&record)
}

/// Send one persisted exact preview after native free-model, agent, session, location and no-tools verification.
#[tauri::command]
pub async fn assistant_send(
    state: State<'_, AssistantState>,
    request: AssistantSendRequest,
) -> Result<AssistantSendResult, String> {
    let (record, cancel, _guard) = reserve_send(state.inner(), &request)?;
    let transport = state.transport()?;
    service::send(
        state.inner(),
        record,
        &transport,
        &transport.directory,
        cancel.as_ref(),
    )
    .await
}

/// Reserve the native global latch synchronously before any provider await; no draft bytes enter via the send command.
fn reserve_send<'a>(
    state: &'a AssistantState,
    request: &AssistantSendRequest,
) -> Result<(store::StoredConversation, Arc<AtomicBool>, SendGuard<'a>), String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Assistant state is busy.")?;
    if active.is_some() || state.has_pending()? {
        return Err("The previous assistant send or cancellation is still unresolved. Confirm its stop before sending again.".into());
    }
    let record = state.storage()?.load(&request.conversation_id)?;
    let preview = policy::preview(&record.draft)?;
    if record.revision != request.expected_revision || preview.sha256 != request.preview_sha256 {
        return Err("The assistant draft changed after review. Review the current exact text before sending.".into());
    }
    policy::validate_send_draft(&record.draft)?;
    if record.messages.len() > policy::MAX_MESSAGES - 2 {
        return Err("This conversation reached its 100-message limit. Local history was preserved; start another conversation.".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *active = Some(ActiveSend {
        conversation_id: record.id.clone(),
        cancel: cancel.clone(),
    });
    Ok((record, cancel, SendGuard(state)))
}

/// Request cancellation only for this app's active or durably pending conversation; owner sessions are never addressed.
#[tauri::command]
pub async fn assistant_cancel(
    state: State<'_, AssistantState>,
    conversation_id: String,
) -> Result<AssistantSendResult, String> {
    match reserve_cancel(state.inner(), &conversation_id)? {
        CancelReservation::Settled(record, status) => Ok(AssistantSendResult {
            status: status.into(),
            conversation: store::public(&record)?,
            cancellation_unconfirmed: status == "cancelling",
            problem: None,
        }),
        CancelReservation::Recover(record, _guard) => {
            let transport = state.transport()?;
            service::recover_cancel(state.inner(), record, &transport, &transport.directory).await
        }
    }
}

/// A cancellation either signals the actual in-flight operation, observes an already settled result, or owns recovery.
enum CancelReservation<'a> {
    Settled(store::StoredConversation, &'static str),
    Recover(store::StoredConversation, SendGuard<'a>),
}

/// Reserve cancellation before loading its current record, so an old pending snapshot cannot overwrite a completed answer.
fn reserve_cancel<'a>(
    state: &'a AssistantState,
    id: &str,
) -> Result<CancelReservation<'a>, String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Assistant state is busy.")?;
    let record = state.storage()?.load(id)?;
    if let Some(current) = active.as_ref() {
        if current.conversation_id != id {
            return Err(
                "Another app-owned conversation is sending. Cancel that conversation first.".into(),
            );
        }
        current.cancel.store(true, Ordering::SeqCst);
        return Ok(CancelReservation::Settled(record, "cancelling"));
    }
    if record.pending.is_none() {
        return Ok(CancelReservation::Settled(record, "idle"));
    }
    *active = Some(ActiveSend {
        conversation_id: record.id.clone(),
        cancel: Arc::new(AtomicBool::new(false)),
    });
    Ok(CancelReservation::Recover(record, SendGuard(state)))
}

#[cfg(test)]
#[path = "assistant_tests.rs"]
mod tests;
