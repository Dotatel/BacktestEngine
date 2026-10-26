//! Freeze the retained producer and lock the pinned embedded interpreter without changing numerical sources.
use crate::{market_data, replay_receipt};
use replay_receipt::{ApprovedSourceManifest, FrozenFile, SourceLocks};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const SOURCE_MANIFEST: &str = include_str!("../../docs/retained-source.json");
const PYTHON_VERSION: &str = "3.14.9";
const PYTHON_ARCHIVE: &str = "3c01d7cfc666f746a6f064f60fb2156ab0ec464d3d738ab796371a46a9bb24a2";
const PYTHON_TREE: &str = "6b9f58c099e50c2f3911cdf3d81fe56753fb885a5c3e144076a3ce4fa36c96db";
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
// Official archive order used by the existing PowerShell staging digest; not a locale-dependent runtime sort.
const PYTHON_FILES: [&str; 37] = [
    "_asyncio.pyd",
    "_bz2.pyd",
    "_ctypes.pyd",
    "_decimal.pyd",
    "_elementtree.pyd",
    "_hashlib.pyd",
    "_lzma.pyd",
    "_multiprocessing.pyd",
    "_overlapped.pyd",
    "_queue.pyd",
    "_remote_debugging.pyd",
    "_socket.pyd",
    "_sqlite3.pyd",
    "_ssl.pyd",
    "_uuid.pyd",
    "_wmi.pyd",
    "_zoneinfo.pyd",
    "_zstd.pyd",
    "libcrypto-3.dll",
    "libffi-8.dll",
    "libssl-3.dll",
    "libtommath.dll",
    "LICENSE.txt",
    "pyexpat.pyd",
    "python.cat",
    "python.exe",
    "python3.dll",
    "python314._pth",
    "python314.dll",
    "python314.zip",
    "pythonw.exe",
    "select.pyd",
    "sqlite3.dll",
    "unicodedata.pyd",
    "vcruntime140_1.dll",
    "vcruntime140.dll",
    "winsound.pyd",
];

/// Exact public producer/tool identities; paths refer to logical package/runtime names only.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ValidationProducerProvenance {
    pub source_manifest_sha256: String,
    pub sources: BTreeMap<String, FrozenFile>,
    pub output_adapter_sha256: String,
    pub python_version: String,
    pub python_archive_sha256: String,
    pub python_tree_sha256: String,
    pub python_files: BTreeMap<String, FrozenFile>,
    pub runtime_manifest_sha256: String,
}

/// The caller must keep this object through confirmed descendant exit, including unconfirmed-cleanup retention.
pub(crate) struct FrozenValidationPackage {
    pub root: PathBuf,
    pub python: PathBuf,
    pub provenance: ValidationProducerProvenance,
    pub provenance_sha256: String,
    _producer_locks: SourceLocks,
    _runtime_locks: SourceLocks,
}

/// Compile-time source capture supplies exact original numerical bytes, rather than accepting mutable package metadata.
#[derive(Deserialize)]
struct RetainedManifest {
    files: Vec<RetainedFile>,
}
/// One original content identity from the compile-time source capture.
#[derive(Deserialize)]
struct RetainedFile {
    file: String,
    sha256: String,
}
/// Only the staged Python record is relevant; no mutable runtime destination is trusted.
#[derive(Deserialize)]
struct RuntimeManifest {
    python: RuntimeIdentity,
}
/// Pin official archive and full-tree identity, including the interpreter executable.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeIdentity {
    version: String,
    archive_hash: String,
    source_tree_sha256: String,
    executable: String,
    executable_sha256: String,
    file_count: usize,
    size_bytes: u64,
}

/// Copy only the 27 approved producer files into a new owned root, retaining frozen-source and installed-runtime locks.
/// Full validation requires the staged embedded interpreter; developer PATH fallbacks do not prove this contract.
pub(crate) fn freeze_validation_package(
    source_root: &Path,
    destination: &Path,
    python: &Path,
) -> Result<FrozenValidationPackage, String> {
    if !source_root.is_absolute() || !destination.is_absolute() || !python.is_absolute() {
        return Err(
            "Validation producer/runtime paths must be absolute native-owned paths.".into(),
        );
    }
    plain_path(source_root)?;
    plain_path(destination)?;
    let expected = retained_sources()?;
    require_inventory(
        &source_root.join("ValidationEngine"),
        expected
            .keys()
            .map(|path| path.strip_prefix("ValidationEngine/").unwrap()),
    )?;
    let sources = source_records(source_root, &expected)?;
    let original_locks =
        replay_receipt::lock_source_manifest(source_root, &manifest(sources.clone())?)?;
    let (python, runtime_files, runtime_manifest, runtime_locks) = locked_runtime(python)?;
    fs::create_dir(destination)
        .map_err(|error| format!("Validation producer destination must be new ({error})."))?;
    copy_sources(source_root, destination, &sources)?;
    drop(original_locks);
    let provenance = ValidationProducerProvenance {
        source_manifest_sha256: manifest(sources.clone())?.sha256,
        sources,
        output_adapter_sha256: replay_receipt::digest(include_bytes!(
            "../optimizer-host/ValidationOutput.py"
        )),
        python_version: PYTHON_VERSION.into(),
        python_archive_sha256: PYTHON_ARCHIVE.into(),
        python_tree_sha256: PYTHON_TREE.into(),
        python_files: runtime_files,
        runtime_manifest_sha256: replay_receipt::digest(&runtime_manifest),
    };
    let bytes = serde_json::to_vec_pretty(&provenance).map_err(|error| error.to_string())?;
    write_new(&destination.join("producer-provenance.json"), &bytes)?;
    let mut locked_sources = provenance.sources.clone();
    locked_sources.insert(
        "producer-provenance.json".into(),
        replay_receipt::file_record("producer-provenance.json", &bytes),
    );
    let producer_locks =
        replay_receipt::lock_source_manifest(destination, &manifest(locked_sources)?)?;
    Ok(FrozenValidationPackage {
        root: destination.to_path_buf(),
        python,
        provenance,
        provenance_sha256: replay_receipt::digest(&bytes),
        _producer_locks: producer_locks,
        _runtime_locks: runtime_locks,
    })
}

/// Parse only the preserved package's exact bounded relative identities, rejecting duplicate or unexpected capture changes.
fn retained_sources() -> Result<BTreeMap<String, String>, String> {
    let captured: RetainedManifest =
        serde_json::from_str(SOURCE_MANIFEST).map_err(|error| error.to_string())?;
    let mut expected = BTreeMap::new();
    for file in captured.files {
        add_retained_source(file, &mut expected)?;
    }
    if expected.len() != 27 {
        return Err(
            "Retained validation source capture must contain its 27 original files.".into(),
        );
    }
    Ok(expected)
}

/// Ignore unrelated C# capture records; numerical package files must remain safe, unique Python identities.
fn add_retained_source(
    file: RetainedFile,
    expected: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let Some(relative) = file.file.strip_prefix("engines/validation/") else {
        return Ok(());
    };
    if !relative.starts_with("ValidationEngine/") {
        return Ok(());
    }
    if !relative.ends_with(".py") || expected.insert(relative.into(), file.sha256).is_some() {
        return Err("Retained validation source capture is malformed or duplicated.".into());
    }
    Ok(())
}

/// Hash known originals before locking; the subsequent lock rechecks the same bytes against their captured hashes.
fn source_records(
    root: &Path,
    expected: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, FrozenFile>, String> {
    expected
        .iter()
        .map(|(relative, expected_hash)| {
            let bytes = market_data::read_limited_bytes(
                &replay_receipt::owned_file(root, relative)?,
                MAX_SOURCE_BYTES,
            )?;
            let record = replay_receipt::file_record(relative, &bytes);
            if record.sha256 != *expected_hash {
                return Err(format!("Retained validation producer changed: {relative}."));
            }
            Ok((relative.clone(), record))
        })
        .collect()
}

/// Copy while original locks are held; never copy cache, native extension, unknown module or user file trees.
fn copy_sources(
    source: &Path,
    destination: &Path,
    sources: &BTreeMap<String, FrozenFile>,
) -> Result<(), String> {
    for record in sources.values() {
        let target = replay_receipt::owned_file(destination, &record.relative_path)?;
        fs::create_dir_all(target.parent().ok_or("Validation source has no parent.")?)
            .map_err(|error| error.to_string())?;
        let bytes =
            market_data::read_limited_bytes(&source.join(&record.relative_path), MAX_SOURCE_BYTES)?;
        if replay_receipt::digest(&bytes) != record.sha256 {
            return Err("Validation producer changed while freezing.".into());
        }
        write_new(&target, &bytes)?;
    }
    Ok(())
}

/// Verified interpreter path, complete file inventory, original manifest bytes and retained runtime locks.
type LockedPythonRuntime = (PathBuf, BTreeMap<String, FrozenFile>, Vec<u8>, SourceLocks);

/// Require the exact official interpreter tree and retain locks over every companion and staging manifest.
fn locked_runtime(python: &Path) -> Result<LockedPythonRuntime, String> {
    plain_path(python)?;
    let python = python
        .canonicalize()
        .map_err(|error| format!("Pinned validation interpreter is unavailable ({error})."))?;
    let root = python
        .parent()
        .ok_or("Validation interpreter has no parent.")?;
    if python.file_name().and_then(|name| name.to_str()) != Some("python.exe") {
        return Err("Full validation requires its staged embedded python.exe.".into());
    }
    require_inventory(root, PYTHON_FILES.into_iter())?;
    let files = runtime_records(root)?;
    let manifest_path = root
        .parent()
        .ok_or("Validation runtime has no staging parent.")?
        .join("manifest.json");
    plain_path(&manifest_path)?;
    let bytes = market_data::read_limited_bytes(&manifest_path, 2 * 1024 * 1024)?;
    let staged: RuntimeManifest =
        serde_json::from_slice(&bytes).map_err(|_| "Validation runtime manifest is malformed.")?;
    verify_runtime_identity(&staged.python, &files)?;
    let mut lock_records = files
        .iter()
        .map(|(name, file)| {
            let mut record = file.clone();
            record.relative_path = format!("python/{name}");
            (record.relative_path.clone(), record)
        })
        .collect::<BTreeMap<_, _>>();
    lock_records.insert(
        "manifest.json".into(),
        replay_receipt::file_record("manifest.json", &bytes),
    );
    // The root must be exactly the staged python child, so logical lock paths cannot select another runtime.
    if root.file_name().and_then(|name| name.to_str()) != Some("python") {
        return Err("Validation interpreter must be the staged runtimes/python child.".into());
    }
    let locks =
        replay_receipt::lock_source_manifest(root.parent().unwrap(), &manifest(lock_records)?)?;
    Ok((python, files, bytes, locks))
}

/// Compute the already established archive digest using its pinned inventory order, avoiding OS-locale sorting changes.
fn verify_runtime_identity(
    staged: &RuntimeIdentity,
    files: &BTreeMap<String, FrozenFile>,
) -> Result<(), String> {
    let lines = PYTHON_FILES
        .iter()
        .map(|name| {
            let file = &files[*name];
            format!("{name}\t{}\t{}", file.size_bytes, file.sha256)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let total = files.values().map(|file| file.size_bytes).sum::<u64>();
    if staged.version != PYTHON_VERSION
        || staged.archive_hash != PYTHON_ARCHIVE
        || staged.source_tree_sha256 != PYTHON_TREE
        || staged.executable != "python.exe"
        || staged.executable_sha256 != files["python.exe"].sha256
        || staged.file_count != PYTHON_FILES.len()
        || staged.size_bytes != total
        || replay_receipt::digest(lines.as_bytes()) != PYTHON_TREE
    {
        return Err(
            "Validation interpreter tree differs from the pinned official embedded runtime.".into(),
        );
    }
    Ok(())
}

/// Read one bounded runtime inventory; the full locked recheck closes the initial hash-to-lock race.
fn runtime_records(root: &Path) -> Result<BTreeMap<String, FrozenFile>, String> {
    PYTHON_FILES
        .iter()
        .map(|name| {
            let bytes = market_data::read_limited_bytes(&root.join(name), 16 * 1024 * 1024)?;
            Ok(((*name).into(), replay_receipt::file_record(name, &bytes)))
        })
        .collect()
}

/// Compare complete plain-file membership with a fixed inventory; extra bytecode or executable modules are refused.
fn require_inventory<'a>(
    root: &Path,
    expected: impl Iterator<Item = &'a str>,
) -> Result<(), String> {
    let expected = expected
        .map(String::from)
        .collect::<std::collections::BTreeSet<_>>();
    let mut actual = std::collections::BTreeSet::new();
    let mut remaining = 256;
    enumerate_plain_files(root, root, &mut actual, 0, &mut remaining)?;
    if actual != expected {
        return Err(
            "Validation producer/runtime inventory has missing or unexpected files.".into(),
        );
    }
    Ok(())
}

/// Bound all filesystem enumeration and reject links, unknown metadata errors and non-directory ancestors.
fn enumerate_plain_files(
    root: &Path,
    directory: &Path,
    files: &mut std::collections::BTreeSet<String>,
    depth: usize,
    remaining: &mut usize,
) -> Result<(), String> {
    plain_path(directory)?;
    if depth > 8 || files.len() > 128 {
        return Err("Validation producer/runtime inventory exceeds its bounds.".into());
    }
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        if *remaining == 0 {
            return Err("Validation inventory enumeration exceeded 256 entries.".into());
        }
        *remaining -= 1;
        enumerate_entry(
            root,
            &entry.map_err(|error| error.to_string())?.path(),
            files,
            depth,
            remaining,
        )?;
    }
    Ok(())
}

/// Recurse only real directories; every ordinary file receives a normalized logical name.
fn enumerate_entry(
    root: &Path,
    path: &Path,
    files: &mut std::collections::BTreeSet<String>,
    depth: usize,
    remaining: &mut usize,
) -> Result<(), String> {
    plain_path(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        return enumerate_plain_files(root, path, files, depth + 1, remaining);
    }
    if !metadata.is_file() {
        return Err("Validation package contains a non-file entry.".into());
    }
    files.insert(
        path.strip_prefix(root)
            .map_err(|_| "Validation package escaped its root.")?
            .to_string_lossy()
            .replace('\\', "/"),
    );
    Ok(())
}

/// Refuse all metadata errors except a genuinely absent future destination; never treat denial as absence.
fn plain_path(path: &Path) -> Result<(), String> {
    replay_receipt::ensure_plain_path(path)?;
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if ancestor != path && !metadata.is_dir() => {
                return Err("Validation path has a non-directory ancestor.".into())
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => {
                return Err(format!(
                    "Validation path metadata is unavailable ({error})."
                ))
            }
        }
    }
    Ok(())
}

/// Reuse the existing locked-source mechanism with a deterministic, bounded logical manifest.
fn manifest(files: BTreeMap<String, FrozenFile>) -> Result<ApprovedSourceManifest, String> {
    let bytes = serde_json::to_vec(&files).map_err(|error| error.to_string())?;
    Ok(ApprovedSourceManifest {
        files,
        sha256: replay_receipt::digest(&bytes),
    })
}

/// Write only new owned files, flushing before a readonly-lock can authorize their provenance.
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    plain_path(path)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "validation_package_tests.rs"]
mod tests;
