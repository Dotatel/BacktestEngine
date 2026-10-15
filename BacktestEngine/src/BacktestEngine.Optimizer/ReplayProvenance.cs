using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace BacktestEngine.Optimizer;

// Candidate parameters alone cannot identify a cached simulation. A change to the
// runner, model resources, base preset, data, warmup or economics invalidates it.
internal static class ReplayProvenance
{
    public static string Compute(string repoRoot, OptimizerConfig config)
    {
        // Without the upfront build dotnet run may rebuild after this point.
        // Disable reuse rather than identify the run by stale assemblies.
        if (!config.BuildRunner)
            return "";
        var paths = new SortedSet<string>(StringComparer.Ordinal);
        void Add(string path)
        {
            if (!string.IsNullOrWhiteSpace(path))
                paths.Add(Program.ResolvePath(repoRoot, path));
        }
        Add(config.BaseParams);
        foreach (ScenarioConfig scenario in config.ActiveScenarios())
        {
            Add(scenario.DataFile);
            foreach (string path in scenario.DataFiles) Add(path);
            Add(scenario.WarmupDataFile);
            Add(scenario.StartupQuote);
            foreach (string path in scenario.WarmupSeries.Values) Add(path);
            Add(scenario.SymbolSpec);
            AddEconomicAuthorities(Program.ResolvePath(repoRoot, scenario.SymbolSpec), paths);
        }
        string project = Program.ResolvePath(repoRoot, config.RunnerProject);
        string binaries = Path.Combine(Path.GetDirectoryName(project)!, "bin", "Debug");
        string[] assemblies = Directory.GetFiles(binaries, "*.dll", SearchOption.AllDirectories);
        if (assemblies.Length == 0)
            throw new InvalidOperationException("Cannot fingerprint the built runner: no Debug assemblies found.");
        foreach (string assembly in assemblies) paths.Add(assembly);
        var identity = new StringBuilder(JsonSerializer.Serialize(config, Program.JsonOptions));
        foreach (string path in paths)
            identity.Append('\n').Append(path).Append(':').Append(HashFile(path));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity.ToString()))).ToLowerInvariant();
    }

    private static void AddEconomicAuthorities(string specificationPath, ISet<string> paths)
    {
        if (string.IsNullOrWhiteSpace(specificationPath)) return;
        var visited = new HashSet<string>(StringComparer.Ordinal);
        void Visit(string file)
        {
            string canonical = CanonicalPath(file);
            if (!visited.Add(canonical)) return;
            paths.Add(canonical);
            // JSONL event captures and CSV data are leaves. Only declared
            // authority links in JSON objects are followed, never arbitrary URLs.
            if (!string.Equals(Path.GetExtension(canonical), ".json", StringComparison.OrdinalIgnoreCase)) return;
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(canonical));
            if (document.RootElement.ValueKind != JsonValueKind.Object) return;
            string directory = Path.GetDirectoryName(canonical)!;
            foreach (string key in new[] {
                "specification_source_path", "swap_time_authority_path", "commission_conversion_authority_path",
                "source_events_path", "source_report_path", "source_spec_path", "source_report_relative_path" })
            {
                if (!document.RootElement.TryGetProperty(key, out JsonElement property)
                    || property.ValueKind != JsonValueKind.String) continue;
                string linked = property.GetString();
                if (string.IsNullOrWhiteSpace(linked) || string.Equals(linked, "UNKNOWN", StringComparison.OrdinalIgnoreCase)) continue;
                Visit(Path.IsPathRooted(linked) ? linked : Path.Combine(directory, linked));
            }
        }
        Visit(specificationPath);
    }

    private static string CanonicalPath(string path)
    {
        string absolute = Path.GetFullPath(path);
        string parent = Path.GetDirectoryName(absolute);
        if (string.IsNullOrEmpty(parent) || parent == absolute) return absolute;
        string resolvedParent = CanonicalPath(parent);
        string candidate = Path.Combine(resolvedParent, Path.GetFileName(absolute));
        FileSystemInfo entry = Directory.Exists(candidate) ? new DirectoryInfo(candidate) : new FileInfo(candidate);
        FileSystemInfo target = entry.ResolveLinkTarget(returnFinalTarget: true);
        return target == null ? candidate : Path.GetFullPath(target.FullName);
    }

    public static bool CanReuse(string provenancePath, string reportPath, string fingerprint)
    {
        if (string.IsNullOrEmpty(fingerprint) || !File.Exists(provenancePath) || !File.Exists(reportPath))
            return false;
        try
        {
            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(provenancePath));
            return doc.RootElement.GetProperty("replay_fingerprint").GetString() == fingerprint
                && doc.RootElement.GetProperty("report_sha256").GetString() == HashFile(reportPath);
        }
        catch (Exception ex) when (ex is JsonException || ex is KeyNotFoundException || ex is InvalidOperationException || ex is IOException)
        {
            return false;
        }
    }

    public static void Write(string path, string reportPath, string fingerprint)
    {
        if (string.IsNullOrEmpty(fingerprint)) return;
        File.WriteAllText(path, JsonSerializer.Serialize(new
        {
            replay_fingerprint = fingerprint,
            report_sha256 = HashFile(reportPath)
        }, Program.JsonOptions));
    }

    private static string HashFile(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
}
