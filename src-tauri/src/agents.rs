use crate::preferences::AgentProvider;
use serde::Serialize;
use std::{path::PathBuf, time::Duration};
use tokio::process::Command;

/// Public connection evidence contains only a provider/version, never credentials or raw CLI output.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnection {
    pub provider: AgentProvider,
    pub version: String,
}

/// Discover the desktop-managed OpenCode CLI through its documented local install folder.
pub(crate) fn find_opencode() -> Option<PathBuf> {
    let base = PathBuf::from(std::env::var_os("APPDATA")?).join("ai.opencode.desktop/cli");
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(base)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("opencode-cli.exe"))
        .filter(|path| path.is_file())
        .collect();
    candidates.sort();
    candidates.pop()
}

/// Verify the existing local OpenCode service with a bounded read-only info call; never start sessions or models.
pub async fn connect(
    provider: AgentProvider,
    cancellation: tokio::sync::oneshot::Receiver<()>,
) -> Result<AgentConnection, String> {
    if provider != AgentProvider::Opencode {
        return Err("This build can connect to an existing OpenCode service. Codex and Claude Code connections are not available yet. Choose OpenCode or skip for now.".into());
    }
    let executable = find_opencode().ok_or(
        "OpenCode Desktop was not found. Open OpenCode Desktop and retry, or skip for now.",
    )?;
    let mut command = Command::new(executable);
    command.args(["api", "GET", "/api/info"]).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let response = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(10), command.output()) => result,
        _ = cancellation => return Err("Connection canceled. You can retry or skip for now.".into()),
    };
    let output = response
        .map_err(|_| "OpenCode did not respond within 10 seconds. Open OpenCode Desktop and retry, or skip for now.".to_string())?
        .map_err(|_| "OpenCode could not be opened. Restart OpenCode Desktop and retry, or skip for now.".to_string())?;
    if !output.status.success() {
        return Err(
            "OpenCode is not responding. Open OpenCode Desktop and retry, or skip for now.".into(),
        );
    }
    parse_connection(&output.stdout)
}

/// Accept only a concrete local service version from the CLI response; raw metadata stays outside the UI.
fn parse_connection(bytes: &[u8]) -> Result<AgentConnection, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "OpenCode returned an unreadable response. Update OpenCode Desktop and retry, or skip for now.".to_string())?;
    let info = value.get("data").unwrap_or(&value);
    let version = info.get("version").and_then(|value| value.as_str()).filter(|value| !value.is_empty() && value.len() < 100)
        .ok_or("OpenCode did not confirm a service version. Restart OpenCode Desktop and retry, or skip for now.")?;
    Ok(AgentConnection {
        provider: AgentProvider::Opencode,
        version: version.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// Only real version-bearing info payloads count as connection evidence.
    fn parses_service_info_without_exposing_extra_metadata() {
        assert_eq!(
            parse_connection(br#"{"version":"2.1.4","other":"private"}"#)
                .unwrap()
                .version,
            "2.1.4"
        );
        assert_eq!(
            parse_connection(br#"{"data":{"version":"2.1.4"}}"#)
                .unwrap()
                .version,
            "2.1.4"
        );
        assert!(parse_connection(br#"{"ok":true}"#).is_err());
        assert!(parse_connection(b"invalid").is_err());
    }
}
