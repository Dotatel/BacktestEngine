//! Deliberately synthetic provenance fixtures; no authenticated economics or trading parity is claimed.
use super::*;
use serde_json::json;

#[test]
fn authority_hash_case_and_whitespace_match_the_original_csharp_loader() {
    let mut fixture = self::fixture(false);
    let original = PathBuf::from(&fixture.profile.original_path);
    let mut raw: serde_json::Value = serde_json::from_slice(&fs::read(&original).unwrap()).unwrap();
    raw["specification_source_sha256"] = json!(format!(
        " {} ",
        digest(&fs::read(&fixture.authority).unwrap()).to_ascii_uppercase()
    ));
    fs::write(&original, serde_json::to_vec(&raw).unwrap()).unwrap();
    fixture.profile = market_data::import_symbol_spec(
        &fixture.home.path().join("catalog"),
        original.to_str().unwrap(),
    )
    .unwrap();
    assert!(
        capture(&fixture).is_ok(),
        "Original RequiredSha256 trims and lowercases declared hashes before comparison."
    );
}

/// Fresh owned source/catalog records used only to exercise byte identity and Windows locking.
pub(crate) struct Fixture {
    pub home: tempfile::TempDir,
    pub source: PathBuf,
    pub run: PathBuf,
    pub approved: workspace_build::ApprovedBuild,
    pub dataset: market_data::ImportedDataset,
    pub profile: market_data::ImportedSymbolSpec,
    pub authority: PathBuf,
}

/// Construct minimal synthetic registered inputs through the real importer, never a valid economic profile.
pub(crate) fn fixture(nested: bool) -> Fixture {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("fresh-source");
    for relative in ["engine", "strategies", "entry"] {
        fs::create_dir_all(source.join(relative)).unwrap();
    }
    for relative in [
        "engine/Original.cs",
        "strategies/f0.cs",
        "entry/WorkspaceStrategyEntry.cs",
        "WorkspaceCompile.csproj",
        "NuGet.Config",
        "Directory.Build.targets",
        "Directory.Build.props",
    ] {
        fs::write(source.join(relative), relative.as_bytes()).unwrap();
    }
    fs::write(
        source.join("revision.json"),
        b"{\"revision\":\"synthetic-revision\"}",
    )
    .unwrap();
    let manifest = source_manifest(&source).unwrap();
    let run = home.path().join("baseline-run");
    fs::create_dir(&run).unwrap();
    let csv = home.path().join("ticks.csv");
    fs::write(&csv, "time_utc,bid,ask\n2026-01-01T00:00:00Z,1.0,1.1\n").unwrap();
    let storage = home.path().join("catalog");
    let dataset =
        market_data::import_market_data(&storage, csv.to_str().unwrap(), "ticks").unwrap();
    let authority = home.path().join("source.json");
    fs::write(&authority, b"{\"synthetic\":true}").unwrap();
    let mut raw = json!({"schema_version":"backtestengine.economic-symbol/v2","symbol":"QA","specification_source_path":"source.json","specification_source_sha256":digest(&fs::read(&authority).unwrap()),"usd_notional_conversion_rule":"quote_to_usd","swap_time_authority_status":"Unknown","commission_model":"UsdPerMillionUsdVolume","commission_rate":0.3,"commission_rate_currency":"USD","commission_side_semantics":"PerFill","minimum_commission":0.5,"minimum_commission_currency":"USD","commission_rounding_mode":"CurrencyCent"});
    if nested {
        add_nested_authority(home.path(), &mut raw);
    }
    let original = home.path().join("profile.json");
    fs::write(&original, serde_json::to_vec(&raw).unwrap()).unwrap();
    let profile = market_data::import_symbol_spec(&storage, original.to_str().unwrap()).unwrap();
    let binary = home.path().join("synthetic-bin");
    fs::create_dir(&binary).unwrap();
    let artifact = binary.join("WorkspaceCompile.dll");
    fs::write(&artifact, b"synthetic-not-a-dotnet-assembly").unwrap();
    let mut runtime_sha256 = BTreeMap::new();
    for name in [
        "BacktestEngine.CAlgoShim.dll",
        "WorkspaceCompile.deps.json",
        "WorkspaceCompile.runtimeconfig.json",
    ] {
        fs::write(binary.join(name), name).unwrap();
        runtime_sha256.insert(name.into(), digest(name.as_bytes()));
    }
    let approved = workspace_build::ApprovedBuild {
        project_root: home.path().canonicalize().unwrap().to_string_lossy().into(),
        artifact_path: artifact.to_string_lossy().into(),
        revision: "synthetic-revision".into(),
        artifact_sha256: digest(b"synthetic-not-a-dotnet-assembly"),
        runtime_sha256,
        strategies: vec!["Synthetic".into()],
        parameter_schemas: Vec::new(),
        source_manifest: manifest.clone(),
    };
    Fixture {
        home,
        source,
        run,
        approved,
        dataset,
        profile,
        authority,
    }
}

/// Add the exact original commission-reference shape with obviously synthetic leaves.
fn add_nested_authority(root: &Path, raw: &mut serde_json::Value) {
    let mut authority = json!({"synthetic":true});
    for (path_key, hash_key, name) in [
        ("source_events_path", "source_events_sha256", "events.jsonl"),
        (
            "source_report_path",
            "source_report_sha256",
            "native-report.json",
        ),
        ("source_spec_path", "source_spec_sha256", "capture.json"),
    ] {
        fs::write(root.join(name), name).unwrap();
        authority[path_key] = json!(name);
        authority[hash_key] = json!(digest(name.as_bytes()));
    }
    let bytes = serde_json::to_vec(&authority).unwrap();
    fs::write(root.join("commission.json"), &bytes).unwrap();
    raw["usd_notional_conversion_rule"] = json!("fixed_base_to_usd");
    raw["commission_conversion_authority_path"] = json!("commission.json");
    raw["commission_conversion_authority_sha256"] = json!(digest(&bytes));
    raw["native_commission_end_utc"] = json!("2026-03-31T00:00:00Z");
}

/// Preserve explicit nondefault economics and no-file parameter semantics in all synthetic receipts.
pub(crate) fn settings() -> ReplaySettings {
    ReplaySettings {
        strategy: "Synthetic".into(),
        symbol: "QA".into(),
        timeframe: "m1".into(),
        starting_balance: 25000.0,
        commission_usd_per_million: -1.0,
        effective_commission_usd_per_million: 0.3,
        slippage_pips: 0.4,
        spread_pips: None,
        start_utc: Some("2026-01-01T00:00:00Z".into()),
        end_utc: Some("2026-04-01T00:00:00Z".into()),
        max_ticks: None,
        max_bars: None,
        bar_timeframe: None,
        bar_price_mode: None,
        write_equity_csv: true,
        parameter_overrides: BTreeMap::from([("HoldTicks".into(), "10".into())]),
        parameter_mode: ParameterMode::NoFile,
    }
}

/// Capture a fixture using the same host-only API later used by ordinary execution.
pub(crate) fn capture(fixture: &Fixture) -> Result<FrozenReplayInputs, String> {
    capture_replay_inputs(CaptureReplayInputs {
        run_id: "synthetic-run",
        run_directory: &fixture.run,
        fresh_source: &fixture.source,
        approved: &fixture.approved,
        settings: settings(),
        dataset: &fixture.dataset,
        profile: &fixture.profile,
    })
}

#[test]
fn fresh_source_and_exact_approved_manifest_are_required() {
    let fixture = self::fixture(false);
    fs::write(
        fixture.source.join("strategies/f0.cs"),
        b"changed after approved compile",
    )
    .unwrap();
    assert!(capture(&fixture)
        .err()
        .unwrap()
        .contains("approved compilation"));
    assert!(!fixture.run.join("replay-inputs").exists());
    let fixture = self::fixture(false);
    fs::write(
        fixture.source.join("revision.json"),
        b"{\"revision\":\"foreign\"}",
    )
    .unwrap();
    assert!(capture(&fixture).is_err());
}

#[test]
fn dataset_replacement_between_preflight_probe_and_capture_is_rejected() {
    let fixture = self::fixture(false);
    fs::write(
        &fixture.dataset.stored_path,
        "time_utc,bid,ask\n2026-01-01T00:00:00Z,9.0,9.1\n",
    )
    .unwrap();
    assert!(capture(&fixture)
        .err()
        .unwrap()
        .contains("changed before capture"));
}

#[test]
fn exact_receipt_hash_and_frozen_bytes_survive_mutable_catalog_changes() {
    let fixture = self::fixture(false);
    let mut frozen = capture(&fixture).unwrap();
    assert_eq!(
        frozen.receipt_sha256,
        digest(&fs::read(frozen.directory.join("receipt.json")).unwrap())
    );
    let original_data = fs::read(&fixture.dataset.stored_path).unwrap();
    assert_eq!(
        fs::read(frozen.directory.join("market.csv")).unwrap(),
        original_data
    );
    fs::write(&fixture.dataset.stored_path, b"mutable catalog replacement").unwrap();
    fs::write(fixture.source.join("strategies/f0.cs"), b"later user edit").unwrap();
    assert!(verify_frozen_replay(&frozen.directory, &frozen.receipt_sha256).is_ok());
    frozen.authority_locks.verify().unwrap();
    assert!(fs::write(frozen.directory.join("market.csv"), b"tampered frozen copy").is_err());
    let directory = frozen.directory.clone();
    let sha256 = frozen.receipt_sha256.clone();
    drop(frozen);
    fs::write(directory.join("market.csv"), b"tampered frozen copy").unwrap();
    assert!(verify_frozen_replay(&directory, &sha256)
        .unwrap_err()
        .contains("changed"));
}

#[test]
fn receipt_cannot_authorize_its_own_changed_hash_or_escape_paths() {
    let fixture = self::fixture(false);
    let frozen = capture(&fixture).unwrap();
    let path = frozen.directory.join("receipt.json");
    let mut raw: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    raw["files"][0]["relativePath"] = json!("../foreign");
    let directory = frozen.directory.clone();
    let sha256 = frozen.receipt_sha256.clone();
    drop(frozen);
    fs::write(path, serde_json::to_vec(&raw).unwrap()).unwrap();
    assert!(verify_frozen_replay(&directory, &sha256)
        .unwrap_err()
        .contains("receipt changed"));
    for path in [
        "../foreign",
        "C:/foreign",
        "runner\\foreign",
        "file:stream",
        "/absolute",
    ] {
        assert!(owned_file(&directory, path).is_err());
    }
}

#[cfg(windows)]
#[test]
fn original_nested_authorities_are_locked_against_write_delete_then_released() {
    let fixture = self::fixture(true);
    let frozen = capture(&fixture).unwrap();
    assert_eq!(frozen.receipt.authorities.len(), 5);
    let leaf = fixture.home.path().join("events.jsonl");
    assert!(fs::OpenOptions::new().write(true).open(&leaf).is_err());
    assert!(fs::rename(&leaf, fixture.home.path().join("renamed.jsonl")).is_err());
    let receipt = frozen.receipt.clone();
    drop(frozen);
    fs::write(&leaf, b"changed after baseline").unwrap();
    assert!(lock_receipt_authorities(&receipt)
        .err()
        .unwrap()
        .contains("changed since the baseline"));
}

#[test]
fn declared_nested_authority_hash_and_registration_tamper_fail_closed() {
    let fixture = self::fixture(true);
    fs::write(
        fixture.home.path().join("events.jsonl"),
        b"not original bytes",
    )
    .unwrap();
    assert!(capture(&fixture)
        .err()
        .unwrap()
        .contains("SHA-256 mismatch"));
    let fixture = self::fixture(false);
    let path = Path::new(&fixture.profile.stored_path)
        .parent()
        .unwrap()
        .join("dependencies.json");
    let mut raw: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    raw["id"] = json!("foreign-catalog-id");
    fs::write(path, serde_json::to_vec(&raw).unwrap()).unwrap();
    assert!(capture(&fixture).err().unwrap().contains("registration"));
}

#[test]
fn sparse_oversized_source_is_rejected_before_allocation() {
    let fixture = self::fixture(false);
    fs::File::create(fixture.source.join("strategies/large.cs"))
        .unwrap()
        .set_len(1024 * 1024 + 1)
        .unwrap();
    assert!(source_manifest(&fixture.source)
        .unwrap_err()
        .contains("too large"));
    assert!(fixture.authority.exists());
}

/// Control-only report projection; production separately requires the complete original ReportWriter schema.
fn baseline_controls(receipt: &FrozenReplayReceipt) -> serde_json::Value {
    let terms = &receipt.commission_terms;
    let settings = &receipt.settings;
    json!({"strategy":settings.strategy,"symbol":settings.symbol,"replay":{"mode":receipt.dataset.kind},"account":{"starting_capital":settings.starting_balance},"execution_slippage_pips_per_fill":settings.slippage_pips,"commission_usd_per_million":settings.effective_commission_usd_per_million,"parameter_file":"","parameter_defaults":0,"parameter_overrides":settings.parameter_overrides.len(),"economic_contract":{"commission_model":terms.model,"commission_rate":settings.effective_commission_usd_per_million,"commission_rate_currency":terms.rate_currency,"commission_side_semantics":terms.side_semantics,"commission_rounding_mode":terms.rounding_mode,"minimum_commission":terms.minimum_commission,"minimum_commission_currency":terms.minimum_currency}})
}

#[test]
fn successful_baseline_receipt_requires_exact_report_controls_hash_and_commission_terms() {
    let fixture = self::fixture(false);
    let mut frozen = capture(&fixture).unwrap();
    let path = fixture.run.join("synthetic-control-projection.json");
    let raw = baseline_controls(&frozen.receipt);
    let bytes = serde_json::to_vec(&raw).unwrap();
    fs::write(&path, &bytes).unwrap();
    verify_baseline_completion(&mut frozen, &path, &digest(&bytes)).unwrap();
    assert!(
        verify_baseline_completion(&mut frozen, &path, &"f".repeat(64))
            .unwrap_err()
            .contains("report changed")
    );
    for field in [
        "commission_model",
        "commission_rate",
        "commission_rate_currency",
        "commission_side_semantics",
        "commission_rounding_mode",
        "minimum_commission",
        "minimum_commission_currency",
    ] {
        let mut changed = raw.clone();
        changed["economic_contract"][field] = serde_json::Value::Null;
        let bytes = serde_json::to_vec(&changed).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(
            verify_baseline_completion(&mut frozen, &path, &digest(&bytes)).is_err(),
            "Changed {field} was accepted."
        );
    }
}
