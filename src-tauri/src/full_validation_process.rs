//! Bounded lifecycle for the verified managed Job Object host; no Python child is spawned directly.
use super::PreparedFullValidation;
use crate::replay_receipt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::oneshot,
};

const MAX_STREAM_BYTES: u64 = 128 * 1024;
const MAX_WORKSPACE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES: usize = 8192;

/// Only host-verified packaged runtime paths may enter the fixed managed-host argument vector.
pub(super) struct ValidationRuntime<'a> {
    pub compiler: &'a Path,
    pub host: &'a Path,
    pub python: &'a Path,
    pub source: &'a Path,
}

/// Start one contained workflow, bound output/disk/time and wait for its direct host on every failure.
pub(super) async fn run_full_validation(
    runtime: ValidationRuntime<'_>,
    prepared: &PreparedFullValidation,
    cancel: &mut oneshot::Receiver<()>,
    timeout_seconds: u64,
    cleanup_confirmed: Arc<AtomicBool>,
) -> Result<Output, String> {
    check_workspace_budget(&prepared.directory)?;
    let job = super::job::OwnedValidationJob::create(Arc::new(AtomicBool::new(true)))?;
    let compiler = crate::build_process::sdk_launch_path(runtime.compiler)?;
    let sdk = compiler
        .parent()
        .ok_or("The validation SDK directory is invalid.")?;
    let mut command = tokio::process::Command::new(&compiler);
    command
        .arg(runtime.host)
        .arg("--python")
        .arg(runtime.python)
        .arg("--source")
        .arg(runtime.source)
        .arg("--config")
        .arg(&prepared.config_path)
        .arg("--sdk")
        .arg(sdk)
        .arg("--working")
        .arg(&prepared.directory)
        .arg("--job")
        .arg(&job.name)
        .current_dir(&prepared.directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    cleanup_confirmed.store(false, Ordering::Release);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            cleanup_confirmed.store(true, Ordering::Release);
            return Err(format!(
                "The contained validation host could not start ({error})."
            ));
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or("Validation host stdout is missing.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Validation host stderr is missing.")?;
    let capture = async {
        let (status, stdout, stderr) = tokio::try_join!(
            async { child.wait().await.map_err(|error| error.to_string()) },
            bounded_output(stdout),
            bounded_output(stderr)
        )?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    };
    let outcome = tokio::select! {
        result=tokio::time::timeout(Duration::from_secs(timeout_seconds),capture)=>match result { Ok(value)=>value,Err(_)=>Err("Full validation exceeded 600 seconds overall; its owned process tree was stopped.".into()) },
        _=&mut *cancel=>Err("Full validation was canceled; its owned process tree was stopped.".into()),
        result=monitor_workspace(&prepared.directory)=>match result { Err(error)=>Err(error),Ok(())=>Err("Validation workspace monitor stopped unexpectedly.".into()) },
    };
    if outcome.is_err() {
        let _ = child.start_kill();
    }
    job.terminate_and_drain().await?;
    tokio::time::timeout(Duration::from_secs(5),child.wait()).await.map_err(|_|format!("{}: direct validation host exit could not be confirmed; restart before running another engine job.",super::job::CLEANUP_UNCONFIRMED))?.map_err(|error|format!("{}: direct validation host wait failed ({error}); restart before running another engine job.",super::job::CLEANUP_UNCONFIRMED))?;
    cleanup_confirmed.store(true, Ordering::Release);
    outcome
}

/// Stop accumulation when a trusted host stream exceeds its capture limit.
async fn bounded_output(stream: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stream
        .take(MAX_STREAM_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_STREAM_BYTES {
        return Err(
            "Validation host output exceeded 128 KiB; its owned process tree was stopped.".into(),
        );
    }
    Ok(bytes)
}

/// Monitor only the known owned working directory; do not enumerate unrelated processes or user data.
async fn monitor_workspace(directory: &Path) -> Result<(), String> {
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        check_workspace_budget(directory)?;
    }
}

/// Bound metadata work as well as actual owned file bytes, refusing redirected descendants.
pub(super) fn check_workspace_budget(directory: &Path) -> Result<(), String> {
    replay_receipt::ensure_plain_path(directory)?;
    if !fs::metadata(directory)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("The fixed validation workspace root is not a directory.".into());
    }
    let mut pending = vec![(directory.to_path_buf(), 0usize)];
    let mut entries = 0usize;
    let mut bytes = 0u64;
    while let Some((folder, depth)) = pending.pop() {
        if depth > 20 {
            return Err("Validation workspace nesting exceeded its limit.".into());
        }
        scan_directory(&folder, depth, &mut pending, &mut entries, &mut bytes)?;
    }
    Ok(())
}

/// Process one bounded directory without recursive shell cleanup or following filesystem links.
fn scan_directory(
    folder: &Path,
    depth: usize,
    pending: &mut Vec<(PathBuf, usize)>,
    entries: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    let entries_read = match fs::read_dir(folder) {
        Ok(value) => value,
        Err(error) if depth > 0 && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries_read {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        replay_receipt::ensure_plain_path(&path)?;
        *entries += 1;
        if *entries > MAX_WORKSPACE_ENTRIES {
            return Err("Validation workspace file count exceeded its limit.".into());
        }
        scan_existing_entry(&entry, depth, pending, bytes)?;
    }
    Ok(())
}

/// Use non-following enumeration metadata so Windows delete-pending files need no failing reopen; permission errors remain fatal.
fn scan_existing_entry(
    entry: &fs::DirEntry,
    depth: usize,
    pending: &mut Vec<(PathBuf, usize)>,
    bytes: &mut u64,
) -> Result<(), String> {
    match entry.metadata() {
        Ok(metadata) if replay_receipt::is_reparse(&metadata) => {
            Err("Validation workspace contains a reparse point.".into())
        }
        Ok(metadata) => add_workspace_entry(&entry.path(), &metadata, depth, pending, bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Account actual file sizes with checked arithmetic before permitting the next monitoring interval.
fn add_workspace_entry(
    path: &Path,
    metadata: &fs::Metadata,
    depth: usize,
    pending: &mut Vec<(PathBuf, usize)>,
    bytes: &mut u64,
) -> Result<(), String> {
    if metadata.is_dir() {
        pending.push((path.to_path_buf(), depth + 1));
        return Ok(());
    }
    *bytes = bytes
        .checked_add(metadata.len())
        .ok_or("Validation workspace size overflowed.")?;
    if *bytes > MAX_WORKSPACE_BYTES {
        return Err(
            "Validation workspace exceeded 512 MiB; its owned process tree was stopped.".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "full_validation_process_tests.rs"]
mod tests;
