using System.Diagnostics;
using System.Text.Json;

namespace BacktestEngine.Optimizer
{

/// <summary>Synthetic entry-point fixture for kernel containment tests; never included in the shipped optimizer.</summary>
internal static class Program
{
    /// <summary>Return an exact exit code, or create a real child/grandchild tree and wait for termination.</summary>
    private static async Task<int> Main(string[] args)
    {
        string role = args[0], root = args[1];
        if (role == "--config")
        {
            using JsonDocument config = JsonDocument.Parse(File.ReadAllBytes(root));
            if (config.RootElement.GetProperty("mode").GetString() == "exit") return config.RootElement.GetProperty("code").GetInt32();
            root = config.RootElement.GetProperty("working").GetString()!;
            role = "parent";
        }
        File.WriteAllText(Path.Combine(root, role + ".pid"), Environment.ProcessId.ToString());
        if (role == "parent") StartChild("child", root);
        if (role == "child") StartChild("grandchild", root);
        await Task.Delay(Timeout.Infinite);
        return 0;
    }

    /// <summary>Launch the separately compiled worker entry point, inheriting the already-joined parent job.</summary>
    private static void StartChild(string role, string root)
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        // The host assembly's entry point requires its private envelope; descendants intentionally use a worker-only assembly.
        start.ArgumentList.Add(Path.Combine(root, "bin", "Release", "net10.0", "ProofWorker.dll"));
        start.ArgumentList.Add(role);
        start.ArgumentList.Add(root);
        Process.Start(start)?.Dispose();
    }
}
}

namespace DotaTel.Optimization
{
    /// <summary>Containment-only fixture dependency; never shipped and never emits candidate authority or a receipt marker.</summary>
    internal sealed class CandidateBindings
    {
        /// <summary>Lifecycle tests have no candidate generator or frozen replay input.</summary>
        internal CandidateBindings(string[] arguments) { }

        /// <summary>These tests prove only Job Object lifetime/exit codes, not optimizer artifact acceptance.</summary>
        internal void Publish() { }
    }
}
