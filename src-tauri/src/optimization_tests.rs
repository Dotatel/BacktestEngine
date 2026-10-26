//! Explicitly synthetic adapter fixtures plus genuine original optimizer subprocess failure evidence.
use super::*;
use serde_json::json;

/// Create a typed draft for value-bound tests; it does not claim registered real economics.
fn request() -> OptimizationRunRequest {
    serde_json::from_value(json!({"strategy":"Synthetic","datasetId":"synthetic-data","symbolSpecId":"synthetic-profile","timeframe":"m1","startingBalance":10000.0,"commissionUsdPerMillion":-1.0,"slippagePips":0.0,"baseParameters":{},"dimensions":[{"name":"HoldTicks","values":[10,20]}],"method":"grid","seed":42,"maxRuns":2,"maxWorkers":1})).unwrap()
}

/// Use real reflected contract shape with explicit synthetic field values.
fn strategy() -> workspace_build::CompiledStrategy {
    serde_json::from_value(json!({"strategy":"Synthetic","strategyType":"Synthetic","parameters":[{"name":"HoldTicks","displayName":"Hold ticks","group":"","valueType":"integer","default":10,"min":1,"max":100,"step":1,"options":[]}]})).unwrap()
}

#[test]
fn parameter_names_types_steps_duplicates_and_budgets_fail_closed() {
    let mut draft = request();
    let schema = strategy();
    let accepted = parameters::validate_search(&draft, &schema).unwrap();
    assert_eq!(accepted.base["HoldTicks"], 10);
    assert_eq!(accepted.dimensions["HoldTicks"]["values"], json!([10, 20]));
    draft.base_parameters.insert("Balance".into(), json!(100));
    assert!(parameters::validate_search(&draft, &schema).is_err());
    draft.base_parameters.clear();
    for values in [
        json!([1.5]),
        json!([101]),
        json!(["10"]),
        json!([null]),
        json!([1, 1.0]),
    ] {
        draft.dimensions[0].values = serde_json::from_value(values).unwrap();
        assert!(parameters::validate_search(&draft, &schema).is_err());
    }
    draft = request();
    draft.max_runs = 101;
    assert!(parameters::validate_search(&draft, &schema).is_err());
    draft = request();
    draft.max_workers = 3;
    assert!(parameters::validate_search(&draft, &schema).is_err());
    draft = request();
    draft.slippage_pips = 0.1;
    assert!(validate_request(&draft).unwrap_err().contains("slippage"));
    let mut raw = serde_json::to_value(request()).unwrap();
    raw["runnerProject"] = json!("arbitrary.csproj");
    assert!(serde_json::from_value::<OptimizationRunRequest>(raw).is_err());
}

/// Write original result shape for adapter tests; this remains a synthetic candidate, not an engine report.
fn raw_candidate(status: &str, report: &str) -> Value {
    json!({"id":"candidate_000001","hash":"0123456789abcdef","status":status,"error":"Synthetic failure","parameters":{"HoldTicks":"10"},"report_path":report,"parameter_file_path":"missing.cbotset","fitness_score":0.0,"elapsed_ms":1.0,"metrics":{"profit_factor":999.0,"net_profit":0.0}})
}

#[test]
fn failed_and_unverifiable_candidates_never_expose_default_zero_metrics() {
    let temporary = tempfile::tempdir().unwrap();
    let output = temporary.path();
    fs::write(
        output.join("results.json"),
        serde_json::to_vec(&json!({"results":[raw_candidate("failed","")]})).unwrap(),
    )
    .unwrap();
    let rows = read_fixture_candidates(output, 2, "Synthetic", "QA").unwrap();
    assert_eq!(rows[0].status, "unproven");
    assert!(rows[0].metrics.is_none());
    assert!(rows[0].report_sha256.is_none());
    assert!(rows[0].elapsed_ms.is_none());
    assert!(rows[0].parameters.is_empty());
    fs::write(
        output.join("results.json"),
        serde_json::to_vec(&json!({"results":[raw_candidate("completed","../outside.json")]}))
            .unwrap(),
    )
    .unwrap();
    let rows = read_fixture_candidates(output, 2, "Synthetic", "QA").unwrap();
    assert_eq!(rows[0].status, "unproven");
    assert!(rows[0].metrics.is_none());
    assert!(read_fixture_candidates(output, 0, "Synthetic", "QA").is_err());
}

/// Complete schema-only report for adapter verification; this synthetic document is never engine execution proof.
fn synthetic_report() -> Value {
    json!({"strategy":"Synthetic","symbol":"QA","timeframe":"Minute","parameter_unknown":[],
        "account":{"currency":"EUR","currency_digits":2,"starting_capital":1000.0,"balance":1000.0,"equity":1000.0,"closed_net_profit":0.0,"open_net_profit":0.0,"marked_to_market_net_profit":0.0,"marked_to_market_return_percent":0.0},
        "replay":{"mode":"ticks","bar_price_mode":null,"input_count":1,"ticks_or_synthetic_ticks":1,"on_bar_count":0,"chart_bar_count":0,"hour_bar_count":0,"elapsed_ms":1.0,"ticks_or_synthetic_ticks_per_second":1000.0,"first_time_utc":"2026-01-01T00:00:00Z","last_time_utc":"2026-01-01T00:00:00Z"},
        "drawdown":{"equity_points":1,"max_balance_drawdown":0.0,"max_balance_drawdown_percent":0.0,"max_balance_drawdown_peak_time_utc":"2026-01-01T00:00:00Z","max_balance_drawdown_trough_time_utc":"2026-01-01T00:00:00Z","max_balance_drawdown_peak":1000.0,"max_balance_drawdown_trough":1000.0,"max_equity_drawdown":0.0,"max_equity_drawdown_percent":0.0,"max_equity_drawdown_peak_time_utc":"2026-01-01T00:00:00Z","max_equity_drawdown_trough_time_utc":"2026-01-01T00:00:00Z","max_equity_drawdown_peak":1000.0,"max_equity_drawdown_trough":1000.0},
        "native_report_drawdown":null,
        "trade_statistics":{"total_trades":0,"winning_trades":0,"losing_trades":0,"long_trades":0,"short_trades":0,"gross_profit":0.0,"gross_loss":0.0,"commissions":0.0,"swaps":0.0,"net_profit":0.0,"profit_factor":null,"total_pips":0.0,"average_net_profit":0.0,"largest_win":0.0,"largest_loss":0.0},"trades":[],"open_positions":[]})
}

/// Persist a candidate fixture in the exact original output shape, with separately verifiable source bytes.
fn completed_candidate_fixture(output: &Path) -> Value {
    let folder = output.join("candidate_000001_0123456789abcdef");
    fs::create_dir(&folder).unwrap();
    let report = folder.join("report.json");
    let preset = folder.join("candidate.cbotset");
    let replay_preset = folder.join("parameters.cbotset");
    let mut source = synthetic_report();
    source["parameter_file"] = json!(replay_preset);
    source["parameter_overrides"] = json!(2);
    fs::write(&report, serde_json::to_vec(&source).unwrap()).unwrap();
    let preset_bytes = serde_json::to_vec(
        &json!({"Chart":{"Symbol":"QA","Period":"m1"},"Parameters":{"HoldTicks":10}}),
    )
    .unwrap();
    fs::write(&preset, &preset_bytes).unwrap();
    fs::write(&replay_preset, &preset_bytes).unwrap();
    fs::write(
        output.join("base.cbotset"),
        serde_json::to_vec(
            &json!({"Chart":{"Symbol":"QA","Period":"m1"},"Parameters":{"HoldTicks":5}}),
        )
        .unwrap(),
    )
    .unwrap();
    let mut candidate = raw_candidate("completed", &report.to_string_lossy());
    candidate["parameter_file_path"] = json!(preset);
    let result_bytes = serde_json::to_vec(&candidate).unwrap();
    fs::write(folder.join("candidate_result.json"), &result_bytes).unwrap();
    fs::write(
        output.join("results.json"),
        serde_json::to_vec(&json!({"results":[candidate.clone()]})).unwrap(),
    )
    .unwrap();
    let compiled = synthetic_compiled_evidence(output);
    let receipt = json!({"version":3,"config_sha256":"c".repeat(64),"base_params_sha256":binding::digest(&fs::read(output.join("base.cbotset")).unwrap()),"data_sha256":"d".repeat(64),"symbol_spec_sha256":"e".repeat(64),"scenarios_json":"[{\"symbol\":\"QA\",\"timeframe\":\"m1\"}]","results_sha256":binding::digest(&fs::read(output.join("results.json")).unwrap()),"compiled_runner":compiled,"candidates":[{"id":"candidate_000001","hash":"0123456789abcdef","parameters":{"HoldTicks":"10"},"values":{"HoldTicks":10},"report_sha256":binding::digest(&fs::read(&report).unwrap()),"preset_sha256":binding::digest(&preset_bytes),"replay_preset_sha256":binding::digest(&preset_bytes),"result_sha256":binding::digest(&result_bytes)}]});
    write_fixture_receipt(output, &receipt);
    candidate
}

/// Synthetic receipt authentication fixture only; exact C# generation is exercised by the real managed host tests.
fn write_fixture_receipt(directory: &Path, receipt: &Value) {
    let bytes = serde_json::to_vec(receipt).unwrap();
    fs::write(directory.join("candidate-bindings.json"), &bytes).unwrap();
    fs::write(
        directory.join("binding.stdout"),
        format!(
            "BACKTESTENGINE_OPTIMIZER_BINDING_SHA256 {}\n",
            binding::digest(&bytes)
        ),
    )
    .unwrap();
}

/// Load declared synthetic fixture bytes through the same strict receipt path used by real output.
fn fixture_binding(directory: &Path) -> Result<binding::Receipt, String> {
    let base = fs::read(directory.join("base.cbotset")).map_err(|error| error.to_string())?;
    let stdout =
        fs::read_to_string(directory.join("binding.stdout")).map_err(|error| error.to_string())?;
    binding::load(
        directory,
        &stdout,
        binding::FrozenInputs {
            config: &"c".repeat(64),
            base: &binding::digest(&base),
            data: &"d".repeat(64),
            profile: &"e".repeat(64),
            capture: &"f".repeat(64),
            source: &"a".repeat(64),
        },
    )
}

/// Clearly synthetic four-file proof for parser-only fixtures; actual original builder evidence is tested separately.
fn synthetic_compiled_evidence(directory: &Path) -> Value {
    let root = directory.join(capture::COMPILED_DIRECTORY);
    fs::create_dir_all(&root).unwrap();
    let mut files = std::collections::BTreeMap::new();
    for name in capture::COMPILED_NAMES {
        fs::write(root.join(name), name).unwrap();
        files.insert(name, binding::digest(name.as_bytes()));
    }
    json!({"capture_sha256":"f".repeat(64),"source_manifest_sha256":"a".repeat(64),"build_configuration":"Release","files":files})
}

/// An old authenticated receipt cannot default the new capture/compiled evidence into numerical acceptance.
#[test]
fn old_v2_and_missing_compiled_evidence_are_rejected_before_candidate_parsing() {
    for missing in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        completed_candidate_fixture(temporary.path());
        let mut receipt: Value = serde_json::from_slice(
            &fs::read(temporary.path().join("candidate-bindings.json")).unwrap(),
        )
        .unwrap();
        if missing {
            receipt.as_object_mut().unwrap().remove("compiled_runner");
        } else {
            receipt["version"] = json!(2);
        }
        write_fixture_receipt(temporary.path(), &receipt);
        assert!(fixture_binding(temporary.path()).is_err());
    }
}

/// Unauthenticated fixture rows remain unproven; only an authenticated failure can retain failed status.
fn read_fixture_candidates(
    output: &Path,
    budget: usize,
    strategy: &str,
    symbol: &str,
) -> Result<Vec<contract::OptimizationCandidate>, String> {
    let receipt = fixture_binding(output);
    parse::read_candidates(
        output,
        budget,
        strategy,
        symbol,
        receipt.as_ref().map_err(String::as_str),
    )
}

/// Explicit synthetic completed binding is supplied here; canceled production work has no fabricated stdout digest.
fn read_fixture_partial_candidates(
    output: &Path,
    budget: usize,
    strategy: &str,
    symbol: &str,
) -> Result<Vec<contract::OptimizationCandidate>, String> {
    let receipt = fixture_binding(output);
    parse::read_partial_candidates(
        output,
        budget,
        strategy,
        symbol,
        receipt.as_ref().map_err(String::as_str),
    )
}

#[test]
fn completed_source_retains_currency_hash_and_undefined_profit_factor_separately_from_score() {
    let temporary = tempfile::tempdir().unwrap();
    completed_candidate_fixture(temporary.path());
    let rows = read_fixture_candidates(temporary.path(), 1, "Synthetic", "QA").unwrap();
    assert_eq!(rows[0].status, "completed", "{:?}", rows[0].error);
    let metrics = rows[0].metrics.as_ref().unwrap();
    assert_eq!(metrics.currency.as_deref(), Some("EUR"));
    assert!(metrics.profit_factor.is_none());
    assert_eq!(metrics.optimizer_profit_factor, Some(999.0));
    assert!(metrics.native_drawdown_percent.is_none());
    assert_eq!(metrics.full_replay_drawdown_percent, Some(0.0));
    assert_eq!(rows[0].report_sha256.as_ref().unwrap().len(), 64);
    let mismatch = read_fixture_candidates(temporary.path(), 1, "DifferentStrategy", "QA").unwrap();
    assert_eq!(mismatch[0].status, "unproven");
    assert!(mismatch[0].metrics.is_none());
}

/// Post-host byte changes, substituted parameter text and absent authentication cannot become completed evidence.
#[test]
fn candidate_binding_rejects_changed_bytes_parameters_and_missing_or_duplicate_markers() {
    for target in ["report.json", "candidate.cbotset", "parameters.cbotset"] {
        let temporary = tempfile::tempdir().unwrap();
        completed_candidate_fixture(temporary.path());
        let path = temporary
            .path()
            .join("candidate_000001_0123456789abcdef")
            .join(target);
        let mut bytes = fs::read(&path).unwrap();
        bytes.push(b' ');
        fs::write(path, bytes).unwrap();
        let rows = read_fixture_candidates(temporary.path(), 1, "Synthetic", "QA").unwrap();
        assert_eq!(rows[0].status, "unproven", "{target}");
        assert!(rows[0].metrics.is_none());
    }
    let temporary = tempfile::tempdir().unwrap();
    let mut candidate = completed_candidate_fixture(temporary.path());
    candidate["parameters"]["HoldTicks"] = json!("99");
    fs::write(
        temporary.path().join("results.json"),
        serde_json::to_vec(&json!({"results":[candidate]})).unwrap(),
    )
    .unwrap();
    assert!(
        read_fixture_candidates(temporary.path(), 1, "Synthetic", "QA")
            .unwrap_err()
            .contains("results.json")
    );
    for stdout in ["".to_string(), "BACKTESTENGINE_OPTIMIZER_BINDING_SHA256 invalid\n".into(), format!("BACKTESTENGINE_OPTIMIZER_BINDING_SHA256 {}\nBACKTESTENGINE_OPTIMIZER_BINDING_SHA256 {}\n", "a".repeat(64), "a".repeat(64))] {
        assert!(binding::marker_digest(&stdout).is_err());
    }
    restore_fixture_parameter_text(temporary.path());
    fs::remove_file(temporary.path().join("binding.stdout")).unwrap();
    let rows = read_fixture_candidates(temporary.path(), 1, "Synthetic", "QA").unwrap();
    assert_eq!(rows[0].status, "unproven");
    assert!(rows[0].metrics.is_none());
}

/// Restore a synthetic receipt after a result-only test mutation without deleting or replacing its source directory.
fn restore_fixture_parameter_text(output: &Path) {
    let mut raw: Value =
        serde_json::from_slice(&fs::read(output.join("results.json")).unwrap()).unwrap();
    raw["results"][0]["parameters"]["HoldTicks"] = json!("10");
    fs::write(
        output.join("results.json"),
        serde_json::to_vec(&raw).unwrap(),
    )
    .unwrap();
}

/// Explicit synthetic re-authentication isolates semantic checks from raw-byte tamper checks.
fn authenticate_fixture_candidate(output: &Path, candidate: &Value) {
    let bytes = serde_json::to_vec(candidate).unwrap();
    fs::write(
        output.join("candidate_000001_0123456789abcdef/candidate_result.json"),
        &bytes,
    )
    .unwrap();
    let mut receipt: Value =
        serde_json::from_slice(&fs::read(output.join("candidate-bindings.json")).unwrap()).unwrap();
    receipt["results_sha256"] = json!(binding::digest(
        &fs::read(output.join("results.json")).unwrap()
    ));
    receipt["candidates"][0]["result_sha256"] = json!(binding::digest(&bytes));
    write_fixture_receipt(output, &receipt);
}

/// Neither aggregate nor per-candidate score/metric bytes can change after the trusted host exits.
#[test]
fn result_hashes_reject_finite_score_metric_changes_missing_files_and_malformed_bytes() {
    for target in [
        "results.json",
        "candidate_000001_0123456789abcdef/candidate_result.json",
    ] {
        for mutation in ["score", "metrics", "missing", "malformed"] {
            let temporary = tempfile::tempdir().unwrap();
            let output = temporary.path();
            completed_candidate_fixture(output);
            mutate_result_file(&output.join(target), mutation);
            assert_result_tamper_rejected(output, target, mutation);
            assert!(
                read_fixture_partial_candidates(output, 1, "Synthetic", "QA").is_err(),
                "{target}: {mutation}"
            );
        }
    }
}

/// Aggregate byte failure aborts the collection; state byte failure keeps its aggregate row non-numeric.
fn assert_result_tamper_rejected(output: &Path, target: &str, mutation: &str) {
    let result = read_fixture_candidates(output, 1, "Synthetic", "QA");
    if target == "results.json" {
        assert!(result.is_err(), "{target}: {mutation}");
        return;
    }
    let rows = result.unwrap();
    assert_eq!(rows[0].status, "unproven", "{target}: {mutation}");
    assert!(rows[0].metrics.is_none());
    assert!(rows[0].elapsed_ms.is_none());
}

/// Mutate raw fixture bytes only, retaining the original synthetic host receipt and stdout digest.
fn mutate_result_file(path: &Path, mutation: &str) {
    if mutation == "missing" {
        fs::remove_file(path).unwrap();
        return;
    }
    if mutation == "malformed" {
        fs::write(path, b"not JSON").unwrap();
        return;
    }
    let mut raw: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let row = if path.file_name().unwrap() == "results.json" {
        &mut raw["results"][0]
    } else {
        &mut raw
    };
    if mutation == "score" {
        row["fitness_score"] = json!(123.25);
    } else {
        row["metrics"]["profit_factor"] = json!(8.5);
    }
    fs::write(path, serde_json::to_vec(&raw).unwrap()).unwrap();
}

/// Even authenticated artifact bytes must agree with original typed generator values and report applied counts.
#[test]
fn candidate_binding_rejects_wrong_preset_fields_values_applied_counts_and_receipt_schema() {
    for mutation in [
        "unknown-root",
        "unknown-parameter",
        "wrong-value",
        "wrong-count",
        "unknown-source",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let output = temporary.path();
        completed_candidate_fixture(output);
        let receipt = mutate_bound_fixture(output, mutation);
        write_fixture_receipt(output, &receipt);
        let rows = read_fixture_candidates(output, 1, "Synthetic", "QA").unwrap();
        assert_eq!(rows[0].status, "unproven", "{mutation}");
        assert!(rows[0].metrics.is_none());
    }
    let temporary = tempfile::tempdir().unwrap();
    completed_candidate_fixture(temporary.path());
    let mut receipt: Value = serde_json::from_slice(
        &fs::read(temporary.path().join("candidate-bindings.json")).unwrap(),
    )
    .unwrap();
    receipt["unknown_authority"] = json!(true);
    write_fixture_receipt(temporary.path(), &receipt);
    assert_eq!(
        read_fixture_candidates(temporary.path(), 1, "Synthetic", "QA").unwrap()[0].status,
        "unproven"
    );
}

/// Alter a synthetic authenticated artifact to test semantic validation independently of its byte-hash guard.
fn mutate_bound_fixture(output: &Path, mutation: &str) -> Value {
    let folder = output.join("candidate_000001_0123456789abcdef");
    let mut receipt: Value =
        serde_json::from_slice(&fs::read(output.join("candidate-bindings.json")).unwrap()).unwrap();
    if ["unknown-root", "unknown-parameter", "wrong-value"].contains(&mutation) {
        let path = folder.join("candidate.cbotset");
        let bytes = mutated_preset_bytes(&path, mutation);
        fs::write(path, &bytes).unwrap();
        receipt["candidates"][0]["preset_sha256"] = json!(binding::digest(&bytes));
        return receipt;
    }
    let path = folder.join("report.json");
    let mut report: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    if mutation == "wrong-count" {
        report["parameter_overrides"] = json!(1);
    } else {
        report["parameter_unknown"] = json!(["HoldTickz"]);
    }
    let bytes = serde_json::to_vec(&report).unwrap();
    fs::write(path, &bytes).unwrap();
    receipt["candidates"][0]["report_sha256"] = json!(binding::digest(&bytes));
    receipt
}

/// Produce bounded explicit preset mutations without altering any retained numerical or generator source.
fn mutated_preset_bytes(path: &Path, mutation: &str) -> Vec<u8> {
    let mut preset: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    match mutation {
        "unknown-root" => preset["Script"] = json!("must-not-execute"),
        "unknown-parameter" => preset["Parameters"]["Balance"] = json!(500),
        _ => preset["Parameters"]["HoldTicks"] = json!(20),
    }
    serde_json::to_vec(&preset).unwrap()
}

#[test]
fn redirected_source_and_malformed_results_are_not_completed_evidence() {
    let temporary = tempfile::tempdir().unwrap();
    let output = temporary.path();
    let mut candidate = completed_candidate_fixture(output);
    candidate["report_path"] = json!(output.join("outside.json"));
    fs::write(
        output.join("outside.json"),
        serde_json::to_vec(&synthetic_report()).unwrap(),
    )
    .unwrap();
    fs::write(
        output.join("results.json"),
        serde_json::to_vec(&json!({"results":[candidate.clone()]})).unwrap(),
    )
    .unwrap();
    authenticate_fixture_candidate(output, &candidate);
    assert!(
        read_fixture_candidates(output, 1, "Synthetic", "QA").unwrap()[0]
            .metrics
            .is_none()
    );
    fs::write(
        output.join("results.json"),
        "{\"results\": [{\"fitness_score\": NaN}]}",
    )
    .unwrap();
    assert!(read_fixture_candidates(output, 1, "Synthetic", "QA")
        .unwrap_err()
        .contains("results.json"));
}

#[test]
fn interruption_reads_only_actual_candidate_state_and_checks_folder_binding() {
    let temporary = tempfile::tempdir().unwrap();
    let output = temporary.path();
    let candidate = completed_candidate_fixture(output);
    let folder = output.join("candidate_000001_0123456789abcdef");
    fs::write(
        folder.join("candidate_result.json"),
        serde_json::to_vec(&candidate).unwrap(),
    )
    .unwrap();
    fs::remove_file(output.join("results.json")).unwrap();
    assert!(read_fixture_partial_candidates(output, 2, "Synthetic", "QA").is_err());
    let mut receipt: Value =
        serde_json::from_slice(&fs::read(output.join("candidate-bindings.json")).unwrap()).unwrap();
    receipt["results_sha256"] = Value::Null;
    write_fixture_receipt(output, &receipt);
    let rows = read_fixture_partial_candidates(output, 2, "Synthetic", "QA").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "completed");
    assert!(read_fixture_partial_candidates(output, 0, "Synthetic", "QA").is_err());
    fs::write(output.join("results.json"), b"{}").unwrap();
    assert!(read_fixture_partial_candidates(output, 2, "Synthetic", "QA").is_err());
    fs::remove_file(output.join("results.json")).unwrap();
    let mut foreign = candidate;
    foreign["id"] = json!("candidate_000002");
    fs::write(
        folder.join("candidate_result.json"),
        serde_json::to_vec(&foreign).unwrap(),
    )
    .unwrap();
    assert!(read_fixture_partial_candidates(output, 2, "Synthetic", "QA").is_err());
}

/// An interrupted host supplies no authenticated receipt, so persisted records expose no numeric values.
#[test]
fn interrupted_records_without_host_receipt_are_unproven_and_non_numeric() {
    let temporary = tempfile::tempdir().unwrap();
    let output = temporary.path();
    completed_candidate_fixture(output);
    fs::remove_file(output.join("binding.stdout")).unwrap();
    fs::remove_file(output.join("results.json")).unwrap();
    let rows = read_fixture_partial_candidates(output, 1, "Synthetic", "QA").unwrap();
    assert_eq!(rows[0].status, "unproven");
    assert!(rows[0].metrics.is_none());
    assert!(rows[0].elapsed_ms.is_none());
    assert!(rows[0].parameters.is_empty());
}

#[test]
fn staged_optimizer_host_matches_its_loading_manifest() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/optimizer");
    assert!(
        verify_optimizer_host(&directory).is_ok(),
        "Run scripts/prepare-optimizer.ps1 first."
    );
}

/// Prepare an explicitly synthetic runner for real original-optimizer process integration tests.
fn synthetic_optimizer_fixture(directory: &Path, program: &str) -> PathBuf {
    let runner = directory.join("runner");
    fs::create_dir(&runner).unwrap();
    fs::write(runner.join("NuGet.Config"),"<configuration><packageSources><clear/></packageSources><auditSources><clear/></auditSources></configuration>").unwrap();
    fs::write(runner.join("WorkspaceCompile.csproj"),"<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include=\"Program.cs\"/><ProjectReference Include=\"shim/BacktestEngine.CAlgoShim.csproj\"/></ItemGroup></Project>").unwrap();
    fs::create_dir(runner.join("shim")).unwrap();
    fs::write(runner.join("shim/BacktestEngine.CAlgoShim.csproj"),"<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>").unwrap();
    fs::write(
        runner.join("shim/Marker.cs"),
        "public class ExplicitSyntheticShimFixture {}",
    )
    .unwrap();
    fs::write(runner.join("Program.cs"), program).unwrap();
    write_optimizer_fixture(
        directory,
        json!({"sha256":binding::digest(program.as_bytes())}),
    )
}

/// Freeze actual generated original-engine source plus a test-only ProcessPath/Release sentinel before intentional profile failure.
fn original_optimizer_fixture(directory: &Path) -> PathBuf {
    let project = directory.join("project");
    fs::create_dir(&project).unwrap();
    fs::write(project.join("Synthetic.cs"),"using cAlgo.API; [Robot] public class Synthetic:Robot { [Parameter(\"Hold ticks\", DefaultValue=5)] public int HoldTicks {get;set;} [Parameter(\"Multiplier\", DefaultValue=1.0)] public double Multiplier {get;set;} [Parameter(\"Label\", DefaultValue=\"base\")] public string Label {get;set;} }").unwrap();
    let root = workspace::ProjectRoot::open(project.to_str().unwrap()).unwrap();
    let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engines/csharp/src");
    let fresh = workspace_build::assemble(&root, &engine, &directory.join("source-stage")).unwrap();
    let runner = directory.join("runner");
    fs::rename(&fresh.snapshot, &runner).unwrap();
    let entry = runner.join("entry/WorkspaceStrategyEntry.cs");
    let path_literal = serde_json::to_string(
        &directory
            .join("actual-runner-process.txt")
            .to_string_lossy(),
    )
    .unwrap();
    let original = fs::read_to_string(&entry).unwrap();
    let assembly_literal = serde_json::to_string(
        &directory
            .join("actual-runner-assembly.txt")
            .to_string_lossy(),
    )
    .unwrap();
    let sentinel = format!("args = args ?? Array.Empty<string>();\n System.IO.File.WriteAllText({path_literal}, System.Environment.ProcessPath ?? \"missing\");\n System.IO.File.WriteAllText({assembly_literal}, typeof(WorkspaceStrategyEntry).Assembly.Location);\n#if DEBUG\n throw new System.InvalidOperationException(\"Synthetic Release sentinel rejected DEBUG build.\");\n#endif\n");
    fs::write(
        entry,
        original.replace("args = args ?? Array.Empty<string>();", &sentinel),
    )
    .unwrap();
    let manifest = crate::replay_receipt::source_manifest(&runner).unwrap();
    write_optimizer_fixture(directory, serde_json::to_value(manifest).unwrap())
}

/// Preserve original optimizer config shape; invalid profile is explicit and never represented as successful economics.
fn write_optimizer_fixture(directory: &Path, source_manifest: Value) -> PathBuf {
    let runner = directory.join("runner");
    fs::write(
        directory.join("ticks.csv"),
        "time,bid,ask\n2026-01-01T00:00:00Z,1,2\n",
    )
    .unwrap();
    fs::write(directory.join("profile.json"), "{}").unwrap();
    fs::write(
        directory.join("base.cbotset"),
        "{\"Chart\":{\"Symbol\":\"QA\",\"Period\":\"m1\"},\"Parameters\":{\"HoldTicks\":5,\"Multiplier\":1,\"Label\":\"base\"}}",
    )
    .unwrap();
    let config = directory.join("optimizer.json");
    fs::write(&config,serde_json::to_vec_pretty(&json!({"strategy":"Synthetic","runner_project":runner.join("WorkspaceCompile.csproj"),"build_runner":true,"base_params":directory.join("base.cbotset"),"scenario":{"symbol":"QA","timeframe":"m1","data_mode":"ticks","data_file":directory.join("ticks.csv"),"symbol_spec":directory.join("profile.json"),"balance":10000.0},"search":{"method":"grid","max_runs":1,"seed":42},"parameters":{"HoldTicks":{"type":"int","values":[10]},"Multiplier":{"type":"double","values":[0.1]},"Label":{"type":"string","values":["</é+&>"]}},"cpu":{"max_workers":1},"output":{"dir":directory.join("output")}})).unwrap()).unwrap();
    fs::write(
        directory.join("optimizer-inputs.json"),
        serde_json::to_vec(
            &json!({"sourceManifest":source_manifest,"buildConfiguration":"Release"}),
        )
        .unwrap(),
    )
    .unwrap();
    config
}

/// Run the unchanged original optimizer against an explicit failing runner fixture; no trading result is fabricated.
#[tokio::test]
async fn original_optimizer_reports_genuine_failed_candidate_without_fake_metrics() {
    // Preserve original compiler stdout/stderr on failure rather than losing the only diagnostic with TempDir.
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../artifacts/optimizer-source-tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&evidence).unwrap();
    let evidence = crate::build_process::workflow_directory(&evidence).unwrap();
    let directory = evidence.as_path();
    let config = original_optimizer_fixture(directory);
    let source_manifest =
        crate::replay_receipt::source_manifest(&directory.join("runner")).unwrap();
    let _source_locks =
        crate::replay_receipt::lock_source_manifest(&directory.join("runner"), &source_manifest)
            .unwrap();
    let sdk =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtimes/dotnet/dotnet.exe");
    let host = verify_optimizer_host(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/optimizer"),
    )
    .unwrap();
    let (_sender, mut cancel) = oneshot::channel();
    let cleanup = Arc::new(AtomicBool::new(true));
    let outcome = process::run_optimizer(
        &sdk,
        &host,
        &config,
        directory,
        &mut cancel,
        120,
        cleanup.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        outcome.status.code(),
        Some(2),
        "{}\n{}",
        String::from_utf8_lossy(&outcome.stdout),
        String::from_utf8_lossy(&outcome.stderr)
    );
    assert!(cleanup.load(Ordering::Acquire));
    let actual = fs::read_to_string(directory.join("actual-runner-process.txt")).unwrap();
    assert_eq!(
        Path::new(&actual).canonicalize().unwrap(),
        sdk.canonicalize().unwrap()
    );
    let actual_assembly = fs::read_to_string(directory.join("actual-runner-assembly.txt")).unwrap();
    assert_eq!(
        Path::new(&actual_assembly).canonicalize().unwrap(),
        directory
            .join(capture::COMPILED_DIRECTORY)
            .join("WorkspaceCompile.dll")
            .canonicalize()
            .unwrap()
    );
    assert_eq!(
        fs::symlink_metadata(directory.join("runner/bin/Release"))
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::NotFound
    );
    assert_eq!(
        fs::symlink_metadata(
            directory.join("runner/bin/Debug/Release/net10.0/WorkspaceCompile.exe")
        )
        .unwrap_err()
        .kind(),
        std::io::ErrorKind::NotFound
    );
    // This receipt comes from the production compiled helper and original C# generator,
    // including G17 floating text and System.Text.Json Unicode/HTML escaping semantics.
    let config_hash = binding::digest(&fs::read(&config).unwrap());
    let base_hash = binding::digest(&fs::read(directory.join("base.cbotset")).unwrap());
    let data_hash = binding::digest(&fs::read(directory.join("ticks.csv")).unwrap());
    let profile_hash = binding::digest(&fs::read(directory.join("profile.json")).unwrap());
    let receipt = binding::load(
        directory,
        &String::from_utf8_lossy(&outcome.stdout),
        binding::FrozenInputs {
            config: &config_hash,
            base: &base_hash,
            data: &data_hash,
            profile: &profile_hash,
            capture: &binding::digest(&fs::read(directory.join("optimizer-inputs.json")).unwrap()),
            source: &source_manifest.sha256,
        },
    )
    .unwrap();
    let original: Value =
        serde_json::from_slice(&fs::read(directory.join("output/results.json")).unwrap()).unwrap();
    assert_eq!(receipt.candidates.len(), 1);
    assert_eq!(
        receipt.candidates[0].hash,
        original["results"][0]["hash"].as_str().unwrap()
    );
    assert_eq!(
        receipt.candidates[0].parameters["Multiplier"],
        "0.10000000000000001"
    );
    assert_eq!(receipt.candidates[0].parameters["Label"], "</é+&>");
    assert_eq!(receipt.candidates[0].values["Multiplier"], json!(0.1));
    assert_eq!(receipt.candidates[0].values["Label"], json!("</é+&>"));
    let output = directory.join("output");
    let rows = parse::read_candidates(&output, 1, "Synthetic", "QA", Ok(&receipt)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "failed");
    assert!(rows[0].metrics.is_none());
    assert!(rows[0].error.as_deref().unwrap().contains("schema_version"));
    let compiled = receipt.compiled_provenance().unwrap();
    assert_eq!(compiled.files.len(), 4);
    assert_eq!(compiled.build_configuration, "Release");
    assert_eq!(
        binding::digest(&fs::read(&actual_assembly).unwrap()),
        compiled.files["WorkspaceCompile.dll"].sha256
    );
    mutate_result_file(&output.join("results.json"), "score");
    assert!(
        parse::read_candidates(&output, 1, "Synthetic", "QA", Ok(&receipt))
            .unwrap_err()
            .contains("results.json")
    );
}

/// A genuine original-builder compile failure must not mint a v3 receipt or authorize guessed compiled hashes.
#[tokio::test]
async fn original_optimizer_failed_build_does_not_publish_authenticated_compilation() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path();
    let config = synthetic_optimizer_fixture(
        directory,
        "This is an intentionally invalid synthetic CSharp fixture.",
    );
    let sdk =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtimes/dotnet/dotnet.exe");
    let host = verify_optimizer_host(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/optimizer"),
    )
    .unwrap();
    let (_sender, mut cancel) = oneshot::channel();
    let cleanup = Arc::new(AtomicBool::new(true));
    let output = process::run_optimizer(
        &sdk,
        &host,
        &config,
        directory,
        &mut cancel,
        120,
        cleanup.clone(),
    )
    .await
    .unwrap();
    assert!(!output.status.success());
    assert!(cleanup.load(Ordering::Acquire));
    assert!(binding::marker_digest(&String::from_utf8_lossy(&output.stdout)).is_err());
    assert_eq!(
        fs::symlink_metadata(directory.join("candidate-bindings.json"))
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::NotFound
    );
}

#[cfg(windows)]
#[path = "optimizer_process_tests.rs"]
mod process_tests;

/// Build only host identity metadata around an actual temporary Windows project, without engine execution.
fn project_identity_fixture() -> (
    tempfile::TempDir,
    WorkspaceState,
    workspace_build::ApprovedBuild,
    workspace::WorkspaceProject,
) {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    fs::create_dir(&project).unwrap();
    let project = workspace::ProjectRoot::open(project.to_str().unwrap()).unwrap();
    let public = workspace::refresh_project(&project).unwrap();
    #[cfg(windows)]
    assert_ne!(project.directory().to_string_lossy(), public.root);
    let approved = workspace_build::ApprovedBuild {
        project_root: project.directory().to_string_lossy().into_owned(),
        artifact_path: "synthetic-unexecuted.dll".into(),
        revision: "synthetic-identity-revision".into(),
        artifact_sha256: "synthetic-identity-hash".into(),
        runtime_sha256: Default::default(),
        strategies: Vec::new(),
        parameter_schemas: Vec::new(),
        source_manifest: crate::replay_receipt::ApprovedSourceManifest {
            files: Default::default(),
            sha256: String::new(),
        },
    };
    let state = WorkspaceState {
        session: workspace::SessionStore {
            path: directory.path().join("session.json"),
        },
        projects_directory: directory.path().join("projects"),
        builds_directory: directory.path().join("builds"),
        selected: Some(project).into(),
        build_running: false.into(),
        build_cancel: None.into(),
        build_flight: None.into(),
        last_successful_build: Some(approved.clone()).into(),
    };
    (directory, state, approved, public)
}

/// A synthetic completed in-memory slot exercises restoration only, never claimed optimizer economics.
fn identity_result(
    project: &str,
    approved: &workspace_build::ApprovedBuild,
) -> OptimizationRunResult {
    serde_json::from_value(json!({"runId":"synthetic-selection-only","projectRoot":project,"buildRevision":approved.revision,"approvedArtifactSha256":approved.artifact_sha256,"datasetId":"synthetic","datasetSha256":"synthetic","symbolSpecId":"synthetic","symbolSpecSha256":"synthetic","configSha256":"synthetic","strategy":"Synthetic","method":"grid","seed":42,"budget":1,"startedAt":"","completedAt":"","durationMs":0,"runFolder":"","configPath":"","status":"completed","success":true,"exitCode":0,"candidates":[],"errors":[],"output":"Identity fixture only; no optimizer or engine executed.","lastGoodPreserved":false})).unwrap()
}

/// Public optimizer metadata matches WorkspaceProject.root while approval remains privately canonical.
#[test]
fn actual_project_optimizer_output_and_saved_restore_use_public_identity() {
    let (directory, workspace, approved, public) = project_identity_fixture();
    let state = OptimizationState {
        directory: directory.path().join("optimizations"),
        running: false.into(),
        cancel: None.into(),
        last_good: None.into(),
        retained_inputs: None.into(),
    };
    let prepared = PreparedOptimization {
        directory: directory.path().join("failed-synthetic-attempt"),
        config: directory.path().join("config.json"),
        config_sha256: "synthetic".into(),
        dataset_sha256: "synthetic".into(),
        symbol: "QA".into(),
        run_id: "synthetic-unexecuted".into(),
        symbol_spec_sha256: "synthetic".into(),
        base_parameter_sha256: "synthetic".into(),
        capture: None,
    };
    let output = finish_optimization(
        &state,
        &approved,
        &request(),
        prepared,
        Err("Synthetic no-process identity test.".into()),
        String::new(),
        0,
    )
    .unwrap();
    assert!(!output.success);
    assert_eq!(output.project_root, public.root);
    *state.last_good.lock().unwrap() = Some(identity_result(&public.root, &approved));
    assert_eq!(
        last_good_optimization_result(&state, &workspace)
            .unwrap()
            .unwrap()
            .project_root,
        public.root
    );
    *workspace.selected.lock().unwrap() = Some(workspace::ProjectRoot::open(&public.root).unwrap());
    assert!(last_good_optimization_result(&state, &workspace)
        .unwrap()
        .is_some());
    let foreign = directory.path().join("project-foreign");
    fs::create_dir(&foreign).unwrap();
    let foreign = workspace::ProjectRoot::open(foreign.to_str().unwrap()).unwrap();
    assert!(foreign.display().starts_with(&public.root));
    *workspace.selected.lock().unwrap() = Some(foreign.clone());
    assert!(last_good_optimization_result(&state, &workspace)
        .unwrap()
        .is_none());
    *workspace.selected.lock().unwrap() = Some(workspace::ProjectRoot::open(&public.root).unwrap());
    assert!(last_good_optimization_result(&state, &workspace)
        .unwrap()
        .is_some());
    state
        .last_good
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .project_root = foreign.display().to_string();
    assert!(last_good_optimization_result(&state, &workspace)
        .unwrap()
        .is_none());
}

/// Exercise guard teardown only; no SDK process or optimizer is launched by these explicitly synthetic states.
pub(super) fn guarded_job_states(
    directory: &Path,
) -> (OptimizationState, execution::ExecutionState) {
    let optimization = OptimizationState {
        directory: directory.join("not-yet-prepared"),
        running: false.into(),
        cancel: None.into(),
        last_good: None.into(),
        retained_inputs: None.into(),
    };
    let execution = execution::ExecutionState {
        runs_directory: directory.join("runs"),
        market_data_directory: directory.join("market"),
        builds_directory: directory.join("builds"),
        running: false.into(),
        cancel: None.into(),
        last_good: None.into(),
        last_good_project: None.into(),
        retained_inputs: None.into(),
    };
    (optimization, execution)
}

/// Model the early SDK-probe error return before optimizer input capture, using the real shared cleanup marker.
fn synthetic_sdk_probe_error(
    optimization: &OptimizationState,
    execution: &execution::ExecutionState,
    cleanup_confirmed: bool,
) -> Result<(), String> {
    let guard = acquire_job(optimization, execution)?;
    let (sender, _receiver) = oneshot::channel();
    *optimization.cancel.lock().unwrap() = Some(sender);
    guard.cleanup.store(cleanup_confirmed, Ordering::Release);
    Err("Synthetic SDK-probe failure; no child was launched.".into())
}

#[test]
fn sdk_probe_cleanup_marker_controls_both_optimizer_latches_before_input_capture() {
    for cleanup_confirmed in [true, false] {
        let temporary = tempfile::tempdir().unwrap();
        let (optimization, execution) = guarded_job_states(temporary.path());
        assert!(synthetic_sdk_probe_error(&optimization, &execution, cleanup_confirmed).is_err());
        assert_eq!(*optimization.running.lock().unwrap(), !cleanup_confirmed);
        assert_eq!(*execution.running.lock().unwrap(), !cleanup_confirmed);
        assert!(optimization.cancel.lock().unwrap().is_none());
        assert_eq!(
            acquire_job(&optimization, &execution).is_ok(),
            cleanup_confirmed
        );
        assert!(
            !optimization.directory.exists(),
            "Probe failure must precede input capture."
        );
    }
}

#[test]
fn unconfirmed_sdk_probe_cleanup_preserves_prior_optimizer_evidence() {
    let (temporary, _workspace, approved, public) = project_identity_fixture();
    let (optimization, execution) = guarded_job_states(temporary.path());
    let prior = identity_result(&public.root, &approved);
    *optimization.last_good.lock().unwrap() = Some(prior.clone());
    assert!(synthetic_sdk_probe_error(&optimization, &execution, false).is_err());
    let preserved = optimization.last_good.lock().unwrap().clone().unwrap();
    assert_eq!(preserved.run_id, prior.run_id);
    assert_eq!(preserved.build_revision, prior.build_revision);
    assert!(*optimization.running.lock().unwrap() && *execution.running.lock().unwrap());
}
