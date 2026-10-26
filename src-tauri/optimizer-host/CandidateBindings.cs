using System.Security.Cryptography;
using System.Text.Json;
using BacktestEngine.Optimizer;

namespace DotaTel.Optimization;

/// <summary>Bind native adapter evidence using the unchanged optimizer's own generator and serialization.</summary>
internal sealed class CandidateBindings
{
    internal const string Marker = "BACKTESTENGINE_OPTIMIZER_BINDING_SHA256 ";
    private const long MetadataLimit = 1024 * 1024;
    private const long ReportLimit = 64 * 1024 * 1024;
    private readonly string configPath;
    private readonly string basePath;
    private readonly string dataPath;
    private readonly string profilePath;
    private readonly string output;
    private readonly string configHash;
    private readonly string baseHash;
    private readonly string dataHash;
    private readonly string profileHash;
    private readonly string scenariosJson;
    private readonly List<Candidate> candidates;
    private readonly string capturePath;
    private readonly string captureHash;
    private readonly string sourceManifestHash;
    private readonly string runnerDirectory;

    /// <summary>Capture expected identities before strategy execution, using the original native CLI contract.</summary>
    internal CandidateBindings(string[] arguments)
    {
        OptimizerOptions options = OptimizerOptions.Parse(arguments);
        configPath = Path.GetFullPath(options.ConfigPath);
        configHash = Hash(configPath, MetadataLimit);
        OptimizerConfig config = OptimizerConfig.Load(configPath);
        string directory = Path.GetDirectoryName(configPath)!;
        capturePath = Path.Combine(directory, "optimizer-inputs.json");
        captureHash = Hash(capturePath, 4 * MetadataLimit);
        using JsonDocument capture = JsonDocument.Parse(File.ReadAllBytes(capturePath));
        sourceManifestHash = capture.RootElement.GetProperty("sourceManifest").GetProperty("sha256").GetString()
            ?? throw new InvalidDataException("The native optimizer source identity is absent.");
        if (capture.RootElement.GetProperty("buildConfiguration").GetString() != "Release"
            || Environment.GetEnvironmentVariable("Configuration") != "Release"
            || Environment.GetEnvironmentVariable("BaseOutputPath") != "bin/Debug/"
            || !string.Equals(Environment.GetEnvironmentVariable("UseAppHost"), "false", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Native optimizer compilation requires Release with UseAppHost=false.");
        if (config.ActiveScenarios().Count != 1 || config.Search.MaxRuns < 1 || config.Search.MaxRuns > 100)
            throw new InvalidDataException("Native candidate binding requires one scenario and a 1–100 candidate budget.");
        ScenarioConfig scenario = config.ActiveScenarios()[0];
        if (scenario.DataFiles.Count != 0 || !string.IsNullOrWhiteSpace(scenario.WarmupDataFile)
            || !string.IsNullOrWhiteSpace(scenario.StartupQuote) || scenario.WarmupSeries.Count != 0)
            throw new InvalidDataException("Native candidate binding does not support additional replay input sources.");
        string root = Program.FindRepoRoot();
        runnerDirectory = Path.Combine(directory, "runner");
        if (!string.Equals(Path.GetFullPath(Program.ResolvePath(root, config.RunnerProject)), Path.Combine(runnerDirectory, "WorkspaceCompile.csproj"), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The optimizer runner project differs from its exact captured source location.");
        basePath = Program.ResolvePath(root, config.BaseParams);
        dataPath = Program.ResolvePath(root, scenario.DataFile);
        profilePath = Program.ResolvePath(root, scenario.SymbolSpec);
        output = Program.ResolvePath(root, config.Output.Dir);
        baseHash = Hash(basePath, MetadataLimit);
        dataHash = Hash(dataPath, ReportLimit);
        profileHash = Hash(profilePath, ReportLimit);
        // Generate independently before the original Main. This reuses its seeded algorithm,
        // ParameterValue formatting and full System.Text.Json scenario serialization unchanged.
        candidates = CandidateGenerator.Generate(config);
        scenariosJson = JsonSerializer.Serialize(config.ActiveScenarios(), Program.JsonOptions);
    }

    /// <summary>After the original process settles, bind its actual artifact bytes and publish one stdout digest.</summary>
    internal void Publish()
    {
        if (Hash(configPath, MetadataLimit) != configHash || Hash(basePath, MetadataLimit) != baseHash
            || Hash(dataPath, ReportLimit) != dataHash || Hash(profilePath, ReportLimit) != profileHash
            || Hash(capturePath, 4 * MetadataLimit) != captureHash)
            throw new InvalidDataException("Frozen optimizer inputs changed while the original optimizer was running.");
        var receipt = new
        {
            version = 3,
            config_sha256 = configHash,
            base_params_sha256 = baseHash,
            data_sha256 = dataHash,
            symbol_spec_sha256 = profileHash,
            scenarios_json = scenariosJson,
            results_sha256 = ExistingHash(Path.Combine(output, "results.json"), ReportLimit),
            compiled_runner = CompiledRunner(),
            candidates = candidates.Select(candidate => BoundCandidate(candidate)).ToArray()
        };
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(receipt, Program.JsonOptions);
        if (bytes.Length > 4 * MetadataLimit)
            throw new InvalidDataException("Candidate binding receipt exceeds 4 MiB.");
        File.WriteAllBytes(Path.Combine(Path.GetDirectoryName(configPath)!, "candidate-bindings.json"), bytes);
        Console.WriteLine(Marker + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    /// <summary>Require actual output from the unchanged original builder; absent/failed builds publish no authenticated v3 receipt.</summary>
    private object CompiledRunner()
    {
        string root = Path.Combine(runnerDirectory, "bin", "Debug", "Release", "net10.0");
        var files = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (string name in new[] { "WorkspaceCompile.dll", "BacktestEngine.CAlgoShim.dll", "WorkspaceCompile.deps.json", "WorkspaceCompile.runtimeconfig.json" })
            files.Add(name, Hash(Path.Combine(root, name), ReportLimit));
        RequireNoAppHost(Path.Combine(root, "WorkspaceCompile.exe"));
        return new { capture_sha256 = captureHash, source_manifest_sha256 = sourceManifestHash, build_configuration = "Release", files };
    }

    /// <summary>Only genuine absence is allowed; permission or I/O failures cannot hide an unbound apphost.</summary>
    private static void RequireNoAppHost(string path)
    {
        try { File.GetAttributes(path); }
        catch (FileNotFoundException) { return; }
        catch (DirectoryNotFoundException) { return; }
        throw new InvalidDataException("The optimizer unexpectedly produced an unbound native apphost.");
    }

    /// <summary>Preserve exact original candidate text/typed values and the original writer's actual byte identities.</summary>
    private object BoundCandidate(Candidate candidate)
    {
        string directory = Path.Combine(output, candidate.Id + "_" + candidate.Hash);
        return new
        {
            id = candidate.Id,
            hash = candidate.Hash,
            parameters = candidate.Parameters.ToDictionary(pair => pair.Key, pair => pair.Value.ToString(), StringComparer.OrdinalIgnoreCase),
            values = candidate.Parameters.ToDictionary(pair => pair.Key, pair => pair.Value.Value, StringComparer.OrdinalIgnoreCase),
            report_sha256 = ExistingHash(Path.Combine(directory, "report.json"), ReportLimit),
            preset_sha256 = ExistingHash(Path.Combine(directory, "candidate.cbotset"), MetadataLimit),
            replay_preset_sha256 = ExistingHash(Path.Combine(directory, "parameters.cbotset"), MetadataLimit),
            result_sha256 = ExistingHash(Path.Combine(directory, "candidate_result.json"), ReportLimit)
        };
    }

    /// <summary>Missing failed-candidate artifacts remain absent; no placeholder report identity is invented.</summary>
    private static string ExistingHash(string path, long limit)
    {
        try { File.GetAttributes(path); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        return Hash(path, limit);
    }

    /// <summary>Hash a bounded regular input without accumulating a complete market file in memory.</summary>
    private static string Hash(string path, long limit)
    {
        using FileStream stream = File.OpenRead(path);
        if (stream.Length > limit)
            throw new InvalidDataException("Optimizer binding input exceeds its supported size.");
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
}
