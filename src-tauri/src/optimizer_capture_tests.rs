//! Synthetic provenance/lock fixtures; actual original-builder and process-tree proof belongs to integration tests.
use super::*;
use serde_json::json;

/// Reuse the existing registered/transitive authority fixture, moving source to the actual final runner location.
fn fixture(nested: bool) -> replay_receipt::tests::Fixture {
    let mut fixture = replay_receipt::tests::fixture(nested);
    let final_runner = fixture.run.join("runner");
    fs::rename(&fixture.source, &final_runner).unwrap();
    fixture.source = final_runner;
    fs::write(
        fixture.run.join("base.cbotset"),
        br#"{"Chart":{"Symbol":"QA","Period":"m1"},"Parameters":{"HoldTicks":10}}"#,
    )
    .unwrap();
    fs::write(fixture.run.join("optimizer.json"), b"{\"synthetic\":true}").unwrap();
    fixture
}

/// Capture only host-preflight fixture inputs; this does not create a valid trading-economics claim.
fn capture(fixture: &replay_receipt::tests::Fixture) -> Result<FrozenOptimizerCapture, String> {
    freeze_inputs(
        &fixture.run,
        &fixture.approved,
        &fixture.dataset,
        &fixture.profile,
    )
}

#[test]
fn exact_approved_source_and_generated_membership_are_required_after_final_move() {
    for relative in [
        "engine/Original.cs",
        "entry/WorkspaceStrategyEntry.cs",
        "Directory.Build.props",
        "Directory.Build.targets",
        "WorkspaceCompile.csproj",
        "strategies/f0.cs",
    ] {
        let fixture = fixture(false);
        fs::write(
            fixture.source.join(relative),
            b"changed owned source fixture",
        )
        .unwrap();
        let error = capture(&fixture).err().unwrap();
        assert!(
            error.contains("approved compilation manifest"),
            "{relative}: {error}"
        );
        assert!(!fixture.run.join(RECORD_NAME).exists());
    }
}

#[test]
fn changed_dataset_bytes_and_wrong_expected_size_fail_during_post_sdk_capture() {
    let fixture = fixture(false);
    fs::write(
        &fixture.dataset.stored_path,
        b"changed dataset after SDK probe",
    )
    .unwrap();
    assert!(capture(&fixture).err().unwrap().contains("post-SDK"));
    let mut fixture = self::fixture(false);
    fixture.dataset.size_bytes += 1;
    assert!(capture(&fixture).err().unwrap().contains("post-SDK"));
}

#[test]
fn source_data_controls_and_transitive_live_authorities_remain_locked_until_drop() {
    let fixture = fixture(true);
    let mut captured = capture(&fixture).unwrap();
    assert!(captured.provenance.authority_sha256.len() > 1);
    captured.verify().unwrap();
    for path in [
        fixture.source.join("strategies/f0.cs"),
        fixture.source.join("Directory.Build.targets"),
        fixture.run.join("market.csv"),
        fixture.run.join("profile.json"),
        fixture.run.join("base.cbotset"),
        fixture.run.join("optimizer.json"),
        fixture.authority.clone(),
        fixture.home.path().join("events.jsonl"),
    ] {
        assert!(
            fs::OpenOptions::new().write(true).open(&path).is_err(),
            "{}",
            path.display()
        );
    }
    assert!(fs::rename(&fixture.source, fixture.run.join("moved-runner")).is_err());
    let public = serde_json::to_value(&captured.provenance).unwrap();
    assert!(public.get("canonicalProjectRoot").is_none());
    assert!(!public
        .to_string()
        .contains(&fixture.home.path().to_string_lossy().replace('\\', "\\\\")));
    drop(captured);
    assert!(fs::OpenOptions::new()
        .write(true)
        .open(&fixture.authority)
        .is_ok());
    assert!(fs::OpenOptions::new()
        .write(true)
        .open(fixture.source.join("strategies/f0.cs"))
        .is_ok());
}

#[test]
fn authority_changed_after_preflight_cannot_acquire_optimizer_capture() {
    let fixture = fixture(true);
    fs::write(
        fixture.home.path().join("events.jsonl"),
        b"changed transitive authority",
    )
    .unwrap();
    assert!(capture(&fixture).is_err());
    assert!(!fixture.run.join(RECORD_NAME).exists());
}

/// Produce obviously synthetic output bytes at the exact retained builder's Release/net10.0 layout.
fn compiled_fixture(captured: &FrozenOptimizerCapture) -> CompiledRunnerEvidence {
    let root = captured.directory.join(COMPILED_DIRECTORY);
    fs::create_dir_all(&root).unwrap();
    let mut files = BTreeMap::new();
    for name in COMPILED_NAMES {
        let bytes = format!("synthetic recompiled fixture {name}").into_bytes();
        fs::write(root.join(name), &bytes).unwrap();
        files.insert(name.into(), replay_receipt::digest(&bytes));
    }
    CompiledRunnerEvidence {
        capture_sha256: captured.provenance.capture_sha256.clone(),
        source_manifest_sha256: captured.provenance.source_manifest_sha256.clone(),
        build_configuration: BUILD_CONFIGURATION.into(),
        files,
    }
}

#[test]
fn actual_compiled_hashes_are_separate_from_approval_and_lock_all_four_known_companions() {
    let fixture = fixture(false);
    let captured = capture(&fixture).unwrap();
    let proof = compiled_fixture(&captured);
    let verified = verify_compiled(&captured, &proof).unwrap();
    assert_ne!(
        verified.provenance.files["WorkspaceCompile.dll"].sha256,
        captured.provenance.approved_artifact_sha256
    );
    for name in COMPILED_NAMES {
        assert!(fs::OpenOptions::new()
            .write(true)
            .open(captured.directory.join(COMPILED_DIRECTORY).join(name))
            .is_err());
    }
    drop(verified);
    assert!(fs::OpenOptions::new()
        .write(true)
        .open(
            captured
                .directory
                .join("runner/bin/Debug/Release/net10.0/WorkspaceCompile.dll")
        )
        .is_ok());
}

#[test]
fn missing_changed_foreign_and_old_compilation_evidence_never_passes() {
    let fixture = fixture(false);
    let captured = capture(&fixture).unwrap();
    let valid = compiled_fixture(&captured);
    for mutation in ["missing", "source", "capture", "debug", "unknown"] {
        let mut proof = valid.clone();
        match mutation {
            "missing" => {
                proof.files.remove("BacktestEngine.CAlgoShim.dll");
            }
            "source" => proof.source_manifest_sha256 = "a".repeat(64),
            "capture" => proof.capture_sha256 = "b".repeat(64),
            "debug" => proof.build_configuration = "Debug".into(),
            _ => {
                proof.files.insert("arbitrary.dll".into(), "c".repeat(64));
            }
        }
        assert!(verify_compiled(&captured, &proof).is_err(), "{mutation}");
    }
    let root = captured.directory.join(COMPILED_DIRECTORY);
    fs::write(
        root.join("WorkspaceCompile.dll"),
        b"changed finite-looking binary",
    )
    .unwrap();
    assert!(verify_compiled(&captured, &valid).is_err());
    fs::remove_file(root.join("WorkspaceCompile.runtimeconfig.json")).unwrap();
    assert!(verify_compiled(&captured, &valid).is_err());
    assert!(serde_json::from_value::<CompiledRunnerEvidence>(
        json!({"build_configuration":"Release","files":{}})
    )
    .is_err());
}

/// Exercise the same receipt boundary with explicit synthetic capture identities.
fn verify_compiled(
    captured: &FrozenOptimizerCapture,
    proof: &CompiledRunnerEvidence,
) -> Result<VerifiedCompiledRunner, String> {
    verify_compiled_files(
        &captured.directory,
        &captured.provenance.capture_sha256,
        &captured.provenance.source_manifest_sha256,
        proof,
    )
}

/// A dropped/failed process future cannot release live authority or source while native cleanup is unknown.
#[test]
fn unconfirmed_optimizer_guard_quarantines_exact_capture_and_both_busy_latches() {
    use std::sync::atomic::Ordering;
    let fixture = fixture(true);
    let captured = capture(&fixture).unwrap();
    let (optimization, execution) =
        crate::optimization::tests::guarded_job_states(fixture.home.path());
    let mut guard = crate::optimization::acquire_job(&optimization, &execution).unwrap();
    guard.inputs = Some(captured);
    guard.cleanup.store(false, Ordering::Release);
    drop(guard);
    assert!(*optimization.running.lock().unwrap() && *execution.running.lock().unwrap());
    assert!(optimization.retained_inputs.lock().unwrap().is_some());
    assert!(crate::optimization::acquire_job(&optimization, &execution).is_err());
    for path in [
        fixture.authority.clone(),
        fixture.source.join("strategies/f0.cs"),
        fixture.run.join("market.csv"),
    ] {
        assert!(fs::OpenOptions::new().write(true).open(path).is_err());
    }
    drop(optimization);
    assert!(fs::OpenOptions::new()
        .write(true)
        .open(&fixture.authority)
        .is_ok());
}
