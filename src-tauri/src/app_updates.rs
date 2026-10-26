//! Explicit, opt-in HTTPS release metadata checks. No downloads, installation or restart operation exists.

use crate::app_settings::{validate_version, AppSettingsState};
use serde::{Deserialize, Serialize};
use std::{io::Read, sync::atomic::Ordering, time::Duration};
use tauri::State;

const RELEASE_ENDPOINT: &str =
    "https://api.github.com/repos/Dotatel/BacktestEngine/releases/latest";
const MAX_RELEASE_BYTES: usize = 1_000_000;

/// Honest outcome of one explicit manual check; errors are not successful version comparisons.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCheck {
    status: &'static str,
    current_version: String,
    latest_version: Option<String>,
    checked_at: Option<String>,
    message: String,
    release_url: Option<String>,
    download_url: Option<String>,
    notes: Option<String>,
    dismissed: bool,
}

/// Only fields relevant to a stable public release are trusted after strict validation.
#[derive(Deserialize)]
struct ReleasePayload {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    html_url: String,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

/// A project-hosted asset may be offered as a browser link, never automatically fetched or installed.
#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

/// Bounded transport evidence, separate from release interpretation for deterministic simulation tests.
struct ReleaseResponse {
    status: u16,
    bytes: Vec<u8>,
}

/// Restore the single-check latch on every result, including transport, payload and storage errors.
struct CheckGuard<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for CheckGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Contact exactly one fixed HTTPS source, with no redirects, credentials, retries or unbounded body read.
fn fetch_release() -> Result<ReleaseResponse, String> {
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("BacktestEngine/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("The HTTPS client could not start ({error})."))?;
    let response = client
        .get(RELEASE_ENDPOINT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|error| {
            if error.is_timeout() {
                "The manual release check timed out after five seconds.".to_string()
            } else {
                "The release source could not be reached. Check your connection and retry manually."
                    .to_string()
            }
        })?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    response
        .take((MAX_RELEASE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "The release response could not be read within the request limit.")?;
    if bytes.len() > MAX_RELEASE_BYTES {
        return Err("The release response exceeds the 1 MB limit.".into());
    }
    Ok(ReleaseResponse { status, bytes })
}

/// Disabled checks return before invoking transport; consent is rechecked after the request settles.
fn check_release(
    state: &AppSettingsState,
    fetch: impl FnOnce() -> Result<ReleaseResponse, String>,
) -> Result<ReleaseCheck, String> {
    if !state.read()?.updates.enabled {
        return Ok(outcome(
            state,
            "disabled",
            None,
            "Manual release checks are disabled.",
        ));
    }
    if state
        .update_check_running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("A manual release check is already running.".into());
    }
    let _guard = CheckGuard(&state.update_check_running);
    let checked_at = chrono::Utc::now().to_rfc3339();
    let response = fetch();
    if !state.read()?.updates.enabled {
        return Ok(outcome(
            state,
            "disabled",
            Some(checked_at),
            "Manual release checks were disabled while the request was running.",
        ));
    }
    match response {
        Ok(response) => interpret_release(state, response, checked_at),
        Err(message) => Ok(outcome(state, "error", Some(checked_at), &message)),
    }
}

/// Distinguish absent public metadata/rate limits/HTTP failures from valid successful version comparisons.
fn interpret_release(
    state: &AppSettingsState,
    response: ReleaseResponse,
    checked_at: String,
) -> Result<ReleaseCheck, String> {
    if response.status == 404 {
        return Ok(outcome(
            state,
            "noRelease",
            Some(checked_at),
            "No public release information is available from the configured project source.",
        ));
    }
    if response.status == 429 || response.status == 403 {
        return Ok(outcome(
            state,
            "rateLimited",
            Some(checked_at),
            "The release source declined this request or rate-limited it. Retry manually later.",
        ));
    }
    if response.status != 200 {
        return Ok(outcome(
            state,
            "error",
            Some(checked_at),
            &format!(
                "The release source returned HTTP {}. Version status is unavailable.",
                response.status
            ),
        ));
    }
    let result = validated_release(state, &response.bytes, &checked_at);
    match result {
        Ok(result) => Ok(result),
        Err(message) => Ok(outcome(state, "error", Some(checked_at), &message)),
    }
}

/// Validate stable SemVer and same-repository links, then stamp only genuinely valid release metadata.
fn validated_release(
    state: &AppSettingsState,
    bytes: &[u8],
    checked_at: &str,
) -> Result<ReleaseCheck, String> {
    if bytes.len() > MAX_RELEASE_BYTES {
        return Err("The release response exceeds the 1 MB limit.".into());
    }
    let payload: ReleasePayload = serde_json::from_slice(bytes)
        .map_err(|_| "The source returned invalid release metadata.")?;
    if payload.draft || payload.prerelease {
        return Err(
            "The source did not return a stable public release. Version status is unavailable."
                .into(),
        );
    }
    let latest = validate_version(
        payload
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&payload.tag_name),
    )?;
    if !latest.pre.is_empty() {
        return Err("The source did not return a stable semantic version.".into());
    }
    let current = validate_version(&state.app_version)?;
    let release_url = trusted_release_url(&payload.html_url)?;
    let download_url = payload
        .assets
        .iter()
        .filter(|asset| windows_asset(&asset.name))
        .find_map(|asset| trusted_download_url(&asset.browser_download_url).ok());
    let dismissed = state
        .read()?
        .updates
        .dismissed_versions
        .contains(&latest.to_string());
    let status = if latest.cmp_precedence(&current).is_gt() {
        "updateAvailable"
    } else {
        "upToDate"
    };
    state.change(|settings| {
        if settings.updates.enabled {
            settings.updates.last_successful_check_at = Some(checked_at.to_string());
        }
        Ok(())
    })?;
    Ok(ReleaseCheck {
        status,
        current_version: current.to_string(),
        latest_version: Some(latest.to_string()),
        checked_at: Some(checked_at.to_string()),
        message: if status == "updateAvailable" {
            "A newer stable release is available. Review it in your browser.".into()
        } else {
            "The installed version is current with the stable release returned by this source."
                .into()
        },
        release_url: Some(release_url),
        download_url,
        notes: payload.body.map(|text| clean_notes(&text)),
        dismissed,
    })
}

/// Project release pages are the only permitted browser destinations.
pub(crate) fn trusted_release_url(value: &str) -> Result<String, String> {
    if value.len() > 2048 {
        return Err("The release link exceeds the supported length.".into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "The release link is invalid.")?;
    let path = url.path().to_ascii_lowercase();
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !path.starts_with("/dotatel/backtestengine/releases/")
    {
        return Err("The release link is outside the trusted project repository.".into());
    }
    Ok(url.to_string())
}

/// Download links stay on the exact project release-download path and are opened only by user action.
fn trusted_download_url(value: &str) -> Result<String, String> {
    let url = trusted_release_url(value)?;
    if !reqwest::Url::parse(&url)
        .map_err(|_| "Invalid release download URL.")?
        .path()
        .to_ascii_lowercase()
        .starts_with("/dotatel/backtestengine/releases/download/")
    {
        return Err("The installer link is not a project release asset.".into());
    }
    Ok(url)
}

/// Only an explicitly named Windows installer/archive is offered; absence stays absent.
fn windows_asset(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    (name.contains("win") || name.contains("windows"))
        && [".exe", ".msi", ".zip"]
            .iter()
            .any(|extension| name.ends_with(extension))
}

/// Notes are plain bounded text; UI rendering never interprets HTML or Markdown from the release source.
fn clean_notes(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .take(2000)
        .collect()
}

/// Build an honest non-comparison outcome with no invented version or release URL.
fn outcome(
    state: &AppSettingsState,
    status: &'static str,
    checked_at: Option<String>,
    message: &str,
) -> ReleaseCheck {
    ReleaseCheck {
        status,
        current_version: state.app_version.clone(),
        latest_version: None,
        checked_at,
        message: message.into(),
        release_url: None,
        download_url: None,
        notes: None,
        dismissed: false,
    }
}

/// Run one manual check off the UI thread; no startup or scheduled call path exists.
#[tauri::command]
pub async fn app_updates_check(state: State<'_, AppSettingsState>) -> Result<ReleaseCheck, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || check_release(&state, fetch_release))
        .await
        .map_err(|error| format!("The release check could not finish ({error})."))?
}

/// Persist one explicit version dismissal without contacting a release source.
#[tauri::command]
pub fn app_updates_dismiss(version: String, state: State<AppSettingsState>) -> Result<(), String> {
    let version = validate_version(&version)?.to_string();
    state.change(|settings| {
        if !settings.updates.dismissed_versions.contains(&version) {
            settings.updates.dismissed_versions.push(version);
        }
        if settings.updates.dismissed_versions.len() > 50 {
            settings.updates.dismissed_versions.remove(0);
        }
        Ok(())
    })
}

/// Open a verified same-project HTTPS link only after an explicit user click; never download/install.
#[tauri::command]
pub fn app_updates_open_release(url: String, state: State<AppSettingsState>) -> Result<(), String> {
    if !state.read()?.updates.enabled {
        return Err("Manual release checks are disabled.".into());
    }
    let url = trusted_release_url(&url)?;
    open_browser(&url)
}

/// Use the Windows URL handler directly without a shell, URL interpolation or hidden installation.
#[cfg(windows)]
fn open_browser(url: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(0x08000000)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("The release page could not be opened ({error})."))
}

/// Non-Windows test hosts do not impersonate an installed browser integration.
#[cfg(not(windows))]
fn open_browser(_url: &str) -> Result<(), String> {
    Err("Opening release pages requires the Windows desktop app.".into())
}

#[cfg(test)]
#[path = "app_updates_tests.rs"]
mod tests;
