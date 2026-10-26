using System.Diagnostics;
using System.Reflection;
using DotaTel.Processes;

namespace DotaTel.Validation;

/// <summary>Contain the unchanged Python validation CLI and every original dotnet scenario descendant.</summary>
internal static class ValidationHost
{
    private static string Bootstrap => ReadBootstrap();

    /// <summary>Accept only fixed host-selected paths, establish ownership and return Python's exact exit code.</summary>
    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "--replay") return await RunReplay(args).ConfigureAwait(false);
            if (args.Length > 0 && (args[0] == "--build" || args[0] == "--metadata")) return await RunWorkspaceTool(args).ConfigureAwait(false);
            if (args.Length > 0 && args[0] == "--sdk-probe") return await RunSdkProbe(args).ConfigureAwait(false);
            var paths = ReadPaths(args);
            OwnedProcessJob.JoinParent(paths.JobName);
            using var python = new Process { StartInfo = PythonStart(paths) };
            if (!python.Start())
                throw new InvalidOperationException("The original Python validation CLI did not start.");
            Console.WriteLine("BACKTESTENGINE_VALIDATION_HOST_READY");
            await python.WaitForExitAsync().ConfigureAwait(false);
            return python.ExitCode;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("BACKTESTENGINE_VALIDATION_HOST_ERROR " + error.GetBaseException().Message);
            return 1;
        }
    }

    /// <summary>Use the same contained host for an exact frozen baseline DLL without changing engine CLI semantics.</summary>
    private static async Task<int> RunReplay(string[] args)
    {
        if (args.Length < 9 || args[1] != "--sdk" || args[3] != "--working" || args[5] != "--job" || args[7] != "--")
            throw new ArgumentException("The replay host requires its fixed native SDK/working/job vector.");
        string sdk = Path.GetFullPath(args[2]);
        string working = Path.GetFullPath(args[4]);
        string artifact = Path.GetFullPath(args[8]);
        if (!string.Equals(artifact, Path.Combine(working, "WorkspaceCompile.dll"), StringComparison.Ordinal) || !File.Exists(artifact))
            throw new ArgumentException("The replay assembly is outside its exact frozen working location.");
        string compiler = Path.Combine(sdk, "dotnet.exe");
        if (!File.Exists(compiler)) throw new FileNotFoundException("The verified replay SDK is unavailable.");
        OwnedProcessJob.JoinParent(args[6]);
        var start = new ProcessStartInfo(compiler) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = working, RedirectStandardInput = true };
        foreach (string argument in args.Skip(8)) start.ArgumentList.Add(argument);
        using Process child = Process.Start(start) ?? throw new InvalidOperationException("The original frozen replay did not start.");
        child.StandardInput.Close();
        Console.WriteLine("BACKTESTENGINE_REPLAY_HOST_READY");
        await child.WaitForExitAsync().ConfigureAwait(false);
        return child.ExitCode;
    }

    /// <summary>Execute only a fixed saved-source build or its exact compiled metadata assembly inside the owned job.</summary>
    private static async Task<int> RunWorkspaceTool(string[] args)
    {
        if (args.Length < 10 || args[1] != "--sdk" || args[3] != "--working" || args[5] != "--job" || args[7] != "--")
            throw new ArgumentException("The workspace host requires its fixed SDK/working/job vector.");
        string sdk = Path.GetFullPath(args[2]), working = Path.GetFullPath(args[4]);
        string[] forwarded = args.Skip(8).ToArray();
        ValidateWorkspaceTool(args[0], working, forwarded);
        string compiler = Path.Combine(sdk, "dotnet.exe");
        if (!File.Exists(compiler)) throw new FileNotFoundException("The verified workspace SDK is unavailable.");
        OwnedProcessJob.JoinParent(args[6]);
        return await RunOwnedChild(compiler, working, forwarded, args[0] == "--build" ? "BACKTESTENGINE_BUILD_HOST_READY" : "BACKTESTENGINE_METADATA_HOST_READY").ConfigureAwait(false);
    }

    /// <summary>Keep tool purpose and project/assembly membership exact; never accept a renderer command string.</summary>
    private static void ValidateWorkspaceTool(string mode, string working, string[] args)
    {
        if (mode == "--build")
        {
            if (args.Length < 2 || args[0] != "build" || !string.Equals(Path.GetFullPath(args[1]), Path.Combine(working, "WorkspaceCompile.csproj"), StringComparison.Ordinal))
                throw new ArgumentException("The build project is outside its exact frozen snapshot.");
            return;
        }
        if (mode != "--metadata" || args.Length != 2 || args[0] != "exec" || !string.Equals(Path.GetFullPath(args[1]), Path.Combine(working, "WorkspaceCompile.dll"), StringComparison.Ordinal))
            throw new ArgumentException("The metadata assembly is outside its exact compiled working location.");
    }

    /// <summary>Probe an explicit dotnet candidate behind the separately verified packaged bootstrap host.</summary>
    private static async Task<int> RunSdkProbe(string[] args)
    {
        if (args.Length != 7 || args[1] != "--candidate" || args[3] != "--working" || args[5] != "--job" || !Path.IsPathRooted(args[2]))
            throw new ArgumentException("The SDK probe requires its exact native candidate/working/job vector.");
        string candidate = Path.GetFullPath(args[2]), working = Path.GetFullPath(args[4]);
        if (!File.Exists(candidate) || !string.Equals(Path.GetFileName(candidate), "dotnet.exe", StringComparison.OrdinalIgnoreCase) || !Directory.Exists(working))
            throw new ArgumentException("The native SDK candidate/probe directory is unavailable.");
        OwnedProcessJob.JoinParent(args[6]);
        return await RunOwnedChild(candidate, working, new[] { "--list-sdks" }, "BACKTESTENGINE_SDK_PROBE_HOST_READY").ConfigureAwait(false);
    }

    /// <summary>Start one already-selected SDK tool with original argument tokens/environment and closed standard input.</summary>
    private static async Task<int> RunOwnedChild(string executable, string working, string[] args, string marker)
    {
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = working, RedirectStandardInput = true };
        start.Environment["DOTNET_GENERATE_ASPNET_CERTIFICATE"] = "false";
        start.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        start.Environment["DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE"] = "true";
        start.Environment["DOTNET_NOLOGO"] = "1";
        foreach (string argument in args) start.ArgumentList.Add(argument);
        using Process child = Process.Start(start) ?? throw new InvalidOperationException("The original workspace tool did not start.");
        child.StandardInput.Close();
        Console.WriteLine(marker);
        await child.WaitForExitAsync().ConfigureAwait(false);
        return child.ExitCode;
    }

    /// <summary>Load the exact shared app-owned output transport embedded at staging; original Python sources remain unchanged.</summary>
    private static string ReadBootstrap()
    {
        using Stream stream = typeof(ValidationHost).Assembly.GetManifestResourceStream("DotaTel.ValidationOutput.py")
            ?? throw new InvalidOperationException("The verified validation output adapter resource is missing.");
        using var reader = new StreamReader(stream, System.Text.Encoding.UTF8, true);
        return reader.ReadToEnd();
    }

    /// <summary>Recognize exactly the native argument vector; no command strings or renderer executable paths exist.</summary>
    private static Paths ReadPaths(string[] args)
    {
        if (args.Length != 12 || args[0] != "--python" || args[2] != "--source" || args[4] != "--config" || args[6] != "--sdk" || args[8] != "--working" || args[10] != "--job")
            throw new ArgumentException("The validation host requires its fixed native path vector.");
        var paths = new Paths(Path.GetFullPath(args[1]), Path.GetFullPath(args[3]), Path.GetFullPath(args[5]), Path.GetFullPath(args[7]), Path.GetFullPath(args[9]), args[11]);
        if (!File.Exists(paths.Python) || !File.Exists(Path.Combine(paths.Source, "ValidationEngine", "Cli.py")) || !File.Exists(paths.Config) || !File.Exists(Path.Combine(paths.Sdk, "dotnet.exe")))
            throw new FileNotFoundException("A verified validation runtime/configuration path is unavailable.");
        if (!string.Equals(paths.Config, Path.Combine(paths.Working, "validation-config.json"), StringComparison.Ordinal))
            throw new ArgumentException("The validation config is outside its exact owned working location.");
        return paths;
    }

    /// <summary>Start only isolated Python; original scenario subprocesses resolve the explicit bundled SDK first.</summary>
    private static ProcessStartInfo PythonStart(Paths paths)
    {
        var start = new ProcessStartInfo(paths.Python)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = paths.Working,
        };
        foreach (string argument in new[] { "-I", "-B", "-X", "utf8", "-c", Bootstrap, paths.Source, Path.Combine(paths.Working,"validation"), "--config", paths.Config })
            start.ArgumentList.Add(argument);
        start.Environment["PATH"] = paths.Sdk + Path.PathSeparator + Environment.GetEnvironmentVariable("PATH");
        start.Environment["DOTNET_ROOT"] = paths.Sdk;
        start.Environment["DOTNET_ROOT_X64"] = paths.Sdk;
        start.Environment["DOTNET_MULTILEVEL_LOOKUP"] = "0";
        start.Environment["DOTNET_CLI_HOME"] = Path.Combine(paths.Working, "cli-home");
        start.Environment["NUGET_PACKAGES"] = Path.Combine(paths.Working, "nuget-packages");
        start.Environment["NUGET_HTTP_CACHE_PATH"] = Path.Combine(paths.Working, "nuget-http-cache");
        start.Environment["RestoreConfigFile"] = Path.Combine(paths.Working, "runner", "NuGet.Config");
        start.Environment["Configuration"] = "Release";
        start.Environment["UseAppHost"] = "false";
        start.Environment["DirectoryBuildPropsPath"] = Path.Combine(paths.Working, "runner", "Directory.Build.props");
        start.Environment["DirectoryBuildTargetsPath"] = Path.Combine(paths.Working, "runner", "Directory.Build.targets");
        start.Environment["NuGetAudit"] = "false";
        start.Environment["UseSharedCompilation"] = "false";
        start.Environment["MSBUILDDISABLENODEREUSE"] = "1";
        start.Environment["DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE"] = "true";
        start.Environment["DOTNET_GENERATE_ASPNET_CERTIFICATE"] = "false";
        start.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        start.Environment["DOTNET_NOLOGO"] = "1";
        start.Environment.Remove("MSBuildSDKsPath");
        start.Environment["PYTHONIOENCODING"] = "utf-8";
        start.Environment["PYTHONDONTWRITEBYTECODE"] = "1";
        return start;
    }

    /// <summary>Canonical host paths are a local implementation detail, never a public renderer request.</summary>
    private sealed record Paths(string Python, string Source, string Config, string Sdk, string Working, string JobName);
}
