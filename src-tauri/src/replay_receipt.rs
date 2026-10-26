//! Host-captured replay evidence. No receipt is reconstructed from a mutable saved report.
use crate::{market_data, workspace_build};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

#[path = "replay_receipt_authorities.rs"]
mod authorities;
pub(crate) use authorities::{lock_receipt_authorities, AuthorityLocks};

pub(crate) const RECEIPT_VERSION: u32 = 1;
const MAX_SOURCE_FILES: usize = 4096;
const MAX_CAPTURE_BYTES: u64 = 256 * 1024 * 1024;

/// Exact owned relative file identity; paths cannot escape the receipt's directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenFile {
    pub relative_path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

/// Private Build-time proof over every original source/project/entry/restore-policy byte.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovedSourceManifest {
    pub files: BTreeMap<String, FrozenFile>,
    pub sha256: String,
}

/// Original invocation semantics, captured before baseline dispatch; no metadata-default substitution.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplaySettings {
    pub strategy: String,
    pub symbol: String,
    pub timeframe: String,
    pub starting_balance: f64,
    pub commission_usd_per_million: f64,
    pub effective_commission_usd_per_million: f64,
    pub slippage_pips: f64,
    pub spread_pips: Option<f64>,
    pub start_utc: Option<String>,
    pub end_utc: Option<String>,
    pub max_ticks: Option<i64>,
    pub max_bars: Option<i64>,
    pub bar_timeframe: Option<String>,
    pub bar_price_mode: Option<String>,
    pub write_equity_csv: bool,
    pub parameter_overrides: BTreeMap<String, String>,
    pub parameter_mode: ParameterMode,
}

/// Ordinary replay currently forbids parameter files; preserve that distinction during reruns.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ParameterMode {
    NoFile,
}

/// Exact profile commission semantics; rate stress never claims multiplication of rounded/minimum fees.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommissionTerms {
    pub model: String,
    pub rate_currency: String,
    pub side_semantics: String,
    pub profile_rate: f64,
    pub minimum_commission: f64,
    pub minimum_currency: String,
    pub rounding_mode: String,
    pub native_end_utc: Option<String>,
}

/// An original external authority and its exact copied evidence; originals remain hash-bound.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AuthorityEvidence {
    pub original_path: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub frozen: FrozenFile,
}

/// One shared registered-profile capture, including the unchanged transitive authority graph and its held locks.
pub(crate) struct CapturedProfileInputs {
    pub files: Vec<FrozenFile>,
    pub authorities: Vec<AuthorityEvidence>,
    pub authority_locks: AuthorityLocks,
}

/// Reuse baseline profile/registration copying and original authority discovery without rewriting hash-bound JSON.
pub(crate) fn capture_registered_profile(
    profile: &market_data::ImportedSymbolSpec,
    directory: &Path,
) -> Result<CapturedProfileInputs, String> {
    let mut files = Vec::new();
    let bytes = freeze_profile(profile, directory, &mut files)?;
    let (authorities, authority_locks) =
        authorities::capture_authorities(&bytes, profile, directory)?;
    Ok(CapturedProfileInputs {
        files,
        authorities,
        authority_locks,
    })
}

/// Versioned input receipt; successful result publication separately binds its hash and report hash.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenReplayReceipt {
    pub version: u32,
    pub execution_run_id: String,
    pub canonical_project_root: String,
    pub build_revision: String,
    pub build_configuration: String,
    pub approved_artifact_sha256: String,
    pub approved_runtime_sha256: BTreeMap<String, String>,
    pub source_manifest: ApprovedSourceManifest,
    pub settings: ReplaySettings,
    pub commission_terms: CommissionTerms,
    pub dataset: market_data::ImportedDataset,
    pub profile: market_data::ImportedSymbolSpec,
    pub files: Vec<FrozenFile>,
    pub authorities: Vec<AuthorityEvidence>,
}

/// Verified caller inputs from selected-project preflight and a newly assembled source tree.
pub(crate) struct CaptureReplayInputs<'a> {
    pub run_id: &'a str,
    pub run_directory: &'a Path,
    pub fresh_source: &'a Path,
    pub approved: &'a workspace_build::ApprovedBuild,
    pub settings: ReplaySettings,
    pub dataset: &'a market_data::ImportedDataset,
    pub profile: &'a market_data::ImportedSymbolSpec,
}

/// Retain authority locks through process teardown, including baseline cancellation/failure.
pub(crate) struct FrozenReplayInputs {
    pub receipt: FrozenReplayReceipt,
    pub receipt_sha256: String,
    pub directory: PathBuf,
    pub authority_locks: AuthorityLocks,
    _input_locks: SourceLocks,
}

/// Read-only source handles prevent successful compilation from borrowing later-mutated source bytes.
pub(crate) struct SourceLocks {
    _files: Vec<fs::File>,
}

/// Lock and verify the exact declared compilation inputs before invoking the compiler/metadata processes.
pub(crate) fn lock_source_manifest(
    snapshot: &Path,
    manifest: &ApprovedSourceManifest,
) -> Result<SourceLocks, String> {
    let mut files = Vec::new();
    for record in manifest.files.values() {
        let path = owned_file(snapshot, &record.relative_path)?;
        let mut file = authorities::open_locked(&path)?;
        let bytes = authorities::read_locked(&mut file)?;
        if bytes.len() as u64 != record.size_bytes || digest(&bytes) != record.sha256 {
            return Err("Compilation source changed before it could be locked.".into());
        }
        files.push(file);
    }
    Ok(SourceLocks { _files: files })
}

/// Snapshot only the compiler's declared source roots and root project/receipt/restore files.
pub(crate) fn source_manifest(snapshot: &Path) -> Result<ApprovedSourceManifest, String> {
    ensure_plain_path(snapshot)?;
    let mut files = BTreeMap::new();
    for relative in ["engine", "strategies", "entry"] {
        collect_source_files(snapshot, Path::new(relative), &mut files, 0)?;
    }
    for relative in [
        "WorkspaceCompile.csproj",
        "NuGet.Config",
        "revision.json",
        "Directory.Build.targets",
        "Directory.Build.props",
    ] {
        add_source_file(snapshot, Path::new(relative), &mut files)?;
    }
    let bytes = serde_json::to_vec(&files).map_err(|error| error.to_string())?;
    Ok(ApprovedSourceManifest {
        files,
        sha256: digest(&bytes),
    })
}

/// Walk bounded source roots without traversing links or compiler-produced bin/obj directories.
fn collect_source_files(
    root: &Path,
    relative: &Path,
    files: &mut BTreeMap<String, FrozenFile>,
    depth: usize,
) -> Result<(), String> {
    if depth > 16 {
        return Err("Replay source nesting exceeds its limit.".into());
    }
    let directory = root.join(relative);
    ensure_plain_path(&directory)?;
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        collect_source_entry(
            root,
            &relative.join(entry.map_err(|error| error.to_string())?.file_name()),
            files,
            depth,
        )?;
    }
    Ok(())
}

/// Select a file or nested source folder without admitting generated binaries to the manifest.
fn collect_source_entry(
    root: &Path,
    relative: &Path,
    files: &mut BTreeMap<String, FrozenFile>,
    depth: usize,
) -> Result<(), String> {
    let path = root.join(relative);
    ensure_plain_path(&path)?;
    if path.is_dir() {
        if matches!(
            path.file_name().and_then(|value| value.to_str()),
            Some("bin" | "obj")
        ) {
            return Ok(());
        }
        return collect_source_files(root, relative, files, depth + 1);
    }
    add_source_file(root, relative, files)
}

/// Hash a bounded original source file and enforce aggregate capture bounds before allocation.
fn add_source_file(
    root: &Path,
    relative: &Path,
    files: &mut BTreeMap<String, FrozenFile>,
) -> Result<(), String> {
    if files.len() >= MAX_SOURCE_FILES {
        return Err("Replay source file count exceeds its limit.".into());
    }
    let bytes = market_data::read_limited_bytes(&root.join(relative), 1024 * 1024)?;
    let key = relative.to_string_lossy().replace('\\', "/");
    files.insert(key.clone(), file_record(&key, &bytes));
    let size: u64 = files.values().map(|file| file.size_bytes).sum();
    if size > MAX_CAPTURE_BYTES {
        return Err("Replay source bytes exceed their aggregate limit.".into());
    }
    Ok(())
}

/// Freeze exact inputs after SDK probing; changed dataset/profile/source bytes fail closed.
pub(crate) fn capture_replay_inputs(
    input: CaptureReplayInputs<'_>,
) -> Result<FrozenReplayInputs, String> {
    ensure_plain_path(input.run_directory)?;
    let source = source_manifest(input.fresh_source)?;
    verify_source_approval(
        &source,
        &input.approved.source_manifest,
        input.fresh_source,
        &input.approved.revision,
    )?;
    let directory = input.run_directory.join("replay-inputs");
    fs::create_dir(&directory)
        .map_err(|error| format!("Cannot create fresh replay capture ({error})."))?;
    let mut files = freeze_source(input.fresh_source, &directory, &source)?;
    files.extend(freeze_binaries(input.approved, &directory)?);
    files.push(copy_expected(
        Path::new(&input.dataset.stored_path),
        &directory,
        "market.csv",
        &input.dataset.sha256,
        input.dataset.size_bytes,
    )?);
    let profile_bytes = freeze_profile(input.profile, &directory, &mut files)?;
    let commission_terms = capture_commission_terms(&profile_bytes, &input.settings)?;
    let (authorities, authority_locks) =
        authorities::capture_authorities(&profile_bytes, input.profile, &directory)?;
    let receipt = FrozenReplayReceipt {
        version: RECEIPT_VERSION,
        execution_run_id: input.run_id.into(),
        canonical_project_root: input.approved.project_root.clone(),
        build_revision: input.approved.revision.clone(),
        build_configuration: "Release".into(),
        approved_artifact_sha256: input.approved.artifact_sha256.clone(),
        approved_runtime_sha256: input.approved.runtime_sha256.clone(),
        source_manifest: source,
        settings: input.settings,
        commission_terms,
        dataset: input.dataset.clone(),
        profile: input.profile.clone(),
        files,
        authorities,
    };
    let bytes = serde_json::to_vec_pretty(&receipt).map_err(|error| error.to_string())?;
    fs::write(directory.join("receipt.json"), &bytes).map_err(|error| error.to_string())?;
    let mut locked_files: BTreeMap<_, _> = receipt
        .files
        .iter()
        .map(|file| (file.relative_path.clone(), file.clone()))
        .collect();
    locked_files.insert("receipt.json".into(), file_record("receipt.json", &bytes));
    let input_locks = lock_source_manifest(
        &directory,
        &ApprovedSourceManifest {
            files: locked_files,
            sha256: String::new(),
        },
    )?;
    Ok(FrozenReplayInputs {
        receipt,
        receipt_sha256: digest(&bytes),
        directory,
        authority_locks,
        _input_locks: input_locks,
    })
}

/// Recheck and copy the approved assembly/runtime bytes after SDK probing, then execute only that frozen copy.
fn freeze_binaries(
    approved: &workspace_build::ApprovedBuild,
    directory: &Path,
) -> Result<Vec<FrozenFile>, String> {
    let artifact = Path::new(&approved.artifact_path);
    let parent = artifact
        .parent()
        .ok_or("Approved replay assembly has no parent.")?;
    let size = fs::metadata(artifact)
        .map_err(|error| error.to_string())?
        .len();
    let mut files = vec![copy_expected(
        artifact,
        directory,
        "binary/WorkspaceCompile.dll",
        &approved.artifact_sha256,
        size,
    )?];
    for name in [
        "BacktestEngine.CAlgoShim.dll",
        "WorkspaceCompile.deps.json",
        "WorkspaceCompile.runtimeconfig.json",
    ] {
        let expected = approved
            .runtime_sha256
            .get(name)
            .ok_or("Approved replay runtime hash is missing.")?;
        let path = parent.join(name);
        let size = fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len();
        files.push(copy_expected(
            &path,
            directory,
            &format!("binary/{name}"),
            expected,
            size,
        )?);
    }
    Ok(files)
}

/// Bind captured effective-rate selection to the frozen profile and exact original request sentinel.
fn capture_commission_terms(
    bytes: &[u8],
    settings: &ReplaySettings,
) -> Result<CommissionTerms, String> {
    let profile: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let text = |key: &str| {
        profile[key]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("Frozen profile lacks commission term {key}."))
    };
    let profile_rate = profile["commission_rate"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or("Frozen profile commission rate is invalid.")?;
    let minimum_commission = profile["minimum_commission"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or("Frozen profile minimum commission is invalid.")?;
    let expected = if settings.commission_usd_per_million < 0.0 {
        profile_rate
    } else {
        settings.commission_usd_per_million
    };
    if !settings.commission_usd_per_million.is_finite()
        || !expected.is_finite()
        || settings.effective_commission_usd_per_million != expected
    {
        return Err(
            "Captured commission controls differ from their frozen profile/request semantics."
                .into(),
        );
    }
    let native_end_utc = if profile
        .get("commission_conversion_authority_path")
        .is_some()
    {
        Some(text("native_commission_end_utc")?)
    } else {
        None
    };
    Ok(CommissionTerms {
        model: text("commission_model")?,
        rate_currency: text("commission_rate_currency")?.to_uppercase(),
        side_semantics: text("commission_side_semantics")?,
        profile_rate,
        minimum_commission,
        minimum_currency: text("minimum_commission_currency")?.to_uppercase(),
        rounding_mode: text("commission_rounding_mode")?,
        native_end_utc,
    })
}

/// Require fresh source AND revision to match private successful-compilation evidence.
fn verify_source_approval(
    fresh: &ApprovedSourceManifest,
    approved: &ApprovedSourceManifest,
    source: &Path,
    revision: &str,
) -> Result<(), String> {
    if fresh != approved {
        return Err("Fresh replay source differs from the approved compilation source manifest. Rebuild and retry.".into());
    }
    let raw: serde_json::Value = serde_json::from_slice(&market_data::read_limited_bytes(
        &source.join("revision.json"),
        1024 * 1024,
    )?)
    .map_err(|error| error.to_string())?;
    if raw["revision"].as_str() != Some(revision) {
        return Err("Fresh replay source revision differs from its approved build.".into());
    }
    Ok(())
}

/// Copy fresh source bytes only after verifying each copy against the approved manifest.
fn freeze_source(
    source: &Path,
    directory: &Path,
    manifest: &ApprovedSourceManifest,
) -> Result<Vec<FrozenFile>, String> {
    let mut files = Vec::new();
    for file in manifest.files.values() {
        files.push(copy_expected(
            &source.join(&file.relative_path),
            directory,
            &format!("runner/{}", file.relative_path),
            &file.sha256,
            file.size_bytes,
        )?);
    }
    Ok(files)
}

/// Preserve the derived profile and exact registration JSON, validating catalog binding again.
fn freeze_profile(
    profile: &market_data::ImportedSymbolSpec,
    directory: &Path,
    files: &mut Vec<FrozenFile>,
) -> Result<Vec<u8>, String> {
    let path = Path::new(&profile.stored_path);
    files.push(copy_expected(
        path,
        directory,
        "profile.json",
        &profile.sha256,
        profile.size_bytes,
    )?);
    let parent = path
        .parent()
        .ok_or("The registered profile has no parent directory.")?;
    for name in ["provenance.json", "dependencies.json"] {
        ensure_plain_path(&parent.join(name))?;
        let bytes = market_data::read_limited_bytes(&parent.join(name), 1024 * 1024)?;
        write_frozen(directory, &format!("registration/{name}"), &bytes)?;
        files.push(file_record(&format!("registration/{name}"), &bytes));
    }
    market_data::read_limited_bytes(
        &directory.join("profile.json"),
        market_data::MAX_IMPORT_BYTES,
    )
}

/// Check every stored byte against the host-held receipt digest; never trust a self-described hash.
pub(crate) fn verify_frozen_replay(
    directory: &Path,
    receipt_sha256: &str,
) -> Result<FrozenReplayReceipt, String> {
    ensure_plain_path(directory)?;
    let bytes = market_data::read_limited_bytes(&directory.join("receipt.json"), 4 * 1024 * 1024)?;
    if digest(&bytes) != receipt_sha256 {
        return Err("The frozen replay receipt changed.".into());
    }
    let receipt: FrozenReplayReceipt =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if receipt.version != RECEIPT_VERSION {
        return Err("The replay receipt version is unsupported.".into());
    }
    for file in receipt.files.iter().chain(
        receipt
            .authorities
            .iter()
            .map(|authority| &authority.frozen),
    ) {
        verify_file(directory, file)?;
    }
    Ok(receipt)
}

/// Verify exact recorded bytes at a separator-contained relative path before parsing or dispatch.
pub(crate) fn verify_file(root: &Path, file: &FrozenFile) -> Result<(), String> {
    let path = owned_file(root, &file.relative_path)?;
    let bytes = market_data::read_limited_bytes(&path, market_data::MAX_IMPORT_BYTES)?;
    if bytes.len() as u64 != file.size_bytes || digest(&bytes) != file.sha256 {
        return Err(format!(
            "Frozen replay input changed: {}.",
            file.relative_path
        ));
    }
    Ok(())
}

/// Copy the exact bytes just verified; do not hash one read and execute a later mutable read.
fn copy_expected(
    source: &Path,
    root: &Path,
    relative: &str,
    sha256: &str,
    size_bytes: u64,
) -> Result<FrozenFile, String> {
    ensure_plain_path(source)?;
    let bytes = market_data::read_limited_bytes(source, market_data::MAX_IMPORT_BYTES)?;
    if bytes.len() as u64 != size_bytes || digest(&bytes) != sha256 {
        return Err(format!(
            "Replay input changed before capture: {}.",
            source.display()
        ));
    }
    write_frozen(root, relative, &bytes)?;
    Ok(file_record(relative, &bytes))
}

/// Write a new owned file; no existing evidence or user file is overwritten.
pub(super) fn write_frozen(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let path = owned_file(root, relative)?;
    fs::create_dir_all(path.parent().ok_or("Frozen input has no parent.")?)
        .map_err(|error| error.to_string())?;
    ensure_plain_path(path.parent().ok_or("Frozen input has no parent.")?)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())
}

/// Validate every relative component; Windows drive, stream, traversal and link escapes are refused.
pub(super) fn owned_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.contains(':')
        || relative.contains('\\')
        || !Path::new(relative)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("Frozen replay path is not a safe relative file.".into());
    }
    let path = Path::new(relative)
        .components()
        .fold(root.to_path_buf(), |mut path, component| {
            path.push(component.as_os_str());
            path
        });
    ensure_plain_path(&path)?;
    Ok(path)
}

/// Reject redirected ancestors, including Windows junctions, before reads/writes/locks.
pub(super) fn ensure_plain_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor).is_ok_and(|metadata| is_reparse(&metadata)) {
            return Err("Replay paths cannot traverse a reparse point.".into());
        }
    }
    Ok(())
}

/// Treat junctions and symbolic links alike on Windows; portable tests still refuse symbolic links.
pub(crate) fn is_reparse(metadata: &fs::Metadata) -> bool {
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

/// Record exact immutable bytes using the same lowercase SHA-256 representation throughout.
pub(super) fn file_record(relative: &str, bytes: &[u8]) -> FrozenFile {
    FrozenFile {
        relative_path: relative.into(),
        sha256: digest(bytes),
        size_bytes: bytes.len() as u64,
    }
}

/// Hash bytes already read under the relevant input/lock boundary.
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A baseline can publish a receipt only after original ReportWriter semantics match all captured controls.
pub(crate) fn verify_baseline_completion(
    frozen: &mut FrozenReplayInputs,
    report_path: &Path,
    report_sha256: &str,
) -> Result<(), String> {
    verify_frozen_replay(&frozen.directory, &frozen.receipt_sha256)?;
    frozen.authority_locks.verify()?;
    let bytes = market_data::read_limited_bytes(report_path, market_data::MAX_IMPORT_BYTES)?;
    if digest(&bytes) != report_sha256 {
        return Err("The baseline report changed before replay receipt publication.".into());
    }
    let raw: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    verify_baseline_report_controls(&frozen.receipt, &raw)
}

/// Check immutable baseline semantics without reopening current project/catalog/authority inputs during historical viewing.
pub(crate) fn verify_baseline_report_controls(
    receipt: &FrozenReplayReceipt,
    raw: &serde_json::Value,
) -> Result<(), String> {
    if raw["strategy"].as_str() != Some(&receipt.settings.strategy)
        || !raw["symbol"]
            .as_str()
            .is_some_and(|symbol| symbol.eq_ignore_ascii_case(&receipt.settings.symbol))
        || raw["replay"]["mode"].as_str() != Some(&receipt.dataset.kind)
    {
        return Err("The baseline report differs from its captured replay identity.".into());
    }
    if raw["account"]["starting_capital"].as_f64() != Some(receipt.settings.starting_balance)
        || raw["execution_slippage_pips_per_fill"].as_f64() != Some(receipt.settings.slippage_pips)
        || raw["commission_usd_per_million"].as_f64()
            != Some(receipt.settings.effective_commission_usd_per_million)
    {
        return Err(
            "The baseline report differs from its captured balance/slippage/commission controls."
                .into(),
        );
    }
    if raw["parameter_file"].as_str() != Some("")
        || raw["parameter_defaults"].as_u64() != Some(0)
        || raw["parameter_overrides"].as_u64()
            != Some(receipt.settings.parameter_overrides.len() as u64)
    {
        return Err(
            "The baseline parameter-loading mode differs from its captured invocation.".into(),
        );
    }
    verify_report_commission(
        raw,
        receipt,
        receipt.settings.effective_commission_usd_per_million,
    )
}

/// Bind the original report's typed commission model and preserved minimum/rounding terms, not just one number.
pub(crate) fn verify_report_commission(
    raw: &serde_json::Value,
    receipt: &FrozenReplayReceipt,
    effective_rate: f64,
) -> Result<(), String> {
    let terms = &receipt.commission_terms;
    let root = &raw["economic_contract"];
    for (field, expected) in [
        ("commission_model", terms.model.as_str()),
        ("commission_side_semantics", terms.side_semantics.as_str()),
        ("commission_rounding_mode", terms.rounding_mode.as_str()),
    ] {
        if !root[field].as_str().is_some_and(|actual| {
            actual
                .replace('_', "")
                .eq_ignore_ascii_case(&expected.replace('_', ""))
        }) {
            return Err(
                "Original report commission model/side/rounding differs from the captured profile."
                    .into(),
            );
        }
    }
    if root["commission_rate"].as_f64() != Some(effective_rate)
        || root["commission_rate_currency"].as_str() != Some(terms.rate_currency.as_str())
        || root["minimum_commission"].as_f64() != Some(terms.minimum_commission)
        || root["minimum_commission_currency"].as_str() != Some(terms.minimum_currency.as_str())
    {
        return Err(
            "Original report commission currency/minimum differs from the captured profile.".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "replay_receipt_tests.rs"]
pub(crate) mod tests;
