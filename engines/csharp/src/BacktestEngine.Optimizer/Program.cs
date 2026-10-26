using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace BacktestEngine.Optimizer;

internal static class Program
{
    internal static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private static async Task<int> Main(string[] args)
    {
        try
        {
            CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
            CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;

            OptimizerOptions options = OptimizerOptions.Parse(args);
            OptimizerConfig config = OptimizerConfig.Load(options.ConfigPath);
            string repoRoot = FindRepoRoot();
            string outputDir = ResolvePath(repoRoot, config.Output.Dir);
            Directory.CreateDirectory(outputDir);

            List<Candidate> candidates = CandidateGenerator.Generate(config);
            if (candidates.Count == 0)
                throw new InvalidOperationException("Optimizer generated zero candidates.");

            int workerCount = WorkerPlanner.CalculateWorkerCount(config.Cpu);
            Console.WriteLine(
                "BACKTESTENGINE_OPTIMIZER_START config={0} candidates={1} workers={2} output={3}",
                Path.GetFullPath(options.ConfigPath),
                candidates.Count,
                workerCount,
                outputDir);

            Stopwatch stopwatch = Stopwatch.StartNew();
            OptimizerRunResult result = await OptimizerRunner.RunAsync(repoRoot, outputDir, config, candidates, workerCount, options.Force);
            stopwatch.Stop();

            SummaryWriter.Write(outputDir, config, result, stopwatch.Elapsed);
            Console.WriteLine(
                "BACKTESTENGINE_OPTIMIZER_DONE completed={0} failed={1} elapsed_ms={2:F0} results={3}",
                result.CompletedCount,
                result.FailedCount,
                stopwatch.Elapsed.TotalMilliseconds,
                Path.Combine(outputDir, "results.csv"));
            return result.FailedCount > 0 ? 2 : 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("BACKTESTENGINE_OPTIMIZER_ERROR " + ex.Message);
            return 1;
        }
    }

    internal static string FindRepoRoot()
    {
        string directory = Directory.GetCurrentDirectory();
        while (!string.IsNullOrWhiteSpace(directory))
        {
            if (Directory.Exists(Path.Combine(directory, ".git")) || File.Exists(Path.Combine(directory, ".git")))
                return directory;
            string parent = Directory.GetParent(directory)?.FullName;
            if (string.Equals(parent, directory, StringComparison.Ordinal))
                break;
            directory = parent;
        }

        return Directory.GetCurrentDirectory();
    }

    internal static string ResolvePath(string repoRoot, string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return "";
        return Path.IsPathRooted(path) ? path : Path.GetFullPath(Path.Combine(repoRoot, path));
    }
}

internal sealed class OptimizerOptions
{
    public string ConfigPath { get; set; } = "";
    public bool Force { get; set; }

    public static OptimizerOptions Parse(string[] args)
    {
        OptimizerOptions options = new OptimizerOptions();
        Queue<string> tokens = new Queue<string>(args ?? Array.Empty<string>());
        while (tokens.Count > 0)
        {
            string token = tokens.Dequeue();
            switch (token)
            {
                case "--config":
                case "-c":
                    options.ConfigPath = RequireValue(token, tokens);
                    break;
                case "--force":
                    options.Force = true;
                    break;
                case "--help":
                case "-h":
                    PrintHelp();
                    Environment.Exit(0);
                    break;
                default:
                    throw new ArgumentException("Unknown argument: " + token);
            }
        }

        if (string.IsNullOrWhiteSpace(options.ConfigPath))
            throw new ArgumentException("--config is required.");
        return options;
    }

    private static string RequireValue(string option, Queue<string> tokens)
    {
        if (tokens.Count == 0)
            throw new ArgumentException(option + " requires a value.");
        return tokens.Dequeue();
    }

    private static void PrintHelp()
    {
        Console.WriteLine("BacktestEngine.Optimizer");
        Console.WriteLine("  --config <optimizer.json>");
        Console.WriteLine("  --force                 Rerun completed candidate folders");
    }
}

internal sealed class OptimizerConfig
{
    public string Strategy { get; set; } = "ExampleStrategy";
    public string RunnerProject { get; set; } = "";
    public bool BuildRunner { get; set; } = true;
    public string BaseParams { get; set; } = "";
    public ScenarioConfig Scenario { get; set; } = new ScenarioConfig();
    public List<ScenarioConfig> Scenarios { get; set; } = new List<ScenarioConfig>();
    public CpuConfig Cpu { get; set; } = new CpuConfig();
    public SearchConfig Search { get; set; } = new SearchConfig();
    public Dictionary<string, ParameterSpec> Parameters { get; set; } = new Dictionary<string, ParameterSpec>(StringComparer.OrdinalIgnoreCase);
    public ScoringConfig Scoring { get; set; } = new ScoringConfig();
    public OutputConfig Output { get; set; } = new OutputConfig();
    [System.Text.Json.Serialization.JsonIgnore]
    public string ReplayFingerprint { get; set; } = "";

    public static OptimizerConfig Load(string path)
    {
        OptimizerConfig config = JsonSerializer.Deserialize<OptimizerConfig>(File.ReadAllText(path), Program.JsonOptions)
            ?? throw new InvalidOperationException("Could not deserialize optimizer config.");
        config.Parameters ??= new Dictionary<string, ParameterSpec>(StringComparer.OrdinalIgnoreCase);
        config.Scenario ??= new ScenarioConfig();
        config.Scenarios ??= new List<ScenarioConfig>();
        config.Scenario.DataFiles ??= new List<string>();
        config.Scenario.WarmupSeries ??= new Dictionary<string, string>();
        foreach (ScenarioConfig scenario in config.Scenarios)
        {
            scenario.DataFiles ??= new List<string>();
            scenario.WarmupSeries ??= new Dictionary<string, string>();
        }
        config.Cpu ??= new CpuConfig();
        config.Search ??= new SearchConfig();
        config.Scoring ??= new ScoringConfig();
        config.Scoring.Weights ??= new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        config.Output ??= new OutputConfig();
        if (string.IsNullOrWhiteSpace(config.Output.Dir))
            throw new ArgumentException("output.dir is required.");
        if (string.IsNullOrWhiteSpace(config.RunnerProject))
            throw new ArgumentException("runner_project is required.");
        foreach (ScenarioConfig scenario in config.ActiveScenarios())
            scenario.Validate();
        OptimizerRunner.ValidateScenarioOutputNames(config.ActiveScenarios());
        return config;
    }

    public IReadOnlyList<ScenarioConfig> ActiveScenarios()
    {
        if (Scenarios.Count > 0)
            return Scenarios;
        return new[] { Scenario };
    }
}

internal sealed class ScenarioConfig
{
    public string Name { get; set; } = "";
    public string Symbol { get; set; } = "";
    public string Timeframe { get; set; } = "";
    public string DataMode { get; set; } = "bars";
    public string DataFile { get; set; } = "";
    public List<string> DataFiles { get; set; } = new List<string>();
    public string WarmupDataFile { get; set; } = "";
    public string StartupQuote { get; set; } = "";
    public Dictionary<string, string> WarmupSeries { get; set; } = new Dictionary<string, string>();
    public string BarPeriod { get; set; } = "";
    public string BarPriceMode { get; set; } = "";
    public string SymbolSpec { get; set; } = "";
    public string StartUtc { get; set; } = "";
    public string EndUtc { get; set; } = "";
    public double? Balance { get; set; }
    public double? SpreadPips { get; set; }
    public double? CommissionUsdPerMillion { get; set; }
    public int? MaxTicks { get; set; }
    public int? MaxBars { get; set; }
    public bool SkipEquityCsv { get; set; }
    public double Weight { get; set; } = 1.0;

    public void Validate()
    {
        string mode = (DataMode ?? "").Trim().ToLowerInvariant();
        if (mode != "ticks" && mode != "tick" && mode != "bars")
            throw new ArgumentException("scenario.data_mode must be ticks or bars; an unknown mode must not silently become bar replay.");
        if (mode == "bars" && (!SpreadPips.HasValue || !double.IsFinite(SpreadPips.Value) || SpreadPips.Value < 0))
            throw new ArgumentException("Bar optimization requires explicit non-negative scenario.spread_pips. Use 0 only for an intentional zero-spread experiment.");
        if (mode == "bars" && string.IsNullOrWhiteSpace(BarPriceMode))
            throw new ArgumentException("Bar optimization requires explicit scenario.bar_price_mode (ohlc or open). Match the native reference data mode.");
        if (string.IsNullOrWhiteSpace(SymbolSpec))
            throw new ArgumentException("scenario.symbol_spec is required; optimization must use explicit symbol economics.");
        if (string.IsNullOrWhiteSpace(DataFile) && DataFiles.Count == 0)
            throw new ArgumentException("A scenario data file is required.");
        if (mode == "bars" && DataFiles.Count > 0)
            throw new ArgumentException("Bar optimization uses data_file, not data_files.");
        if (WarmupSeries.Count > 0 && !string.IsNullOrWhiteSpace(WarmupDataFile))
            throw new ArgumentException("scenario.warmup_series and warmup_data_file are mutually exclusive.");
        if (WarmupSeries.Any(pair => string.IsNullOrWhiteSpace(pair.Key) || string.IsNullOrWhiteSpace(pair.Value)))
            throw new ArgumentException("scenario.warmup_series requires timeframe-to-CSV path entries.");
        DateTimeOffset? start = string.IsNullOrWhiteSpace(StartUtc) ? null : DateTimeOffset.Parse(StartUtc, CultureInfo.InvariantCulture);
        DateTimeOffset? end = string.IsNullOrWhiteSpace(EndUtc) ? null : DateTimeOffset.Parse(EndUtc, CultureInfo.InvariantCulture);
        if (start.HasValue && end.HasValue && start >= end)
            throw new ArgumentException("scenario.start_utc must precede end_utc (exclusive).");
    }

    public string ResolvedName(int index)
    {
        if (!string.IsNullOrWhiteSpace(Name))
            return Name;
        string symbol = string.IsNullOrWhiteSpace(Symbol) ? "scenario" : Symbol;
        string timeframe = string.IsNullOrWhiteSpace(Timeframe) ? "" : "_" + Timeframe;
        return symbol + timeframe + "_" + (index + 1).ToString("D2", CultureInfo.InvariantCulture);
    }
}

internal sealed class CpuConfig
{
    public int MaxPercent { get; set; } = 70;
    public int LeaveCoresFree { get; set; } = 1;
    public int MaxWorkers { get; set; }
}

internal sealed class SearchConfig
{
    public string Method { get; set; } = "grid";
    public int Seed { get; set; } = 42;
    public int MaxRuns { get; set; } = 100;
}

internal sealed class ParameterSpec
{
    public string Type { get; set; } = "";
    public JsonElement[] Values { get; set; } = Array.Empty<JsonElement>();
    public double? Min { get; set; }
    public double? Max { get; set; }
    public double? Step { get; set; }

    public List<ParameterValue> ExpandAll()
    {
        string type = NormalizeType();
        if (Values is { Length: > 0 })
            return Values.Select(value => ParameterValue.FromJson(type, value)).ToList();

        if (type == "bool")
            return new List<ParameterValue> { new ParameterValue(false), new ParameterValue(true) };

        if (Min == null || Max == null)
            throw new ArgumentException("Parameter range requires min and max.");

        double step = Step.GetValueOrDefault(type == "int" ? 1.0 : Math.Max((Max.Value - Min.Value) / 10.0, 0.000001));
        if (step <= 0.0)
            throw new ArgumentException("Parameter step must be positive.");

        List<ParameterValue> values = new List<ParameterValue>();
        for (double value = Min.Value; value <= Max.Value + step * 0.000001; value += step)
        {
            values.Add(type == "int"
                ? new ParameterValue((int)Math.Round(value))
                : new ParameterValue(Math.Round(value, 10)));
        }

        return values;
    }

    public ParameterValue Sample(Random random)
    {
        string type = NormalizeType();
        if (Values is { Length: > 0 })
        {
            JsonElement value = Values[random.Next(Values.Length)];
            return ParameterValue.FromJson(type, value);
        }

        if (type == "bool")
            return new ParameterValue(random.Next(2) == 1);

        if (Min == null || Max == null)
            throw new ArgumentException("Parameter range requires min and max.");

        if (type == "int")
        {
            int min = (int)Math.Round(Min.Value);
            int max = (int)Math.Round(Max.Value);
            int step = Math.Max(1, (int)Math.Round(Step.GetValueOrDefault(1.0)));
            int slots = Math.Max(0, (max - min) / step);
            return new ParameterValue(min + random.Next(slots + 1) * step);
        }

        if (Step.GetValueOrDefault() > 0.0)
        {
            double step = Step.Value;
            int slots = Math.Max(0, (int)Math.Floor((Max.Value - Min.Value) / step));
            return new ParameterValue(Math.Round(Min.Value + random.Next(slots + 1) * step, 10));
        }

        return new ParameterValue(Min.Value + random.NextDouble() * (Max.Value - Min.Value));
    }

    private string NormalizeType()
    {
        string type = (Type ?? "").Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(type))
            return type;
        if (Values is { Length: > 0 })
            return "string";
        if (Min != null || Max != null)
            return Step != null && Math.Abs(Step.Value - Math.Round(Step.Value)) < 0.0000001 ? "int" : "double";
        return "string";
    }
}

internal readonly struct ParameterValue
{
    public object Value { get; }

    public ParameterValue(object value)
    {
        Value = value;
    }

    public static ParameterValue FromJson(string type, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.True:
                return new ParameterValue(true);
            case JsonValueKind.False:
                return new ParameterValue(false);
            case JsonValueKind.Number:
                if (type == "int" && element.TryGetInt32(out int intValue))
                    return new ParameterValue(intValue);
                return new ParameterValue(element.GetDouble());
            case JsonValueKind.String:
                string text = element.GetString() ?? "";
                if (type == "bool" && bool.TryParse(text, out bool boolValue))
                    return new ParameterValue(boolValue);
                if (type == "int" && int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsedInt))
                    return new ParameterValue(parsedInt);
                if (type == "double" && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out double parsedDouble))
                    return new ParameterValue(parsedDouble);
                return new ParameterValue(text);
            default:
                return new ParameterValue(element.ToString());
        }
    }

    public override string ToString()
    {
        return Value switch
        {
            bool boolValue => boolValue ? "true" : "false",
            double doubleValue => doubleValue.ToString("G17", CultureInfo.InvariantCulture),
            float floatValue => floatValue.ToString("G9", CultureInfo.InvariantCulture),
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => Convert.ToString(Value, CultureInfo.InvariantCulture) ?? ""
        };
    }
}

internal sealed class ScoringConfig
{
    public int TargetTrades { get; set; } = 30;
    public int MaxUsefulTrades { get; set; } = 300;
    public double AcceptableDrawdownPercent { get; set; } = 5.0;
    public double BadDrawdownPercent { get; set; } = 30.0;
    public Dictionary<string, double> Weights { get; set; } = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
}

internal sealed class OutputConfig
{
    public string Dir { get; set; } = "";
    public bool WriteCandidateCbotSet { get; set; } = true;
    public bool WriteHtmlReport { get; set; } = true;
    public bool WriteEventsJson { get; set; } = true;
    public bool WriteCombinedLog { get; set; } = true;
}

internal sealed class Candidate
{
    public string Id { get; set; } = "";
    public string Hash { get; set; } = "";
    public Dictionary<string, ParameterValue> Parameters { get; set; } = new Dictionary<string, ParameterValue>(StringComparer.OrdinalIgnoreCase);

    public string ParameterText()
    {
        return string.Join("; ", Parameters.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
            .Select(pair => pair.Key + "=" + pair.Value));
    }
}

internal static class CandidateGenerator
{
    public static List<Candidate> Generate(OptimizerConfig config)
    {
        string method = (config.Search.Method ?? "grid").Trim().Replace("-", "_").ToLowerInvariant();
        List<Candidate> candidates = method switch
        {
            "grid" => GenerateGrid(config),
            "random" => GenerateRandom(config),
            _ => throw new ArgumentException("Unsupported search.method '" + config.Search.Method + "'. Use grid or random.")
        };

        for (int i = 0; i < candidates.Count; i++)
        {
            candidates[i].Id = "candidate_" + (i + 1).ToString("D6", CultureInfo.InvariantCulture);
            candidates[i].Hash = HashCandidate(config, candidates[i]);
        }

        return candidates;
    }

    private static List<Candidate> GenerateGrid(OptimizerConfig config)
    {
        int maxRuns = Math.Max(1, config.Search.MaxRuns);
        List<KeyValuePair<string, List<ParameterValue>>> dimensions = config.Parameters
            .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
            .Select(pair => new KeyValuePair<string, List<ParameterValue>>(pair.Key, pair.Value.ExpandAll()))
            .ToList();

        List<Candidate> candidates = new List<Candidate>();
        Expand(0, new Dictionary<string, ParameterValue>(StringComparer.OrdinalIgnoreCase));
        return candidates;

        void Expand(int index, Dictionary<string, ParameterValue> current)
        {
            if (candidates.Count >= maxRuns)
                return;
            if (index >= dimensions.Count)
            {
                candidates.Add(new Candidate
                {
                    Parameters = new Dictionary<string, ParameterValue>(current, StringComparer.OrdinalIgnoreCase)
                });
                return;
            }

            KeyValuePair<string, List<ParameterValue>> dimension = dimensions[index];
            foreach (ParameterValue value in dimension.Value)
            {
                current[dimension.Key] = value;
                Expand(index + 1, current);
                if (candidates.Count >= maxRuns)
                    return;
            }
        }
    }

    private static List<Candidate> GenerateRandom(OptimizerConfig config)
    {
        int maxRuns = Math.Max(1, config.Search.MaxRuns);
        Random random = new Random(config.Search.Seed);
        List<KeyValuePair<string, ParameterSpec>> dimensions = config.Parameters
            .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
            .ToList();
        List<Candidate> candidates = new List<Candidate>();
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int attempts = 0;

        while (candidates.Count < maxRuns && attempts < maxRuns * 50)
        {
            attempts++;
            Dictionary<string, ParameterValue> parameters = new Dictionary<string, ParameterValue>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, ParameterSpec> dimension in dimensions)
                parameters[dimension.Key] = dimension.Value.Sample(random);

            string key = string.Join("|", parameters.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .Select(pair => pair.Key + "=" + pair.Value));
            if (!seen.Add(key) && dimensions.Count > 0)
                continue;

            candidates.Add(new Candidate { Parameters = parameters });
        }

        return candidates;
    }

    private static string HashCandidate(OptimizerConfig config, Candidate candidate)
    {
        string text = config.Strategy + "\n" + candidate.ParameterText() + "\n" + JsonSerializer.Serialize(config.ActiveScenarios(), Program.JsonOptions);
        byte[] bytes = SHA256.HashData(Encoding.UTF8.GetBytes(text));
        return Convert.ToHexString(bytes).Substring(0, 16).ToLowerInvariant();
    }
}

internal static class WorkerPlanner
{
    public static int CalculateWorkerCount(CpuConfig cpu)
    {
        int logicalCores = Math.Max(1, Environment.ProcessorCount);
        int maxPercent = Math.Clamp(cpu.MaxPercent <= 0 ? 70 : cpu.MaxPercent, 1, 100);
        int budgetWorkers = Math.Max(1, (int)Math.Floor(logicalCores * (maxPercent / 100.0)));
        int coresAfterReserve = Math.Max(1, logicalCores - Math.Max(0, cpu.LeaveCoresFree));
        int workers = Math.Min(budgetWorkers, coresAfterReserve);
        if (cpu.MaxWorkers > 0)
            workers = Math.Min(workers, cpu.MaxWorkers);
        return Math.Max(1, workers);
    }
}

internal static class OptimizerRunner
{
    public static async Task<OptimizerRunResult> RunAsync(
        string repoRoot,
        string outputDir,
        OptimizerConfig config,
        IReadOnlyList<Candidate> candidates,
        int workerCount,
        bool force)
    {
        ValidateScenarioOutputNames(config.ActiveScenarios());
        if (config.BuildRunner)
            await BuildRunnerProjectAsync(repoRoot, outputDir, config);
        config.ReplayFingerprint = ReplayProvenance.Compute(repoRoot, config);

        ConcurrentBag<CandidateResult> results = new ConcurrentBag<CandidateResult>();
        using SemaphoreSlim semaphore = new SemaphoreSlim(workerCount);
        List<Task> tasks = new List<Task>();

        foreach (Candidate candidate in candidates)
        {
            await semaphore.WaitAsync();
            tasks.Add(Task.Run(async () =>
            {
                try
                {
                    CandidateResult result = await RunCandidateAsync(repoRoot, outputDir, config, candidate, force);
                    results.Add(result);
                }
                finally
                {
                    semaphore.Release();
                }
            }));
        }

        await Task.WhenAll(tasks);
        List<CandidateResult> ordered = results
            .OrderBy(result => result.Id, StringComparer.Ordinal)
            .ToList();
        return new OptimizerRunResult { Results = ordered };
    }

    private static async Task<CandidateResult> RunCandidateAsync(
        string repoRoot,
        string outputDir,
        OptimizerConfig config,
        Candidate candidate,
        bool force)
    {
        string candidateDir = Path.Combine(outputDir, candidate.Id + "_" + candidate.Hash);
        Directory.CreateDirectory(candidateDir);

        CandidateResult result = new CandidateResult
        {
            Id = candidate.Id,
            Hash = candidate.Hash,
            Status = "running",
            RunDir = candidateDir,
            Parameters = candidate.Parameters.ToDictionary(pair => pair.Key, pair => pair.Value.ToString(), StringComparer.OrdinalIgnoreCase)
        };

        IReadOnlyList<ScenarioConfig> scenarios = config.ActiveScenarios();
        if (config.Output.WriteCandidateCbotSet)
        {
            ScenarioConfig firstScenario = scenarios[0];
            result.ParameterFilePath = Path.Combine(candidateDir, "candidate.cbotset");
            CbotSetArtifactWriter.Write(
                result.ParameterFilePath,
                Program.ResolvePath(repoRoot, config.BaseParams),
                firstScenario.Symbol,
                firstScenario.Timeframe,
                candidate.Parameters);
        }
        bool multiScenario = scenarios.Count > 1;
        Stopwatch totalStopwatch = Stopwatch.StartNew();

        for (int i = 0; i < scenarios.Count; i++)
        {
            ScenarioConfig scenario = scenarios[i];
            string scenarioName = SafePathSegment(scenario.ResolvedName(i));
            string scenarioDir = multiScenario ? Path.Combine(candidateDir, scenarioName) : candidateDir;
            string reportPath = Path.Combine(scenarioDir, "report.json");
            Directory.CreateDirectory(scenarioDir);

            // This is the replay input as well as the reproducible export. Using
            // the base preset here could retain another scenario's chart symbol.
            string scenarioParameterPath = Path.Combine(scenarioDir, "parameters.cbotset");
            CbotSetArtifactWriter.Write(
                scenarioParameterPath,
                Program.ResolvePath(repoRoot, config.BaseParams),
                scenario.Symbol,
                scenario.Timeframe,
                candidate.Parameters);

            CandidateScenarioResult scenarioResult = await RunCandidateScenarioAsync(
                repoRoot,
                config,
                candidate,
                scenario,
                scenarioName,
                scenarioDir,
                reportPath,
                scenarioParameterPath,
                force);
            scenarioResult.ParameterFilePath = scenarioParameterPath;
            result.Scenarios.Add(scenarioResult);

            if (scenarioResult.Status == "failed")
            {
                result.Status = "failed";
                result.ExitCode = scenarioResult.ExitCode;
                result.Error = scenarioResult.Error;
                break;
            }
        }

        totalStopwatch.Stop();
        result.ElapsedMs = totalStopwatch.Elapsed.TotalMilliseconds;
        File.WriteAllText(Path.Combine(candidateDir, "parameters.json"), JsonSerializer.Serialize(result.Parameters, Program.JsonOptions));

        if (result.Status != "failed")
        {
            result.Status = "completed";
            result.ReportPath = scenarios.Count == 1 ? result.Scenarios[0].ReportPath : "";
            ApplyScenarioReportsAndScore(config, result);
        }

        foreach (CandidateScenarioResult scenarioResult in result.Scenarios)
            OptimizerArtifactWriter.WriteScenarioArtifacts(config.Output, result, scenarioResult);

        WriteCandidateState(candidateDir, result);
        return result;
    }

    private static async Task<CandidateScenarioResult> RunCandidateScenarioAsync(
        string repoRoot,
        OptimizerConfig config,
        Candidate candidate,
        ScenarioConfig scenario,
        string scenarioName,
        string scenarioDir,
        string reportPath,
        string scenarioParameterPath,
        bool force)
    {
        string stdoutPath = Path.Combine(scenarioDir, "stdout.log");
        string stderrPath = Path.Combine(scenarioDir, "stderr.log");
        string combinedLogPath = Path.Combine(scenarioDir, "log.txt");
        CandidateScenarioResult result = new CandidateScenarioResult
        {
            Name = scenarioName,
            Symbol = scenario.Symbol,
            Timeframe = scenario.Timeframe,
            Weight = scenario.Weight <= 0.0 ? 1.0 : scenario.Weight,
            Status = "running",
            RunDir = scenarioDir,
            ReportPath = reportPath,
            StdoutPath = stdoutPath,
            StderrPath = stderrPath,
            LogPath = combinedLogPath
        };

        string provenancePath = Path.Combine(scenarioDir, "replay-provenance.json");
        if (!force && ReplayProvenance.CanReuse(provenancePath, reportPath, config.ReplayFingerprint))
        {
            if (RejectUnknownReportParameters(reportPath, result))
                return result;
            result.Status = "skipped_existing";
            result.Metrics = BacktestMetrics.Load(reportPath);
            return result;
        }

        List<string> arguments = BuildRunnerArguments(repoRoot, config, candidate, scenario, reportPath, scenarioParameterPath);
        string dotnetPath = DotnetLocator.Resolve();
        File.WriteAllText(Path.Combine(scenarioDir, "command.txt"), EscapeArgument(dotnetPath) + " " + string.Join(" ", arguments.Select(EscapeArgument)));

        Stopwatch stopwatch = Stopwatch.StartNew();
        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = dotnetPath,
            WorkingDirectory = repoRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        foreach (string argument in arguments)
            startInfo.ArgumentList.Add(argument);

        using Process process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start dotnet runner.");
        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        stopwatch.Stop();

        string stdout = await stdoutTask;
        string stderr = await stderrTask;
        File.WriteAllText(stdoutPath, stdout);
        File.WriteAllText(stderrPath, stderr);
        if (config.Output.WriteCombinedLog)
        {
            string combined = stdout;
            if (!string.IsNullOrWhiteSpace(stderr))
                combined += (combined.EndsWith('\n') ? "" : Environment.NewLine) + "--- STDERR ---" + Environment.NewLine + stderr;
            File.WriteAllText(combinedLogPath, combined);
        }

        result.ExitCode = process.ExitCode;
        result.ElapsedMs = stopwatch.Elapsed.TotalMilliseconds;
        if (process.ExitCode != 0)
        {
            result.Status = "failed";
            result.Error = FirstNonEmptyLine(stderr) ?? FirstNonEmptyLine(stdout) ?? "Runner exited with code " + process.ExitCode;
            return result;
        }

        if (!File.Exists(reportPath))
        {
            result.Status = "failed";
            result.Error = "Runner completed but did not write report.json.";
            return result;
        }

        if (RejectUnknownReportParameters(reportPath, result))
            return result;
        result.Status = "completed";
        result.Metrics = BacktestMetrics.Load(reportPath);
        ReplayProvenance.Write(provenancePath, reportPath, config.ReplayFingerprint);
        return result;
    }

    private static bool RejectUnknownReportParameters(string reportPath, CandidateScenarioResult result)
    {
        using JsonDocument report = JsonDocument.Parse(File.ReadAllText(reportPath));
        if (!report.RootElement.TryGetProperty("parameter_unknown", out JsonElement unknown)
            || unknown.ValueKind != JsonValueKind.Array)
        {
            result.Error = "Runner report is missing the parameter_unknown acceptance record.";
        }
        else if (unknown.GetArrayLength() > 0)
        {
            string names = string.Join(", ", unknown.EnumerateArray().Select(value => value.ToString()).Distinct(StringComparer.OrdinalIgnoreCase));
            result.Error = "Optimizer candidate contains parameters the strategy did not recognize: " + names;
        }
        else return false;
        result.Status = "failed";
        result.ExitCode = 1;
        return true;
    }

    private static List<string> BuildRunnerArguments(string repoRoot, OptimizerConfig config, Candidate candidate, ScenarioConfig scenario, string reportPath, string scenarioParameterPath)
    {
        string dataMode = (scenario.DataMode ?? "bars").Trim().ToLowerInvariant();
        List<string> args = new List<string>
        {
            "run",
            "--project",
            Program.ResolvePath(repoRoot, config.RunnerProject)
        };
        if (config.BuildRunner)
            args.Add("--no-build");
        args.AddRange(new[]
        {
            "--",
            "--strategy",
            config.Strategy,
            "--report-json",
            reportPath
        });

        AddPath(args, "--params", repoRoot, scenarioParameterPath);
        AddValue(args, "--symbol", scenario.Symbol);
        AddValue(args, "--period", scenario.Timeframe);
        AddPath(args, "--symbol-spec", repoRoot, scenario.SymbolSpec);
        AddPath(args, "--startup-quote", repoRoot, scenario.StartupQuote);
        AddNullable(args, "--balance", scenario.Balance);
        AddNullable(args, "--spread-pips", scenario.SpreadPips);
        AddNullable(args, "--commission-usd-per-million", scenario.CommissionUsdPerMillion);
        AddValue(args, "--start-utc", scenario.StartUtc);
        AddValue(args, "--end-utc", scenario.EndUtc);
        foreach (KeyValuePair<string, string> series in scenario.WarmupSeries.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
            AddValue(args, "--warmup-series", series.Key + "=" + Program.ResolvePath(repoRoot, series.Value));
        if (scenario.SkipEquityCsv)
            args.Add("--skip-equity-csv");

        if (dataMode == "ticks" || dataMode == "tick")
        {
            IReadOnlyList<string> dataFiles = scenario.DataFiles.Count > 0
                ? scenario.DataFiles
                : new[] { scenario.DataFile };
            foreach (string dataFile in dataFiles)
                AddPath(args, "--ticks", repoRoot, dataFile);
            AddPath(args, "--warmup-bars", repoRoot, scenario.WarmupDataFile);
            AddValue(args, "--bar-period", scenario.BarPeriod);
            AddNullable(args, "--max-ticks", scenario.MaxTicks);
        }
        else
        {
            AddPath(args, "--bars", repoRoot, scenario.DataFile);
            AddPath(args, "--warmup-bars", repoRoot, scenario.WarmupDataFile);
            AddValue(args, "--bar-period", scenario.BarPeriod);
            AddValue(args, "--bar-price-mode", scenario.BarPriceMode);
            AddNullable(args, "--max-bars", scenario.MaxBars);
        }

        foreach (KeyValuePair<string, ParameterValue> parameter in candidate.Parameters.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
        {
            args.Add("--param");
            args.Add(parameter.Key + "=" + parameter.Value);
        }

        return args;
    }

    private static async Task BuildRunnerProjectAsync(string repoRoot, string outputDir, OptimizerConfig config)
    {
        string dotnetPath = DotnetLocator.Resolve();
        string projectPath = Program.ResolvePath(repoRoot, config.RunnerProject);
        ProcessStartInfo startInfo = new ProcessStartInfo
        {
            FileName = dotnetPath,
            WorkingDirectory = repoRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        startInfo.ArgumentList.Add("build");
        startInfo.ArgumentList.Add(projectPath);

        using Process process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start runner build.");
        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();

        string stdout = await stdoutTask;
        string stderr = await stderrTask;
        File.WriteAllText(Path.Combine(outputDir, "runner_build.stdout.log"), stdout);
        File.WriteAllText(Path.Combine(outputDir, "runner_build.stderr.log"), stderr);
        if (process.ExitCode != 0)
            throw new InvalidOperationException("Runner build failed. See " + Path.Combine(outputDir, "runner_build.stderr.log"));
    }

    private static void ApplyScenarioReportsAndScore(OptimizerConfig config, CandidateResult result)
    {
        CandidateScenarioResult[] completed = result.Scenarios
            .Where(scenario => scenario.Status == "completed" || scenario.Status == "skipped_existing")
            .ToArray();
        result.Metrics = BacktestMetrics.Aggregate(completed);

        result.FitnessScore = FitnessScorer.Score(config.Scoring, result.Metrics);
    }

    private static void WriteCandidateState(string candidateDir, CandidateResult result)
    {
        File.WriteAllText(Path.Combine(candidateDir, "candidate_result.json"), JsonSerializer.Serialize(result, Program.JsonOptions));
    }

    internal static void ValidateScenarioOutputNames(IReadOnlyList<ScenarioConfig> scenarios)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int index = 0; index < scenarios.Count; index++)
        {
            string name = SafePathSegment(scenarios[index].ResolvedName(index));
            if (name == "." || name == ".." || !names.Add(name))
                throw new ArgumentException("Scenario output names must be unique after filename sanitization (case-insensitive), and cannot be '.' or '..': " + name);
        }
    }

    private static string SafePathSegment(string value)
    {
        string text = string.IsNullOrWhiteSpace(value) ? "scenario" : value.Trim();
        char[] invalid = Path.GetInvalidFileNameChars();
        StringBuilder builder = new StringBuilder(text.Length);
        foreach (char ch in text)
            builder.Append(invalid.Contains(ch) || char.IsWhiteSpace(ch) ? '_' : ch);
        return builder.ToString();
    }

    private static void AddPath(List<string> args, string option, string repoRoot, string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return;
        args.Add(option);
        args.Add(Program.ResolvePath(repoRoot, path));
    }

    private static void AddValue(List<string> args, string option, string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return;
        args.Add(option);
        args.Add(value);
    }

    private static void AddNullable(List<string> args, string option, double? value)
    {
        if (value == null)
            return;
        args.Add(option);
        args.Add(value.Value.ToString("G17", CultureInfo.InvariantCulture));
    }

    private static void AddNullable(List<string> args, string option, int? value)
    {
        if (value == null)
            return;
        args.Add(option);
        args.Add(value.Value.ToString(CultureInfo.InvariantCulture));
    }

    private static string EscapeArgument(string value)
    {
        if (string.IsNullOrEmpty(value))
            return "\"\"";
        if (!value.Any(char.IsWhiteSpace) && !value.Contains('"'))
            return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string FirstNonEmptyLine(string text)
    {
        return text?.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim())
            .FirstOrDefault(line => line.Length > 0);
    }
}

internal static class DotnetLocator
{
    public static string Resolve()
    {
        string processPath = Environment.ProcessPath ?? "";
        if (Path.GetFileName(processPath).Equals("dotnet", StringComparison.OrdinalIgnoreCase) && File.Exists(processPath))
            return processPath;

        string pathDotnet = FindOnPath("dotnet");
        if (!string.IsNullOrWhiteSpace(pathDotnet))
            return pathDotnet;

        string[] candidates =
        {
            "/usr/local/share/dotnet/dotnet",
            "/opt/homebrew/bin/dotnet",
            "/usr/local/bin/dotnet"
        };

        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate))
                return candidate;
        }

        return "dotnet";
    }

    private static string FindOnPath(string executable)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string directory in path.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(directory))
                continue;
            string candidate = Path.Combine(directory, executable);
            if (File.Exists(candidate))
                return candidate;
        }

        return "";
    }
}

internal sealed class BacktestMetrics
{
    public double StartingCapital { get; set; }
    public double EndingBalance { get; set; }
    public double EndingEquity { get; set; }
    public double NetProfit { get; set; }
    public double MarkedToMarketNetProfit { get; set; }
    public double MarkedToMarketReturnPercent { get; set; }
    public double GrossProfit { get; set; }
    public double GrossLoss { get; set; }
    public double? ProfitFactor { get; set; }
    public int TotalTrades { get; set; }
    public int WinningTrades { get; set; }
    public int LosingTrades { get; set; }
    public int LongTrades { get; set; }
    public int ShortTrades { get; set; }
    public double WinRate { get; set; }
    public double AverageTrade { get; set; }
    public double AverageEconomicResult { get; set; }
    public double MaxEquityDrawdown { get; set; }
    public double MaxEquityDrawdownPercent { get; set; }
    public double RecoveryFactor { get; set; }
    public double TopTradeProfitShare { get; set; }
    public int OpenPositionCount { get; set; }
    public int OpenLosingPositionCount { get; set; }
    public double OpenNetProfit { get; set; }
    public double OpenLossPercentOfStartingCapital { get; set; }
    public double WorstOpenPositionLossPercentOfStartingCapital { get; set; }
    public double MaxOpenPositionAgeHours { get; set; }
    public double MaxLosingOpenPositionAgeHours { get; set; }
    public double MaxDayStartEquityLossPercent { get; set; }
    public double MaxIntradayEquityDrawdownPercent { get; set; }
    public double ClosedSwaps { get; set; }
    public double OpenSwaps { get; set; }
    public double ReplayElapsedMs { get; set; }
    public double EventsPerSecond { get; set; }

    public static BacktestMetrics Load(string path)
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        JsonElement root = document.RootElement;
        BacktestMetrics metrics = new BacktestMetrics
        {
            StartingCapital = GetDouble(root, "account.starting_capital") ?? 0.0,
            EndingBalance = GetDouble(root, "account.balance") ?? 0.0,
            EndingEquity = GetDouble(root, "account.equity") ?? 0.0,
            NetProfit = GetDouble(root, "trade_statistics.net_profit") ?? 0.0,
            MarkedToMarketNetProfit = GetDouble(root, "account.marked_to_market_net_profit")
                ?? ((GetDouble(root, "account.equity") ?? 0.0) - (GetDouble(root, "account.starting_capital") ?? 0.0)),
            MarkedToMarketReturnPercent = GetDouble(root, "account.marked_to_market_return_percent")
                ?? ((GetDouble(root, "account.starting_capital") ?? 0.0) > 0.0
                    ? ((GetDouble(root, "account.equity") ?? 0.0) - (GetDouble(root, "account.starting_capital") ?? 0.0))
                        / (GetDouble(root, "account.starting_capital") ?? 1.0) * 100.0
                    : 0.0),
            GrossProfit = GetDouble(root, "trade_statistics.gross_profit") ?? 0.0,
            GrossLoss = GetDouble(root, "trade_statistics.gross_loss") ?? 0.0,
            ProfitFactor = GetDouble(root, "trade_statistics.profit_factor"),
            TotalTrades = GetInt(root, "trade_statistics.total_trades") ?? 0,
            WinningTrades = GetInt(root, "trade_statistics.winning_trades") ?? 0,
            LosingTrades = GetInt(root, "trade_statistics.losing_trades") ?? 0,
            LongTrades = GetInt(root, "trade_statistics.long_trades") ?? 0,
            ShortTrades = GetInt(root, "trade_statistics.short_trades") ?? 0,
            AverageTrade = GetDouble(root, "trade_statistics.average_net_profit") ?? 0.0,
            MaxEquityDrawdown = GetDouble(root, "native_report_drawdown.max_equity_drawdown") ?? GetDouble(root, "drawdown.max_equity_drawdown") ?? 0.0,
            MaxEquityDrawdownPercent = GetDouble(root, "native_report_drawdown.max_equity_drawdown_percent") ?? GetDouble(root, "drawdown.max_equity_drawdown_percent") ?? 0.0,
            OpenPositionCount = GetInt(root, "open_risk.position_count") ?? 0,
            OpenLosingPositionCount = GetInt(root, "open_risk.losing_position_count") ?? 0,
            OpenNetProfit = GetDouble(root, "open_risk.open_net_profit") ?? 0.0,
            OpenLossPercentOfStartingCapital = GetDouble(root, "open_risk.open_loss_percent_of_starting_capital") ?? 0.0,
            WorstOpenPositionLossPercentOfStartingCapital = GetDouble(root, "open_risk.worst_position_loss_percent_of_starting_capital") ?? 0.0,
            MaxOpenPositionAgeHours = GetDouble(root, "open_risk.max_position_age_hours") ?? 0.0,
            MaxLosingOpenPositionAgeHours = GetDouble(root, "open_risk.max_losing_position_age_hours") ?? 0.0,
            MaxDayStartEquityLossPercent = GetDouble(root, "risk_path.max_day_start_equity_loss_percent") ?? 0.0,
            MaxIntradayEquityDrawdownPercent = GetDouble(root, "risk_path.max_intraday_equity_drawdown_percent") ?? 0.0,
            ClosedSwaps = GetDouble(root, "trade_statistics.swaps") ?? 0.0,
            OpenSwaps = GetDouble(root, "open_risk.open_swaps") ?? 0.0,
            ReplayElapsedMs = GetDouble(root, "replay.elapsed_ms") ?? 0.0,
            EventsPerSecond = GetDouble(root, "replay.ticks_or_synthetic_ticks_per_second") ?? 0.0
        };
        if (metrics.ProfitFactor == null && metrics.GrossProfit > 0.0 && Math.Abs(metrics.GrossLoss) < 0.0000001)
            metrics.ProfitFactor = 999.0;
        metrics.WinRate = metrics.TotalTrades > 0 ? metrics.WinningTrades * 100.0 / metrics.TotalTrades : 0.0;
        int economicOutcomes = metrics.TotalTrades + metrics.OpenPositionCount;
        metrics.AverageEconomicResult = economicOutcomes > 0 ? metrics.MarkedToMarketNetProfit / economicOutcomes : 0.0;
        metrics.RecoveryFactor = metrics.MaxEquityDrawdown > 0.0 ? metrics.MarkedToMarketNetProfit / metrics.MaxEquityDrawdown : Math.Max(0.0, metrics.MarkedToMarketNetProfit);
        metrics.TopTradeProfitShare = CalculateTopTradeProfitShare(root, metrics.GrossProfit);
        return metrics;
    }

    public static BacktestMetrics Aggregate(IReadOnlyList<CandidateScenarioResult> scenarios)
    {
        BacktestMetrics metrics = new BacktestMetrics();
        if (scenarios.Count == 0)
            return metrics;

        foreach (CandidateScenarioResult scenario in scenarios)
        {
            BacktestMetrics item = scenario.Metrics ?? new BacktestMetrics();
            double weight = scenario.Weight <= 0.0 ? 1.0 : scenario.Weight;
            metrics.StartingCapital += item.StartingCapital * weight;
            metrics.EndingBalance += item.EndingBalance * weight;
            metrics.EndingEquity += item.EndingEquity * weight;
            metrics.NetProfit += item.NetProfit * weight;
            metrics.MarkedToMarketNetProfit += item.MarkedToMarketNetProfit * weight;
            metrics.GrossProfit += item.GrossProfit * weight;
            metrics.GrossLoss += item.GrossLoss * weight;
            metrics.TotalTrades += item.TotalTrades;
            metrics.WinningTrades += item.WinningTrades;
            metrics.LosingTrades += item.LosingTrades;
            metrics.LongTrades += item.LongTrades;
            metrics.ShortTrades += item.ShortTrades;
            metrics.OpenPositionCount += item.OpenPositionCount;
            metrics.OpenLosingPositionCount += item.OpenLosingPositionCount;
            metrics.OpenNetProfit += item.OpenNetProfit * weight;
            metrics.OpenLossPercentOfStartingCapital = Math.Max(metrics.OpenLossPercentOfStartingCapital, item.OpenLossPercentOfStartingCapital);
            metrics.WorstOpenPositionLossPercentOfStartingCapital = Math.Max(metrics.WorstOpenPositionLossPercentOfStartingCapital, item.WorstOpenPositionLossPercentOfStartingCapital);
            metrics.MaxOpenPositionAgeHours = Math.Max(metrics.MaxOpenPositionAgeHours, item.MaxOpenPositionAgeHours);
            metrics.MaxLosingOpenPositionAgeHours = Math.Max(metrics.MaxLosingOpenPositionAgeHours, item.MaxLosingOpenPositionAgeHours);
            metrics.MaxDayStartEquityLossPercent = Math.Max(metrics.MaxDayStartEquityLossPercent, item.MaxDayStartEquityLossPercent);
            metrics.MaxIntradayEquityDrawdownPercent = Math.Max(metrics.MaxIntradayEquityDrawdownPercent, item.MaxIntradayEquityDrawdownPercent);
            metrics.ClosedSwaps += item.ClosedSwaps * weight;
            metrics.OpenSwaps += item.OpenSwaps * weight;
            metrics.MaxEquityDrawdown = Math.Max(metrics.MaxEquityDrawdown, item.MaxEquityDrawdown);
            metrics.MaxEquityDrawdownPercent = Math.Max(metrics.MaxEquityDrawdownPercent, item.MaxEquityDrawdownPercent);
            metrics.TopTradeProfitShare = Math.Max(metrics.TopTradeProfitShare, item.TopTradeProfitShare);
            metrics.ReplayElapsedMs += item.ReplayElapsedMs;
            metrics.EventsPerSecond += item.EventsPerSecond;
        }

        if (metrics.GrossLoss < -0.0000001)
            metrics.ProfitFactor = metrics.GrossProfit / Math.Abs(metrics.GrossLoss);
        else if (metrics.GrossProfit > 0.0)
            metrics.ProfitFactor = 999.0;
        metrics.AverageTrade = metrics.TotalTrades > 0 ? metrics.NetProfit / metrics.TotalTrades : 0.0;
        int economicOutcomes = metrics.TotalTrades + metrics.OpenPositionCount;
        metrics.AverageEconomicResult = economicOutcomes > 0 ? metrics.MarkedToMarketNetProfit / economicOutcomes : 0.0;
        metrics.MarkedToMarketReturnPercent = metrics.StartingCapital > 0.0 ? metrics.MarkedToMarketNetProfit / metrics.StartingCapital * 100.0 : 0.0;
        metrics.WinRate = metrics.TotalTrades > 0 ? metrics.WinningTrades * 100.0 / metrics.TotalTrades : 0.0;
        metrics.RecoveryFactor = metrics.MaxEquityDrawdown > 0.0 ? metrics.MarkedToMarketNetProfit / metrics.MaxEquityDrawdown : Math.Max(0.0, metrics.MarkedToMarketNetProfit);
        metrics.EventsPerSecond = scenarios.Count > 0 ? metrics.EventsPerSecond / scenarios.Count : 0.0;
        return metrics;
    }

    private static double CalculateTopTradeProfitShare(JsonElement root, double grossProfit)
    {
        if (grossProfit <= 0.0 || !TryGet(root, "trades", out JsonElement trades) || trades.ValueKind != JsonValueKind.Array)
            return 0.0;

        double top = 0.0;
        foreach (JsonElement trade in trades.EnumerateArray())
        {
            if (trade.TryGetProperty("net_profit", out JsonElement netElement) && netElement.ValueKind == JsonValueKind.Number)
                top = Math.Max(top, netElement.GetDouble());
        }

        return top > 0.0 ? top / grossProfit : 0.0;
    }

    private static double? GetDouble(JsonElement root, string path)
    {
        if (!TryGet(root, path, out JsonElement element) || element.ValueKind == JsonValueKind.Null)
            return null;
        if (element.ValueKind == JsonValueKind.Number)
            return element.GetDouble();
        return null;
    }

    private static int? GetInt(JsonElement root, string path)
    {
        if (!TryGet(root, path, out JsonElement element) || element.ValueKind != JsonValueKind.Number)
            return null;
        return element.GetInt32();
    }

    private static bool TryGet(JsonElement root, string path, out JsonElement element)
    {
        element = root;
        foreach (string segment in path.Split('.'))
        {
            if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(segment, out element))
                return false;
        }

        return true;
    }
}

internal static class FitnessScorer
{
    public static double Score(ScoringConfig scoring, BacktestMetrics metrics)
    {
        Dictionary<string, double> weights = scoring.Weights;
        if (weights.Count == 0)
        {
            weights = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
            {
                ["marked_to_market_net_profit"] = 0.25,
                ["profit_factor"] = 0.20,
                ["drawdown_penalty"] = 0.25,
                ["trade_count_quality"] = 0.15,
                ["average_trade"] = 0.10,
                ["equity_smoothness"] = 0.05
            };
        }

        double score = 0.0;
        double economicProfitWeight = weights.ContainsKey("marked_to_market_net_profit")
            ? Weight(weights, "marked_to_market_net_profit")
            : Weight(weights, "net_profit");
        score += economicProfitWeight * NormalizePositive(metrics.MarkedToMarketNetProfit, Math.Max(1.0, Math.Abs(metrics.MaxEquityDrawdown) * 5.0));
        score += Weight(weights, "profit_factor") * NormalizeProfitFactor(metrics.ProfitFactor);
        score += Weight(weights, "average_trade") * NormalizePositive(metrics.AverageEconomicResult, 100.0);
        score += Weight(weights, "trade_count_quality") * TradeCountQuality(metrics.TotalTrades, scoring.TargetTrades, scoring.MaxUsefulTrades);
        score += Weight(weights, "equity_smoothness") * EquitySmoothness(metrics);
        score -= Weight(weights, "drawdown_penalty") * NormalizePenalty(metrics.MaxEquityDrawdownPercent, scoring.AcceptableDrawdownPercent, scoring.BadDrawdownPercent);
        return score;
    }

    private static double Weight(Dictionary<string, double> weights, string name)
    {
        return weights.TryGetValue(name, out double value) ? value : 0.0;
    }

    private static double NormalizePositive(double value, double excellent)
    {
        if (value <= 0.0)
            return 0.0;
        if (excellent <= 0.0)
            return 1.0;
        return Math.Clamp(value / excellent, 0.0, 1.0);
    }

    private static double NormalizeProfitFactor(double? profitFactor)
    {
        if (profitFactor == null || profitFactor.Value <= 1.0)
            return 0.0;
        if (double.IsInfinity(profitFactor.Value))
            return 1.0;
        return Math.Clamp((profitFactor.Value - 1.0) / 2.0, 0.0, 1.0);
    }

    private static double NormalizePenalty(double value, double acceptable, double bad)
    {
        if (value <= acceptable)
            return 0.0;
        if (bad <= acceptable)
            return 1.0;
        return Math.Clamp((value - acceptable) / (bad - acceptable), 0.0, 1.0);
    }

    private static double TradeCountQuality(int trades, int targetMin, int targetMax)
    {
        targetMin = Math.Max(1, targetMin);
        targetMax = Math.Max(targetMin, targetMax);
        if (trades < targetMin)
            return Math.Clamp(trades / (double)targetMin, 0.0, 1.0);
        if (trades <= targetMax)
            return 1.0;
        return Math.Clamp(1.0 - (trades - targetMax) / (double)targetMax, 0.0, 1.0);
    }

    private static double EquitySmoothness(BacktestMetrics metrics)
    {
        double recovery = NormalizePositive(metrics.RecoveryFactor, 3.0);
        double concentration = Math.Clamp(metrics.TopTradeProfitShare, 0.0, 1.0);
        return Math.Clamp(0.7 * recovery + 0.3 * (1.0 - concentration), 0.0, 1.0);
    }
}

internal sealed class CandidateScenarioResult
{
    public string Name { get; set; } = "";
    public string Symbol { get; set; } = "";
    public string Timeframe { get; set; } = "";
    public double Weight { get; set; } = 1.0;
    public string Status { get; set; } = "";
    public int ExitCode { get; set; }
    public string Error { get; set; } = "";
    public string RunDir { get; set; } = "";
    public string ReportPath { get; set; } = "";
    public string HtmlReportPath { get; set; } = "";
    public string EventsPath { get; set; } = "";
    public string ParameterFilePath { get; set; } = "";
    public string StdoutPath { get; set; } = "";
    public string StderrPath { get; set; } = "";
    public string LogPath { get; set; } = "";
    public BacktestMetrics Metrics { get; set; } = new BacktestMetrics();
    public double ElapsedMs { get; set; }
}

internal sealed class CandidateResult
{
    public string Id { get; set; } = "";
    public string Hash { get; set; } = "";
    public string Status { get; set; } = "";
    public int ExitCode { get; set; }
    public string Error { get; set; } = "";
    public string RunDir { get; set; } = "";
    public string ReportPath { get; set; } = "";
    public string ParameterFilePath { get; set; } = "";
    public Dictionary<string, string> Parameters { get; set; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    public List<CandidateScenarioResult> Scenarios { get; set; } = new List<CandidateScenarioResult>();
    public BacktestMetrics Metrics { get; set; } = new BacktestMetrics();
    public double FitnessScore { get; set; }
    public double ElapsedMs { get; set; }
}

internal sealed class OptimizerRunResult
{
    public List<CandidateResult> Results { get; set; } = new List<CandidateResult>();
    public int CompletedCount => Results.Count(result => result.Status == "completed");
    public int FailedCount => Results.Count(result => result.Status == "failed");
}

internal static class SummaryWriter
{
    public static void Write(string outputDir, OptimizerConfig config, OptimizerRunResult result, TimeSpan elapsed)
    {
        WriteCsv(Path.Combine(outputDir, "results.csv"), result.Results);
        WriteCsv(Path.Combine(outputDir, "summary.csv"), result.Results);
        string serialized = JsonSerializer.Serialize(result, Program.JsonOptions);
        File.WriteAllText(Path.Combine(outputDir, "results.json"), serialized);
        File.WriteAllText(Path.Combine(outputDir, "summary.json"), serialized);
        OptimizerArtifactWriter.WriteResultsHtml(Path.Combine(outputDir, "results.html"), result.Results);

        var report = new
        {
            generated_at_utc = DateTime.UtcNow,
            strategy = config.Strategy,
            search_method = config.Search.Method,
            candidates = result.Results.Count,
            completed = result.CompletedCount,
            failed = result.FailedCount,
            elapsed_ms = elapsed.TotalMilliseconds,
            results_csv = Path.Combine(outputDir, "results.csv"),
            results_json = Path.Combine(outputDir, "results.json"),
            results_html = Path.Combine(outputDir, "results.html")
        };
        File.WriteAllText(Path.Combine(outputDir, "optimizer_report.json"), JsonSerializer.Serialize(report, Program.JsonOptions));
    }

    private static void WriteCsv(string path, IReadOnlyList<CandidateResult> results)
    {
        using StreamWriter writer = new StreamWriter(path, false);
        writer.WriteLine(string.Join(",",
            "candidate_id",
            "status",
            "fitness_score",
            "closed_net_profit",
            "marked_to_market_net_profit",
            "marked_to_market_return_percent",
            "starting_capital",
            "ending_balance",
            "ending_equity",
            "gross_profit",
            "gross_loss",
            "profit_factor",
            "total_trades",
            "winning_trades",
            "losing_trades",
            "long_trades",
            "short_trades",
            "win_rate",
            "average_trade",
            "average_economic_result",
            "max_equity_drawdown",
            "max_equity_drawdown_percent",
            "recovery_factor",
            "top_trade_profit_share",
            "open_position_count",
            "open_losing_position_count",
            "open_net_profit",
            "open_loss_percent_of_starting_capital",
            "worst_open_position_loss_percent_of_starting_capital",
            "max_open_position_age_hours",
            "max_losing_open_position_age_hours",
            "max_day_start_equity_loss_percent",
            "max_intraday_equity_drawdown_percent",
            "closed_swaps",
            "open_swaps",
            "elapsed_ms",
            "events_per_second",
            "parameter_hash",
            "parameters",
            "candidate_cbotset",
            "scenario_reports",
            "scenario_html_reports",
            "scenario_events",
            "scenario_logs",
            "run_dir"));

        foreach (CandidateResult result in results)
        {
            BacktestMetrics metrics = result.Metrics ?? new BacktestMetrics();
            writer.WriteLine(string.Join(",",
                Csv(result.Id),
                Csv(result.Status),
                Csv(result.FitnessScore),
                Csv(metrics.NetProfit),
                Csv(metrics.MarkedToMarketNetProfit),
                Csv(metrics.MarkedToMarketReturnPercent),
                Csv(metrics.StartingCapital),
                Csv(metrics.EndingBalance),
                Csv(metrics.EndingEquity),
                Csv(metrics.GrossProfit),
                Csv(metrics.GrossLoss),
                Csv(metrics.ProfitFactor),
                Csv(metrics.TotalTrades),
                Csv(metrics.WinningTrades),
                Csv(metrics.LosingTrades),
                Csv(metrics.LongTrades),
                Csv(metrics.ShortTrades),
                Csv(metrics.WinRate),
                Csv(metrics.AverageTrade),
                Csv(metrics.AverageEconomicResult),
                Csv(metrics.MaxEquityDrawdown),
                Csv(metrics.MaxEquityDrawdownPercent),
                Csv(metrics.RecoveryFactor),
                Csv(metrics.TopTradeProfitShare),
                Csv(metrics.OpenPositionCount),
                Csv(metrics.OpenLosingPositionCount),
                Csv(metrics.OpenNetProfit),
                Csv(metrics.OpenLossPercentOfStartingCapital),
                Csv(metrics.WorstOpenPositionLossPercentOfStartingCapital),
                Csv(metrics.MaxOpenPositionAgeHours),
                Csv(metrics.MaxLosingOpenPositionAgeHours),
                Csv(metrics.MaxDayStartEquityLossPercent),
                Csv(metrics.MaxIntradayEquityDrawdownPercent),
                Csv(metrics.ClosedSwaps),
                Csv(metrics.OpenSwaps),
                Csv(result.ElapsedMs),
                Csv(metrics.EventsPerSecond),
                Csv(result.Hash),
                Csv(string.Join("; ", result.Parameters.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase).Select(pair => pair.Key + "=" + pair.Value))),
                Csv(result.ParameterFilePath),
                Csv(string.Join("; ", result.Scenarios.Select(scenario => scenario.ReportPath))),
                Csv(string.Join("; ", result.Scenarios.Select(scenario => scenario.HtmlReportPath))),
                Csv(string.Join("; ", result.Scenarios.Select(scenario => scenario.EventsPath))),
                Csv(string.Join("; ", result.Scenarios.Select(scenario => scenario.LogPath))),
                Csv(result.RunDir)));
        }
    }

    private static string Csv(string value)
    {
        string text = value ?? "";
        if (!text.Contains(',') && !text.Contains('"') && !text.Contains('\n') && !text.Contains('\r'))
            return text;
        return "\"" + text.Replace("\"", "\"\"") + "\"";
    }

    private static string Csv(double value)
    {
        return value.ToString("G17", CultureInfo.InvariantCulture);
    }

    private static string Csv(double? value)
    {
        return value == null ? "" : Csv(value.Value);
    }

    private static string Csv(int value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }
}
