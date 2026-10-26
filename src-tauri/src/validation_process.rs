//! Bounded, cancelable Python subprocess capture for report-only validation.
use std::{
    path::Path,
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::oneshot,
};

const MAX_CAPTURE_BYTES: u64 = 64 * 1024;

/// Run the preserved Python CLI with bounded output; dropping this future terminates its direct child.
pub(super) async fn run_python(
    python: &Path,
    arguments: &[&str],
    source: &Path,
    cancel: &mut oneshot::Receiver<()>,
    timeout_seconds: u64,
) -> Result<Output, String> {
    let mut command = tokio::process::Command::new(python);
    command
        .args(arguments)
        .current_dir(source)
        .env("PYTHONPATH", source)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Python could not start ({error})."))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Python stdout was unavailable.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Python stderr was unavailable.")?;
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
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(timeout_seconds), capture) => result.map_err(|_| format!("Python did not respond within {timeout_seconds} seconds and was stopped."))?,
        _ = &mut *cancel => Err(crate::workspace_build::CANCELLATION_MESSAGE.into()),
    }
}

/// Stop capture at the boundary instead of accumulating unlimited output and truncating afterward.
async fn bounded_output(stream: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stream
        .take(MAX_CAPTURE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("Python output could not be read ({error})."))?;
    if bytes.len() as u64 > MAX_CAPTURE_BYTES {
        return Err("Python output exceeded the 64 KiB stream limit and was stopped.".into());
    }
    Ok(bytes)
}
