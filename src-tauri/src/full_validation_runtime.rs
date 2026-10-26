//! Host-selected packaged validation executable identity; no executable paths are accepted from IPC.
use crate::{market_data, replay_receipt};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tauri::Manager;

/// Manifest accepts only known CLR companions, never additional arbitrary resource paths.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostManifest {
    files: BTreeMap<String, String>,
    source_sha256: BTreeMap<String, String>,
}

/// Resolve under the existing validation resource group so package inventory needs no new resource root.
pub(crate) fn resolve_host(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let packaged = resources.join("validation/host");
    if packaged.join("manifest.json").is_file() {
        return verify_host(&packaged);
    }
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/validation/host");
        if source.join("manifest.json").is_file() {
            return verify_host(&source);
        }
    }
    Err("The verified full-validation host is missing. Stage/package the validation host before running engine reruns.".into())
}

/// Verify exact original host binaries before launching their Windows containment boundary.
pub(crate) fn verify_host(directory: &Path) -> Result<PathBuf, String> {
    replay_receipt::ensure_plain_path(directory)?;
    let manifest: HostManifest = serde_json::from_slice(&market_data::read_limited_bytes(
        &directory.join("manifest.json"),
        1024 * 1024,
    )?)
    .map_err(|_| "The full-validation host manifest is malformed.")?;
    for (name, bytes) in [
        (
            "ValidationOutput.py",
            include_bytes!("../optimizer-host/ValidationOutput.py").as_slice(),
        ),
        (
            "ValidationHost.cs",
            include_bytes!("../optimizer-host/ValidationHost.cs").as_slice(),
        ),
        (
            "process_job.cs",
            include_bytes!("../optimizer-host/process_job.cs").as_slice(),
        ),
    ] {
        if manifest.source_sha256.get(name) != Some(&replay_receipt::digest(bytes)) {
            return Err(format!("Validation host source {name} differs from this application's compiled producer. Restage/rebuild the managed host."));
        }
    }
    for name in [
        "ValidationHost.dll",
        "ValidationHost.deps.json",
        "ValidationHost.runtimeconfig.json",
    ] {
        let path = directory.join(name);
        replay_receipt::ensure_plain_path(&path)?;
        let hash = replay_receipt::digest(&market_data::read_limited_bytes(
            &path,
            market_data::MAX_IMPORT_BYTES,
        )?);
        if manifest.files.get(name) != Some(&hash) {
            return Err(format!(
                "Validation host companion {name} differs from its staged manifest."
            ));
        }
    }
    Ok(directory.join("ValidationHost.dll"))
}
