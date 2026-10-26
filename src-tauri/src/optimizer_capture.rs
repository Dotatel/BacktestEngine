//! Host-owned optimizer input capture; retained candidate generation, compilation and scoring remain unchanged.
use crate::{market_data, replay_receipt, workspace_build};
use replay_receipt::{
    ApprovedSourceManifest, AuthorityEvidence, AuthorityLocks, FrozenFile, SourceLocks,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) const BUILD_CONFIGURATION: &str = "Release";
// The unchanged optimizer fingerprints bin/Debug; this is one real Release output, never an alias/copy.
pub(crate) const COMPILED_DIRECTORY: &str = "runner/bin/Debug/Release/net10.0";
pub(crate) const COMPILED_NAMES: [&str; 4] = [
    "WorkspaceCompile.dll",
    "BacktestEngine.CAlgoShim.dll",
    "WorkspaceCompile.deps.json",
    "WorkspaceCompile.runtimeconfig.json",
];
const RECORD_NAME: &str = "optimizer-inputs.json";
const MAX_RECORD_BYTES: u64 = 4 * 1024 * 1024;

/// Private frozen-input record; original authority paths stay local and are not exposed as public provenance.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OptimizerInputRecord {
    version: u32,
    canonical_project_root: String,
    build_revision: String,
    approved_artifact_sha256: String,
    approved_runtime_sha256: BTreeMap<String, String>,
    build_configuration: String,
    source_manifest: ApprovedSourceManifest,
    dataset: market_data::ImportedDataset,
    profile: market_data::ImportedSymbolSpec,
    files: Vec<FrozenFile>,
    authorities: Vec<AuthorityEvidence>,
}

/// Public identities describe exact captured inputs without leaking absolute source/authority paths.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OptimizerCaptureProvenance {
    pub capture_sha256: String,
    pub source_manifest_sha256: String,
    pub approved_artifact_sha256: String,
    pub build_configuration: String,
    pub dataset_sha256: String,
    pub profile_sha256: String,
    pub config_sha256: String,
    pub base_params_sha256: String,
    pub authority_sha256: Vec<String>,
}

/// Keep this entire object through confirmed child-tree teardown, or in native quarantine if cleanup is unknown.
pub(crate) struct FrozenOptimizerCapture {
    pub directory: PathBuf,
    pub provenance: OptimizerCaptureProvenance,
    record: OptimizerInputRecord,
    record_file: FrozenFile,
    authority_locks: AuthorityLocks,
    _frozen_locks: SourceLocks,
}

/// Required v3 trusted-host receipt field; missing compiled evidence cannot default into numerical acceptance.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompiledRunnerEvidence {
    pub capture_sha256: String,
    pub source_manifest_sha256: String,
    pub build_configuration: String,
    pub files: BTreeMap<String, String>,
}

/// These actual recompiled bytes are distinct from the earlier approved assembly; no binary-parity claim is made.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompiledRunnerProvenance {
    pub build_configuration: String,
    pub files: BTreeMap<String, FrozenFile>,
}

/// Locks prevent post-verification replacement while original candidates are parsed and promoted.
pub(crate) struct VerifiedCompiledRunner {
    pub provenance: CompiledRunnerProvenance,
    _locks: SourceLocks,
}

/// Capture only after the SDK probe and final runner move, with base/config files already written by native preparation.
/// Registration and transitive authority discovery use the same authoritative helper as ordinary replay.
pub(crate) fn freeze_inputs(
    directory: &Path,
    approved: &workspace_build::ApprovedBuild,
    dataset: &market_data::ImportedDataset,
    profile: &market_data::ImportedSymbolSpec,
) -> Result<FrozenOptimizerCapture, String> {
    replay_receipt::ensure_plain_path(directory)?;
    let directory = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let source_manifest = approved_source(&directory.join("runner"), approved)?;
    // Lock only at the final path: MSBuild must never compile a later mutable replacement of the staged source.
    let original_source_locks =
        replay_receipt::lock_source_manifest(&directory.join("runner"), &source_manifest)?;
    let mut files = prefixed_source_files(&source_manifest);
    files.push(freeze_dataset(&directory, dataset)?);
    let captured_profile = replay_receipt::capture_registered_profile(profile, &directory)?;
    files.extend(captured_profile.files);
    files.push(read_record(&directory, "base.cbotset", 1024 * 1024)?);
    files.push(read_record(&directory, "optimizer.json", 1024 * 1024)?);
    let record = OptimizerInputRecord {
        version: 1,
        canonical_project_root: approved.project_root.clone(),
        build_revision: approved.revision.clone(),
        approved_artifact_sha256: approved.artifact_sha256.clone(),
        approved_runtime_sha256: approved.runtime_sha256.clone(),
        build_configuration: BUILD_CONFIGURATION.into(),
        source_manifest,
        dataset: dataset.clone(),
        profile: profile.clone(),
        files,
        authorities: captured_profile.authorities,
    };
    let bytes = serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("Optimizer input capture exceeds 4 MiB.".into());
    }
    write_new(&directory.join(RECORD_NAME), &bytes)?;
    let record_file = replay_receipt::file_record(RECORD_NAME, &bytes);
    let locked = lock_inventory(&record, &record_file)?;
    let frozen_locks = replay_receipt::lock_source_manifest(&directory, &locked)?;
    drop(original_source_locks);
    let provenance = public_provenance(&record, &record_file)?;
    Ok(FrozenOptimizerCapture {
        directory,
        provenance,
        record,
        record_file,
        authority_locks: captured_profile.authority_locks,
        _frozen_locks: frozen_locks,
    })
}

impl FrozenOptimizerCapture {
    /// Recheck original authority handles and all exact captured copies before launch and after confirmed teardown.
    pub(crate) fn verify(&mut self) -> Result<(), String> {
        self.authority_locks.verify()?;
        for file in self.record.files.iter().chain(
            self.record
                .authorities
                .iter()
                .map(|authority| &authority.frozen),
        ) {
            replay_receipt::verify_file(&self.directory, file)?;
        }
        replay_receipt::verify_file(&self.directory, &self.record_file)?;
        if replay_receipt::source_manifest(&self.directory.join("runner"))?
            != self.record.source_manifest
        {
            return Err("Optimizer source membership changed after capture.".into());
        }
        Ok(())
    }
}

/// Receipt parsing retains all four actual binaries before it can authorize any original candidate statistics.
pub(crate) fn verify_compiled_files(
    directory: &Path,
    capture_sha256: &str,
    source_manifest_sha256: &str,
    evidence: &CompiledRunnerEvidence,
) -> Result<VerifiedCompiledRunner, String> {
    validate_compilation_identity(capture_sha256, source_manifest_sha256, evidence)?;
    let root = directory.join(COMPILED_DIRECTORY);
    replay_receipt::ensure_plain_path(&root)?;
    let mut files = BTreeMap::new();
    for name in COMPILED_NAMES {
        let file = read_record(&root, name, market_data::MAX_IMPORT_BYTES)?;
        if evidence.files.get(name) != Some(&file.sha256) {
            return Err(format!("Actual compiled optimizer companion {name} changed or has a different host-bound hash."));
        }
        files.insert(name.into(), file);
    }
    let locks = replay_receipt::lock_source_manifest(&root, &logical_manifest(files.clone())?)?;
    Ok(VerifiedCompiledRunner {
        provenance: CompiledRunnerProvenance {
            build_configuration: BUILD_CONFIGURATION.into(),
            files,
        },
        _locks: locks,
    })
}

/// Require the full private approved source/project/entry/restore/membership manifest, not only strategy revision text.
fn approved_source(
    runner: &Path,
    approved: &workspace_build::ApprovedBuild,
) -> Result<ApprovedSourceManifest, String> {
    let source = replay_receipt::source_manifest(runner)?;
    if source != approved.source_manifest {
        return Err("Optimizer source differs from the exact approved compilation manifest. Rebuild and retry.".into());
    }
    let raw: serde_json::Value = serde_json::from_slice(&market_data::read_limited_bytes(
        &runner.join("revision.json"),
        1024 * 1024,
    )?)
    .map_err(|_| "Optimizer source revision is malformed.")?;
    if raw["revision"].as_str() != Some(approved.revision.as_str()) {
        return Err("Optimizer source revision differs from approval.".into());
    }
    Ok(source)
}

/// Prefix fixed source identities after the move so one held native inventory covers the entire actual runner tree.
fn prefixed_source_files(source: &ApprovedSourceManifest) -> Vec<FrozenFile> {
    source
        .files
        .values()
        .map(|file| FrozenFile {
            relative_path: format!("runner/{}", file.relative_path),
            sha256: file.sha256.clone(),
            size_bytes: file.size_bytes,
        })
        .collect()
}

/// Rehash actual imported bytes after SDK probing, check their expected size, and freeze only that read.
fn freeze_dataset(
    directory: &Path,
    dataset: &market_data::ImportedDataset,
) -> Result<FrozenFile, String> {
    let original = Path::new(&dataset.stored_path);
    replay_receipt::ensure_plain_path(original)?;
    let bytes = market_data::read_limited_bytes(original, market_data::MAX_IMPORT_BYTES)?;
    if bytes.len() as u64 != dataset.size_bytes || replay_receipt::digest(&bytes) != dataset.sha256
    {
        return Err("Imported data changed before optimizer post-SDK capture.".into());
    }
    write_new(&directory.join("market.csv"), &bytes)?;
    Ok(replay_receipt::file_record("market.csv", &bytes))
}

/// Hold source, data, controls, registration, captured authority bytes and their private record until safe teardown.
fn lock_inventory(
    record: &OptimizerInputRecord,
    record_file: &FrozenFile,
) -> Result<ApprovedSourceManifest, String> {
    let mut files = BTreeMap::new();
    for file in record
        .files
        .iter()
        .chain(record.authorities.iter().map(|authority| &authority.frozen))
        .chain(std::iter::once(record_file))
    {
        if files
            .insert(file.relative_path.clone(), file.clone())
            .is_some()
        {
            return Err("Optimizer capture has duplicate fixed file identities.".into());
        }
    }
    logical_manifest(files)
}

/// Native SourceLocks use logical hashes only; absolute paths are held separately in private native state.
fn logical_manifest(files: BTreeMap<String, FrozenFile>) -> Result<ApprovedSourceManifest, String> {
    let bytes = serde_json::to_vec(&files).map_err(|error| error.to_string())?;
    Ok(ApprovedSourceManifest {
        files,
        sha256: replay_receipt::digest(&bytes),
    })
}

/// Project source and original authority paths remain private; only exact identities enter result provenance.
fn public_provenance(
    record: &OptimizerInputRecord,
    record_file: &FrozenFile,
) -> Result<OptimizerCaptureProvenance, String> {
    Ok(OptimizerCaptureProvenance {
        capture_sha256: record_file.sha256.clone(),
        source_manifest_sha256: record.source_manifest.sha256.clone(),
        approved_artifact_sha256: record.approved_artifact_sha256.clone(),
        build_configuration: record.build_configuration.clone(),
        dataset_sha256: role(record, "market.csv")?.sha256.clone(),
        profile_sha256: role(record, "profile.json")?.sha256.clone(),
        config_sha256: role(record, "optimizer.json")?.sha256.clone(),
        base_params_sha256: role(record, "base.cbotset")?.sha256.clone(),
        authority_sha256: record
            .authorities
            .iter()
            .map(|authority| authority.sha256.clone())
            .collect(),
    })
}

/// A fixed role must have been captured; missing controls or profile bytes are never filled with invented defaults.
fn role<'a>(record: &'a OptimizerInputRecord, name: &str) -> Result<&'a FrozenFile, String> {
    record
        .files
        .iter()
        .find(|file| file.relative_path == name)
        .ok_or_else(|| format!("Optimizer capture lacks required file {name}."))
}

/// Only four fixed native companion basenames and the current capture/configuration/source identity are supported.
fn validate_compilation_identity(
    capture_sha256: &str,
    source_manifest_sha256: &str,
    evidence: &CompiledRunnerEvidence,
) -> Result<(), String> {
    if evidence.capture_sha256 != capture_sha256
        || evidence.source_manifest_sha256 != source_manifest_sha256
        || evidence.build_configuration != BUILD_CONFIGURATION
        || evidence.files.len() != COMPILED_NAMES.len()
    {
        return Err("Actual compiled optimizer evidence has a foreign capture/source/configuration identity.".into());
    }
    for name in COMPILED_NAMES {
        let value = evidence
            .files
            .get(name)
            .ok_or("Actual compiled optimizer evidence lacks a fixed runtime companion.")?;
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Actual compiled optimizer companion hash is malformed.".into());
        }
    }
    Ok(())
}

/// Read a safe relative fixed file with an explicit limit; the following SourceLocks recheck closes hash-to-lock races.
fn read_record(root: &Path, relative: &str, limit: u64) -> Result<FrozenFile, String> {
    let bytes =
        market_data::read_limited_bytes(&replay_receipt::owned_file(root, relative)?, limit)?;
    if bytes.is_empty() {
        return Err(format!("Optimizer fixed artifact {relative} is empty."));
    }
    Ok(replay_receipt::file_record(relative, &bytes))
}

/// Create only new owned files; source, catalog, previous captures and original authorities are never overwritten.
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    replay_receipt::ensure_plain_path(path)?;
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
#[path = "optimizer_capture_tests.rs"]
mod tests;
