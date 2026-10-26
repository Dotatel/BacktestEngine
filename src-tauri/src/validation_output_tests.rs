//! Injected transport fixtures plus actual staged Python; these checks do not execute a C# backtest.
use super::*;
use serde_json::json;

/// Explicit synthetic raw bytes and matching normalized transport exercise authentication independently of engines.
fn fixture() -> (Vec<u8>, Value) {
    let raw = br#"{"combined_report":{"profit_factor":Infinity},"verdict":{"status":"FAIL","unproven":["stress"]}}"#.to_vec();
    let envelope = json!({"version":1,"originalSha256":digest(&raw),"payload":{"combined_report":{"profit_factor":null},"verdict":{"status":"FAIL","unproven":["stress"]}},"nonFinite":[{"pointer":"/combined_report/profit_factor","token":"Infinity","meaning":"positiveUnbounded","origin":"retainedProfitFactor"}]});
    (raw, envelope)
}

/// Synthesize a captured wrapper marker only for a clearly labelled injected fixture.
fn accept_fixture(raw: &[u8], envelope: &Value) -> Result<VerifiedOutput, String> {
    let bytes = serde_json::to_vec(envelope).unwrap();
    verify(raw, &bytes, &format!("{MARKER}{}\n", digest(&bytes)))
}

#[test]
fn authenticated_positive_unbounded_value_preserves_original_verdict_and_hashes() {
    let (raw, envelope) = fixture();
    let accepted = accept_fixture(&raw, &envelope).unwrap();
    assert_eq!(accepted.payload["verdict"], envelope["payload"]["verdict"]);
    assert_eq!(accepted.original_sha256, digest(&raw));
    assert_eq!(
        accepted.envelope_sha256,
        digest(&serde_json::to_vec(&envelope).unwrap())
    );
    assert_eq!(accepted.non_finite.len(), 1);
    assert_eq!(accepted.non_finite[0].meaning, "positiveUnbounded");
}

#[test]
fn changed_original_sidecar_and_missing_or_duplicate_stdout_digests_fail() {
    let (raw, envelope) = fixture();
    let bytes = serde_json::to_vec(&envelope).unwrap();
    let marker = format!("{MARKER}{}\n", digest(&bytes));
    for stdout in [
        String::new(),
        format!("{marker}{marker}"),
        format!("{MARKER}bad\n"),
    ] {
        assert!(verify(&raw, &bytes, &stdout).is_err());
    }
    assert!(verify(b"{}", &bytes, &marker).is_err());
    let mut changed = bytes.clone();
    changed.push(b' ');
    assert!(verify(&raw, &changed, &marker).is_err());
    let mut changed = envelope;
    changed["version"] = json!(2);
    assert!(accept_fixture(&raw, &changed).is_err());
}

#[test]
fn annotation_token_meaning_origin_pointer_null_and_uniqueness_are_required() {
    for (key, value) in [
        ("token", "NaN"),
        ("token", "-Infinity"),
        ("meaning", "noLossProven"),
        ("origin", "invented"),
        ("pointer", "/other/profit_factor"),
        ("pointer", "/combined_report/missing"),
    ] {
        let (raw, mut envelope) = fixture();
        envelope["nonFinite"][0][key] = json!(value);
        assert!(accept_fixture(&raw, &envelope).is_err(), "{key}={value}");
    }
    let (raw, mut envelope) = fixture();
    envelope["payload"]["combined_report"]["profit_factor"] = json!(1.0);
    assert!(accept_fixture(&raw, &envelope).is_err());
    let (raw, mut envelope) = fixture();
    let annotation = envelope["nonFinite"][0].clone();
    envelope["nonFinite"]
        .as_array_mut()
        .unwrap()
        .push(annotation);
    assert!(accept_fixture(&raw, &envelope).is_err());
    let (raw, mut envelope) = fixture();
    envelope["nonFinite"][0]["unknown"] = json!(true);
    assert!(accept_fixture(&raw, &envelope).is_err());
}

#[test]
fn finite_null_cannot_acquire_an_invented_annotation_or_changed_verdict() {
    let (_, mut envelope) = fixture();
    let raw = serde_json::to_vec(&envelope["payload"]).unwrap();
    envelope["originalSha256"] = json!(digest(&raw));
    assert!(accept_fixture(&raw, &envelope).is_err());
    envelope["nonFinite"] = json!([]);
    assert!(accept_fixture(&raw, &envelope).is_ok());
    envelope["payload"]["verdict"]["status"] = json!("PASS");
    assert!(accept_fixture(&raw, &envelope).is_err());
}

#[test]
fn annotation_indices_require_actual_arrays_and_canonical_positions() {
    let (raw, mut envelope) = fixture();
    envelope["payload"]["monte_carlo"] =
        json!({"distributions":[{"pf":null}],"concentration":{"remove_best":[{"pf":null}]}});
    for pointer in [
        "/monte_carlo/distributions/0/pf",
        "/monte_carlo/concentration/remove_best/0/pf",
    ] {
        envelope["nonFinite"][0]["pointer"] = json!(pointer);
        assert!(accept_fixture(&raw, &envelope).is_ok());
    }
    for pointer in [
        "/monte_carlo/distributions/00/pf",
        "/monte_carlo/distributions/+0/pf",
        "/monte_carlo/distributions/1/pf",
        "/monte_carlo/summary/0/pf_p05",
    ] {
        envelope["nonFinite"][0]["pointer"] = json!(pointer);
        assert!(accept_fixture(&raw, &envelope).is_err());
    }
    envelope["payload"]["monte_carlo"]["distributions"] = json!({"0":{"pf":null}});
    envelope["nonFinite"][0]["pointer"] = json!("/monte_carlo/distributions/0/pf");
    assert!(accept_fixture(&raw, &envelope).is_err());
}

#[test]
fn known_statistic_types_and_structural_depth_are_bounded() {
    for value in [json!(true), json!("Infinity"), json!({}), json!([])] {
        let (raw, mut envelope) = fixture();
        envelope["payload"]["combined_report"]["profit_factor"] = value;
        assert!(accept_fixture(&raw, &envelope).is_err());
    }
    let (raw, mut envelope) = fixture();
    let mut nested = Value::Null;
    for _ in 0..=MAX_DEPTH {
        nested = json!({"child":nested});
    }
    envelope["payload"]["deep"] = nested;
    assert!(accept_fixture(&raw, &envelope).is_err());
}

/// Actual pinned interpreter reproduces the unchanged CLI's original Infinity output and authenticates its sidecar.
#[tokio::test]
async fn staged_python_original_regression_is_accepted_without_replacing_raw_output() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let python = root.join("resources/runtimes/python/python.exe");
    assert!(
        python.is_file(),
        "Stage pinned embeddable Python before adapter tests."
    );
    let temporary = tempfile::tempdir().unwrap();
    let program = "import importlib.util,sys,pathlib;spec=importlib.util.spec_from_file_location('fixture',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);d=pathlib.Path(sys.argv[2]);config=m.original_cli_fixture(d);sys.argv=['-c',sys.argv[3],str(d/'validation'),'--config',str(config)];exec(m.ADAPTER.read_text(),{'__name__':'__main__'})";
    let mut command = tokio::process::Command::new(python);
    command
        .args(["-I", "-B", "-X", "utf8", "-c", program])
        .arg(root.join("validation-output-tests/test_validation_output.py"))
        .arg(temporary.path())
        .arg(root.join("resources/validation"))
        .current_dir(temporary.path())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let folder = temporary.path().join("validation");
    let original = std::fs::read(folder.join("FinalVerdict.json")).unwrap();
    let sidecar = std::fs::read(folder.join("FinalVerdict.adapter.json")).unwrap();
    let accepted = verify(
        &original,
        &sidecar,
        &String::from_utf8_lossy(&output.stdout),
    )
    .unwrap();
    assert_eq!(accepted.non_finite.len(), 23);
    assert_eq!(accepted.payload["verdict"]["status"], "FAIL");
    assert_eq!(accepted.payload["monte_carlo"]["summary"][0]["pf_p05"], 0.0);
    assert!(serde_json::from_slice::<Value>(&original).is_err());
    assert_eq!(accepted.original_sha256, digest(&original));
}
