//! Real local project filesystem service for the Build workspace.
//!
//! Responsibilities: canonical root selection, project-relative id validation with
//! traversal/reparse-point rejection, the bounded explorer tree, create/rename/move entry
//! operations, documents with content-hash revisions, the durable workspace session store, and
//! C# source collection for the build snapshot. Deletion is not implemented in this milestone.
//! Build tooling lives in [`crate::workspace_build`].

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path, path::PathBuf};

/// Largest document a read or save accepts, keeping editor traffic bounded.
pub const MAX_DOCUMENT_BYTES: u32 = 2 * 1024 * 1024;

/// Largest number of explorer entries (folders plus files) one tree scan returns.
pub const MAX_TREE_ENTRIES: usize = 4000;

/// Largest tree depth a scan descends below the project root.
pub const MAX_TREE_DEPTH: usize = 16;

/// Largest number of open file ids the durable session accepts.
pub const MAX_SESSION_OPEN_FILES: usize = 32;

/// Largest number of parameter presets the durable session accepts.
pub const MAX_SESSION_PRESETS: usize = 200;

/// Largest number of parameter values one preset accepts.
pub const MAX_PRESET_VALUES: usize = 64;

/// Largest accepted path identifier length.
pub const MAX_ID_LENGTH: usize = 400;

/// Largest accepted entry/file name length typed by the user.
pub const MAX_NAME_LENGTH: usize = 120;

/// Directory names treated as generated build caches; never shown or modified.
pub const EXCLUDED_DIRECTORY_NAMES: [&str; 10] = [
    ".git",
    ".vs",
    ".idea",
    "artifacts",
    "testresults",
    "__pycache__",
    "node_modules",
    "packages",
    "bin",
    "obj",
];

/// File name endings shown as editable text files; everything else is hidden from the tree.
const TEXT_EXTENSIONS: [&str; 22] = [
    "bat",
    "cfg",
    "cmd",
    "config",
    "cs",
    "csproj",
    "ini",
    "json",
    "md",
    "props",
    "ps1",
    "py",
    "sln",
    "slnf",
    "targets",
    "toml",
    "txt",
    "xml",
    "yaml",
    "yml",
    "license",
    "gitignore",
];

/// Windows device names that can never be used as file or folder names.
const RESERVED_DEVICE_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// The app-created example strategy; copied verbatim from the retained engine example
/// (`engines/csharp/examples/ExampleStrategy.cs`) so seeded projects compile honestly and
/// stay mechanical without any profitability claim.
pub const EXAMPLE_STRATEGY_TEMPLATE: &str = r#"using cAlgo.API;

namespace cAlgo.Robots
{
    // Mechanical execution example only; it makes no profitability claim.
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class ExampleStrategy : Robot
    {
        [Parameter("Volume Multiplier", DefaultValue = 1)]
        public int VolumeMultiplier { get; set; }
        [Parameter("Hold Ticks", DefaultValue = 100)]
        public int HoldTicks { get; set; }
        private int _ticks;
        private bool _buy = true;
        protected override void OnStart()
        {
            if (VolumeMultiplier < 1 || HoldTicks < 1)
                throw new System.ArgumentException("Example parameters must be positive.");
        }
        protected override void OnTick()
        {
            if (++_ticks % HoldTicks != 0) return;
            foreach (var position in Positions.FindAll("EXAMPLE", SymbolName))
                ClosePosition(position);
            ExecuteMarketOrder(_buy ? TradeType.Buy : TradeType.Sell, SymbolName,
                Symbol.VolumeInUnitsMin * VolumeMultiplier, "EXAMPLE");
            _buy = !_buy;
        }
    }
}
"#;

/// The seeded project readme shown next to the example strategy.
pub const EXAMPLE_PROJECT_README: &str = r#"# Example strategy project

This project was created by the app. It contains the mechanical `ExampleStrategy` robot from
the retained engine examples; the Build workspace compiles its saved C# source through the
preserved engine runner and reports real parameter metadata. No trades or results are claimed
by this template.
"#;

/// Symbols Windows refuses inside file and folder names, including both separators.
const FORBIDDEN_NAME_SYMBOLS: [char; 10] = [':', '\\', '/', '<', '>', '"', '|', '?', '*', '\0'];

/// One project-relative explorer item; identifiers use forward slashes and never escape the root.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub id: String,
    pub name: String,
    pub kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<WorkspaceEntry>>,
}

/// Explorer item classification matching the bridge contract.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Folder,
}

/// A real selected project and its current tree; the root string is display data only.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub root: String,
    pub name: String,
    pub entries: Vec<WorkspaceEntry>,
}

/// Text plus a host-issued content revision used to reject overwriting externally changed files.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocument {
    pub path: String,
    pub content: String,
    pub revision: String,
}

/// A named parameter choice tied to its project and compiled robot.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePreset {
    pub project_root: String,
    pub strategy: String,
    pub name: String,
    pub values: Map<String, Value>,
}

/// Durable view state, independent of source contents and onboarding preferences.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceSession {
    pub last_project: Option<String>,
    pub active_file: Option<String>,
    pub open_files: Vec<String>,
    pub presets: Vec<WorkspacePreset>,
}

impl Default for WorkspaceSession {
    /// Start a session with no project, no documents and no presets.
    fn default() -> Self {
        Self {
            last_project: None,
            active_file: None,
            open_files: Vec::new(),
            presets: Vec::new(),
        }
    }
}

/// On-disk envelope so a later session schema is detected instead of silently accepted.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionFile {
    version: u8,
    session: WorkspaceSession,
}

impl SessionFile {
    /// The current session storage schema version.
    const VERSION: u8 = 1;
}

/// Owns one durable session file; the host mutex serializes all reads and writes.
pub struct SessionStore {
    pub path: PathBuf,
}

/// A canonical, verified project root directory with its user-facing display form.
#[derive(Clone, Debug)]
pub struct ProjectRoot {
    directory: PathBuf,
    display: String,
}

/// Traversal counter keeping one tree scan strictly bounded.
struct ScanBudget {
    remaining_entries: usize,
}

/// Tests whether a file name is an editable text file the workspace exposes.
pub fn is_text_entry(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    match lowered.rsplit_once('.') {
        Some((_stem, extension)) => TEXT_EXTENSIONS.contains(&extension),
        None => {
            let bare = lowered.trim_start_matches('.');
            TEXT_EXTENSIONS.contains(&bare)
        }
    }
}

/// Rejects names Windows itself refuses: traversal, separators, reserved devices, padding.
fn validate_component(name: &str) -> Result<(), String> {
    let has_forbidden_symbol = name
        .chars()
        .any(|symbol| FORBIDDEN_NAME_SYMBOLS.contains(&symbol) || symbol.is_control());
    let stem = name.split('.').next().unwrap_or(name);
    if name.is_empty()
        || name == "."
        || name == ".."
        || has_forbidden_symbol
        || name.trim() != name
        || name.ends_with('.')
        || RESERVED_DEVICE_NAMES.contains(&stem.trim_end().to_ascii_lowercase().as_str())
    {
        return Err(format!(
            "'{name}' is not a usable file or folder name in this workspace."
        ));
    }
    Ok(())
}

/// Validates a project-relative identifier used by documents, explorer entries and moves.
pub fn validate_path_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ID_LENGTH || id.starts_with('/') || id.ends_with('/') {
        return Err(format!("'{id}' is not a valid project-relative path."));
    }
    id.split('/').try_for_each(validate_component)
}

/// Validates a user-typed file or folder name before any filesystem call.
pub fn validate_entry_name(name: &str, kind: EntryKind) -> Result<(), String> {
    if name.is_empty() || name.chars().count() > MAX_NAME_LENGTH {
        return Err("Names must be 1 to 120 characters long.".into());
    }
    validate_component(name)?;
    if kind == EntryKind::File && !is_text_entry(name) {
        return Err(
            "New files must use a workspace-supported text extension such as .cs or .json.".into(),
        );
    }
    Ok(())
}

/// Removes the `\\?\` verbatim prefix so canonical Windows paths stay human-readable.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    PathBuf::from(path.to_string_lossy().replace(r"\\?\", ""))
}

/// Format only an already host-verified canonical project path for public identity metadata.
/// Renderer expectations are compared exactly with ProjectRoot::display, never normalized here.
pub(crate) fn public_project_identity(canonical: &Path) -> String {
    strip_verbatim(canonical.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// Computes the SHA-256 content revision used by document conflict detection.
pub fn content_revision(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

impl ProjectRoot {
    /// Canonicalizes a user-selected folder; non-existent roots and file paths are rejected.
    pub fn open(raw: &str) -> Result<ProjectRoot, String> {
        if raw.trim().is_empty() {
            return Err("Choose a project folder first.".into());
        }
        let raw_path = PathBuf::from(raw.trim());
        if !raw_path.is_dir() {
            return Err(format!("'{raw}' is not an existing project folder."));
        }
        let canonical = fs::canonicalize(&raw_path).map_err(|error| {
            format!("'{raw}' could not be opened ({error}). Check folder access and retry.")
        })?;
        Ok(ProjectRoot {
            display: public_project_identity(&canonical),
            directory: canonical,
        })
    }

    /// Returns the canonical directory that every operation resolves against.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Match an internal host-recorded canonical identity exactly, without opening renderer paths.
    pub(crate) fn matches_canonical_identity(&self, identity: &str) -> bool {
        self.directory.to_string_lossy() == identity
    }

    /// Return the exact host-issued public identity used by WorkspaceProject and result metadata.
    pub fn display(&self) -> &str {
        &self.display
    }

    /// Derives the project display name for the workspace header.
    pub fn name(&self) -> String {
        self.directory
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| self.display.clone())
    }
}

/// Windows reparse-point file attribute (`FILE_ATTRIBUTE_REPARSE_POINT`).
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// Reports whether Windows metadata marks a reparse point (junction or symlink).
#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// Non-Windows fallback; reparse attributes do not exist there.
#[cfg(not(windows))]
fn is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

/// Ensures the deepest existing ancestor of a path rests inside the canonical root and
/// rejects any junction/reparse-point link on the way. This is the hard escape boundary;
/// component metadata checks alone are not an authority claim on Windows.
fn enforce_inside_root(root: &ProjectRoot, path: &Path) -> Result<(), String> {
    let mut verification = path.to_path_buf();
    loop {
        match fs::canonicalize(&verification) {
            Ok(canonical) => {
                if !canonical.starts_with(root.directory()) {
                    return Err(format!(
                        "'{}' points outside the project, which is not allowed.",
                        root.display()
                    ));
                }
                if is_reparse(&fs::symlink_metadata(&canonical).map_err(|error| error.to_string())?)
                {
                    return Err("Symbolic link and junction traversal is not allowed.".into());
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(parent) = verification.parent() else {
                    return Err("The project path could not be verified.".into());
                };
                verification = parent.to_path_buf();
                continue;
            }
            Err(error) => return Err(format!("The path could not be verified ({error}).")),
        }
    }
}

/// One resolved, existence-checked path whose id parts and full location are both known.
struct ResolvedPath {
    defaults_to_root: PathBuf,
    relative_parts: Vec<String>,
}

impl ResolvedPath {
    /// The full path including the final component.
    fn full_path(&self) -> PathBuf {
        self.join_parts(0)
    }

    /// The path of the containing folder of the final component.
    fn parent_path(&self) -> PathBuf {
        self.join_parts(1)
    }

    /// Builds a path skipping the first `parts.len() - skip` leading id parts.
    fn join_parts(&self, skip_from_full: usize) -> PathBuf {
        let mut path = self.defaults_to_root.clone();
        let take_up_to = self.relative_parts.len().saturating_sub(skip_from_full);
        for part in &self.relative_parts[..take_up_to] {
            path.push(part);
        }
        path
    }
}

/// Validates an id against traversal rules; rejects missing paths, reparse points, and
/// path components that are confirmed readable on each component chain walk.
fn resolve_checked(root: &ProjectRoot, id: &str) -> Result<ResolvedPath, String> {
    validate_path_id(id)?;
    let relative_parts: Vec<String> = id.split('/').map(|part| part.to_string()).collect();
    let mut current = root.directory().to_path_buf();
    for relative_part in &relative_parts {
        current.push(relative_part);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("'{id}' is no longer available on disk ({error})."))?;
        if metadata.file_type().is_symlink() || is_reparse(&metadata) {
            return Err(format!(
                "'{id}' passes through a symbolic link or junction, which is not allowed."
            ));
        }
    }
    enforce_inside_root(root, &current)?;
    Ok(ResolvedPath {
        defaults_to_root: root.directory().to_path_buf(),
        relative_parts,
    })
}

/// Confirms a resolved path is an existing directory inside the root; the empty id is the
/// project root itself, which create/move callers legitimately use as a parent.
fn require_directory(root: &ProjectRoot, id: &str) -> Result<ResolvedPath, String> {
    if id.trim().is_empty() && id.chars().all(|symbol| symbol.is_whitespace()) {
        return Ok(ResolvedPath {
            defaults_to_root: root.directory().to_path_buf(),
            relative_parts: Vec::new(),
        });
    }
    let resolved = resolve_checked(root, id)?;
    let metadata = fs::symlink_metadata(resolved.full_path())
        .map_err(|error| format!("'{id}' is no longer available on disk ({error})."))?;
    if !metadata.is_dir() {
        return Err(format!("'{id}' is not a folder."));
    }
    Ok(resolved)
}

/// Rejects destinations inside generated build caches the app owns or regenerates.
fn reject_protected_parent(relative_parts: &[String]) -> Result<(), String> {
    let protected = relative_parts.iter().any(|part| {
        let lowered = part.to_ascii_lowercase();
        EXCLUDED_DIRECTORY_NAMES.contains(&lowered.as_str())
    });
    if protected {
        return Err(
            "That target is inside a generated build cache folder, which cannot be changed.".into(),
        );
    }
    Ok(())
}

/// Atomically replaces a file with a same-directory temporary file; failures retain the original.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir() && !parent.is_symlink())
        .ok_or_else(|| {
            format!(
                "'{}' cannot be written right now.",
                strip_verbatim(path.to_path_buf()).display()
            )
        })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("The file could not be prepared for saving ({error})."))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| {
            format!("The file could not be written. Free some disk space and retry ({error}).")
        })?;
    temporary
        .persist(path)
        .map_err(|error| format!("The file could not replace its previous version ({error})."))?;
    Ok(())
}

/// Reads one editable text document with its host content revision.
pub fn read_document(root: &ProjectRoot, path: &str) -> Result<WorkspaceDocument, String> {
    let resolved = resolve_checked(root, path)?;
    let file_name = path.rsplit('/').next().unwrap_or(path);
    if !is_text_entry(file_name) {
        return Err(format!("'{path}' is not an editable text file."));
    }
    let metadata = fs::metadata(resolved.full_path())
        .map_err(|error| format!("'{path}' is no longer available on disk ({error})."))?;
    if metadata.len() > u64::from(MAX_DOCUMENT_BYTES) {
        return Err(format!(
            "'{path}' is larger than {} MB and cannot be opened.",
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        ));
    }
    let bytes = fs::read(resolved.full_path())
        .map_err(|error| format!("'{path}' could not be read ({error})."))?;
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("'{path}' is not UTF-8 text and cannot be edited."))?;
    let revision = content_revision(content.as_bytes());
    Ok(WorkspaceDocument {
        path: path.to_string(),
        content,
        revision,
    })
}

/// Saves an edited document, rejecting the write when the file changed outside the editor.
///
/// The given revision must still match the on-disk content hash; the returned document carries
/// the fresh revision for the next save. The caller keeps its draft when this returns `Err`.
pub fn save_document(
    root: &ProjectRoot,
    path: &str,
    content: &str,
    revision: &str,
) -> Result<WorkspaceDocument, String> {
    let resolved = resolve_checked(root, path)?;
    if !is_text_entry(path.rsplit('/').next().unwrap_or(path)) {
        return Err(format!("'{path}' is not an editable text file."));
    }
    reject_protected_parent(&resolved.relative_parts[..resolved.relative_parts.len() - 1])?;
    if content.len() > usize::try_from(MAX_DOCUMENT_BYTES).unwrap_or(usize::MAX) {
        return Err("The edited document exceeds the supported file size.".into());
    }
    let current = fs::read(resolved.full_path())
        .map_err(|error| format!("'{path}' could not be read before saving ({error})."))?;
    let current_revision = content_revision(&current);
    if current_revision != revision {
        return Err(format!(
            "'{path}' changed outside the editor. Reload the file to get the new version; your draft is preserved."
        ));
    }
    write_atomic(&resolved.full_path(), content.as_bytes())?;
    Ok(WorkspaceDocument {
        path: path.to_string(),
        content: content.to_string(),
        revision: content_revision(content.as_bytes()),
    })
}

/// Creates a new empty file or folder inside an existing root-scoped folder.
pub fn create_entry(
    root: &ProjectRoot,
    parent: &str,
    name: &str,
    kind: EntryKind,
) -> Result<WorkspaceProject, String> {
    let resolved = require_directory(root, parent)?;
    validate_entry_name(name, kind)?;
    reject_protected_parent(&resolved.relative_parts)?;
    let mut target = resolved.full_path();
    enforce_inside_root(root, &target)?;
    target.push(name);
    match kind {
        EntryKind::File => fs::File::create_new(&target).map(|_| ()).map_err(|error| {
            format!(
                "'{name}' could not be created in {parent} ({error}). Check the name is unused."
            )
        })?,
        EntryKind::Folder => fs::create_dir(&target).map_err(|error| {
            format!(
                "'{name}' could not be created in {parent} ({error}). Check the name is unused."
            )
        })?,
    };
    refresh_project(root)
}

/// Renames an existing entry inside its current parent, rejecting collisions and cache folders.
pub fn rename_entry(
    root: &ProjectRoot,
    path: &str,
    name: &str,
) -> Result<WorkspaceProject, String> {
    let resolved = resolve_checked(root, path)?;
    reject_protected_parent(&resolved.relative_parts)?;
    let current_name = resolved
        .relative_parts
        .last()
        .ok_or_else(|| "Cannot rename the project root.".to_string())?;
    validate_entry_name(name, entry_kind(&resolved.full_path()))?;
    if *current_name == name {
        return refresh_project(root);
    }
    let mut target = resolved.parent_path();
    enforce_inside_root(root, &target)?;
    target.push(name);
    if target.symlink_metadata().is_ok() {
        return Err(format!("'{name}' already exists in its folder."));
    }
    fs::rename(resolved.full_path(), &target)
        .map_err(|error| format!("'{path}' could not be renamed ({error})."))?;
    refresh_project(root)
}

/// Moves an existing entry into another folder, rejecting collisions, ancestors and cache folders.
pub fn move_entry(
    root: &ProjectRoot,
    path: &str,
    parent: &str,
) -> Result<WorkspaceProject, String> {
    let source = resolve_checked(root, path)?;
    reject_protected_parent(&source.relative_parts)?;
    if source.relative_parts.is_empty() {
        return Err("The project root itself cannot be moved.".into());
    }
    let destination = require_directory(root, parent)?;
    reject_protected_parent(&destination.relative_parts)?;
    let destination_directory = fs::canonicalize(destination.full_path())
        .map_err(|error| format!("'{parent}' could not be resolved ({error})."))?;
    enforce_inside_root(root, &destination_directory)?;
    let source_directory = fs::canonicalize(source.parent_path()).map_err(|error| {
        format!("The containing folder of '{path}' could not be resolved ({error}).")
    })?;
    if source_directory == destination_directory {
        return refresh_project(root);
    }
    if destination_directory.starts_with(
        fs::canonicalize(source.full_path())
            .map_err(|error| format!("'{path}' could not be resolved ({error})."))?,
    ) {
        return Err(format!(
            "'{path}' cannot be moved into itself or its own children."
        ));
    }
    let mut target = destination_directory;
    target.push(
        source
            .relative_parts
            .last()
            .ok_or_else(|| "The entry has no name.".to_string())?,
    );
    if target.symlink_metadata().is_ok() {
        return Err(format!(
            "An entry named '{parent}' already contains an item with that name."
        ));
    }
    fs::rename(source.full_path(), &target)
        .map_err(|error| format!("'{path}' could not be moved ({error}). See the app guides; cross-drive copies are not supported."))?;
    refresh_project(root)
}

/// Classifies a resolved path by looking at its metadata.
fn entry_kind(path: &Path) -> EntryKind {
    if path.is_dir() && !path.is_symlink() {
        EntryKind::Folder
    } else {
        EntryKind::File
    }
}

/// Validates a stored session against the bridge contract limits.
fn validate_session(session: &WorkspaceSession) -> Result<(), String> {
    if let Some(project) = &session.last_project {
        if project.trim().is_empty() || project.len() > MAX_ID_LENGTH * 2 {
            return Err("The stored last project must be a usable folder path.".into());
        }
    }
    if let Some(active) = &session.active_file {
        validate_path_id(active)?;
    }
    if session.open_files.len() > MAX_SESSION_OPEN_FILES {
        return Err("The session lists too many open files.".into());
    }
    session
        .open_files
        .iter()
        .try_for_each(|path| validate_path_id(path))?;
    if session.presets.len() > MAX_SESSION_PRESETS {
        return Err("The session lists too many presets.".into());
    }
    session.presets.iter().try_for_each(validate_preset)
}

/// Validates one stored preset: a labeled choice scoped by project and strategy name.
fn validate_preset(preset: &WorkspacePreset) -> Result<(), String> {
    if preset.project_root.trim().is_empty()
        || preset.strategy.trim().is_empty()
        || preset.name.trim().is_empty()
    {
        return Err("Presets require a project, a strategy and a preset name.".into());
    }
    if preset.project_root.len() > MAX_ID_LENGTH * 2
        || preset.strategy.chars().count() > MAX_NAME_LENGTH * 2
        || preset.name.chars().count() > MAX_NAME_LENGTH
    {
        return Err(
            "A stored preset references an unusably long project, strategy or name.".into(),
        );
    }
    if preset.values.len() > MAX_PRESET_VALUES {
        return Err("A preset lists too many parameter values.".into());
    }
    Ok(())
}

impl SessionStore {
    /// Loads validated state; a missing file means a first launch.
    pub fn load(&self) -> Result<WorkspaceSession, String> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WorkspaceSession::default());
            }
            Err(_) => {
                return Err(
                    "The workspace session could not be read. Check access to the app settings folder and retry."
                        .into(),
                )
            }
        };
        let file: SessionFile = serde_json::from_slice(&bytes).map_err(|_| {
            "The workspace session file is damaged. It must be recovered before it can be used again."
                .to_string()
        })?;
        if file.version != SessionFile::VERSION {
            return Err("The workspace session uses an unsupported version.".into());
        }
        validate_session(&file.session)?;
        Ok(file.session)
    }

    /// Atomically replaces validated session state using the established temp-file pattern.
    pub fn save(&self, session: &WorkspaceSession) -> Result<(), String> {
        validate_session(session)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("The app settings folder cannot be created ({error})."))?;
        }
        let payload = SessionFile {
            version: SessionFile::VERSION,
            session: session.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&payload).map_err(|error| {
            format!("The workspace session could not be prepared for saving ({error}).")
        })?;
        write_atomic(&self.path, &bytes)
    }
}

/// Refreshes the real bounded project tree for an already-open root.
pub fn refresh_project(root: &ProjectRoot) -> Result<WorkspaceProject, String> {
    let mut budget = ScanBudget {
        remaining_entries: MAX_TREE_ENTRIES,
    };
    let entries = scan_root_directory(root, &mut budget)?;
    Ok(WorkspaceProject {
        root: root.display().to_string(),
        name: root.name(),
        entries,
    })
}

/// Scans all top-level entries of the project root for the explorer tree.
fn scan_root_directory(
    root: &ProjectRoot,
    budget: &mut ScanBudget,
) -> Result<Vec<WorkspaceEntry>, String> {
    let read = fs::read_dir(root.directory())
        .map_err(|error| format!("The project folder could not be read ({error})."))?;
    let mut directories: Vec<(String, PathBuf)> = Vec::new();
    let mut files: Vec<WorkspaceEntry> = Vec::new();
    for entry in read.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() || is_reparse(&metadata) {
            continue;
        }
        if metadata.is_dir() {
            directories.push((name, path));
        } else if is_text_entry(&name) {
            files.push(WorkspaceEntry {
                id: name.clone(),
                name,
                kind: EntryKind::File,
                children: None,
            });
        }
    }
    directories.sort_by_key(|(name, _)| name.to_ascii_lowercase());
    files.sort_by_key(|entry| entry.name.to_ascii_lowercase());
    let mut children = Vec::new();
    for (name, path) in directories {
        append_scanned_directory(&name, path, &mut children, budget);
    }
    for entry in files {
        if budget.remaining_entries == 0 {
            break;
        }
        budget.remaining_entries -= 1;
        children.push(entry);
    }
    Ok(children)
}

/// Appends one scanned top-level directory, pruning generated cache folders outright.
fn append_scanned_directory(
    name: &str,
    path: PathBuf,
    children: &mut Vec<WorkspaceEntry>,
    budget: &mut ScanBudget,
) {
    if EXCLUDED_DIRECTORY_NAMES.contains(&name.to_ascii_lowercase().as_str()) {
        return;
    }
    if let Some(child) = scan_directory(&path, name, 1, budget) {
        budget.remaining_entries -= 1;
        children.push(child);
    }
}

/// Scans one nested directory, listing folders first, honoring the exclusions and budget.
fn scan_directory(
    full: &Path,
    dir_id: &str,
    depth: usize,
    budget: &mut ScanBudget,
) -> Option<WorkspaceEntry> {
    if depth > MAX_TREE_DEPTH || budget.remaining_entries == 0 {
        return None;
    }
    let read = fs::read_dir(full).ok()?;
    let mut directories: Vec<(String, PathBuf)> = Vec::new();
    let mut files: Vec<WorkspaceEntry> = Vec::new();
    for entry in read.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink()
            || is_reparse(&metadata)
            || EXCLUDED_DIRECTORY_NAMES.contains(&name.to_ascii_lowercase().as_str())
        {
            continue;
        }
        if metadata.is_dir() {
            directories.push((name, path));
        } else if is_text_entry(&name) {
            files.push(WorkspaceEntry {
                id: format!("{dir_id}/{name}"),
                name,
                kind: EntryKind::File,
                children: None,
            });
        }
    }
    directories.sort_by_key(|(name, _)| name.to_ascii_lowercase());
    files.sort_by_key(|entry| entry.name.to_ascii_lowercase());
    let mut children = Vec::new();
    for (name, path) in directories {
        if budget.remaining_entries == 0 {
            break;
        }
        let child_id = format!("{dir_id}/{name}");
        if let Some(child) = scan_directory(&path, &child_id, depth + 1, budget) {
            budget.remaining_entries -= 1;
            children.push(child);
        }
    }
    for file in files {
        if budget.remaining_entries == 0 {
            break;
        }
        budget.remaining_entries -= 1;
        children.push(file);
    }
    Some(WorkspaceEntry {
        id: dir_id.to_string(),
        name: dir_id.rsplit('/').next().unwrap_or(dir_id).to_string(),
        kind: EntryKind::Folder,
        children: Some(children),
    })
}

/// Collects the project-relative ids of all C# source files the build snapshot takes as input.
///
/// Returned in sorted id order so generated wrapper artifacts stay deterministic. The same
/// exclusions as the explorer tree apply, so generated `obj`/`bin` copies are skipped, and
/// traversal is depth-bounded like the tree scan.
pub fn collect_source_files(root: &ProjectRoot) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    scan_for_sources(root.directory(), &mut ids, 1);
    ids.sort_by_key(|id| id.to_ascii_lowercase());
    Ok(ids)
}

/// Recursively appends project-relative C# ids within the depth bound, sorted incrementally.
fn scan_for_sources(directory: &Path, ids: &mut Vec<String>, depth: usize) {
    if depth > MAX_TREE_DEPTH {
        return;
    }
    let read = match fs::read_dir(directory) {
        Ok(read) => read,
        Err(_) => return,
    };
    let mut subdirectory_names: Vec<String> = Vec::new();
    for entry in read.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink()
            || is_reparse(&metadata)
            || EXCLUDED_DIRECTORY_NAMES.contains(&name.to_ascii_lowercase().as_str())
        {
            continue;
        }
        if metadata.is_dir() {
            subdirectory_names.push(name);
        } else if name.to_ascii_lowercase().ends_with(".cs") {
            ids.push(name);
        }
    }
    subdirectory_names.sort_by_key(|name| name.to_ascii_lowercase());
    for name in subdirectory_names {
        // Nested ids accumulate one level at a time with their parent prefix.
        let nested_ids_start = ids.len();
        scan_for_sources(&directory.join(&name), ids, depth + 1);
        for id in &mut ids[nested_ids_start..] {
            *id = format!("{name}/{id}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Prepares a real temporary project containing the given relative-id text files.
    fn temp_project(files: &[(&str, &str)]) -> (tempfile::TempDir, ProjectRoot) {
        let base = tempfile::TempDir::with_prefix("bktest-project-").unwrap();
        for (id, content) in files {
            let target = base.path().join(id.replace('/', "\\"));
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&target, content).unwrap();
        }
        let root = ProjectRoot::open(base.path().to_str().unwrap()).unwrap();
        (base, root)
    }

    /// Names Windows itself refuses must fail validation on every entry operation.
    #[test]
    fn name_validation_rejects_unusable_names() {
        for name in [
            "with/slash",
            "with\\slash",
            "with:colon",
            "a<b",
            "a>b",
            "a\"b",
            "a|b",
            "a?b",
            "a*b",
            "..",
            ".",
            "con",
            "NUL",
            "com1",
            "aux",
            "",
            "trail.",
            "trail. ",
            " leading",
            "trailing ",
            "bad\nname",
            "bad\tname",
            "n\0t",
        ] {
            let result = validate_entry_name(name, EntryKind::Folder);
            assert!(
                result.is_err(),
                "'{name}' was accepted but must be rejected."
            );
        }
        for name in ["ok", "ok.cs", "Ok-2_Name.csproj", "README.md"] {
            let kind = if name.contains('.') {
                EntryKind::File
            } else {
                EntryKind::Folder
            };
            assert!(
                validate_entry_name(name, kind).is_ok(),
                "'{name}' was rejected."
            );
        }
    }

    /// New files must be editable text; binary-looking names are refused before any disk call.
    #[test]
    fn file_names_require_a_supported_text_extension() {
        assert!(validate_entry_name("Strategy.cs", EntryKind::File).is_ok());
        assert!(validate_entry_name("README.md", EntryKind::File).is_ok());
        assert!(validate_entry_name("pic.png", EntryKind::File).is_err());
        assert!(validate_entry_name("archive.exe", EntryKind::File).is_err());
        // Binary extensions stay acceptable as folder names.
        assert!(validate_entry_name("bin", EntryKind::File).is_err());
    }

    /// Path ids may never escape the root through traversal, absolute roots or separators.
    #[test]
    fn path_ids_reject_escapes_and_separators() {
        for id in [
            "../other",
            "a/../../b",
            "..\\".trim_end(),
            "a\\b",
            "/abs",
            "a/",
            "",
            "a/.",
        ] {
            let attempt = validate_path_id(id);
            assert!(attempt.is_err(), "id '{id}' escaped validation.");
        }
        for id in ["S.cs", "src/S.cs", "deep/nested/file.json"] {
            assert!(validate_path_id(id).is_ok(), "id '{id}' should be valid.");
        }
    }

    /// Creating entries works at the project root (`parent = ""`) and in nested folders.
    #[test]
    fn create_entry_accepts_root_parent_and_nested_folders() {
        let (_base, root) = temp_project(&[("docs/notes.md", "seed")]);
        create_entry(&root, "", "Strategy.cs", EntryKind::File).unwrap();
        create_entry(&root, "docs", "api.json", EntryKind::File).unwrap();
        create_entry(&root, "", "widgets", EntryKind::Folder).unwrap();
        assert!(root.directory().join("Strategy.cs").is_file());
        assert!(root.directory().join("docs").join("api.json").is_file());
        assert!(root.directory().join("widgets").is_dir());
        let reloaded = refresh_project(&root).unwrap();
        let ids = flatten_ids(&reloaded.entries);
        assert!(ids.contains(&"Strategy.cs".to_string()));
        assert!(ids.contains(&"docs/api.json".to_string()));
        assert!(ids.contains(&"widgets".to_string()));
    }

    /// Aggregates every tree id recursively for assertions.
    fn flatten_ids(entries: &[WorkspaceEntry]) -> Vec<String> {
        let mut ids = Vec::new();
        for entry in entries {
            ids.push(entry.id.clone());
            if let Some(children) = &entry.children {
                ids.extend(flatten_ids(children));
            }
        }
        ids
    }

    /// Duplicate entry creation must fail honestly without touching the existing file.
    #[test]
    fn create_entry_rejects_collisions() {
        let (_base, root) = temp_project(&[("S.cs", "class S {}\n")]);
        let error = create_entry(&root, "", "S.cs", EntryKind::File).unwrap_err();
        assert!(error.contains("could not be created"), "{error}");
        let error = create_entry(&root, "", "S.cs", EntryKind::Folder).unwrap_err();
        assert!(error.contains("could not be created"), "{error}");
        assert!(root.directory().join("S.cs").is_file());
    }

    /// Renaming works within the parent and refuses clobbering an existing sibling.
    #[test]
    fn rename_entry_renames_and_rejects_collisions() {
        let (_base, root) = temp_project(&[("S.cs", "old"), ("T.cs", "target")]);
        rename_entry(&root, "S.cs", "Renamed.cs").unwrap();
        assert!(root.directory().join("Renamed.cs").is_file());
        assert!(!root.directory().join("S.cs").exists());
        let error = rename_entry(&root, "Renamed.cs", "T.cs").unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert!(root.directory().join("Renamed.cs").is_file());
    }

    /// A top-level entry can be moved into a folder and back to the root (`parent = ""`).
    #[test]
    fn move_entry_supports_top_level_moves_in_both_directions() {
        let (_base, root) = temp_project(&[("S.cs", "content"), ("docs/notes.md", "n")]);
        move_entry(&root, "S.cs", "docs").unwrap();
        assert!(root.directory().join("docs").join("S.cs").is_file());
        assert!(!root.directory().join("S.cs").exists());
        move_entry(&root, "docs/S.cs", "").unwrap();
        assert!(root.directory().join("S.cs").is_file());
        assert!(!root.directory().join("docs").join("S.cs").exists());
    }

    /// Moving an entry into its own subtree is refused, as are cache-folder targets.
    #[test]
    fn move_entry_rejects_self_and_protected_targets() {
        let (_base, root) = temp_project(&[("src/S.cs", "c"), ("obj/cache.tmp", "generated")]);
        let error = move_entry(&root, "src", "src/nested-missing").unwrap_err();
        assert!(!error.is_empty());
        // The parent `src/nested-missing` does not exist; creation-by-move is not allowed.
        assert!(root.directory().join("src").join("S.cs").is_file());
        let error = move_entry(&root, "src/S.cs", "obj").unwrap_err();
        assert!(error.contains("generated build cache"), "{error}");
        create_entry(&root, "src", "inner", EntryKind::Folder).unwrap();
        assert!(move_entry(&root, "src", "src/inner").is_err());
        assert!(root.directory().join("src").is_dir());
    }

    /// The project root itself can never be renamed or moved.
    #[test]
    fn move_entry_rejects_the_root() {
        let (_base, root) = temp_project(&[("S.cs", "c")]);
        let error = move_entry(&root, "S.cs/../..", "").unwrap_err();
        assert!(!error.is_empty(), "a traversal id must not move the root.");
        let tree = refresh_project(&root).unwrap();
        assert_eq!(tree.entries.len(), 1);
    }

    /// Documents roundtrip through real files with consistent content hash revisions.
    #[test]
    fn documents_roundtrip_with_content_revisions() {
        let (_base, root) = temp_project(&[("src/S.cs", "class S {}\n")]);
        let document = read_document(&root, "src/S.cs").unwrap();
        assert_eq!(document.content, "class S {}\n");
        assert_eq!(
            document.revision,
            content_revision(document.content.as_bytes())
        );
        let saved = save_document(&root, "src/S.cs", "class S { }\n", &document.revision).unwrap();
        assert_eq!(saved.revision, content_revision("class S { }\n".as_bytes()));
        let reread = read_document(&root, "src/S.cs").unwrap();
        assert_eq!(reread.content, "class S { }\n");
        assert_eq!(reread.revision, saved.revision);
    }

    /// An externally changed file rejects the stale save and keeps the external content.
    #[test]
    fn save_document_rejects_external_change_conflicts() {
        let (_base, root) = temp_project(&[("S.cs", "// original\n")]);
        let document = read_document(&root, "S.cs").unwrap();
        fs::write(root.directory().join("S.cs"), "// changed outside\n").unwrap();
        let error =
            save_document(&root, "S.cs", "// edited draft\n", &document.revision).unwrap_err();
        assert!(error.contains("changed outside the editor"), "{error}");
        assert_eq!(
            fs::read(root.directory().join("S.cs")).unwrap(),
            b"// changed outside\n"
        );
        // The fresh revision of the external content accepts the next save.
        let fresh = read_document(&root, "S.cs").unwrap();
        save_document(&root, "S.cs", "// merged now\n", &fresh.revision).unwrap();
        assert_eq!(
            fs::read(root.directory().join("S.cs")).unwrap(),
            b"// merged now\n"
        );
    }

    /// Saving to generated cache folders is refused even though the file exists there.
    #[test]
    fn save_document_refuses_protected_cache_folders() {
        let (_base, root) = temp_project(&[("obj/generated.cs", "// generated\n")]);
        let revision = content_revision("// generated\n".as_bytes());
        let error = save_document(&root, "obj/generated.cs", "new", &revision).unwrap_err();
        assert!(error.contains("generated build cache"), "{error}");
    }

    /// The durable session roundtrips atomically and validates restored content.
    #[test]
    fn session_store_roundtrip_and_validation() {
        let base = tempfile::TempDir::with_prefix("bktest-session-").unwrap();
        let store = SessionStore {
            path: base.path().join("workspace").join("session.json"),
        };
        assert_eq!(store.load().unwrap(), WorkspaceSession::default());
        let session = WorkspaceSession {
            last_project: Some(r"D:\projects\demo".to_string()),
            active_file: Some("src/S.cs".to_string()),
            open_files: vec!["src/S.cs".to_string(), "README.md".to_string()],
            presets: vec![WorkspacePreset {
                project_root: r"D:\projects\demo".to_string(),
                strategy: "ExampleStrategy".to_string(),
                name: "Default".to_string(),
                values: Map::new(),
            }],
        };
        store.save(&session).unwrap();
        assert_eq!(store.load().unwrap(), session);
        base.close().unwrap();
    }

    /// Damaged stores and out-of-contract payloads are detected, never silently accepted.
    #[test]
    fn session_store_rejects_damaged_or_invalid_content() {
        let base = tempfile::TempDir::with_prefix("bktest-session-bad-").unwrap();
        let store = SessionStore {
            path: base.path().join("session.json"),
        };
        let write_raw = |raw: &str| {
            let mut file = fs::File::create(&store.path).unwrap();
            file.write_all(raw.as_bytes()).unwrap();
        };
        write_raw("{ not json");
        assert!(store.load().is_err());
        write_raw(
            r#"{"version":1,"session":{"lastProject":null,"activeFile":null,"openFiles":[],"presets":[]},"extra":1}"#,
        );
        assert!(
            store.load().is_err(),
            "unknown fields must fail, not be ignored."
        );
        write_raw(
            r#"{"version":99,"session":{"lastProject":null,"activeFile":null,"openFiles":[],"presets":[]}}"#,
        );
        assert!(store.load().is_err(), "a future schema version must fail.");
        write_raw(
            r#"{"version":1,"session":{"lastProject":null,"activeFile":"../escape.cs","openFiles":[],"presets":[]}}"#,
        );
        assert!(store.load().is_err(), "escaping ids must fail validation.");
        // Saving invalid payloads is refused as well.
        let too_many = WorkspaceSession {
            open_files: (0..MAX_SESSION_OPEN_FILES + 1)
                .map(|index| format!("f{index}.cs"))
                .collect(),
            ..WorkspaceSession::default()
        };
        assert!(store.save(&too_many).is_err());
        base.close().unwrap();
    }

    /// The explorer tree skips generated caches and files the workspace cannot edit.
    #[test]
    fn tree_excludes_cache_folders_and_binary_files() {
        let (_base, root) = temp_project(&[
            ("SM.cs", "class SM {}\n"),
            ("README.md", "readme"),
            ("bin/cache.dll", "binary"),
            ("obj/tmp.cs", "generated"),
            ("node_modules/pkg/index.js", "dep"),
            ("assets/pic.png", "binary"),
        ]);
        let project = refresh_project(&root).unwrap();
        let ids = flatten_ids(&project.entries);
        assert!(ids.contains(&"SM.cs".to_string()), "{ids:?}");
        assert!(ids.contains(&"README.md".to_string()), "{ids:?}");
        assert!(ids.iter().all(|id| !id.starts_with("bin/")), "{ids:?}");
        assert!(ids.iter().all(|id| !id.starts_with("obj/")), "{ids:?}");
        assert!(
            ids.iter().all(|id| !id.starts_with("node_modules/")),
            "{ids:?}"
        );
        assert!(ids.iter().all(|id| !id.ends_with("pic.png")), "{ids:?}");
    }

    /// Build snapshots collect every C# file deterministically, sorted, skipping caches.
    #[test]
    fn source_collection_is_sorted_and_excludes_caches() {
        let (_base, root) = temp_project(&[
            ("Zeta.cs", "z"),
            ("Alpha/Second.cs", "s"),
            ("Alpha/First.cs", "f"),
            ("obj/skip.cs", "g"),
        ]);
        let ids = collect_source_files(&root).unwrap();
        assert_eq!(
            ids,
            vec![
                "Alpha/First.cs".to_string(),
                "Alpha/Second.cs".to_string(),
                "Zeta.cs".to_string(),
            ]
        );
    }

    /// Note: `is_text_entry` keeps only workspace-supported text endings visible.
    #[test]
    fn text_entry_filter_matches_documented_endings() {
        for name in [
            "a.cs",
            "a.CS",
            "a.json",
            "a.md",
            "license",
            "gitignore",
            ".gitignore",
        ] {
            assert!(is_text_entry(name), "'{name}' should be visible text.");
        }
        for name in ["a.dll", "a.png", "a.pdb", "a.dll.csproj-asset"] {
            assert!(!is_text_entry(name), "'{name}' should be hidden.");
        }
    }

    /// Junctions and symbolic links never permit leaving the project or shadowing content.
    ///
    /// Windows allows junction creation without elevated rights; symbolically-linked files
    /// usually require developer mode, so that part is skipped when local policy forbids it.
    #[cfg(windows)]
    #[test]
    fn reparse_points_are_rejected_everywhere() {
        let base = tempfile::TempDir::with_prefix("bktest-junction-").unwrap();
        let outside = base.path().join("outside");
        let project = base.path().join("proj");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::write(outside.join("Outside.cs"), "// outside\n").unwrap();
        fs::write(project.join("S.cs"), "class S {}\n").unwrap();
        let root = ProjectRoot::open(project.to_str().unwrap()).unwrap();

        let junction = project.join("link");
        let junction_made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(junction.as_os_str())
            .arg(outside.as_os_str())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if junction_made {
            // The tree never lists the junction.
            let ids = flatten_ids(&refresh_project(&root).unwrap().entries);
            assert!(ids.iter().all(|id| *id != "link"), "{ids:?}");
            // Disks reads, writes and moves through the junction are refused.
            assert!(read_document(&root, "link/Outside.cs").is_err());
            assert!(create_entry(&root, "link", "X.cs", EntryKind::File).is_err());
            assert!(move_entry(&root, "S.cs", "link").is_err());
            assert!(
                fs::read(root.directory().join("S.cs")).is_ok(),
                "root content intact."
            );
        } else {
            eprintln!("skip: junction creation is unavailable on this volume.");
        }

        let symlink = project.join("slink");
        let symlink_made = std::os::windows::fs::symlink_dir(&outside, &symlink)
            .or_else(|_| {
                std::os::windows::fs::symlink_file(
                    outside.join("Outside.cs"),
                    project.join("sfile"),
                )
            })
            .is_ok();
        if symlink_made {
            let ids = flatten_ids(&refresh_project(&root).unwrap().entries);
            assert!(
                ids.iter()
                    .all(|id| !id.starts_with("sli") && !id.starts_with("sf")),
                "{ids:?}"
            );
            assert!(read_document(&root, "slink/Outside.cs").is_err());
        } else {
            eprintln!("skip: symlink creation requires elevated or developer-mode rights.");
        }

        // Clean the links first so the temp-dir cleanup never descends into the target.
        if base.path().exists() {
            let _ = fs::symlink_metadata(project.join("link"))
                .and_then(|_| fs::remove_dir(project.join("link")));
            let _ = fs::symlink_metadata(project.join("slink"))
                .and_then(|_| fs::remove_dir(project.join("slink")));
            let _ = fs::symlink_metadata(project.join("sfile"))
                .and_then(|_| fs::remove_file(project.join("sfile")));
            base.close().unwrap();
        }
    }
}
