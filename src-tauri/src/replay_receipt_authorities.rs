//! The original engine reads authority paths unchanged; retained handles prevent mutation on Windows.
use super::{
    digest, ensure_plain_path, file_record, write_frozen, AuthorityEvidence, FrozenReplayReceipt,
};
use crate::market_data::{self, ImportedSymbolSpec, SymbolSpecDependencyManifest};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const MAX_AUTHORITIES: usize = 16;
const MAX_AUTHORITY_BYTES: u64 = 256 * 1024 * 1024;

/// Private original handles remain alive until baseline/rerun descendants have completely exited.
pub(crate) struct AuthorityLocks {
    files: Vec<(fs::File, String)>,
}

impl AuthorityLocks {
    /// Rehash the original opened handles, including platforms where locking cannot enforce exclusion.
    pub(crate) fn verify(&mut self) -> Result<(), String> {
        for (file, expected) in &mut self.files {
            if digest(&read_locked(file)?) != *expected {
                return Err("A locked replay authority changed.".into());
            }
        }
        Ok(())
    }
}

/// Known original C# graph roles; unrelated JSON strings are never interpreted as file references.
#[derive(Clone, Copy)]
enum Role {
    Leaf,
    Commission,
    Swap,
}

/// One declared SHA-256 relationship resolved relative to its unchanged parent authority.
struct PendingAuthority {
    path: PathBuf,
    sha256: String,
    role: Role,
}

/// Check registered root references, discover original C# transitive links, copy bytes and retain locks.
pub(super) fn capture_authorities(
    profile_bytes: &[u8],
    profile: &ImportedSymbolSpec,
    directory: &Path,
) -> Result<(Vec<AuthorityEvidence>, AuthorityLocks), String> {
    let root: Value = serde_json::from_slice(profile_bytes).map_err(|error| error.to_string())?;
    let registration = directory.join("registration");
    let manifest: SymbolSpecDependencyManifest = serde_json::from_slice(
        &market_data::read_limited_bytes(&registration.join("dependencies.json"), 1024 * 1024)?,
    )
    .map_err(|error| error.to_string())?;
    let recorded: ImportedSymbolSpec = serde_json::from_slice(&market_data::read_limited_bytes(
        &registration.join("provenance.json"),
        1024 * 1024,
    )?)
    .map_err(|error| error.to_string())?;
    if manifest.id != profile.id
        || manifest.derived_sha256 != profile.sha256
        || manifest.stored_path != profile.stored_path
        || recorded.id != profile.id
        || recorded.sha256 != profile.sha256
        || recorded.stored_path != profile.stored_path
    {
        return Err("Replay profile registration no longer matches its catalog identity.".into());
    }
    let mut pending = registered_roots(&root, profile, &manifest)?;
    let mut evidence = Vec::new();
    let mut files = Vec::new();
    let mut visited = BTreeMap::new();
    while let Some(item) = pending.pop() {
        capture_one(
            item,
            directory,
            &mut pending,
            &mut evidence,
            &mut files,
            &mut visited,
        )?;
    }
    Ok((evidence, AuthorityLocks { files }))
}

/// Bind every active top-level reference to both its profile-declared hash and import manifest.
fn registered_roots(
    root: &Value,
    profile: &ImportedSymbolSpec,
    manifest: &SymbolSpecDependencyManifest,
) -> Result<Vec<PendingAuthority>, String> {
    let references = market_data::active_symbol_spec_references(root)?;
    if references.len() != manifest.dependencies.len() {
        return Err("Replay authority registration has extra or missing dependencies.".into());
    }
    let parent = Path::new(&profile.stored_path)
        .parent()
        .ok_or("Profile has no parent directory.")?;
    let mut pending = Vec::new();
    for (field, relative) in references {
        pending.push(registered_root(root, parent, &field, &relative, manifest)?);
    }
    Ok(pending)
}

/// Resolve one active root with the same relative/absolute path semantics as the retained C# loader.
fn registered_root(
    root: &Value,
    parent: &Path,
    field: &str,
    relative: &str,
    manifest: &SymbolSpecDependencyManifest,
) -> Result<PendingAuthority, String> {
    let dependency = manifest
        .dependencies
        .iter()
        .find(|item| item.field == field)
        .ok_or("An active replay authority is not registered.")?;
    if manifest
        .dependencies
        .iter()
        .filter(|item| item.field == field)
        .count()
        != 1
    {
        return Err("Replay authority registration contains a duplicate field.".into());
    }
    let path = canonical_plain(&parent.join(relative))?;
    let registered = canonical_plain(Path::new(&dependency.absolute))?;
    let hash_key = field
        .strip_suffix("_path")
        .ok_or("Unknown replay authority field.")?
        .to_string()
        + "_sha256";
    let sha256 = required_sha(root, &hash_key)?;
    if path != registered || dependency.sha256 != sha256 {
        return Err("Replay authority differs from its registered path/hash.".into());
    }
    let role = match field {
        "commission_conversion_authority_path" => Role::Commission,
        "swap_time_authority_path" => Role::Swap,
        _ => Role::Leaf,
    };
    Ok(PendingAuthority { path, sha256, role })
}

/// Lock/hash/copy one declared file before following its bounded known outgoing relationships.
fn capture_one(
    item: PendingAuthority,
    directory: &Path,
    pending: &mut Vec<PendingAuthority>,
    evidence: &mut Vec<AuthorityEvidence>,
    files: &mut Vec<(fs::File, String)>,
    visited: &mut BTreeMap<PathBuf, String>,
) -> Result<(), String> {
    if let Some(existing) = visited.get(&item.path) {
        if existing != &item.sha256 {
            return Err("Replay authority has conflicting declared hashes.".into());
        }
        return Ok(());
    }
    if evidence.len() >= MAX_AUTHORITIES {
        return Err("Replay authority file count exceeds its limit.".into());
    }
    let mut file = open_locked(&item.path)?;
    let bytes = read_locked(&mut file)?;
    if digest(&bytes) != item.sha256 {
        return Err(format!(
            "Replay authority SHA-256 mismatch: {}.",
            item.path.display()
        ));
    }
    let total: u64 = evidence.iter().map(|record| record.size_bytes).sum();
    if total + bytes.len() as u64 > MAX_AUTHORITY_BYTES {
        return Err("Replay authority aggregate bytes exceed their limit.".into());
    }
    pending.extend(child_authorities(&item, &bytes)?);
    let relative = format!("authorities/{:02}.bin", evidence.len());
    write_frozen(directory, &relative, &bytes)?;
    evidence.push(AuthorityEvidence {
        original_path: item.path.to_string_lossy().into(),
        sha256: item.sha256.clone(),
        size_bytes: bytes.len() as u64,
        frozen: file_record(&relative, &bytes),
    });
    visited.insert(item.path, item.sha256.clone());
    files.push((file, item.sha256));
    Ok(())
}

/// Follow only the three native commission evidence paths or authenticated swap report path.
fn child_authorities(
    parent: &PendingAuthority,
    bytes: &[u8],
) -> Result<Vec<PendingAuthority>, String> {
    let fields: &[(&str, &str)] = match parent.role {
        Role::Leaf => return Ok(Vec::new()),
        Role::Commission => &[
            ("source_events_path", "source_events_sha256"),
            ("source_report_path", "source_report_sha256"),
            ("source_spec_path", "source_spec_sha256"),
        ],
        Role::Swap => &[("source_report_relative_path", "source_report_sha256")],
    };
    let document: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Replay authority JSON is malformed ({error})."))?;
    let directory = parent
        .path
        .parent()
        .ok_or("Authority has no parent directory.")?;
    let mut children = Vec::new();
    for (path_key, hash_key) in fields {
        let path = document[*path_key]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("A replay authority requires a nonempty evidence path.")?;
        children.push(PendingAuthority {
            path: canonical_plain(&directory.join(path))?,
            sha256: required_sha(&document, hash_key)?,
            role: Role::Leaf,
        });
    }
    Ok(children)
}

/// Validate declared evidence hashes before using them as approval identities.
fn required_sha(document: &Value, key: &str) -> Result<String, String> {
    let value = document[key]
        .as_str()
        .ok_or_else(|| format!("Replay authority requires {key}."))?
        .trim()
        .to_ascii_lowercase();
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("Replay authority SHA-256 must be lowercase hexadecimal.".into());
    }
    Ok(value)
}

/// Resolve without traversing a link/junction, then reject any canonical redirected ancestor too.
fn canonical_plain(path: &Path) -> Result<PathBuf, String> {
    ensure_plain_path(path)?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Replay authority is missing ({error})."))?;
    ensure_plain_path(&canonical)?;
    Ok(canonical)
}

/// Reacquire original authority locks using only the already host-hash-verified receipt.
pub(crate) fn lock_receipt_authorities(
    receipt: &FrozenReplayReceipt,
) -> Result<AuthorityLocks, String> {
    if receipt.authorities.len() > MAX_AUTHORITIES {
        return Err("Replay authority count exceeds its limit.".into());
    }
    let mut files = Vec::new();
    for evidence in &receipt.authorities {
        let mut file = open_locked(&canonical_plain(Path::new(&evidence.original_path))?)?;
        let bytes = read_locked(&mut file)?;
        if bytes.len() as u64 != evidence.size_bytes || digest(&bytes) != evidence.sha256 {
            return Err("Original replay authority changed since the baseline.".into());
        }
        files.push((file, evidence.sha256.clone()));
    }
    Ok(AuthorityLocks { files })
}

/// Windows denies write/delete sharing for the entire open-handle lifetime; other hosts fail closed.
pub(super) fn open_locked(path: &Path) -> Result<fs::File, String> {
    ensure_plain_path(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(path)
            .map_err(|error| format!("Replay authority cannot be locked read-only ({error})."))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Replay authority write/delete exclusion requires Windows.".into())
    }
}

/// Read/hash the same retained handle with allocation bounded before accumulation.
pub(super) fn read_locked(file: &mut fs::File) -> Result<Vec<u8>, String> {
    if file.metadata().map_err(|error| error.to_string())?.len() > market_data::MAX_IMPORT_BYTES {
        return Err("Replay authority file exceeds its size limit.".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(market_data::MAX_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > market_data::MAX_IMPORT_BYTES {
        return Err("Replay authority file exceeds its size limit.".into());
    }
    Ok(bytes)
}
