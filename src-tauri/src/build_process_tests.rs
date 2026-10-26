//! Native boundary fixtures only; these do not simulate successful compiler capability or economic evidence.
use super::*;

/// Profile isolation follows authoritative managed workspace storage, with no lookup or writes to a default owner profile.
#[test]
fn sdk_probes_follow_managed_isolated_build_root() {
    let home = tempfile::tempdir().unwrap();
    let isolated = home.path().join("isolated/workspace/builds");
    let owner = home.path().join("owner/workspace/builds");
    let probes = probe_directory(&isolated).unwrap();
    assert_eq!(probes, home.path().join("isolated/workspace/sdk-probes"));
    assert_ne!(probes, probe_directory(&owner).unwrap());
    assert_eq!(fs::read_dir(home.path()).unwrap().count(), 0);
    assert!(probe_directory(Path::new("relative/builds")).is_err());
}

/// A candidate is always a canonical absolute dotnet.exe; relative alternate commands cannot reach host dispatch.
#[test]
fn candidate_resolution_rejects_relative_and_wrong_executable_paths() {
    assert!(canonical_candidate(Path::new("relative/dotnet.exe")).is_err());
    let home = tempfile::tempdir().unwrap();
    let wrong = home.path().join("different.exe");
    fs::write(&wrong, b"synthetic, never executed").unwrap();
    assert!(canonical_candidate(&wrong).is_err());
    let candidate = home.path().join("dotnet.exe");
    fs::write(&candidate, b"synthetic path identity only, never executed").unwrap();
    assert_eq!(
        canonical_candidate(&candidate).unwrap(),
        candidate.canonicalize().unwrap()
    );
}

/// MSBuild launch spelling must round-trip to the same native identity; canonical receipts are preserved.
#[cfg(windows)]
#[test]
fn sdk_launch_spelling_round_trips_to_exact_canonical_identity() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("dotnet.exe");
    fs::write(&path, b"synthetic identity, never executed").unwrap();
    let canonical = canonical_candidate(&path).unwrap();
    let launch = sdk_launch_path(&canonical).unwrap();
    assert!(!launch.to_string_lossy().starts_with(r"\\?\"));
    assert_eq!(launch.canonicalize().unwrap(), canonical);
    assert_eq!(
        fs::read(launch).unwrap(),
        b"synthetic identity, never executed"
    );
}

/// UNC handling is prefix-specific; trailing dots/spaces, device aliases and lossy spellings cannot be normalized into another SDK.
#[cfg(windows)]
#[test]
fn sdk_spelling_handles_unc_and_refuses_ambiguous_dos_names() {
    assert_eq!(
        sdk_spelling(Path::new(r"\\?\UNC\server\share\sdk\dotnet.exe")).unwrap(),
        PathBuf::from(r"\\server\share\sdk\dotnet.exe")
    );
    for path in [
        r"\\?\C:\sdk.\dotnet.exe",
        r"\\?\C:\sdk \dotnet.exe",
        r"\\?\C:\CON\dotnet.exe",
        r"\\?\Volume{synthetic}\dotnet.exe",
    ] {
        assert!(sdk_spelling(Path::new(path)).is_err(), "{path}");
    }
}

/// Declaring a bootstrap hash cannot authorize different executable bytes, even before the separate host verifier runs.
#[test]
fn changed_bootstrap_identity_is_rejected_before_any_candidate_runs() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join("runtimes/dotnet")).unwrap();
    fs::write(
        home.path().join("runtimes/dotnet/dotnet.exe"),
        b"synthetic changed bytes",
    )
    .unwrap();
    fs::write(home.path().join("runtimes/manifest.json"),serde_json::to_vec(&serde_json::json!({"dotnet":{"destination":"runtimes/dotnet","executable":"dotnet.exe","executableSha256":"0".repeat(64)}})).unwrap()).unwrap();
    assert!(
        runtime_from_resources(home.path(), &home.path().join("probes"))
            .err()
            .unwrap()
            .contains("staged identity")
    );
}

/// Retained source locks survive unconfirmed cleanup and are released only after confirmed native termination.
#[cfg(windows)]
#[test]
fn build_flight_keeps_exact_sources_locked_until_cleanup_is_confirmed() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("Original.cs");
    fs::write(&source, b"synthetic source bytes").unwrap();
    let bytes = fs::read(&source).unwrap();
    let manifest = replay_receipt::ApprovedSourceManifest {
        files: std::collections::BTreeMap::from([(
            "Original.cs".into(),
            replay_receipt::FrozenFile {
                relative_path: "Original.cs".into(),
                sha256: replay_receipt::digest(&bytes),
                size_bytes: bytes.len() as u64,
            },
        )]),
        sha256: String::new(),
    };
    let flight = BuildFlight::new();
    flight
        .retain_sources(replay_receipt::lock_source_manifest(home.path(), &manifest).unwrap())
        .unwrap();
    flight.cleanup.store(false, Ordering::Release);
    assert!(!flight.release_sources());
    assert!(fs::write(&source, b"must remain locked").is_err());
    flight.cleanup.store(true, Ordering::Release);
    assert!(flight.release_sources());
    fs::write(&source, b"released after simulated confirmed marker").unwrap();
}

/// An existing canonical workflow parent keeps its identity but avoids MSBuild's verbatim-prefix wildcard handling.
#[test]
fn workflow_parent_uses_tool_spelling_without_changing_identity() {
    let home = tempfile::tempdir().unwrap();
    let canonical = home.path().canonicalize().unwrap();
    let ordinary = workflow_directory(&canonical).unwrap();
    assert_eq!(ordinary.canonicalize().unwrap(), canonical);
    assert!(!ordinary.to_string_lossy().starts_with(r"\\?\"));
    let file = ordinary.join("not-a-directory");
    fs::write(&file, b"owned fixture").unwrap();
    assert!(workflow_directory(&file).is_err());
    assert!(workflow_directory(&ordinary.join("not-created")).is_err());
}
