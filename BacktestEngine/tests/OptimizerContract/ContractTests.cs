using System.Reflection;
using System.Text.Json;

namespace BacktestEngine.Optimizer.Tests;

internal static class ContractTests
{
    private static int _assertions;

    private static int Main()
    {
        string root = Path.Combine(Path.GetTempPath(), "optimizer-contract-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            ValidateCostsAndDataModes();
            VerifyReplayCache(root);
            VerifyRunnerArguments(root);
            VerifyUnknownParameterRejection(root);
            VerifyScenarioOutputNames(root);
            VerifyWorktreeRoot(root);
            VerifyNativeReportMetric(root);
            Console.WriteLine($"OPTIMIZER_CONTRACT status=passed assertions={_assertions}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("OPTIMIZER_CONTRACT status=failed " + ex);
            return 1;
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void VerifyNativeReportMetric(string root)
    {
        string path = Path.Combine(root, "drawdown.json");
        File.WriteAllText(path, "{\"drawdown\":{\"max_equity_drawdown\":300,\"max_equity_drawdown_percent\":3},\"native_report_drawdown\":{\"max_equity_drawdown\":231.2,\"max_equity_drawdown_percent\":2.3120739863675164}}");
        var metrics = BacktestMetrics.Load(path);
        Check(metrics.MaxEquityDrawdown == 231.2, "optimizer uses native report absolute DD");
        Check(metrics.MaxEquityDrawdownPercent == 2.3120739863675164, "optimizer uses native report percentage DD");
        File.WriteAllText(path, "{\"drawdown\":{\"max_equity_drawdown\":300,\"max_equity_drawdown_percent\":3}}");
        metrics = BacktestMetrics.Load(path);
        Check(metrics.MaxEquityDrawdown == 300 && metrics.MaxEquityDrawdownPercent == 3, "older reports retain full-path metric fallback");
    }

    private static ScenarioConfig Scenario() => new ScenarioConfig
    {
        Symbol = "XAUUSD",
        Timeframe = "h1",
        DataMode = "bars",
        DataFile = "prices.csv",
        WarmupDataFile = "warmup.csv",
        BarPeriod = "m1",
        BarPriceMode = "ohlc",
        SymbolSpec = "symbol.json",
        SpreadPips = 1.0,
        StartUtc = "2025-01-01T00:00:00Z",
        EndUtc = "2025-02-01T00:00:00Z"
    };

    private static void ValidateCostsAndDataModes()
    {
        ScenarioConfig scenario = Scenario();
        scenario.Validate();
        scenario.SpreadPips = null;
        Reject(scenario.Validate, "spread_pips", "missing bar costs rejected");
        scenario.SpreadPips = -1;
        Reject(scenario.Validate, "spread_pips", "negative bar costs rejected");
        scenario.SpreadPips = double.NaN;
        Reject(scenario.Validate, "spread_pips", "nonfinite bar costs rejected");
        scenario.SpreadPips = 0;
        scenario.Validate();
        Check(true, "intentional zero-spread research remains expressible");
        scenario.BarPriceMode = "";
        Reject(scenario.Validate, "bar_price_mode", "implicit bar path rejected");
        scenario.BarPriceMode = "ohlc";
        scenario.SymbolSpec = "";
        Reject(scenario.Validate, "symbol_spec", "implicit symbol economics rejected");
        scenario.SymbolSpec = "symbol.json";
        scenario.DataMode = "tics";
        Reject(scenario.Validate, "data_mode", "typo cannot silently switch tick replay to bars");
        scenario.DataMode = "ticks";
        scenario.SpreadPips = null;
        scenario.BarPriceMode = "";
        scenario.Validate();
        Check(true, "native bid-ask tick replay does not require fixed spread");
        scenario.EndUtc = scenario.StartUtc;
        Reject(scenario.Validate, "start_utc", "empty date interval rejected");
        scenario.EndUtc = "2024-12-31T00:00:00Z";
        Reject(scenario.Validate, "start_utc", "reversed date interval rejected");
        scenario = Scenario();
        scenario.WarmupSeries["h1"] = "native-h1.csv";
        Reject(scenario.Validate, "mutually exclusive", "ambiguous warmup sources rejected");
        scenario.WarmupDataFile = "";
        scenario.Validate();
        Check(true, "independent native warmup series accepted");
    }

    private static OptimizerConfig Config() => new OptimizerConfig
    {
        Strategy = "ExampleStrategy",
        RunnerProject = "runner/Runner.csproj",
        BuildRunner = true,
        BaseParams = "base.cbotset",
        Scenario = Scenario(),
        Output = new OutputConfig { Dir = "output" }
    };

    private static void VerifyReplayCache(string root)
    {
        string[] inputs =
        {
            "base.cbotset", "prices.csv", "warmup.csv", "symbol.json", "metadata.json", "swap-authority.json",
            "native-report.json", "native-events.jsonl",
            "runner/bin/Debug/net10.0/Runner.dll", "runner/bin/Debug/net10.0/BacktestEngine.CAlgoShim.dll"
        };
        foreach (string input in inputs)
        {
            string path = Path.Combine(root, input);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, "original:" + input);
        }
        File.WriteAllText(Path.Combine(root, "symbol.json"), "{\"specification_source_path\":\"metadata.json\",\"swap_time_authority_path\":\"swap-authority.json\"}");
        File.WriteAllText(Path.Combine(root, "metadata.json"), "{\"source_report_relative_path\":\"native-report.json\"}");
        File.WriteAllText(Path.Combine(root, "swap-authority.json"), "{\"swap_time\":\"21:00:00\"}");
        File.WriteAllText(Path.Combine(root, "native-report.json"), "{\"source_events_path\":\"native-events.jsonl\",\"source_spec_path\":\"symbol.json\"}");
        File.WriteAllText(Path.Combine(root, "native-events.jsonl"), "{\"event\":\"commission\",\"value\":12}\n");
        OptimizerConfig config = Config();
        string original = ReplayProvenance.Compute(root, config);
        Check(original.Length == 64 && original == ReplayProvenance.Compute(root, config), "stable replay fingerprint with cyclic transitive authority references");
        string report = Path.Combine(root, "report.json");
        string provenance = Path.Combine(root, "replay-provenance.json");
        File.WriteAllText(report, "{\"account\":{\"balance\":10123.45}}");
        Check(!ReplayProvenance.CanReuse(provenance, report, original), "historical reports without provenance cannot be reused");
        ReplayProvenance.Write(provenance, report, original);
        Check(ReplayProvenance.CanReuse(provenance, report, original), "unchanged verified report is reusable");

        foreach (string input in inputs)
        {
            string path = Path.Combine(root, input);
            string content = File.ReadAllText(path);
            File.AppendAllText(path, " ");
            string changed = ReplayProvenance.Compute(root, config);
            Check(changed != original && !ReplayProvenance.CanReuse(provenance, report, changed), "changed input invalidates cached result: " + input);
            File.WriteAllText(path, content);
        }
        config.Scenario.DataMode = "ticks";
        config.Scenario.DataFiles.Add("second-quarter.csv");
        File.WriteAllText(Path.Combine(root, "second-quarter.csv"), "original tick chunk");
        string withChunk = ReplayProvenance.Compute(root, config);
        File.AppendAllText(Path.Combine(root, "second-quarter.csv"), " changed");
        Check(withChunk != ReplayProvenance.Compute(root, config), "all repeated tick files are fingerprinted");
        config = Config();
        config.Scenario.WarmupDataFile = "";
        config.Scenario.WarmupSeries["m15"] = "native-m15.csv";
        File.WriteAllText(Path.Combine(root, "native-m15.csv"), "captured history");
        string withNativeHistory = ReplayProvenance.Compute(root, config);
        File.AppendAllText(Path.Combine(root, "native-m15.csv"), " changed");
        Check(withNativeHistory != ReplayProvenance.Compute(root, config), "independent native warmup file invalidates cache");
        config = Config();
        config.Scenario.StartUtc = "2025-01-02T00:00:00Z";
        Check(original != ReplayProvenance.Compute(root, config), "date window change invalidates cached result");
        config = Config();
        config.Scenario.SpreadPips = 2;
        Check(original != ReplayProvenance.Compute(root, config), "execution cost change invalidates cached result");
        config = Config();
        config.BuildRunner = false;
        Check(ReplayProvenance.Compute(root, config) == "", "possible deferred rebuild disables unsafe cache reuse");
        Check(!ReplayProvenance.CanReuse(provenance, report, ""), "empty provenance cannot authorize reuse");
        File.AppendAllText(report, " ");
        Check(!ReplayProvenance.CanReuse(provenance, report, original), "altered report invalidates cached result");
        File.WriteAllText(provenance, "{");
        Check(!ReplayProvenance.CanReuse(provenance, report, original), "corrupt provenance fails closed");
        File.WriteAllText(provenance, "{}");
        Check(!ReplayProvenance.CanReuse(provenance, report, original), "incomplete provenance fails closed");
        File.Delete(report);
        Check(!ReplayProvenance.CanReuse(provenance, report, original), "missing report cannot be reused");
    }

    private static void VerifyRunnerArguments(string root)
    {
        OptimizerConfig config = Config();
        ScenarioConfig scenario = config.Scenario;
        MethodInfo method = typeof(OptimizerRunner).GetMethod("BuildRunnerArguments", BindingFlags.NonPublic | BindingFlags.Static)!;
        Candidate candidate = new Candidate();
        candidate.Parameters["TakeProfitAtr"] = new ParameterValue(1.75);
        candidate.Parameters["EnableStop"] = new ParameterValue(true);
        string basePath = Path.Combine(root, "scenario-base.cbotset");
        string exportPath = Path.Combine(root, "scenario.cbotset");
        File.WriteAllText(basePath, "{\"Chart\":{\"Symbol\":\"EURUSD\",\"Period\":\"m1\"},\"Parameters\":{\"TakeProfitAtr\":1,\"RiskPerEntryPercent\":0.25,\"EnableStop\":false}}");
        CbotSetArtifactWriter.Write(exportPath, basePath, scenario.Symbol, scenario.Timeframe, candidate.Parameters);
        using (JsonDocument exported = JsonDocument.Parse(File.ReadAllText(exportPath)))
        {
            JsonElement chart = exported.RootElement.GetProperty("Chart");
            JsonElement values = exported.RootElement.GetProperty("Parameters");
            Check(chart.GetProperty("Symbol").GetString() == scenario.Symbol, "scenario symbol replaces unrelated base symbol");
            Check(chart.GetProperty("Period").GetString() == scenario.Timeframe, "scenario timeframe replaces base timeframe");
            Check(values.GetProperty("TakeProfitAtr").GetDouble() == 1.75, "numeric candidate override exported exactly");
            Check(values.GetProperty("EnableStop").GetBoolean(), "boolean candidate override exported exactly");
            Check(values.GetProperty("RiskPerEntryPercent").GetDouble() == 0.25, "non-optimized base parameters preserved");
        }
        // This covers the actual process argument builder, not a parallel model of it.
        object[] parameters = new object[] { root, config, candidate, scenario, "report.json", exportPath };
        var arguments = (List<string>)method.Invoke(null, parameters)!;
        Check(Value(arguments, "--start-utc") == scenario.StartUtc, "inclusive start forwarded exactly");
        Check(Value(arguments, "--end-utc") == scenario.EndUtc, "exclusive end forwarded exactly");
        Check(Value(arguments, "--symbol-spec") == Path.Combine(root, scenario.SymbolSpec), "economic contract forwarded");
        Check(Value(arguments, "--warmup-bars") == Path.Combine(root, scenario.WarmupDataFile), "startup history forwarded");
        Check(Value(arguments, "--spread-pips") == "1", "explicit bar spread forwarded");
        Check(Value(arguments, "--params") == exportPath, "evaluated parameters use exported scenario symbol and timeframe");
        Check(arguments.Contains("TakeProfitAtr=1.75"), "numeric process override equals exported candidate value");
        scenario.DataMode = "ticks";
        scenario.DataFiles = new List<string> { "first ticks.csv", "second ticks.csv" };
        arguments = (List<string>)method.Invoke(null, parameters)!;
        Check(arguments.Count(x => x == "--ticks") == 2, "multi-file tick replay forwards every file");
        Check(!arguments.Contains("--bars"), "tick mode cannot become bar replay");
        Check(arguments.Contains(Path.Combine(root, "first ticks.csv")), "paths with spaces remain one process argument");
        scenario.WarmupDataFile = "";
        scenario.WarmupSeries["h1"] = "native h1.csv";
        scenario.WarmupSeries["m15"] = "native m15.csv";
        arguments = (List<string>)method.Invoke(null, parameters)!;
        Check(arguments.Count(x => x == "--warmup-series") == 2, "every independently captured timeframe is forwarded");
        Check(arguments.Contains("h1=" + Path.Combine(root, "native h1.csv")), "warmup timeframe and resolved path remain one argument");
        Check(!arguments.Contains("--warmup-bars"), "independent histories do not accidentally enable aggregated warmup");
    }

    private static void VerifyWorktreeRoot(string root)
    {
        string old = Directory.GetCurrentDirectory();
        string repo = Path.Combine(root, "worktree");
        string child = Path.Combine(repo, "nested", "project");
        Directory.CreateDirectory(child);
        File.WriteAllText(Path.Combine(repo, ".git"), "gitdir: /unused/test/worktree");
        try
        {
            Directory.SetCurrentDirectory(repo);
            string canonicalRepo = Directory.GetCurrentDirectory();
            Directory.SetCurrentDirectory(child);
            Check(Program.FindRepoRoot() == canonicalRepo, "managed worktree .git file resolves repository root");
        }
        finally { Directory.SetCurrentDirectory(old); }
    }

    private static void VerifyUnknownParameterRejection(string root)
    {
        string directory = Path.Combine(root, "unknown-parameter-cache");
        Directory.CreateDirectory(directory);
        string report = Path.Combine(directory, "report.json");
        var config = Config();
        config.ReplayFingerprint = "verified-test-report";
        var candidate = new Candidate();
        candidate.Parameters["TakeProftAtr"] = new ParameterValue(1.5);
        MethodInfo run = typeof(OptimizerRunner).GetMethod("RunCandidateScenarioAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
        foreach (string contents in new[] { "{\"parameter_unknown\":[\"TakeProftAtr\"]}", "{}", "{\"parameter_unknown\":null}" })
        {
            File.WriteAllText(report, contents);
            ReplayProvenance.Write(Path.Combine(directory, "replay-provenance.json"), report, config.ReplayFingerprint);
            var task = (Task<CandidateScenarioResult>)run.Invoke(null, new object[] {
                root, config, candidate, config.Scenario, "unknown", directory, report, "unused.cbotset", false });
            CandidateScenarioResult result = task.GetAwaiter().GetResult();
            Check(result.Status == "failed" && result.ExitCode != 0,
                "cached report must fail instead of ranking an ignored or unverified parameter");
            Check(result.Error.Contains(contents.Contains("TakeProftAtr") ? "TakeProftAtr" : "parameter_unknown"),
                "rejection names the unknown parameter or missing acceptance evidence");
        }
        File.WriteAllText(report, "{\"parameter_unknown\":[]}");
        ReplayProvenance.Write(Path.Combine(directory, "replay-provenance.json"), report, config.ReplayFingerprint);
        var acceptedTask = (Task<CandidateScenarioResult>)run.Invoke(null, new object[] {
            root, config, new Candidate(), config.Scenario, "known", directory, report, "unused.cbotset", false });
        Check(acceptedTask.GetAwaiter().GetResult().Status == "skipped_existing", "verified known-parameter cache remains reusable");
    }

    private static void VerifyScenarioOutputNames(string root)
    {
        foreach (var pair in new[] { ("same", "same"), ("same name", "same_name"), ("Same", "same"), ("..", "other") })
        {
            var config = Config();
            config.BuildRunner = false;
            var first = Scenario(); first.Name = pair.Item1;
            var second = Scenario(); second.Name = pair.Item2; second.Symbol = "EURUSD"; second.SpreadPips = 2;
            config.Scenarios = new List<ScenarioConfig> { first, second };
            Reject(() => OptimizerRunner.RunAsync(root, "unused", config, Array.Empty<Candidate>(), 1, false).GetAwaiter().GetResult(),
                "Scenario output names", "economically different scenarios cannot share a report/cache directory");
            string path = Path.Combine(root, "invalid-scenarios.json");
            File.WriteAllText(path, JsonSerializer.Serialize(config, Program.JsonOptions));
            Reject(() => OptimizerConfig.Load(path), "Scenario output names", "ambiguous output paths rejected during config loading");
        }
        var valid = new[] { Scenario(), Scenario() };
        valid[1].Symbol = "EURUSD";
        OptimizerRunner.ValidateScenarioOutputNames(valid);
        Check(true, "default indexed scenario names remain distinct");
    }

    private static string Value(List<string> arguments, string name)
    {
        int index = arguments.IndexOf(name);
        return index >= 0 && index + 1 < arguments.Count ? arguments[index + 1] : null;
    }

    private static void Reject(Action action, string expectedMessage, string label)
    {
        try { action(); }
        catch (ArgumentException ex) when (ex.Message.Contains(expectedMessage, StringComparison.Ordinal))
        {
            Check(true, label);
            return;
        }
        throw new InvalidOperationException("Expected rejection: " + label);
    }

    private static void Check(bool condition, string label)
    {
        if (!condition) throw new InvalidOperationException("Contract assertion failed: " + label);
        _assertions++;
    }
}
