use super::*;
use crate::app_settings::tests::state;

/// Authentic release field shapes with deterministic same-repository URLs; never a live provider call.
fn response(status: u16, version: &str) -> ReleaseResponse {
    ReleaseResponse { status, bytes: serde_json::to_vec(&serde_json::json!({ "tag_name": version, "draft": false, "prerelease": false, "html_url": format!("https://github.com/Dotatel/BacktestEngine/releases/tag/{version}"), "body": "Release notes\n<script>plain text</script>\u{0001}", "assets": [{ "name": "BacktestEngine-win-x64.exe", "browser_download_url": format!("https://github.com/Dotatel/BacktestEngine/releases/download/{version}/BacktestEngine-win-x64.exe") }] })).unwrap() }
}

#[test]
fn disabled_manual_check_never_calls_transport() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    let calls = std::cell::Cell::new(0);
    let outcome = check_release(&state, || {
        calls.set(calls.get() + 1);
        Ok(response(200, "v1.1.0"))
    })
    .unwrap();
    assert_eq!(calls.get(), 0);
    assert_eq!(outcome.status, "disabled");
    assert!(outcome.checked_at.is_none());
}

#[test]
fn unavailable_offline_rate_limited_and_invalid_payloads_never_claim_up_to_date() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    state
        .change(|settings| {
            settings.updates.enabled = true;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        check_release(&state, || Ok(response(404, "v1.0.0")))
            .unwrap()
            .status,
        "noRelease"
    );
    assert_eq!(
        check_release(&state, || Ok(response(429, "v1.0.0")))
            .unwrap()
            .status,
        "rateLimited"
    );
    assert_eq!(
        check_release(&state, || Err("offline".into()))
            .unwrap()
            .status,
        "error"
    );
    assert_eq!(
        check_release(&state, || Ok(ReleaseResponse {
            status: 200,
            bytes: b"not json".to_vec()
        }))
        .unwrap()
        .status,
        "error"
    );
    assert_eq!(
        check_release(&state, || Ok(ReleaseResponse {
            status: 200,
            bytes: vec![b'x'; MAX_RELEASE_BYTES + 1]
        }))
        .unwrap()
        .status,
        "error"
    );
    assert!(state
        .read()
        .unwrap()
        .updates
        .last_successful_check_at
        .is_none());
}

#[test]
fn stable_semver_links_notes_and_success_timestamps_are_validated() {
    let root = tempfile::tempdir().unwrap();
    let mut state = state(root.path());
    state
        .change(|settings| {
            settings.updates.enabled = true;
            settings.updates.dismissed_versions.push("1.2.0".into());
            Ok(())
        })
        .unwrap();
    let result = check_release(&state, || Ok(response(200, "v1.2.0"))).unwrap();
    assert_eq!(result.status, "updateAvailable");
    assert_eq!(result.latest_version.as_deref(), Some("1.2.0"));
    assert!(result.dismissed);
    assert!(!result.notes.unwrap().contains('\u{0001}'));
    assert!(state
        .read()
        .unwrap()
        .updates
        .last_successful_check_at
        .is_some());
    state.app_version = "1.0.0+local".into();
    assert_eq!(
        check_release(&state, || Ok(response(200, "v1.0.0+remote")))
            .unwrap()
            .status,
        "upToDate"
    );
    assert_eq!(
        check_release(&state, || Ok(response(200, "v2.0.0-beta.1")))
            .unwrap()
            .status,
        "error"
    );
    assert!(
        trusted_release_url("https://evil.example/Dotatel/BacktestEngine/releases/tag/v1.2.0")
            .is_err()
    );
    assert!(trusted_release_url("https://github.com/another/repo/releases/tag/v1.2.0").is_err());
    assert!(trusted_release_url(
        "https://user@github.com/Dotatel/BacktestEngine/releases/tag/v1.2.0"
    )
    .is_err());
    assert!(trusted_release_url(
        "https://github.com/Dotatel/BacktestEngine/releases/tag/v1.2.0?redirect=evil"
    )
    .is_err());
}

#[test]
fn concurrent_checks_are_blocked_and_disabling_during_request_suppresses_metadata() {
    let root = tempfile::tempdir().unwrap();
    let state = state(root.path());
    state
        .change(|settings| {
            settings.updates.enabled = true;
            Ok(())
        })
        .unwrap();
    let result = check_release(&state, || {
        assert!(check_release(&state, || Ok(response(200, "v1.2.0"))).is_err());
        state
            .change(|settings| {
                settings.updates.enabled = false;
                Ok(())
            })
            .unwrap();
        Ok(response(200, "v1.2.0"))
    })
    .unwrap();
    assert_eq!(result.status, "disabled");
    assert!(state
        .read()
        .unwrap()
        .updates
        .last_successful_check_at
        .is_none());
    assert!(!state.update_check_running.load(Ordering::Acquire));
}
