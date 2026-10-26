//! Experimental declarative app-only manifests; no script, native code, filesystem or network execution.

use crate::{
    app_settings::{
        valid_extension_id, valid_sha256, validate_version, AppSettingsState, ExtensionPreference,
        EXTENSION_API_VERSION,
    },
    execution, reports, WorkspaceState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::Path,
};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_EXTENSIONS: usize = 200;

/// Only these trusted report operations may be declared; manifests never register executable handlers.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum ExtensionCommandId {
    #[serde(rename = "report.export-json")]
    Json,
    #[serde(rename = "report.export-csv")]
    Csv,
    #[serde(rename = "report.export-html")]
    Html,
}

impl ExtensionCommandId {
    /// Map a validated declaration to the existing native saved-report exporter.
    fn format(self) -> reports::ReportFormat {
        match self {
            Self::Json => reports::ReportFormat::Json,
            Self::Csv => reports::ReportFormat::TradesCsv,
            Self::Html => reports::ReportFormat::Html,
        }
    }
}

/// Bounded display metadata for a trusted command id.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExtensionCommand {
    id: ExtensionCommandId,
    title: String,
    category: Option<String>,
}

/// The extension API implements only the commands contribution kind.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Contributions {
    commands: Vec<ExtensionCommand>,
}

/// Legacy-compatible app manifest with strict unknown-field rejection; no main/script entry point exists.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtensionManifest {
    id: String,
    name: String,
    version: String,
    api_version: String,
    description: Option<String>,
    #[serde(default)]
    permissions: Vec<String>,
    contributes: Contributions,
}

/// Registry integrity receipt; the original folder is provenance, never an active execution input.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestReceipt {
    version: u8,
    id: String,
    sha256: String,
    imported_at: String,
    original_directory: String,
}

/// One isolated registry entry, including unsupported/tampered manifests without enabling them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppExtension {
    id: String,
    name: String,
    version: Option<String>,
    api_version: Option<String>,
    description: Option<String>,
    manifest_sha256: Option<String>,
    permissions: Vec<String>,
    commands: Vec<ExtensionCommand>,
    compatible: bool,
    enabled: bool,
    issue: Option<String>,
}

/// Explicit owner-clicked command plus reviewed extension and saved-run identities.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionExportRequest {
    extension_id: String,
    manifest_sha256: String,
    command: ExtensionCommandId,
    project_root: String,
    run_id: String,
    report_sha256: String,
}

/// Validate and normalize the bounded manifest without evaluating or importing extension code.
fn parse_manifest(bytes: &[u8]) -> Result<ExtensionManifest, String> {
    let manifest: ExtensionManifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("Unsupported declarative manifest: {error}"))?;
    if !valid_extension_id(&manifest.id) {
        return Err("Extension id must be 2–64 lowercase letters, digits or hyphens, beginning with a letter or digit.".into());
    }
    text_field(&manifest.name, 80, "Extension name")?;
    validate_version(&manifest.version)?;
    let required = validate_version(&manifest.api_version)?;
    let supported = validate_version(EXTENSION_API_VERSION)?;
    if required.major != supported.major || required.cmp_precedence(&supported).is_gt() {
        return Err(format!("This manifest requires API {}; this app provides experimental API {EXTENSION_API_VERSION}.", manifest.api_version));
    }
    if manifest
        .description
        .as_ref()
        .is_some_and(|text| text.chars().count() > 2000)
    {
        return Err("Extension description exceeds 2000 characters.".into());
    }
    if manifest.permissions.len() > 16
        || manifest
            .permissions
            .iter()
            .any(|permission| permission != "commands")
    {
        return Err("Only the declarative commands permission is supported; filesystem and network grants are unavailable.".into());
    }
    if manifest.permissions.len() > 1 {
        return Err("The commands permission must not be duplicated.".into());
    }
    if manifest.contributes.commands.len() > 64 {
        return Err("A manifest may declare at most 64 commands.".into());
    }
    if !manifest.contributes.commands.is_empty()
        && !manifest
            .permissions
            .iter()
            .any(|permission| permission == "commands")
    {
        return Err("Command contributions require the commands permission.".into());
    }
    validate_commands(&manifest.contributes.commands)?;
    Ok(manifest)
}

/// Enforce unique allowlisted ids and bounded plain text for every contribution.
fn validate_commands(commands: &[ExtensionCommand]) -> Result<(), String> {
    let mut ids = BTreeSet::new();
    for command in commands {
        if !ids.insert(command.id) {
            return Err("A command id is declared more than once.".into());
        }
        text_field(&command.title, 120, "Command title")?;
        if let Some(category) = &command.category {
            text_field(category, 80, "Command category")?;
        }
    }
    Ok(())
}

/// Manifest UI text is non-empty and contains no hidden controls.
fn text_field(value: &str, maximum: usize, name: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.chars().count() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "{name} must be visible text of at most {maximum} characters."
        ));
    }
    Ok(())
}

/// Reparse points, symbolic links and cloud placeholders do not establish a local manifest authority.
fn reject_reparse(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|error| format!("Extension path could not be inspected ({error})."))?;
        if metadata.file_type().is_symlink() || windows_reparse(&metadata) {
            return Err("Choose a local extension folder without symbolic links, junctions or reparse points.".into());
        }
    }
    Ok(())
}

/// Windows junction and placeholder flags are checked in addition to Rust's symlink classification.
#[cfg(windows)]
fn windows_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

/// Other hosts still reject symbolic links through the shared path inspection.
#[cfg(not(windows))]
fn windows_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

/// Read only a bounded regular local file, refusing a substituted reparse target.
fn bounded_file(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    reject_reparse(path)?;
    if !path.is_file() {
        return Err("The extension manifest or receipt must be a regular file.".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > maximum {
        return Err("The extension manifest or receipt exceeds its size limit.".into());
    }
    Ok(bytes)
}

/// Atomically create a new registry file; existing manifests and original files are never overwritten.
fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Extension registry path is invalid.")?;
    reject_reparse(parent)?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| format!("Extension registry file could not be created ({error})."))?;
    Ok(())
}

/// Copy only validated manifest bytes into a new app-owned registration, with durable default-disablement.
pub(crate) fn import_folder(
    state: &AppSettingsState,
    source: &Path,
) -> Result<AppExtension, String> {
    reject_reparse(source)?;
    let source = source
        .canonicalize()
        .map_err(|_| "Choose an existing local extension folder.")?;
    if !source.is_dir() || source.to_string_lossy().len() > 2048 {
        return Err("Choose a local folder with a supported path length.".into());
    }
    let bytes = bounded_file(&source.join("manifest.json"), MAX_MANIFEST_BYTES)?;
    let manifest = parse_manifest(&bytes)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    fs::create_dir_all(&state.extensions_directory).map_err(|error| error.to_string())?;
    reject_reparse(&state.extensions_directory)?;
    let destination = state.extensions_directory.join(&manifest.id);
    let store = state
        .store
        .lock()
        .map_err(|_| "Application settings are busy.")?;
    let (_, mut settings) = store.load()?;
    if destination
        .try_exists()
        .map_err(|error| error.to_string())?
    {
        return Err("An extension with this id is already installed. Disable or remove it before importing another copy.".into());
    }
    if settings.extensions.len() >= MAX_EXTENSIONS
        && !settings.extensions.contains_key(&manifest.id)
    {
        return Err("The registry supports at most 200 extension identities.".into());
    }
    settings.extensions.insert(
        manifest.id.clone(),
        ExtensionPreference {
            enabled: false,
            manifest_sha256: hash.clone(),
        },
    );
    store.save(&settings)?;
    fs::create_dir(&destination).map_err(|error| {
        format!("The extension registry folder could not be reserved ({error}).")
    })?;
    let receipt = ManifestReceipt {
        version: 1,
        id: manifest.id.clone(),
        sha256: hash,
        imported_at: chrono::Utc::now().to_rfc3339(),
        original_directory: source.to_string_lossy().into_owned(),
    };
    let write_result = write_registration(&destination, &bytes, &receipt);
    drop(store);
    if let Err(error) = write_result {
        cleanup_new_registration(&destination);
        return Err(error);
    }
    describe(state, &manifest.id)
}

/// Create the manifest and receipt as separate bounded atomic files under the reserved identity.
fn write_registration(
    destination: &Path,
    bytes: &[u8],
    receipt: &ManifestReceipt,
) -> Result<(), String> {
    write_new_file(&destination.join("manifest.json"), bytes)?;
    write_new_file(
        &destination.join("receipt.json"),
        &serde_json::to_vec_pretty(receipt).map_err(|error| error.to_string())?,
    )
}

/// Roll back only two newly created named files and their empty directory; never recurse through a link.
fn cleanup_new_registration(destination: &Path) {
    if reject_reparse(destination).is_err() {
        return;
    }
    let _ = fs::remove_file(destination.join("manifest.json"));
    let _ = fs::remove_file(destination.join("receipt.json"));
    let _ = fs::remove_dir(destination);
}

/// Bind directory identity, receipt and actual manifest bytes before interpreting an installed entry.
fn installed_manifest(
    state: &AppSettingsState,
    id: &str,
) -> Result<(ExtensionManifest, String), String> {
    if !valid_extension_id(id) {
        return Err("The registry entry has an invalid extension id.".into());
    }
    let directory = state.extensions_directory.join(id);
    reject_reparse(&directory)?;
    let canonical = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if canonical.parent()
        != Some(
            state
                .extensions_directory
                .canonicalize()
                .map_err(|error| error.to_string())?
                .as_path(),
        )
    {
        return Err("The extension directory is outside its registry.".into());
    }
    let receipt: ManifestReceipt =
        serde_json::from_slice(&bounded_file(&directory.join("receipt.json"), 8192)?)
            .map_err(|_| "The extension receipt is damaged.")?;
    if receipt.version != 1 || receipt.id != id || !valid_sha256(&receipt.sha256) {
        return Err("The extension receipt identity is invalid.".into());
    }
    let bytes = bounded_file(&directory.join("manifest.json"), MAX_MANIFEST_BYTES)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if hash != receipt.sha256 {
        return Err(
            "The imported manifest changed. Disable it and reimport a reviewed copy.".into(),
        );
    }
    let manifest = parse_manifest(&bytes)?;
    if manifest.id != id {
        return Err("The manifest id does not match its registered directory.".into());
    }
    Ok((manifest, hash))
}

/// Show one supported entry or return its actual validation failure to the isolating registry list.
fn describe(state: &AppSettingsState, id: &str) -> Result<AppExtension, String> {
    let (manifest, hash) = installed_manifest(state, id)?;
    let settings = state.read()?;
    let preference = settings.extensions.get(id);
    let enabled = preference.is_some_and(|entry| entry.enabled && entry.manifest_sha256 == hash);
    let issue = preference
        .filter(|entry| entry.enabled && entry.manifest_sha256 != hash)
        .map(|_| {
            "Enablement belongs to another manifest hash. Disable and review this entry.".into()
        });
    Ok(AppExtension {
        id: manifest.id,
        name: manifest.name,
        version: Some(manifest.version),
        api_version: Some(manifest.api_version),
        description: manifest.description,
        manifest_sha256: Some(hash),
        permissions: manifest.permissions,
        commands: manifest.contributes.commands,
        compatible: issue.is_none(),
        enabled,
        issue,
    })
}

/// Broken entries remain visible and isolated instead of silently disappearing or becoming enabled.
fn isolated(id: &str, issue: String) -> AppExtension {
    let id: String = id
        .chars()
        .filter(|character| !character.is_control())
        .take(96)
        .collect();
    AppExtension {
        name: id.clone(),
        id,
        version: None,
        api_version: None,
        description: None,
        manifest_sha256: None,
        permissions: Vec::new(),
        commands: Vec::new(),
        compatible: false,
        enabled: false,
        issue: Some(issue),
    }
}

/// Enumerate only the bounded app-owned registry; never scan user folders or load executable code.
pub(crate) fn list(state: &AppSettingsState) -> Result<Vec<AppExtension>, String> {
    state.read()?;
    if !state.extensions_directory.exists() {
        return Ok(Vec::new());
    }
    reject_reparse(&state.extensions_directory)?;
    let entries = fs::read_dir(&state.extensions_directory)
        .map_err(|error| error.to_string())?
        .take(MAX_EXTENSIONS + 1)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if entries.len() > MAX_EXTENSIONS {
        return Err("The extension registry exceeds its 200 entry limit.".into());
    }
    let mut result: Vec<_> = entries
        .into_iter()
        .map(|entry| {
            let id = entry.file_name().to_string_lossy().into_owned();
            describe(state, &id).unwrap_or_else(|error| isolated(&id, error))
        })
        .collect();
    result.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(result)
}

/// Bind user enablement to the verified manifest; disabling remains possible for a damaged entry.
pub(crate) fn set_enabled(
    state: &AppSettingsState,
    id: &str,
    expected_hash: Option<&str>,
    enabled: bool,
) -> Result<(), String> {
    if !valid_extension_id(id) {
        return Err("The extension id is invalid.".into());
    }
    if !enabled {
        return state.change(|settings| {
            let entry = settings
                .extensions
                .get_mut(id)
                .ok_or("This extension is not registered.")?;
            entry.enabled = false;
            Ok(())
        });
    }
    let (_, hash) = installed_manifest(state, id)?;
    if expected_hash != Some(hash.as_str()) {
        return Err("The reviewed manifest changed. Refresh Extensions before enabling it.".into());
    }
    state.change(|settings| {
        settings.extensions.insert(
            id.to_string(),
            ExtensionPreference {
                enabled: true,
                manifest_sha256: hash,
            },
        );
        Ok(())
    })
}

/// Recheck enabled state, exact manifest hash and command declaration at each export boundary.
pub(crate) fn authorize_command(
    state: &AppSettingsState,
    id: &str,
    expected_hash: &str,
    command: ExtensionCommandId,
) -> Result<reports::ReportFormat, String> {
    let entry = describe(state, id)?;
    if !entry.enabled || !entry.compatible {
        return Err("This extension is disabled or invalid. Review it in Extensions.".into());
    }
    if entry.manifest_sha256.as_deref() != Some(expected_hash) {
        return Err("The extension manifest changed after review.".into());
    }
    if !entry
        .permissions
        .iter()
        .any(|permission| permission == "commands")
        || !entry.commands.iter().any(|entry| entry.id == command)
    {
        return Err(
            "This trusted report command was not declared with permission by the extension.".into(),
        );
    }
    Ok(command.format())
}

/// Read the current registry without executing any contribution.
#[tauri::command]
pub fn app_extensions_list(state: State<AppSettingsState>) -> Result<Vec<AppExtension>, String> {
    list(state.inner())
}

/// Pick an explicitly selected local folder and copy only its validated manifest into the registry.
#[tauri::command]
pub async fn app_extensions_import(
    app: tauri::AppHandle,
    state: State<'_, AppSettingsState>,
) -> Result<Option<AppExtension>, String> {
    state.read()?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Import experimental declarative app extension")
        .pick_folder(move |folder| {
            let _ = sender.send(folder);
        });
    let selected = receiver
        .await
        .map_err(|_| "The extension folder picker closed unexpectedly.")?;
    let Some(tauri_plugin_dialog::FilePath::Path(path)) = selected else {
        return Ok(None);
    };
    import_folder(state.inner(), &path).map(Some)
}

/// Persist one explicit enable/disable choice, then reread current registry evidence.
#[tauri::command]
pub fn app_extensions_set_enabled(
    id: String,
    manifest_sha256: Option<String>,
    enabled: bool,
    state: State<AppSettingsState>,
) -> Result<Vec<AppExtension>, String> {
    set_enabled(state.inner(), &id, manifest_sha256.as_deref(), enabled)?;
    list(state.inner())
}

/// Only a user-clicked native save dialog can export an enabled extension's selected immutable run.
#[tauri::command]
pub async fn app_extensions_export(
    app: tauri::AppHandle,
    request: ExtensionExportRequest,
    state: State<'_, AppSettingsState>,
    execution_state: State<'_, execution::ExecutionState>,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Option<reports::ReportExportReceipt>, String> {
    let ExtensionExportRequest {
        extension_id,
        manifest_sha256,
        command,
        project_root,
        run_id,
        report_sha256,
    } = request;
    let format = authorize_command(state.inner(), &extension_id, &manifest_sha256, command)?;
    let directory = crate::app_settings::default_export_directory(state.inner())?;
    reports::export_saved_with_guard(
        app,
        reports::SavedReportExport {
            project_root,
            run_id,
            report_sha256,
            format,
        },
        execution_state.inner(),
        workspace_state.inner(),
        directory,
        || authorize_command(state.inner(), &extension_id, &manifest_sha256, command).map(|_| ()),
    )
    .await
}

#[cfg(test)]
#[path = "app_extensions_tests.rs"]
mod tests;
