//! App-owned, bounded assistant drafts and transcripts; no source/project/data files are read here.
use super::{contract::*, policy};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const MAX_CONVERSATION_BYTES: u64 = 1024 * 1024;

/// Native-only provider binding captured from creation and reverified before any prompt or cancellation.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProviderSession {
    pub id: String,
    pub model: AssistantModelRef,
}

/// A known native-generated inbox ID prevents ambiguous API timeouts from silently resending a prompt.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Admission {
    #[default]
    Unknown,
    Confirmed,
    NotDispatched,
}

/// A known input stays unresolved until acknowledged/observed, or proven never dispatched by the native CLI.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PendingSend {
    pub message_id: String,
    pub started_at: String,
    #[serde(default)]
    pub admission: Admission,
}

/// Private disk schema; provider session IDs cannot be supplied through the public draft contract.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredConversation {
    pub version: u8,
    pub owned_by: String,
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub updated_at: String,
    pub draft: AssistantDraft,
    pub messages: Vec<AssistantMessage>,
    pub session: Option<ProviderSession>,
    pub pending: Option<PendingSend>,
}

/// One host-supplied root contains only assistant records and its isolated no-tools context.
#[derive(Clone)]
pub(super) struct AssistantStore {
    pub directory: PathBuf,
    ownership: Arc<Mutex<Option<fs::File>>>,
}

impl AssistantStore {
    /// Share one lazy Windows storage-ownership handle across this state's clones; another app instance must fail closed.
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            ownership: Arc::new(Mutex::new(None)),
        }
    }

    /// Create only the dedicated app-owned paths after refusing linked ancestors.
    pub fn prepare(&self) -> Result<PathBuf, String> {
        if !self.directory.is_absolute() {
            return Err(
                "Assistant storage must use the host's absolute app-data directory.".into(),
            );
        }
        assert_unredirected(&self.directory)?;
        fs::create_dir_all(self.directory.join("conversations"))
            .map_err(|_| "Local assistant storage could not be created.")?;
        fs::create_dir_all(self.directory.join("context"))
            .map_err(|_| "The isolated assistant context could not be created.")?;
        assert_unredirected(&self.directory)?;
        assert_unredirected(&self.directory.join("conversations"))?;
        assert_unredirected(&self.directory.join("context"))?;
        let directory = self
            .directory
            .canonicalize()
            .map_err(|_| "Local assistant storage is unavailable.")?;
        let mut ownership = self
            .ownership
            .lock()
            .map_err(|_| "Assistant storage ownership is busy.")?;
        if ownership.is_none() {
            let path = directory.join("storage-owner.lock");
            assert_unredirected(&path)?;
            *ownership = Some(open_owner_lock(&path)?);
        }
        Ok(directory)
    }

    /// Load bounded validated local records without touching a provider or accepting arbitrary file paths.
    pub fn load(&self, id: &str) -> Result<StoredConversation, String> {
        let path = self.path(id)?;
        let bytes = read_owned(&path, MAX_CONVERSATION_BYTES)?;
        let record: StoredConversation = serde_json::from_slice(&bytes).map_err(|_| {
            "This local assistant conversation is damaged. The original file was preserved."
        })?;
        validate_record(&record, id)?;
        Ok(record)
    }

    /// Serialize a same-directory temporary file and atomically persist; no older history is silently evicted.
    pub fn save(&self, record: &StoredConversation) -> Result<(), String> {
        validate_record(record, &record.id)?;
        let path = self.path(&record.id)?;
        let bytes = serde_json::to_vec_pretty(record)
            .map_err(|_| "The local conversation could not be serialized.")?;
        if bytes.len() as u64 > MAX_CONVERSATION_BYTES {
            return Err("This conversation reached its 1 MiB local limit. Its existing history was preserved; start another conversation.".into());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(
            path.parent().ok_or("Assistant storage has no parent.")?,
        )
        .map_err(|_| "The conversation could not be staged for saving.")?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| {
                "The conversation could not be saved. Existing local history was preserved."
            })?;
        assert_unredirected(&path)?;
        temporary.persist(&path).map_err(|_| {
            "The conversation could not be replaced. Existing local history was preserved."
        })?;
        Ok(())
    }

    /// List at most 20 validated app-owned conversations; malformed files are not skipped or deleted.
    pub fn list(&self) -> Result<Vec<AssistantHistoryEntry>, String> {
        let directory = self.prepare()?.join("conversations");
        let mut rows = Vec::new();
        for entry in
            fs::read_dir(directory).map_err(|_| "Assistant history could not be listed.")?
        {
            let path = entry
                .map_err(|_| "An assistant history entry is unavailable.")?
                .path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            if rows.len() >= policy::MAX_CONVERSATIONS {
                return Err("Local assistant history exceeds the supported 20 conversations; no records were removed.".into());
            }
            let id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .ok_or("An assistant record has an invalid name.")?;
            let record = self.load(id)?;
            rows.push(AssistantHistoryEntry {
                id: record.id,
                title: record.title,
                updated_at: record.updated_at,
            });
        }
        rows.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(rows)
    }

    /// Allocate a UUID after checking the explicit history limit; creating local drafts performs no network work.
    pub fn create(&self) -> Result<StoredConversation, String> {
        if self.list()?.len() >= policy::MAX_CONVERSATIONS {
            return Err("The 20-conversation limit is reached. Local history was preserved; no conversation was silently removed.".into());
        }
        let record = StoredConversation {
            version: 1,
            owned_by: policy::OWNER.into(),
            id: uuid::Uuid::new_v4().to_string(),
            title: "New conversation".into(),
            revision: 0,
            updated_at: chrono::Utc::now().to_rfc3339(),
            draft: AssistantDraft::default(),
            messages: Vec::new(),
            session: None,
            pending: None,
        };
        self.save(&record)?;
        Ok(record)
    }

    /// Persist a fixed app-owned agent profile, refusing hand-edited drift instead of weakening any global configuration.
    pub fn prepare_profile(&self) -> Result<PathBuf, String> {
        let directory = self.prepare()?.join("context");
        let path = directory.join("opencode.json");
        let expected = policy::agent_config();
        if path.exists() {
            let current: serde_json::Value = serde_json::from_slice(&read_owned(&path, 16 * 1024)?)
                .map_err(|_| "The owned assistant profile is malformed; nothing was sent.")?;
            if current != expected {
                return Err("The owned assistant profile changed. Restore its proposal-only configuration before reconnecting; global settings were not altered.".into());
            }
            return Ok(directory);
        }
        let bytes = serde_json::to_vec_pretty(&expected)
            .map_err(|_| "The assistant profile could not be prepared.")?;
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|_| "The assistant profile could not be staged.")?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "The assistant profile could not be written.")?;
        temporary.persist_noclobber(&path).map_err(|_| {
            "The assistant profile already exists or could not be saved; reconnect to verify it."
        })?;
        Ok(directory)
    }

    /// Native UUIDs are the only filenames; canonical/reparse checks cover existing paths and all ancestors.
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        validate_local_id(id)?;
        let path = self
            .prepare()?
            .join("conversations")
            .join(format!("{id}.json"));
        assert_unredirected(&path)?;
        Ok(path)
    }
}

/// A retained no-sharing Windows file handle prevents two app processes from overwriting the same assistant history.
fn open_owner_lock(path: &Path) -> Result<fs::File, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).share_mode(0).open(path).map_err(|_|"Another app instance owns this assistant history, or its storage is unavailable. Close that instance or use a separate profile; existing files were preserved.".into())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Optional assistant history currently requires Windows process-exclusive storage. Core offline work remains available.".into())
    }
}

/// Project only safe conversation content and a freshly composed outgoing application-text preview.
pub(super) fn public(record: &StoredConversation) -> Result<AssistantConversation, String> {
    Ok(AssistantConversation {
        id: record.id.clone(),
        title: record.title.clone(),
        revision: record.revision,
        updated_at: record.updated_at.clone(),
        draft: record.draft.clone(),
        messages: record.messages.clone(),
        preview: policy::preview(&record.draft)?,
    })
}

/// One bounded monotonic revision invalidates stale previews and asynchronous draft writes.
pub(super) fn advance(record: &mut StoredConversation) -> Result<(), String> {
    record.revision = record
        .revision
        .checked_add(1)
        .ok_or("The local conversation revision limit was reached.")?;
    record.updated_at = chrono::Utc::now().to_rfc3339();
    Ok(())
}

/// Reject traversal, alternative spellings and renderer-created provider IDs at the local file boundary.
pub(super) fn validate_local_id(id: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(id)
        .map_err(|_| "Select a valid app-owned assistant conversation.")?;
    if parsed.to_string() != id {
        return Err("Select a canonical app-owned conversation ID.".into());
    }
    Ok(())
}

/// Stored ownership/schema/field bounds are checked on both read and write; damaged records are never reset silently.
fn validate_record(record: &StoredConversation, id: &str) -> Result<(), String> {
    validate_local_id(id)?;
    if record.version != 1
        || record.owned_by != policy::OWNER
        || record.id != id
        || record.title.len() > 160
        || record.messages.len() > policy::MAX_MESSAGES
    {
        return Err("This local assistant record has unsupported ownership, schema or limits. Its file was preserved.".into());
    }
    policy::validate_draft(&record.draft)?;
    for message in &record.messages {
        validate_message(message)?;
    }
    if let Some(session) = &record.session {
        if !policy::provider_id(&session.id, "ses_") || !policy::allowed_model(&session.model) {
            return Err("The saved provider binding is invalid; nothing was sent.".into());
        }
    }
    if record.pending.as_ref().is_some_and(|pending| {
        !policy::provider_id(&pending.message_id, "msg_") || record.session.is_none()
    }) {
        return Err("The saved pending-send identity is invalid; nothing was sent.".into());
    }
    chrono::DateTime::parse_from_rfc3339(&record.updated_at)
        .map_err(|_| "The local conversation timestamp is invalid.")?;
    Ok(())
}

/// Only user/assistant proposal text and known lifecycle states can enter durable app history.
fn validate_message(message: &AssistantMessage) -> Result<(), String> {
    if !["user", "assistant"].contains(&message.role.as_str())
        || ![
            "pending",
            "completed",
            "failed",
            "cancelled",
            "timeout",
            "unconfirmed",
        ]
        .contains(&message.status.as_str())
        || message.text.len() > policy::MAX_ANSWER_BYTES
        || !policy::allowed_model(&message.model)
        || !policy::provider_id(&message.id, "msg_")
    {
        return Err(
            "A local assistant message exceeds its text, role, identity or model bounds.".into(),
        );
    }
    chrono::DateTime::parse_from_rfc3339(&message.created_at)
        .map_err(|_| "A local assistant message timestamp is invalid.")?;
    Ok(())
}

/// Read a bounded owned local file after checking its complete ancestor chain for links/reparse points.
fn read_owned(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    assert_unredirected(path)?;
    let file =
        fs::File::open(path).map_err(|_| "The local assistant record could not be opened.")?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The local assistant record could not be read.")?;
    if bytes.len() as u64 > limit {
        return Err(
            "The local assistant record exceeds its supported size; it was preserved.".into(),
        );
    }
    Ok(bytes)
}

/// App-owned assistant storage must not traverse a symlink or any Windows reparse ancestor.
pub(super) fn assert_unredirected(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("An assistant storage ancestor is inaccessible.".into()),
        };
        if redirected(&metadata) {
            return Err(
                "Assistant storage is redirected; local writes and provider work were refused."
                    .into(),
            );
        }
    }
    Ok(())
}

/// Windows reparse points include junctions that ordinary symlink checks alone do not cover.
fn redirected(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
