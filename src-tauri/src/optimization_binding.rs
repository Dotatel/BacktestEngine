//! Verify the trusted managed host's exact original-generator receipt before exposing completed candidates.
use crate::market_data::read_limited_bytes;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

const MARKER: &str = "BACKTESTENGINE_OPTIMIZER_BINDING_SHA256 ";
pub(super) const PRESET_LIMIT: u64 = 1024 * 1024;

/// Native hashes captured before process launch; the managed host may not replace these frozen inputs.
pub(super) struct FrozenInputs<'a> {
    pub config: &'a str,
    pub base: &'a str,
    pub data: &'a str,
    pub profile: &'a str,
    pub capture: &'a str,
    pub source: &'a str,
}

/// Only the exact digest announced once by the trusted host stdout authorizes these receipt bytes.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    version: u32,
    config_sha256: String,
    base_params_sha256: String,
    data_sha256: String,
    symbol_spec_sha256: String,
    scenarios_json: String,
    pub results_sha256: Option<String>,
    pub candidates: Vec<Candidate>,
    compiled_runner: super::capture::CompiledRunnerEvidence,
    #[serde(skip)]
    pub base: Option<Preset>,
    #[serde(skip)]
    verified_compilation: Option<super::capture::VerifiedCompiledRunner>,
}

impl Receipt {
    /// Return only actual four-file provenance verified and locked when this receipt was loaded.
    pub(super) fn compiled_provenance(&self) -> Option<super::capture::CompiledRunnerProvenance> {
        self.verified_compilation
            .as_ref()
            .map(|verified| verified.provenance.clone())
    }
}

/// Original CandidateGenerator identities and ParameterValue text/typed values, never a Rust-generated search.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Candidate {
    pub id: String,
    pub hash: String,
    pub parameters: BTreeMap<String, String>,
    pub values: BTreeMap<String, Value>,
    pub report_sha256: Option<String>,
    pub preset_sha256: Option<String>,
    pub replay_preset_sha256: Option<String>,
    pub result_sha256: Option<String>,
}

/// The native preset writer emits exactly Chart and Parameters; unknown root/chart fields are not accepted.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
pub(super) struct Preset {
    pub chart: Chart,
    pub parameters: BTreeMap<String, Value>,
}

/// Native scenario chart identity, before the retained runner normalizes timeframe aliases for its report.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
pub(super) struct Chart {
    pub symbol: String,
    pub period: String,
}

/// Read only the fixed native receipt/base preset, binding every declaration to stdout and frozen input hashes.
pub(super) fn load(
    directory: &Path,
    stdout: &str,
    frozen: FrozenInputs<'_>,
) -> Result<Receipt, String> {
    let announced = marker_digest(stdout)?;
    let bytes = read_limited_bytes(
        &owned(directory, "candidate-bindings.json")?,
        4 * PRESET_LIMIT,
    )?;
    if digest(&bytes) != announced {
        return Err(
            "The original candidate binding receipt differs from the trusted host stdout digest."
                .into(),
        );
    }
    let mut receipt: Receipt = serde_json::from_slice(&bytes).map_err(|error| {
        format!("The original candidate binding receipt is malformed ({error}).")
    })?;
    if receipt.version != 3
        || receipt.config_sha256 != frozen.config
        || receipt.base_params_sha256 != frozen.base
        || receipt.data_sha256 != frozen.data
        || receipt.symbol_spec_sha256 != frozen.profile
    {
        return Err(
            "The original candidate binding receipt does not match the frozen native inputs."
                .into(),
        );
    }
    if receipt.candidates.is_empty() || receipt.candidates.len() > 100 {
        return Err("Original candidate binding count exceeds the native budget bounds.".into());
    }
    let scenarios: Vec<Value> = serde_json::from_str(&receipt.scenarios_json)
        .map_err(|_| "The original scenario serialization is malformed.")?;
    if scenarios.len() != 1 {
        return Err("Original candidate binding requires one frozen scenario.".into());
    }
    let base_bytes = read_limited_bytes(&owned(directory, "base.cbotset")?, PRESET_LIMIT)?;
    if digest(&base_bytes) != frozen.base {
        return Err("The frozen base preset changed after preparation.".into());
    }
    receipt.base = Some(
        serde_json::from_slice(&base_bytes).map_err(|_| "The frozen base preset is malformed.")?,
    );
    receipt.verified_compilation = Some(super::capture::verify_compiled_files(
        directory,
        frozen.capture,
        frozen.source,
        &receipt.compiled_runner,
    )?);
    Ok(receipt)
}

/// Authenticate raw aggregate bytes before JSON parsing; a missing original file cannot authorize a later replacement.
pub(super) fn verify_results(bytes: &[u8], receipt: &Receipt) -> Result<(), String> {
    verify_bytes(bytes, receipt.results_sha256.as_deref(), "results.json")
}

/// Partial recovery must preserve the aggregate's captured presence as well as its bytes.
pub(super) fn verify_results_presence(output: &Path, receipt: &Receipt) -> Result<(), String> {
    let path = output.join("results.json");
    if receipt.results_sha256.is_none() {
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(format!(
                    "Cannot verify original aggregate absence ({error})."
                ))
            }
            Ok(_) => {}
        }
    }
    let bytes = read_limited_bytes(&owned(output, "results.json")?, 64 * 1024 * 1024)?;
    verify_results(&bytes, receipt)
}

/// A state file present at host publication cannot silently disappear from partial recovery.
pub(super) fn verify_candidate_presence(output: &Path, receipt: &Receipt) -> Result<(), String> {
    for candidate in receipt
        .candidates
        .iter()
        .filter(|candidate| candidate.result_sha256.is_some())
    {
        let folder = owned(output, &format!("{}_{}", candidate.id, candidate.hash))?;
        owned(&folder, "candidate_result.json")?;
    }
    Ok(())
}

/// Load only the exact original candidate-state bytes from its fixed native folder, authenticating before deserialization.
pub(super) fn candidate_result(
    output: &Path,
    receipt: &Receipt,
    id: &str,
    hash: &str,
) -> Result<Vec<u8>, String> {
    let candidate = candidate(receipt, id, hash)?;
    let folder = owned(output, &format!("{id}_{hash}"))?;
    let bytes = read_limited_bytes(&owned(&folder, "candidate_result.json")?, 64 * 1024 * 1024)?;
    verify_bytes(
        &bytes,
        candidate.result_sha256.as_deref(),
        "candidate_result.json",
    )?;
    Ok(bytes)
}

/// A missing, duplicate or malformed digest marker cannot authenticate a mutable receipt file.
pub(super) fn marker_digest(stdout: &str) -> Result<String, String> {
    let markers: Vec<_> = stdout
        .lines()
        .filter(|line| line.starts_with(MARKER.trim_end()))
        .collect();
    if markers.len() != 1 {
        return Err("The trusted optimizer host must announce exactly one candidate binding receipt digest.".into());
    }
    let digest = markers[0]
        .strip_prefix(MARKER)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("The candidate binding receipt stdout marker is malformed.")?;
    Ok(digest.to_ascii_lowercase())
}

/// Look up one exact original candidate; duplicate ids or unknown generated identities remain unproven.
pub(super) fn candidate<'a>(
    receipt: &'a Receipt,
    id: &str,
    hash: &str,
) -> Result<&'a Candidate, String> {
    let matches: Vec<_> = receipt
        .candidates
        .iter()
        .filter(|candidate| candidate.id == id)
        .collect();
    if matches.len() != 1 || matches[0].hash != hash {
        return Err("Candidate id/hash does not match the original generator receipt.".into());
    }
    Ok(matches[0])
}

/// Compare actual preset semantics with the frozen native base plus the original generator's exact typed values.
pub(super) fn validate_preset(
    bytes: &[u8],
    receipt: &Receipt,
    candidate: &Candidate,
) -> Result<usize, String> {
    let actual: Preset = serde_json::from_slice(bytes)
        .map_err(|_| "Candidate preset is malformed or has unsupported fields.")?;
    let base = receipt
        .base
        .as_ref()
        .ok_or("The frozen base preset binding is unavailable.")?;
    let mut expected = base.clone();
    if candidate.values.keys().ne(candidate.parameters.keys()) {
        return Err("Original candidate text and typed parameter names differ.".into());
    }
    for (name, value) in &candidate.values {
        if !expected.parameters.contains_key(name) {
            return Err("Candidate includes an unknown frozen base parameter.".into());
        }
        expected.parameters.insert(name.clone(), value.clone());
    }
    if actual.chart != expected.chart
        || actual.parameters.len() != expected.parameters.len()
        || actual.parameters.iter().any(|(name, value)| {
            !expected
                .parameters
                .get(name)
                .is_some_and(|expected| same_value(value, expected))
        })
    {
        return Err(
            "Candidate preset does not match the frozen base and original generated values.".into(),
        );
    }
    Ok(actual.parameters.len())
}

/// JSON serializers can spell the same finite CLI number as integer or floating notation without changing its value.
fn same_value(actual: &Value, expected: &Value) -> bool {
    if actual.is_number() && expected.is_number() {
        return actual.as_f64() == expected.as_f64();
    }
    actual == expected
}

/// Require each actual source artifact to retain the exact byte digest captured by the managed host after execution.
pub(super) fn verify_bytes(bytes: &[u8], expected: Option<&str>, name: &str) -> Result<(), String> {
    if expected != Some(digest(bytes).as_str()) {
        return Err(format!(
            "Candidate {name} differs from the original host-bound bytes."
        ));
    }
    Ok(())
}

/// Keep adapter metadata in the fixed owned directory, refusing links or alternate renderer paths.
fn owned(directory: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    let directory = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let expected = directory.join(name);
    let actual = expected.canonicalize().map_err(|error| error.to_string())?;
    if actual != expected {
        return Err("Candidate binding metadata is redirected.".into());
    }
    Ok(actual)
}

/// Hash original bytes, never a reserialized approximation of the C# generator's JSON or number formatting.
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
