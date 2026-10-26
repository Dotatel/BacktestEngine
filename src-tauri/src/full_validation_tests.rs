//! Synthetic provenance/output fixtures and actual unchanged Python planning; never economic qualification.
use super::*;
use crate::{
    full_validation_contract::WalkForwardRequest, replay_receipt::tests as receipt_fixture,
    workspace_build,
};

/// Request a small original scenario matrix using deliberately synthetic receipt identities.
fn request(hash: &str) -> FullValidationRequest {
    FullValidationRequest {
        execution_run_id: "synthetic-run".into(),
        replay_receipt_sha256: hash.into(),
        spread_multipliers: vec![1.0, 1.5],
        commission_multipliers: vec![1.0, 2.0],
        latency_ticks: vec![1, 5],
        walk_forward: WalkForwardRequest {
            train_days: 20,
            validation_days: 10,
            test_days: 10,
            embargo_days: 2,
        },
        monte_carlo_runs: 10,
        seed: 42,
        gates: None,
    }
}

/// Stage a new workflow without executing a runner; original authorities stay read-locked.
pub(super) fn prepared() -> (
    receipt_fixture::Fixture,
    replay_receipt::FrozenReplayInputs,
    PreparedFullValidation,
) {
    let fixture = receipt_fixture::fixture(false);
    let frozen = receipt_fixture::capture(&fixture).unwrap();
    let draft = request(&frozen.receipt_sha256);
    let prepared = prepare_full_validation(
        &frozen.directory,
        BaselineEvidence {
            canonical_project_root: &fixture.approved.project_root,
            execution_run_id: "synthetic-run",
            replay_receipt_sha256: &frozen.receipt_sha256,
            source_report_sha256: &"b".repeat(64),
        },
        &draft,
        &fixture
            .home
            .path()
            .canonicalize()
            .unwrap()
            .join("validation-1"),
    )
    .unwrap();
    (fixture, frozen, prepared)
}

#[test]
fn typed_planning_rejects_unsupported_missing_duplicate_and_excessive_inputs() {
    let fixture = receipt_fixture::fixture(false);
    let frozen = receipt_fixture::capture(&fixture).unwrap();
    let mut draft = request(&frozen.receipt_sha256);
    let plan = contract::plan_validation(&draft, &frozen.receipt).unwrap();
    assert_eq!(plan.scenarios.len(), 9);
    assert_eq!(plan.generated_walk_forward_windows, 4);
    assert_eq!(plan.excluded_walk_forward_windows, 1);
    let mut receipt = frozen.receipt.clone();
    receipt.dataset.kind = "bars".into();
    assert!(contract::plan_validation(&draft, &receipt)
        .err()
        .unwrap()
        .contains("tick replay only"));
    receipt = frozen.receipt.clone();
    receipt.settings.start_utc = None;
    assert!(contract::plan_validation(&draft, &receipt)
        .err()
        .unwrap()
        .contains("explicit original"));
    draft.spread_multipliers = vec![1.0, 1.0];
    assert!(contract::plan_validation(&draft, &frozen.receipt).is_err());
    draft = request(&frozen.receipt_sha256);
    draft.walk_forward.train_days = 0;
    assert!(contract::plan_validation(&draft, &frozen.receipt).is_err());
    draft = request(&frozen.receipt_sha256);
    draft.monte_carlo_runs = 10001;
    assert!(contract::plan_validation(&draft, &frozen.receipt).is_err());
    draft = request(&frozen.receipt_sha256);
    draft.spread_multipliers = vec![1., 2., 3., 4., 5., 6., 7., 8.];
    draft.commission_multipliers = draft.spread_multipliers.clone();
    assert!(contract::plan_validation(&draft, &frozen.receipt)
        .err()
        .unwrap()
        .contains("scenario limit"));
    assert!(serde_json::from_value::<FullValidationRequest>(
        json!({"executionRunId":"x","runnerProject":"foreign"})
    )
    .is_err());
}

#[test]
fn commission_rate_stress_rejects_unsupported_zero_unchanged_and_bound_authorities() {
    let fixture = receipt_fixture::fixture(false);
    let frozen = receipt_fixture::capture(&fixture).unwrap();
    let mut draft = request(&frozen.receipt_sha256);
    let mut receipt = frozen.receipt.clone();
    receipt.commission_terms.model = "PerLot".into();
    assert!(contract::plan_validation(&draft, &receipt)
        .err()
        .unwrap()
        .contains("model/currency/side"));
    receipt = frozen.receipt.clone();
    receipt.settings.effective_commission_usd_per_million = 0.0;
    assert!(contract::plan_validation(&draft, &receipt)
        .err()
        .unwrap()
        .contains("zero base rate"));
    receipt = frozen.receipt.clone();
    receipt.commission_terms.native_end_utc = Some("2026-03-31T00:00:00Z".into());
    assert!(contract::plan_validation(&draft, &receipt)
        .err()
        .unwrap()
        .contains("binds its original rate"));
    draft.commission_multipliers = vec![1.0];
    assert!(contract::plan_validation(&draft, &receipt)
        .err()
        .unwrap()
        .contains("boundary differs"));
    draft.walk_forward = WalkForwardRequest {
        train_days: 80,
        validation_days: 4,
        test_days: 4,
        embargo_days: 1,
    };
    let plan = contract::plan_validation(&draft, &receipt).unwrap();
    assert_eq!(
        plan.scenarios
            .iter()
            .filter(|scenario| scenario.layer == "WalkForward")
            .count(),
        1
    );
    assert_eq!(receipt.commission_terms.minimum_commission,0.5,"The original minimum remains unchanged; this is rate stress, never a fee multiplier claim.");
}

#[test]
fn preparation_preserves_baseline_and_rejects_foreign_project_receipt() {
    let (fixture, frozen, mut prepared) = prepared();
    let original_entry = fs::read(
        frozen
            .directory
            .join("runner/entry/WorkspaceStrategyEntry.cs"),
    )
    .unwrap();
    assert_ne!(
        fs::read(
            prepared
                .directory
                .join("runner/entry/WorkspaceStrategyEntry.cs")
        )
        .unwrap(),
        original_entry
    );
    assert_eq!(
        fs::read(
            frozen
                .directory
                .join("runner/entry/WorkspaceStrategyEntry.cs")
        )
        .unwrap(),
        original_entry
    );
    verify_prepared_inputs(&mut prepared).unwrap();
    let config: Value = serde_json::from_slice(&fs::read(&prepared.config_path).unwrap()).unwrap();
    assert_eq!(config["ExistingReports"], json!([]));
    assert_eq!(config["ReuseExistingReports"], false);
    assert_eq!(config["MonteCarlo"]["Balance"], 25000.0);
    assert_eq!(config["ParameterOverrides"]["HoldTicks"], "10");
    let error = prepare_full_validation(
        &frozen.directory,
        BaselineEvidence {
            canonical_project_root: "foreign",
            execution_run_id: "synthetic-run",
            replay_receipt_sha256: &frozen.receipt_sha256,
            source_report_sha256: &"b".repeat(64),
        },
        &request(&frozen.receipt_sha256),
        &fixture.home.path().join("foreign"),
    )
    .err()
    .unwrap();
    assert!(error.contains("different project"));
    assert!(!fixture.home.path().join("foreign").exists());
    assert!(
        fs::write(&prepared.config_path, b"{}").is_err(),
        "Prepared compiler/config inputs must remain locked while the job can use them."
    );
    verify_prepared_inputs(&mut prepared).unwrap();
    prepared.config_sha256 = "f".repeat(64);
    assert!(verify_prepared_inputs(&mut prepared)
        .unwrap_err()
        .contains("entry/config changed"));
}

/// Require a bundled runtime; missing staging is a test failure, never an implicit skip.
pub(super) fn runtime(relative: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(relative);
    assert!(
        path.is_file(),
        "Required staged test runtime is missing: {}",
        path.display()
    );
    path
}

/// Execute bounded fixed test arguments using the same hidden process helper as existing compiler fixtures.
pub(super) async fn process(
    executable: &Path,
    args: &[&str],
    directory: &Path,
    environment: &[(&str, String)],
) -> std::process::Output {
    let (_sender, mut cancel) = tokio::sync::oneshot::channel();
    let result =
        workspace_build::run_process(executable, args, directory, environment, &mut cancel, 180)
            .await
            .unwrap();
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../artifacts/full-validation-fixed-process-tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&evidence).unwrap();
    fs::write(evidence.join("result.json"),serde_json::to_vec_pretty(&json!({"syntheticProcessFixture":true,"executable":executable,"arguments":args,"workingDirectory":directory,"exitCode":result.status.code(),"stdout":String::from_utf8_lossy(&result.stdout),"stderr":String::from_utf8_lossy(&result.stderr)})).unwrap()).unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}\nevidence={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
        evidence.display()
    );
    result
}

#[tokio::test]
async fn unchanged_python_plan_and_commands_equal_the_native_bounded_plan() {
    let (_fixture, _frozen, prepared) = prepared();
    let python = runtime("runtimes/python/python.exe");
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/validation");
    assert!(source.join("ValidationEngine/Cli.py").is_file());
    let program = "import sys,json;sys.path.insert(0,sys.argv[1]);from ValidationEngine.Config import load_config;from ValidationEngine.Cli import run_validation;print(json.dumps(run_validation(load_config(sys.argv[2]),True)))";
    let output = process(
        &python,
        &[
            "-I",
            "-B",
            "-X",
            "utf8",
            "-c",
            program,
            source.to_str().unwrap(),
            prepared.config_path.to_str().unwrap(),
        ],
        &prepared.directory,
        &[],
    )
    .await;
    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    for (key, layer) in [
        ("run_results", "Reports"),
        ("latency_results", "LatencyStress"),
        ("walk_forward_results", "WalkForward"),
    ] {
        let expected: Vec<_> = prepared
            .plan
            .scenarios
            .iter()
            .filter(|item| item.layer == layer)
            .collect();
        let actual = payload[key].as_array().unwrap();
        assert_eq!(expected.len(), actual.len());
        for (expected, actual) in expected.iter().zip(actual) {
            assert_eq!(actual["name"], expected.name);
            assert_eq!(actual["status"], "planned");
            assert_eq!(
                actual["command"],
                json!(expected_command(&prepared, expected))
            );
        }
    }
    assert_eq!(
        payload["walk_forward_windows"].as_array().unwrap().len(),
        prepared.plan.generated_walk_forward_windows
    );
}

#[tokio::test]
async fn generated_managed_entry_forwards_nondefault_economics_without_attribute_default_loading() {
    let (fixture, _frozen, prepared) = prepared();
    let canonical_parent = fixture.home.path().canonicalize().unwrap();
    let ordinary_parent = crate::build_process::workflow_directory(&canonical_parent).unwrap();
    assert_eq!(ordinary_parent.canonicalize().unwrap(), canonical_parent);
    let directory = ordinary_parent.join("adapter-process-proof");
    fs::create_dir(&directory).unwrap();
    for path in [
        "entry",
        "engine/BacktestEngine.Run",
        "engine/BacktestEngine.CAlgoShim",
    ] {
        fs::create_dir_all(directory.join(path)).unwrap();
    }
    fs::copy(
        prepared
            .directory
            .join("runner/entry/WorkspaceStrategyEntry.cs"),
        directory.join("entry/WorkspaceStrategyEntry.cs"),
    )
    .unwrap();
    fs::write(directory.join("engine/BacktestEngine.Run/Program.cs"),r#"namespace BacktestEngine.Run { internal static class Program { private static int Main(string[] args) {
#if DEBUG
System.Console.WriteLine("WRONG_DEBUG_STRATEGY_BRANCH");
#else
System.Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(args));
System.Console.Error.WriteLine("PROCESS_PATH=" + System.Environment.ProcessPath);
#endif
return 0; } } }"#).unwrap();
    fs::write(directory.join("WorkspaceCompile.csproj"),r#"<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><StartupObject>WorkspaceStrategyEntry</StartupObject></PropertyGroup></Project>"#).unwrap();
    fs::write(directory.join("NuGet.Config"),"<configuration><packageSources><clear/></packageSources><auditSources><clear/></auditSources></configuration>").unwrap();
    workspace_build::compile_inputs::write_compile_membership(&directory, &[]).unwrap();
    let sdk = crate::build_process::sdk_launch_path(
        &runtime("runtimes/dotnet/dotnet.exe")
            .canonicalize()
            .unwrap(),
    )
    .unwrap();
    let project = directory.join("WorkspaceCompile.csproj");
    let env = [
        (
            "DOTNET_CLI_HOME",
            directory.join("cli-home").to_string_lossy().into(),
        ),
        (
            "NUGET_PACKAGES",
            directory.join("packages").to_string_lossy().into(),
        ),
        ("DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "1".into()),
        ("DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE", "true".into()),
        ("DOTNET_CLI_TELEMETRY_OPTOUT", "1".into()),
        ("Configuration", "Release".into()),
        ("UseAppHost", "false".into()),
        ("DOTNET_GENERATE_ASPNET_CERTIFICATE", "false".into()),
        (
            "DirectoryBuildPropsPath",
            directory
                .join("Directory.Build.props")
                .to_string_lossy()
                .into(),
        ),
        (
            "DirectoryBuildTargetsPath",
            directory
                .join("Directory.Build.targets")
                .to_string_lossy()
                .into(),
        ),
    ];
    process(
        &sdk,
        &[
            "build",
            project.to_str().unwrap(),
            "-c",
            "Release",
            "-p:RestoreConfigFile=NuGet.Config",
            "-p:NuGetAudit=false",
            "-p:UseSharedCompilation=false",
            "-nodeReuse:false",
            "-v:q",
        ],
        &directory,
        &env,
    )
    .await;
    let assembly = directory.join("bin/Release/net10.0/WorkspaceCompile.dll");
    let placeholder = prepared.directory.join("parameters-placeholder.json");
    let output = process(
        &sdk,
        &[
            assembly.to_str().unwrap(),
            "--params",
            placeholder.to_str().unwrap(),
            "--param",
            "HoldTicks=10",
            "--symbol",
            "QA",
            "--commission-usd-per-million",
            "0.3",
        ],
        &directory,
        &env,
    )
    .await;
    let actual: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
    assert_dotnet_process(&output, &sdk);
    let rerun = process(
        &sdk,
        &[
            "run",
            "--project",
            project.to_str().unwrap(),
            "--",
            "--params",
            placeholder.to_str().unwrap(),
            "--param",
            "HoldTicks=10",
            "--symbol",
            "QA",
            "--commission-usd-per-million",
            "0.3",
        ],
        &directory,
        &env,
    )
    .await;
    assert_dotnet_process(&rerun, &sdk);
    assert!(!directory
        .join("bin/Release/net10.0/WorkspaceCompile.exe")
        .exists());
    assert_eq!(
        serde_json::from_slice::<Vec<String>>(&rerun.stdout).unwrap(),
        actual,
        "Original Python dotnet-run must preserve the actual Release strategy branch."
    );
    assert_eq!(
        actual,
        vec![
            "--param",
            "HoldTicks=10",
            "--symbol",
            "QA",
            "--commission-usd-per-million",
            "-1",
            "--balance",
            "25000",
            "--slippage-pips",
            "0.4"
        ]
    );
    let (_sender, mut cancel) = tokio::sync::oneshot::channel();
    let rejected = workspace_build::run_process(
        &sdk,
        &[assembly.to_str().unwrap(), "--params", "foreign.json"],
        &directory,
        &env,
        &mut cancel,
        10,
    )
    .await
    .unwrap();
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("placeholder path changed"));
}

#[test]
fn leftover_report_from_failed_process_and_foreign_command_are_rejected() {
    let (_fixture, _frozen, prepared) = prepared();
    let scenario = &prepared.plan.scenarios[0];
    let path = prepared.directory.join(&scenario.relative_report_path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"{\"leftover\":true}").unwrap();
    let mut row = json!({"name":scenario.name,"status":"failed","exit_code":1,"report_path":path,"command":expected_command(&prepared,scenario)});
    assert!(accept_scenario(&prepared, scenario, &row)
        .unwrap_err()
        .contains("leftover report remains unaccepted"));
    row["status"] = json!("completed");
    row["exit_code"] = json!(0);
    row["command"][0] = json!("foreign-runner");
    assert!(accept_scenario(&prepared, scenario, &row)
        .unwrap_err()
        .contains("command differs"));
    let payload = json!({"run_results":[row.clone(),row]});
    assert!(accept_layer(&prepared, &payload, "run_results", "Reports")
        .unwrap_err()
        .contains("count differs"));
}

/// Prove an original-style rerun uses the verified dotnet executable rather than an unbound generated apphost.
fn assert_dotnet_process(output: &std::process::Output, sdk: &Path) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let path = stderr
        .lines()
        .find_map(|line| line.strip_prefix("PROCESS_PATH="))
        .expect("Actual process identity marker is required.");
    assert_eq!(
        Path::new(path).canonicalize().unwrap(),
        sdk.canonicalize().unwrap()
    );
}
