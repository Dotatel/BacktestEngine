//! Fixed existing-service CLI transport; no server/password/auto flags, auth/config reads or raw diagnostics.
use super::policy;
use serde_json::Value;
use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};

/// Only these service operations are permitted by the assistant; no arbitrary endpoint/command is accepted from UI.
#[derive(Clone, Debug)]
pub(super) enum ApiCall {
    Info,
    Models,
    Agent,
    Create(Value),
    Session(String),
    Prompt(String, Value),
    Messages(String),
    Inbox(String),
    CancelInbox(String, String),
    Interrupt(String),
    Wait(String),
}

/// The transport distinguishes a local pre-dispatch rejection from an ambiguous request already sent to the service.
#[derive(Debug)]
pub(super) struct CallError {
    pub message: String,
    pub may_have_dispatched: bool,
}

impl CallError {
    /// A process/argument failure before spawn proves that this API request never reached OpenCode.
    pub(super) fn not_dispatched(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            may_have_dispatched: false,
        }
    }
    /// Once spawned, killing a CLI cannot establish whether its durable POST reached the service.
    pub(super) fn ambiguous(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            may_have_dispatched: true,
        }
    }
}

impl From<CallError> for String {
    /// Other API callers expose only the sanitized diagnostic; prompt orchestration retains dispatch certainty explicitly.
    fn from(error: CallError) -> Self {
        error.message
    }
}

/// Inject one narrow asynchronous service seam for security/lifecycle tests without creating live sessions.
pub(super) trait AssistantTransport: Send + Sync {
    /// Perform one fixed safe service operation with bounded output/deadline and an explicit cancellation flag.
    fn call<'a>(
        &'a self,
        operation: ApiCall,
        cancel: &'a AtomicBool,
    ) -> Pin<Box<dyn Future<Output = Result<Value, CallError>> + Send + 'a>>;
}

/// The native host supplies both the registered CLI and the isolated app-owned context directory.
pub(super) struct CliTransport {
    pub executable: PathBuf,
    pub directory: PathBuf,
}

impl AssistantTransport for CliTransport {
    /// Use only the existing background service's normal authenticated CLI discovery, with fixed bounded arguments.
    fn call<'a>(
        &'a self,
        operation: ApiCall,
        cancel: &'a AtomicBool,
    ) -> Pin<Box<dyn Future<Output = Result<Value, CallError>> + Send + 'a>> {
        Box::pin(async move {
            if cancel.load(Ordering::SeqCst) {
                return Err(CallError::not_dispatched(
                    "Assistant request cancelled before dispatch.",
                ));
            }
            let args = arguments(&operation, &self.directory.to_string_lossy())
                .map_err(CallError::not_dispatched)?;
            if args
                .iter()
                .map(|value| value.encode_utf16().count() + 1)
                .sum::<usize>()
                > 30_000
            {
                return Err(CallError::not_dispatched("The reviewed prompt exceeds the Windows CLI argument limit. Shorten the message or context; nothing was sent."));
            }
            let mut command = tokio::process::Command::new(&self.executable);
            command
                .args(args)
                .current_dir(&self.directory)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            let mut child = command.spawn().map_err(|_| {
                CallError::not_dispatched(
                    "OpenCode could not be opened. Open OpenCode Desktop and reconnect.",
                )
            })?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| CallError::ambiguous("OpenCode stdout is unavailable."))?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| CallError::ambiguous("OpenCode stderr is unavailable."))?;
            let capture = async {
                let (status, stdout, _stderr) = tokio::try_join!(
                    async {
                        child
                            .wait()
                            .await
                            .map_err(|_| "OpenCode could not be observed.".to_string())
                    },
                    bounded(stdout, output_limit(&operation)),
                    bounded(stderr, 16 * 1024)
                )?;
                if !status.success() {
                    return Err("The OpenCode request failed. Check its connection or free-model quota in OpenCode Desktop; no fallback was selected.".into());
                }
                if stdout.is_empty() {
                    return Ok(Value::Null);
                }
                serde_json::from_slice(&stdout).map_err(|_|"OpenCode returned an unreadable response. Reconnect or update OpenCode Desktop.".into())
            };
            let seconds = if matches!(operation, ApiCall::Info) {
                10
            } else {
                30
            };
            let result: Result<Value, String> = tokio::select! {
                value=tokio::time::timeout(Duration::from_secs(seconds),capture)=>match value{Ok(value)=>value,Err(_)=>Err("The OpenCode request timed out. No automatic retry or fallback was attempted.".into())},
                ()=cancelled(cancel)=>Err("Assistant request cancelled.".into()),
            };
            if result.is_err() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            result.map_err(CallError::ambiguous)
        })
    }
}

/// Validate native-observed IDs again while building the fixed command vector; include an explicit metadata location.
pub(super) fn arguments(operation: &ApiCall, directory: &str) -> Result<Vec<String>, String> {
    let location = format!("location%5Bdirectory%5D={}", encode_query(directory));
    let (method, path, body) = match operation {
        ApiCall::Info => ("GET", "/api/info".into(), None),
        ApiCall::Models => ("GET", format!("/api/model?{location}"), None),
        ApiCall::Agent => (
            "GET",
            format!("/api/agent/{}?{location}", policy::AGENT_ID),
            None,
        ),
        ApiCall::Create(body) => ("POST", "/api/session".into(), Some(body)),
        ApiCall::Session(id) => ("GET", session_path(id, "")?, None),
        ApiCall::Prompt(id, body) => ("POST", session_path(id, "/prompt")?, Some(body)),
        ApiCall::Messages(id) => (
            "GET",
            session_path(id, "/message?limit=100&order=desc")?,
            None,
        ),
        ApiCall::Inbox(id) => ("GET", session_path(id, "/inbox")?, None),
        ApiCall::CancelInbox(id, message) => {
            if !policy::provider_id(message, "msg_") {
                return Err("The owned assistant inbox identity is invalid.".into());
            }
            (
                "DELETE",
                session_path(id, &format!("/inbox/{message}"))?,
                None,
            )
        }
        ApiCall::Interrupt(id) => ("POST", session_path(id, "/interrupt?resume=false")?, None),
        ApiCall::Wait(id) => (
            "POST",
            format!("/api/experimental/session/{}/wait", valid_session(id)?),
            None,
        ),
    };
    let mut args = vec!["api".into(), method.into(), path];
    if let Some(body) = body {
        args.push("--data".into());
        args.push(
            serde_json::to_string(body)
                .map_err(|_| "The assistant request could not be prepared.")?,
        );
    }
    Ok(args)
}

/// Encode only the known host-owned directory; no URL scheme, host or arbitrary query is accepted.
fn encode_query(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Session IDs are opaque native observations, not renderer-controlled path fragments.
fn valid_session(id: &str) -> Result<&str, String> {
    if !policy::provider_id(id, "ses_") {
        return Err("The owned assistant session identity is invalid.".into());
    }
    Ok(id)
}

/// Bind every session operation to the one native-observed session, never an arbitrary endpoint.
fn session_path(id: &str, suffix: &str) -> Result<String, String> {
    Ok(format!("/api/session/{}{suffix}", valid_session(id)?))
}

/// Model metadata can be larger than a conversation; all stdout and stderr streams have fixed memory bounds.
fn output_limit(operation: &ApiCall) -> usize {
    if matches!(operation, ApiCall::Models) {
        4 * 1024 * 1024
    } else {
        1024 * 1024
    }
}

/// Reject oversized output without surfacing its potentially credential-bearing contents.
async fn bounded(stream: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stream
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "OpenCode output could not be read.")?;
    if bytes.len() > limit {
        return Err("OpenCode output exceeded the assistant's safe response limit; raw output was discarded.".into());
    }
    Ok(bytes)
}

/// Interruptible short polling keeps cancellation responsive without relying on a process observation timeout.
pub(super) async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    /// Output caps reject one byte over the boundary and retain exact valid bytes without raw diagnostic interpolation.
    async fn capture_bounds_are_exact_and_do_not_echo_discarded_output() {
        assert_eq!(bounded(&b"safe"[..], 4).await.unwrap(), b"safe");
        let error = bounded(&b"SYNTHETIC_PRIVATE_DIAGNOSTIC"[..], 4)
            .await
            .unwrap_err();
        assert!(!error.contains("PRIVATE"));
    }
}
