//! Native build ownership and verified bootstrap selection; no source or runtime path comes from renderer IPC.
use crate::{
    execution_process::{self, ToolMode, ToolRequest},
    market_data, replay_receipt,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;
use tokio::sync::oneshot;

/// A verified packaged bootstrap runs the trusted host independently of any candidate SDK.
#[derive(Clone)]
pub(crate) struct BuildRuntime {
    pub bootstrap: PathBuf,
    pub host: PathBuf,
    pub probe_directory: PathBuf,
}

/// State-owned source handles outlive an abandoned async build and remain retained after unconfirmed cleanup.
pub(crate) struct BuildFlight {
    pub cleanup: Arc<AtomicBool>,
    source_locks: Mutex<Option<replay_receipt::SourceLocks>>,
}
impl Default for BuildFlight {
    /// Default ownership starts before any child dispatch, with no retained source handles.
    fn default() -> Self {
        Self::new()
    }
}
impl BuildFlight {
    /// Preparation starts with no running child, so cleanup is confirmed until dispatch begins.
    pub fn new() -> Self {
        Self {
            cleanup: Arc::new(AtomicBool::new(true)),
            source_locks: Mutex::new(None),
        }
    }
    /// Install exact source locks before the first compiler await, with no file handles in the serialized build contract.
    pub fn retain_sources(&self, locks: replay_receipt::SourceLocks) -> Result<(), String> {
        let mut slot = self
            .source_locks
            .lock()
            .map_err(|_| "Build input ownership is busy.")?;
        if slot.is_some() {
            return Err("This build already owns its source inputs.".into());
        }
        *slot = Some(locks);
        Ok(())
    }
    /// Remove locked inputs only when both the direct host and all owned descendants were confirmed exited.
    pub fn release_sources(&self) -> bool {
        if !self.cleanup.load(Ordering::Acquire) {
            return false;
        }
        self.source_locks
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        true
    }
}

/// Resolve only packaged identities, with the same verified source-resource fallback in development.
pub(crate) fn resolve_runtime(app: &tauri::AppHandle) -> Result<BuildRuntime, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let workspace = app
        .try_state::<crate::WorkspaceState>()
        .ok_or("Workspace storage is unavailable for an isolated SDK probe.")?;
    let probes = probe_directory(&workspace.builds_directory)?;
    if resources.join("runtimes/manifest.json").is_file() {
        return runtime_from_resources(&resources, &probes);
    }
    #[cfg(debug_assertions)]
    {
        runtime_from_resources(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"),
            &probes,
        )
    }
    #[cfg(not(debug_assertions))]
    Err(
        "The verified contained build runtime is missing. Repair the installation before building."
            .into(),
    )
}

/// Derive probe storage only from the already managed build root, including isolated profile overrides.
fn probe_directory(builds: &Path) -> Result<PathBuf, String> {
    if !builds.is_absolute() {
        return Err("Managed build storage must use an absolute path.".into());
    }
    let workspace = builds
        .parent()
        .ok_or("Managed build storage has no workspace parent.")?;
    replay_receipt::ensure_plain_path(workspace)?;
    Ok(workspace.join("sdk-probes"))
}

/// Share the staged runtime/host verifiers with actual tests; a directory alone is never a capability claim.
pub(crate) fn runtime_from_resources(
    resources: &Path,
    probes: &Path,
) -> Result<BuildRuntime, String> {
    replay_receipt::ensure_plain_path(resources)?;
    let manifest: serde_json::Value = serde_json::from_slice(&market_data::read_limited_bytes(
        &resources.join("runtimes/manifest.json"),
        1024 * 1024,
    )?)
    .map_err(|_| "The runtime manifest is malformed.")?;
    let entry = &manifest["dotnet"];
    if entry["destination"] != "runtimes/dotnet" || entry["executable"] != "dotnet.exe" {
        return Err("The bootstrap runtime manifest has an unexpected path.".into());
    }
    let bootstrap = canonical_candidate(&resources.join("runtimes/dotnet/dotnet.exe"))?;
    let bytes = market_data::read_limited_bytes(&bootstrap, market_data::MAX_IMPORT_BYTES)?;
    if entry["executableSha256"].as_str() != Some(replay_receipt::digest(&bytes).as_str()) {
        return Err("The packaged bootstrap executable differs from its staged identity.".into());
    }
    let host = crate::full_validation::verify_engine_host(&resources.join("validation/host"))?;
    Ok(BuildRuntime {
        bootstrap,
        host,
        probe_directory: probes.to_path_buf(),
    })
}

/// Resolve an SDK candidate to a plain absolute dotnet.exe, including a shell-free Windows PATH lookup.
pub(crate) fn canonical_candidate(candidate: &Path) -> Result<PathBuf, String> {
    let path = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        if candidate != Path::new("dotnet") {
            return Err("SDK candidates must resolve to absolute executable paths.".into());
        }
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .filter(|directory| directory.is_absolute())
            .map(|directory| directory.join("dotnet.exe"))
            .find(|path| path.is_file())
            .ok_or("No absolute dotnet.exe was found on PATH.")?
    };
    replay_receipt::ensure_plain_path(&path)?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("The SDK executable is unavailable ({error})."))?;
    replay_receipt::ensure_plain_path(&path)?;
    if !path.is_file()
        || !path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("dotnet.exe"))
    {
        return Err("The SDK candidate is not an exact dotnet.exe file.".into());
    }
    Ok(path)
}

/// Preserve the verified canonical identity while using the ordinary Windows spelling required by MSBuild SDK imports.
pub(crate) fn sdk_launch_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_candidate(path)?;
    let launch = sdk_spelling(&canonical)?;
    if launch.canonicalize().map_err(|error| error.to_string())? != canonical {
        return Err(
            "The SDK launch spelling does not resolve to the same verified executable.".into(),
        );
    }
    Ok(launch)
}

/// Return an existing owned directory in tool-compatible Windows spelling while preserving its exact canonical identity.
pub(crate) fn workflow_directory(path: &Path) -> Result<PathBuf, String> {
    replay_receipt::ensure_plain_path(path)?;
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    replay_receipt::ensure_plain_path(&canonical)?;
    if !canonical.is_dir() {
        return Err("The owned workflow parent is not an existing directory.".into());
    }
    let launch = sdk_spelling(&canonical)?;
    if launch.canonicalize().map_err(|error| error.to_string())? != canonical {
        return Err(
            "The workflow spelling does not resolve to the same verified directory.".into(),
        );
    }
    Ok(launch)
}

/// Convert only known verbatim drive/UNC prefixes; ambiguous DOS components fail before any tool starts.
fn sdk_spelling(canonical: &Path) -> Result<PathBuf, String> {
    for component in canonical.components() {
        if let std::path::Component::Normal(name) = component {
            validate_sdk_component(
                name.to_str()
                    .ok_or("SDK paths require lossless Unicode spelling.")?,
            )?;
        }
    }
    let text = canonical
        .to_str()
        .ok_or("SDK paths require lossless Unicode spelling.")?;
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return Ok(PathBuf::from(format!(r"\\{rest}")));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if rest.as_bytes().get(1) != Some(&b':')
            || rest.as_bytes().get(2) != Some(&b'\\')
            || !rest.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        {
            return Err("The SDK uses an unsupported device path spelling.".into());
        }
        return Ok(PathBuf::from(rest));
    }
    Ok(canonical.to_path_buf())
}

/// Ordinary DOS path normalization must never silently trim or reinterpret a verified SDK filename.
fn validate_sdk_component(name: &str) -> Result<(), String> {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|value| value.is_control() || "<>:\"|?*".contains(value))
        || reserved
    {
        return Err("The verified SDK path cannot be represented safely for MSBuild.".into());
    }
    Ok(())
}

/// Probe only --list-sdks inside the existing contained host, never bootstrap that host with the unverified candidate.
pub(crate) async fn probe_sdk(
    runtime: &BuildRuntime,
    candidate: &Path,
    cancel: &mut oneshot::Receiver<()>,
    cleanup: Arc<AtomicBool>,
    timeout: u64,
) -> Result<std::process::Output, String> {
    replay_receipt::ensure_plain_path(&runtime.probe_directory)?;
    fs::create_dir_all(&runtime.probe_directory).map_err(|error| error.to_string())?;
    let working = runtime
        .probe_directory
        .canonicalize()
        .map_err(|error| error.to_string())?
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&working).map_err(|error| error.to_string())?;
    let output = execution_process::run_workspace_tool(
        ToolRequest {
            bootstrap: &runtime.bootstrap,
            host: &runtime.host,
            candidate,
            mode: ToolMode::SdkProbe,
            arguments: &[],
            working: &working,
            environment: &[],
            timeout_seconds: timeout,
        },
        cancel,
        cleanup.clone(),
    )
    .await;
    if cleanup.load(Ordering::Acquire) {
        let _ = fs::remove_dir(&working);
    }
    output
}

/// Forward fixed compiler or metadata argv and exact caller environment into the shared bounded transport.
pub(crate) async fn run_tool(
    request: BuildTool<'_>,
    cancel: &mut oneshot::Receiver<()>,
    cleanup: Arc<AtomicBool>,
) -> Result<std::process::Output, String> {
    execution_process::run_workspace_tool(
        ToolRequest {
            bootstrap: &request.runtime.bootstrap,
            host: &request.runtime.host,
            candidate: request.compiler,
            mode: request.mode,
            arguments: request.arguments,
            working: request.working,
            environment: request.environment,
            timeout_seconds: request.timeout_seconds,
        },
        cancel,
        cleanup,
    )
    .await
}

/// One native-only build phase; mode is restricted to the app's fixed host protocol.
pub(crate) struct BuildTool<'a> {
    pub runtime: &'a BuildRuntime,
    pub compiler: &'a Path,
    pub mode: ToolMode,
    pub arguments: &'a [String],
    pub working: &'a Path,
    pub environment: &'a [(&'a str, String)],
    pub timeout_seconds: u64,
}

#[cfg(test)]
#[path = "build_process_tests.rs"]
mod tests;

/// Actual staged runtimes used by integration tests; missing preparation fails rather than simulating host capability.
#[cfg(test)]
pub(crate) fn staged_test_runtime(probes: &Path) -> BuildRuntime {
    runtime_from_resources(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"),
        probes,
    )
    .expect("Stage the verified SDK and contained host before native integration tests.")
}
