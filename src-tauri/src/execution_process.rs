//! Bounded ordinary replay through the shared parent-owned job; original engine arguments remain unchanged.
use crate::{engine_job::OwnedValidationJob, workspace_build};
use std::{
    path::Path,
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
const HOST_EXIT_SECONDS: u64 = 5;
const HOST_READY: &str = "BACKTESTENGINE_REPLAY_HOST_READY";

/// Both executable paths come from native runtime verification; no renderer may supply either path.
pub(crate) struct ReplayRuntime<'a> {
    pub compiler: &'a Path,
    pub host: &'a Path,
}

/// Only four fixed app-owned host operations exist; no arbitrary executable or shell is accepted.
#[derive(Clone, Copy)]
pub(crate) enum ToolMode {
    Replay,
    Build,
    Metadata,
    SdkProbe,
}

/// Native-only phase request; bootstrap is verified independently from the SDK candidate being probed or used.
pub(crate) struct ToolRequest<'a> {
    pub bootstrap: &'a Path,
    pub host: &'a Path,
    pub candidate: &'a Path,
    pub mode: ToolMode,
    pub arguments: &'a [String],
    pub working: &'a Path,
    pub environment: &'a [(&'a str, String)],
    pub timeout_seconds: u64,
}

/// Run the exact frozen DLL/CLI vector with bounded capture; only confirmed host AND descendant exit releases caller locks.
/// The caller must retain frozen inputs and keep its busy latch when cleanup_confirmed remains false, including future drop.
pub(crate) async fn run_replay(
    runtime: ReplayRuntime<'_>,
    arguments: &[String],
    working: &Path,
    cancel: &mut oneshot::Receiver<()>,
    timeout_seconds: u64,
    cleanup_confirmed: Arc<AtomicBool>,
) -> Result<Output, String> {
    run_workspace_tool(
        ToolRequest {
            bootstrap: runtime.compiler,
            host: runtime.host,
            candidate: runtime.compiler,
            mode: ToolMode::Replay,
            arguments,
            working,
            environment: &[],
            timeout_seconds,
        },
        cancel,
        cleanup_confirmed,
    )
    .await
}

/// Share bounded capture and exact owned-tree/direct-host exit proof across the four fixed host phases.
pub(crate) async fn run_workspace_tool(
    request: ToolRequest<'_>,
    cancel: &mut oneshot::Receiver<()>,
    cleanup_confirmed: Arc<AtomicBool>,
) -> Result<Output, String> {
    check_pre_dispatch_cancel(cancel)?;
    if !cleanup_confirmed.load(Ordering::Acquire) {
        return Err(format!(
            "{}: previous engine cleanup remains unconfirmed; restart before another dispatch.",
            crate::engine_job::CLEANUP_UNCONFIRMED
        ));
    }
    let bootstrap = crate::build_process::sdk_launch_path(request.bootstrap)?;
    let candidate = crate::build_process::sdk_launch_path(request.candidate)?;
    let request = ToolRequest {
        bootstrap: &bootstrap,
        candidate: &candidate,
        ..request
    };
    let job_cleanup = Arc::new(AtomicBool::new(true));
    let job = OwnedValidationJob::create(job_cleanup)?;
    let vector = tool_arguments(&request, &job.name)?;
    let mut command = tokio::process::Command::new(request.bootstrap);
    command
        .args(vector)
        .current_dir(request.working)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (name, value) in request.environment {
        command.env(name, value);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    cleanup_confirmed.store(false, Ordering::Release);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            cleanup_confirmed.store(true, Ordering::Release);
            return Err(format!(
                "The contained replay host could not start ({error})."
            ));
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or("Replay host stdout is missing.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Replay host stderr is missing.")?;
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
    let outcome: Result<Output, String> = tokio::select! {
        result=tokio::time::timeout(Duration::from_secs(request.timeout_seconds),capture)=>match result {
            Ok(value)=>value,
            Err(_)=>Err(format!("The process did not respond within {} seconds; owned termination was requested.",request.timeout_seconds)),
        },
        _=&mut *cancel=>Err(workspace_build::CANCELLATION_MESSAGE.into()),
    };
    if outcome.is_err() {
        let _ = child.start_kill();
    }
    let tree_cleanup = job.terminate_and_drain().await;
    let host_cleanup =
        tokio::time::timeout(Duration::from_secs(HOST_EXIT_SECONDS), child.wait()).await;
    // Job accounting excludes a host that failed before joining; its direct exit must be independently observed.
    if !matches!(host_cleanup, Ok(Ok(_))) {
        return Err(format!("{}: replay host exit could not be confirmed; restart before running another engine job.",crate::engine_job::CLEANUP_UNCONFIRMED));
    }
    tree_cleanup?;
    cleanup_confirmed.store(true, Ordering::Release);
    let output = outcome?;
    verify_phase_ready(&output, request.mode)?;
    Ok(output)
}

/// Stop before job creation or process dispatch when cancellation is already signaled or its owner disappeared.
fn check_pre_dispatch_cancel(cancel: &mut oneshot::Receiver<()>) -> Result<(), String> {
    match cancel.try_recv() {
        Ok(()) | Err(oneshot::error::TryRecvError::Closed) => {
            Err(workspace_build::CANCELLATION_MESSAGE.into())
        }
        Err(oneshot::error::TryRecvError::Empty) => Ok(()),
    }
}

/// Frame the original arguments as individual arguments after a fixed host delimiter; never create a shell command.
#[cfg(test)]
fn replay_arguments(
    runtime: &ReplayRuntime<'_>,
    arguments: &[String],
    working: &Path,
    job: &str,
) -> Result<Vec<std::ffi::OsString>, String> {
    tool_arguments(
        &ToolRequest {
            bootstrap: runtime.compiler,
            host: runtime.host,
            candidate: runtime.compiler,
            mode: ToolMode::Replay,
            arguments,
            working,
            environment: &[],
            timeout_seconds: 1,
        },
        job,
    )
}

/// Validate phase-specific paths before framing fixed managed-host arguments.
fn tool_arguments(request: &ToolRequest<'_>, job: &str) -> Result<Vec<std::ffi::OsString>, String> {
    let sdk = request
        .candidate
        .parent()
        .ok_or("The SDK directory is invalid.")?;
    if matches!(request.mode, ToolMode::SdkProbe) {
        if !request.arguments.is_empty() {
            return Err("SDK probes cannot carry arbitrary arguments.".into());
        }
        return Ok(vec![
            request.host.as_os_str().to_owned(),
            "--sdk-probe".into(),
            "--candidate".into(),
            request.candidate.as_os_str().to_owned(),
            "--working".into(),
            request.working.as_os_str().to_owned(),
            "--job".into(),
            job.into(),
        ]);
    }
    validate_phase_arguments(request)?;
    let mut vector = vec![
        request.host.as_os_str().to_owned(),
        phase_flag(request.mode).into(),
        "--sdk".into(),
        sdk.as_os_str().to_owned(),
        "--working".into(),
        request.working.as_os_str().to_owned(),
        "--job".into(),
        job.into(),
        "--".into(),
    ];
    vector.extend(request.arguments.iter().map(std::ffi::OsString::from));
    Ok(vector)
}

/// Each mode binds its original argv to one known owned input; CLI option values are forwarded unchanged.
fn validate_phase_arguments(request: &ToolRequest<'_>) -> Result<(), String> {
    let args = request.arguments;
    let matches = match request.mode {
        ToolMode::Replay => args
            .first()
            .is_some_and(|value| Path::new(value) == request.working.join("WorkspaceCompile.dll")),
        ToolMode::Build => {
            args.first().is_some_and(|value| value == "build")
                && args.get(1).is_some_and(|value| {
                    Path::new(value) == request.working.join("WorkspaceCompile.csproj")
                })
        }
        ToolMode::Metadata => {
            args.len() == 2
                && args[0] == "exec"
                && Path::new(&args[1]) == request.working.join("WorkspaceCompile.dll")
        }
        ToolMode::SdkProbe => false,
    };
    if !matches {
        return Err("The tool arguments differ from their exact owned phase input.".into());
    }
    Ok(())
}

/// Fixed protocol tags are private implementation details, never arbitrary renderer-selected commands.
fn phase_flag(mode: ToolMode) -> &'static str {
    match mode {
        ToolMode::Replay => "--replay",
        ToolMode::Build => "--build",
        ToolMode::Metadata => "--metadata",
        ToolMode::SdkProbe => "--sdk-probe",
    }
}

/// Bound each stream before accumulation; overflow fails the run and triggers owned-tree termination.
async fn bounded_output(stream: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stream
        .take(MAX_STREAM_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_STREAM_BYTES {
        return Err("Tool output exceeded 128 KiB; owned-tree termination was requested.".into());
    }
    Ok(bytes)
}

/// A zero exit without the verified host's readiness boundary cannot promote any report left on disk.
#[cfg(test)]
fn verify_ready(output: &Output) -> Result<(), String> {
    verify_phase_ready(output, ToolMode::Replay)
}

/// A zero exit from any contained phase requires its exact host readiness boundary.
fn verify_phase_ready(output: &Output, mode: ToolMode) -> Result<(), String> {
    let marker = match mode {
        ToolMode::Replay => HOST_READY,
        ToolMode::Build => "BACKTESTENGINE_BUILD_HOST_READY",
        ToolMode::Metadata => "BACKTESTENGINE_METADATA_HOST_READY",
        ToolMode::SdkProbe => "BACKTESTENGINE_SDK_PROBE_HOST_READY",
    };
    if output.status.success()
        && !String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line == marker)
    {
        return Err("The contained replay host did not confirm its owned launch boundary.".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "execution_process_tests.rs"]
mod tests;

#[cfg(all(test, windows))]
#[path = "execution_process_actual_tests.rs"]
mod actual_tests;
