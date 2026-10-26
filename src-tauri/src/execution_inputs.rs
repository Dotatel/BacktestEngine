//! Shared read-only execution preflight for ordinary replay and bounded optimization.
//! Callers bind the host-selected project before entry and own their run latch/cancellation.
use super::{
    current_source_revision, read_bounded_file, sha256_hex, validate_artifact,
    validate_parameter_path, validate_request, validate_runtime_companions, validate_symbol_spec,
    ExecutionRunRequest, ExecutionState,
};
use crate::{market_data, workspace, workspace_build};
use std::{fs, path::Path, path::PathBuf};

/// Canonical, verified inputs; this contract creates no run folder and launches no process.
#[derive(Debug)]
pub(crate) struct ExecutionInputs {
    pub artifact_path: PathBuf,
    pub dataset_record: market_data::ImportedDataset,
    pub symbol_spec_path: PathBuf,
    pub resolved_symbol: String,
    pub build_revision: String,
}

/// Verify every ordinary execution gate before a replay or optimization prepares work.
/// The approved build and selected-project binding must come from host state, never the renderer.
pub(crate) fn preflight_execution_inputs(
    state: &ExecutionState,
    request: &ExecutionRunRequest,
    approved: &workspace_build::ApprovedBuild,
) -> Result<ExecutionInputs, String> {
    validate_request(request)?;
    let artifact_path = approved_artifact(state, approved)?;
    validate_source_freshness(approved)?;
    if !approved
        .strategies
        .iter()
        .any(|name| name == &request.strategy)
    {
        return Err("The selected strategy is not part of the approved build.".to_string());
    }
    let schema = approved
        .parameter_schemas
        .iter()
        .find(|schema| schema.strategy == request.strategy)
        .ok_or_else(|| {
            "The selected strategy metadata is missing from the approved build. Rebuild and retry."
                .to_string()
        })?;
    validate_parameter_overrides(request.parameter_overrides.as_ref(), schema)?;
    let (_, dataset_record) =
        market_data::load_dataset(&state.market_data_directory, &request.dataset_id)?;
    let symbol_spec_path = validate_symbol_spec(state, &request.symbol_spec_path)?;
    if let Some(path) = &request.parameter_path {
        validate_parameter_path(path)?;
    }
    let resolved_symbol = resolve_symbol(request, &symbol_spec_path)?;
    Ok(ExecutionInputs {
        artifact_path,
        dataset_record,
        symbol_spec_path,
        resolved_symbol,
        build_revision: approved.revision.clone(),
    })
}

/// Bind ordinary CLI overrides to actual approved reflection before any SDK or runner dispatch.
/// C# accepts property names and display aliases case-insensitively; duplicate aliases are refused.
pub(super) fn validate_parameter_overrides(
    overrides: Option<&std::collections::BTreeMap<String, String>>,
    schema: &workspace_build::CompiledStrategy,
) -> Result<(), String> {
    let Some(overrides) = overrides else {
        return Ok(());
    };
    if overrides.len() > 256 || schema.parameters.len() > 256 {
        return Err("Parameter overrides exceed the 256-parameter limit.".into());
    }
    let mut applied = std::collections::BTreeSet::new();
    for (name, value) in overrides {
        if name.is_empty() || name.len() > 256 || value.len() > 2048 || value.contains('\0') {
            return Err("Parameter names or values exceed their supported bounds.".into());
        }
        let parameter = schema
            .parameters
            .iter()
            .find(|parameter| {
                parameter.name.eq_ignore_ascii_case(name)
                    || parameter.display_name.eq_ignore_ascii_case(name)
            })
            .ok_or_else(|| format!("Parameter '{name}' is not in the approved strategy schema."))?;
        if !applied.insert(&parameter.name) {
            return Err(format!(
                "Parameter '{}' is supplied more than once through aliases.",
                parameter.name
            ));
        }
    }
    Ok(())
}

/// Verify the real receipt, main assembly and all known CLR companions with the host approval.
fn approved_artifact(
    state: &ExecutionState,
    approved: &workspace_build::ApprovedBuild,
) -> Result<PathBuf, String> {
    let artifact_path = Path::new(&approved.artifact_path)
        .canonicalize()
        .map_err(|error| format!("The approved build artifact could not be resolved ({error})."))?;
    let (_, revision) = validate_artifact(&state.builds_directory, &approved.artifact_path)?;
    if revision != approved.revision {
        return Err("The build receipt revision does not match the approved build.".to_string());
    }
    let bytes = fs::read(&artifact_path)
        .map_err(|error| format!("The approved build artifact could not be read ({error})."))?;
    if sha256_hex(&bytes) != approved.artifact_sha256 {
        return Err("The approved build artifact changed on disk. Rebuild and retry.".to_string());
    }
    validate_runtime_companions(&artifact_path, &approved.runtime_sha256)?;
    Ok(artifact_path)
}

/// Require the current project source to match the exact approved snapshot fingerprint.
fn validate_source_freshness(approved: &workspace_build::ApprovedBuild) -> Result<(), String> {
    if approved.revision.trim().is_empty() {
        return Err("The approved build is missing its source revision.".to_string());
    }
    if approved.project_root.trim().is_empty() {
        return Err("The approved build is missing its project root.".to_string());
    }
    let root = workspace::ProjectRoot::open(&approved.project_root)
        .map_err(|error| format!("The approved project could not be opened ({error})."))?;
    let revision = current_source_revision(&root).map_err(|error| {
        format!("The project source fingerprint could not be computed ({error}).")
    })?;
    if revision != approved.revision {
        return Err(
            "The project source changed since the approved build. Rebuild and retry.".to_string(),
        );
    }
    Ok(())
}

/// Resolve the requested symbol or the registered profile's declared symbol without launching .NET.
fn resolve_symbol(request: &ExecutionRunRequest, profile: &Path) -> Result<String, String> {
    if let Some(symbol) = request
        .symbol
        .as_deref()
        .map(str::trim)
        .filter(|symbol| !symbol.is_empty())
    {
        return Ok(symbol.to_string());
    }
    let bytes = read_bounded_file(profile)?;
    let document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The derived profile is damaged.".to_string())?;
    document
        .get("symbol")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|symbol| !symbol.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "The symbol could not be resolved from the request or profile.".to_string())
}
