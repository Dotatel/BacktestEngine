use std::{path::PathBuf, time::Duration};
use tokio::process::Command;

/// Invoke the preserved self-contained engine with one fixed, read-only metadata command and a bounded lifetime.
pub async fn metadata(executable: PathBuf) -> Result<serde_json::Value, String> {
    if !executable.is_file() {
        return Err("The bundled C# engine is missing. Run the documented engine preparation step and rebuild the app.".into());
    }
    let mut command = Command::new(executable);
    command
        .args(["--describe-strategy", "ExampleStrategy"])
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "The C# engine did not respond within 15 seconds.".to_string())?
        .map_err(|_| "The bundled C# engine could not start.".to_string())?;
    if !output.status.success() {
        return Err("The C# engine could not describe its example strategy.".into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json = stdout
        .lines()
        .find_map(|line| line.strip_prefix("BACKTESTENGINE_STRATEGY_METADATA "))
        .ok_or("The C# engine did not return strategy metadata.")?;
    serde_json::from_str(json)
        .map_err(|_| "The C# engine returned invalid strategy metadata.".into())
}
