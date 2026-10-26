//! Missing application preferences only; onboarding/theme remain in the existing PreferenceStore.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

const MAX_SETTINGS_BYTES: u64 = 64 * 1024;
pub(crate) const EXTENSION_API_VERSION: &str = "1.0.0";

/// Explicit user opt-in and bounded local dismissal history; enabling never performs a network call.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePreferences {
    pub enabled: bool,
    pub last_successful_check_at: Option<String>,
    pub dismissed_versions: Vec<String>,
}

/// Enablement is bound to the exact imported manifest content approved by the user.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionPreference {
    pub enabled: bool,
    pub manifest_sha256: String,
}

/// Missing-only versioned settings; no duplicate appearance, workspace, onboarding or shortcut state.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    pub version: u8,
    pub default_export_directory: Option<String>,
    pub updates: UpdatePreferences,
    pub extensions: BTreeMap<String, ExtensionPreference>,
}

impl Default for AppSettings {
    /// Offline defaults do not opt into network checks or enable an extension.
    fn default() -> Self {
        Self {
            version: 1,
            default_export_directory: None,
            updates: UpdatePreferences::default(),
            extensions: BTreeMap::new(),
        }
    }
}

impl AppSettings {
    /// Enforce schema/version/length/semantic bounds before trusting or writing a settings document.
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("This application settings version is unsupported.".into());
        }
        if self
            .default_export_directory
            .as_ref()
            .is_some_and(|path| path.is_empty() || path.len() > 2048)
        {
            return Err("The default export folder is invalid.".into());
        }
        if self.updates.dismissed_versions.len() > 50 || self.extensions.len() > 200 {
            return Err("Application settings exceed the supported entry limits.".into());
        }
        for version in &self.updates.dismissed_versions {
            validate_version(version)?;
        }
        if let Some(time) = &self.updates.last_successful_check_at {
            chrono::DateTime::parse_from_rfc3339(time)
                .map_err(|_| "The update timestamp is invalid.")?;
        }
        for (id, entry) in &self.extensions {
            if !valid_extension_id(id) || !valid_sha256(&entry.manifest_sha256) {
                return Err(
                    "An extension setting has an invalid identity or manifest hash.".into(),
                );
            }
        }
        Ok(())
    }
}

/// Serialized host settings store, extension registry and protected report storage locations.
#[derive(Clone)]
pub struct AppSettingsState {
    pub(crate) store: Arc<Mutex<AppSettingsStore>>,
    pub(crate) update_check_running: Arc<AtomicBool>,
    pub(crate) extensions_directory: PathBuf,
    pub(crate) runs_directory: PathBuf,
    pub(crate) resources_directory: PathBuf,
    pub(crate) app_version: String,
}

/// Atomically persisted settings, deliberately separate from onboarding state.
pub struct AppSettingsStore {
    pub path: PathBuf,
}

/// Bundle facts are presence checks, not claims that a runtime passed numerical compatibility tests.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDiagnostics {
    app_version: String,
    platform: &'static str,
    architecture: &'static str,
    settings_path: String,
    extensions_directory: String,
    resource_directory: String,
    engine_bundle_present: bool,
    python_bundle_present: bool,
    extension_api_version: &'static str,
}

/// Missing storage and damaged storage are distinct; corrupt files are preserved for explicit recovery.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    state: &'static str,
    settings: Option<AppSettings>,
    problem: Option<String>,
    recovered_backup_path: Option<String>,
    diagnostics: SettingsDiagnostics,
}

impl AppSettingsStore {
    /// Missing files return offline defaults; malformed, oversized or unsupported content is preserved.
    pub(crate) fn load(&self) -> Result<(bool, AppSettings), String> {
        let file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((false, AppSettings::default()))
            }
            Err(error) => return Err(format!("Application settings could not be read ({error}).")),
        };
        let mut bytes = Vec::new();
        file.take(MAX_SETTINGS_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Application settings could not be read ({error})."))?;
        if bytes.len() as u64 > MAX_SETTINGS_BYTES {
            return Err("Application settings exceed the 64 KiB limit.".into());
        }
        let settings: AppSettings = serde_json::from_slice(&bytes).map_err(|_| {
            "Application settings are damaged. Back up and reset them explicitly in Settings."
                .to_string()
        })?;
        settings.validate()?;
        Ok((true, settings))
    }

    /// Persist a validated same-directory temporary file; a failed write leaves prior settings intact.
    pub(crate) fn save(&self, settings: &AppSettings) -> Result<(), String> {
        settings.validate()?;
        let parent = self
            .path
            .parent()
            .ok_or("Application settings path is invalid.")?;
        fs::create_dir_all(parent).map_err(|error| {
            format!("Application settings folder could not be created ({error}).")
        })?;
        let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_SETTINGS_BYTES {
            return Err("Application settings exceed the 64 KiB limit.".into());
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|error| format!("Application settings could not be written ({error})."))?;
        temporary
            .persist(&self.path)
            .map_err(|error| format!("Application settings could not be replaced ({error})."))?;
        Ok(())
    }

    /// After explicit confirmation, copy damaged bytes to a unique backup before atomic replacement.
    fn recover(&self) -> Result<PathBuf, String> {
        if self.load().is_ok() {
            return Err(
                "Settings are readable. Recovery was canceled to preserve the current document."
                    .into(),
            );
        }
        let backup = self
            .path
            .with_extension(format!("backup-{}.json", uuid::Uuid::new_v4()));
        fs::copy(&self.path, &backup).map_err(|error| {
            format!("Settings backup failed; the original file was preserved ({error}).")
        })?;
        self.save(&AppSettings::default())?;
        Ok(backup)
    }
}

impl AppSettingsState {
    /// Serialize every read-modify-write so concurrent update/extension settings cannot overwrite each other.
    pub(crate) fn change(
        &self,
        mutation: impl FnOnce(&mut AppSettings) -> Result<(), String>,
    ) -> Result<(), String> {
        let store = self
            .store
            .lock()
            .map_err(|_| "Application settings are busy.")?;
        let (_, mut settings) = store.load()?;
        mutation(&mut settings)?;
        store.save(&settings)
    }

    /// Read the current trusted document without silently replacing corruption with defaults.
    pub(crate) fn read(&self) -> Result<AppSettings, String> {
        self.store
            .lock()
            .map_err(|_| "Application settings are busy.")?
            .load()
            .map(|(_, value)| value)
    }

    /// Materialize durable settings and local diagnostic facts, preserving actionable corruption details.
    fn snapshot(&self, backup: Option<PathBuf>) -> Result<SettingsSnapshot, String> {
        let store = self
            .store
            .lock()
            .map_err(|_| "Application settings are busy.")?;
        let loaded = store.load();
        let (state, settings, problem) = match loaded {
            Ok((exists, settings)) => (
                if exists { "ready" } else { "firstRun" },
                Some(settings),
                None,
            ),
            Err(error) => ("corrupt", None, Some(error)),
        };
        Ok(SettingsSnapshot {
            state,
            settings,
            problem,
            recovered_backup_path: backup.map(|path| path.to_string_lossy().into_owned()),
            diagnostics: SettingsDiagnostics {
                app_version: self.app_version.clone(),
                platform: std::env::consts::OS,
                architecture: std::env::consts::ARCH,
                settings_path: store.path.to_string_lossy().into_owned(),
                extensions_directory: self.extensions_directory.to_string_lossy().into_owned(),
                resource_directory: self.resources_directory.to_string_lossy().into_owned(),
                engine_bundle_present: self
                    .resources_directory
                    .join("engine/BacktestEngine.Run.exe")
                    .is_file(),
                python_bundle_present: self
                    .resources_directory
                    .join("runtimes/python/python.exe")
                    .is_file(),
                extension_api_version: EXTENSION_API_VERSION,
            },
        })
    }
}

/// Accept strict SemVer without custom parsing or implicit prefix repair.
pub(crate) fn validate_version(value: &str) -> Result<semver::Version, String> {
    if value.len() > 96 {
        return Err("Version text exceeds the supported limit.".into());
    }
    semver::Version::parse(value).map_err(|_| "A strict semantic version is required.".into())
}

/// Keep extension identifiers bounded and path-free, matching the legacy declarative contract.
pub(crate) fn valid_extension_id(value: &str) -> bool {
    (2..=64).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// A stored enablement binds to one exact SHA-256 receipt.
pub(crate) fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Resolve a chosen existing folder and exclude internal run evidence from export defaults.
pub(crate) fn validate_export_directory(path: &Path, runs: &Path) -> Result<PathBuf, String> {
    let selected = path
        .canonicalize()
        .map_err(|_| "Choose an existing local export folder.")?;
    if !selected.is_dir() {
        return Err("The default export destination must be a folder.".into());
    }
    let forbidden = runs.canonicalize().unwrap_or_else(|_| runs.to_path_buf());
    if path_within(&selected, &forbidden) {
        return Err("Choose an export folder outside the app's internal run storage.".into());
    }
    Ok(selected)
}

/// Compare full Windows components case-insensitively while retaining canonical paths for actual IO.
fn path_within(child: &Path, parent: &Path) -> bool {
    let child = child
        .to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .replace('\\', "/")
        .to_lowercase();
    let parent = parent
        .to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    child == parent || child.starts_with(&format!("{parent}/"))
}

/// Revalidate the default at native save-dialog use; stale/moved folders never silently redirect an export.
pub(crate) fn default_export_directory(
    state: &AppSettingsState,
) -> Result<Option<PathBuf>, String> {
    state
        .read()?
        .default_export_directory
        .map(|path| validate_export_directory(Path::new(&path), &state.runs_directory))
        .transpose()
}

/// Read-only settings access never checks a release endpoint or launches a runtime.
#[tauri::command]
pub fn app_settings_load(state: State<AppSettingsState>) -> Result<SettingsSnapshot, String> {
    state.snapshot(None)
}

/// Persist explicit update consent; enabling is separate from the Check now action.
#[tauri::command]
pub fn app_settings_set_updates(
    enabled: bool,
    state: State<AppSettingsState>,
) -> Result<SettingsSnapshot, String> {
    state.change(|settings| {
        settings.updates.enabled = enabled;
        Ok(())
    })?;
    state.snapshot(None)
}

/// Open the native folder picker only from the explicit settings action, then canonicalize the chosen folder.
#[tauri::command]
pub async fn app_settings_choose_export_directory(
    app: tauri::AppHandle,
    state: State<'_, AppSettingsState>,
) -> Result<Option<SettingsSnapshot>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose default report export folder")
        .pick_folder(move |folder| {
            let _ = sender.send(folder);
        });
    let selected = receiver
        .await
        .map_err(|_| "The folder picker closed unexpectedly.")?;
    let Some(tauri_plugin_dialog::FilePath::Path(path)) = selected else {
        return Ok(None);
    };
    let selected = validate_export_directory(&path, &state.runs_directory)?;
    state.change(|settings| {
        settings.default_export_directory = Some(selected.to_string_lossy().into_owned());
        Ok(())
    })?;
    state.snapshot(None).map(Some)
}

/// Clear only the report export default; actual exports still require the native save dialog.
#[tauri::command]
pub fn app_settings_clear_export_directory(
    state: State<AppSettingsState>,
) -> Result<SettingsSnapshot, String> {
    state.change(|settings| {
        settings.default_export_directory = None;
        Ok(())
    })?;
    state.snapshot(None)
}

/// Explicit recovery preserves a backup and never resets onboarding, appearance or project files.
#[tauri::command]
pub fn app_settings_recover(state: State<AppSettingsState>) -> Result<SettingsSnapshot, String> {
    let backup = state
        .store
        .lock()
        .map_err(|_| "Application settings are busy.")?
        .recover()?;
    state.snapshot(Some(backup))
}

#[cfg(test)]
#[path = "app_settings_tests.rs"]
pub(crate) mod tests;
