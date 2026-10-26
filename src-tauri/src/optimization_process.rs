//! Bounded native capture; the native parent owns kernel cancellation and confirms complete teardown.
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

/// Run only the verified optimizer host assembly with fixed native arguments and isolated build/cache settings.
pub(super) async fn run_optimizer(
    compiler: &Path,
    host: &Path,
    config: &Path,
    working: &Path,
    cancel: &mut oneshot::Receiver<()>,
    timeout_seconds: u64,
    cleanup_confirmed: Arc<AtomicBool>,
) -> Result<Output, String> {
    if !matches!(cancel.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
        return Err("Optimization was canceled before dispatch.".into());
    }
    if !cleanup_confirmed.load(Ordering::Acquire) {
        return Err(format!(
            "{}: optimizer cleanup is not confirmed.",
            crate::engine_job::CLEANUP_UNCONFIRMED
        ));
    }
    let compiler = crate::build_process::sdk_launch_path(compiler)?;
    let sdk = compiler
        .parent()
        .ok_or("The optimizer SDK location is invalid.")?;
    let mut path = vec![sdk.to_path_buf()];
    path.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let path = std::env::join_paths(path).map_err(|_| "The SDK search path is invalid.")?;
    let job = crate::engine_job::OwnedValidationJob::create(Arc::new(AtomicBool::new(true)))?;
    let mut command = tokio::process::Command::new(&compiler);
    command
        .arg(host)
        .arg("--job")
        .arg(&job.name)
        .arg("--")
        .arg("--config")
        .arg(config)
        .current_dir(working)
        .env("PATH", path)
        .env("DOTNET_ROOT", sdk)
        .env("DOTNET_ROOT_X64", sdk)
        .env("DOTNET_MULTILEVEL_LOOKUP", "0")
        .env("DOTNET_CLI_HOME", working.join("cli-home"))
        .env("NUGET_PACKAGES", working.join("nuget-packages"))
        .env("NUGET_HTTP_CACHE_PATH", working.join("nuget-http-cache"))
        .env("RestoreConfigFile", working.join("runner/NuGet.Config"))
        .env("NuGetAudit", "false")
        .env("DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE", "true")
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
        .env("DOTNET_GENERATE_ASPNET_CERTIFICATE", "false")
        .env("DOTNET_NOLOGO", "1")
        .env("MSBUILDDISABLENODEREUSE", "1")
        .env("UseSharedCompilation", "false")
        .env("Configuration", "Release")
        .env("BaseOutputPath", "bin/Debug/")
        .env("UseAppHost", "false")
        .env_remove("MSBuildSDKsPath")
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
                "The original optimizer host could not start ({error})."
            ));
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or("Optimizer stdout is unavailable.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Optimizer stderr is unavailable.")?;
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
        result = tokio::time::timeout(Duration::from_secs(timeout_seconds),capture) => match result {
            Ok(value) => value,
            Err(_) => Err(format!("Optimization exceeded {timeout_seconds} seconds; its owned process tree was stopped.")),
        },
        _ = &mut *cancel => Err("Optimization was canceled; its owned process tree was stopped.".into()),
    };
    if outcome.is_err() {
        let _ = child.start_kill();
    }
    let tree_cleanup = job.terminate_and_drain().await;
    let host_cleanup = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    if !matches!(host_cleanup, Ok(Ok(_))) {
        return Err(format!("{}: direct optimizer host exit could not be confirmed; restart before another engine job.", crate::engine_job::CLEANUP_UNCONFIRMED));
    }
    tree_cleanup?;
    cleanup_confirmed.store(true, Ordering::Release);
    if let Ok(output) = &outcome {
        if String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| *line == "BACKTESTENGINE_OPTIMIZER_HOST_READY")
            .count()
            != 1
        {
            return Err(
                "The optimizer did not confirm its exact parent-owned process boundary.".into(),
            );
        }
    }
    outcome
}

/// Stop unbounded output before accumulation; parent job teardown must still finish before the caller may reuse inputs.
async fn bounded_output(stream: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stream
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() > 128 * 1024 {
        return Err(
            "Optimizer output exceeded its 128 KiB stream bound; its process tree was stopped."
                .into(),
        );
    }
    Ok(bytes)
}
