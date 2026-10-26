using System.Diagnostics;

namespace DotaTel.ValidationProof;

/// <summary>Explicitly synthetic process tree for validation containment tests; never a trading strategy.</summary>
internal static class LifecycleFixture
{
    /// <summary>Write only owned PID files, create child/grandchild and wait for the host's kernel teardown.</summary>
    private static async Task<int> Main(string[] args)
    {
        string role = args[0];
        string root = args[1];
        File.WriteAllText(Path.Combine(root, role + ".pid"), Environment.ProcessId.ToString());
        if (role == "parent") StartChild("child", root);
        if (role == "child") StartChild("grandchild", root);
        await Task.Delay(Timeout.Infinite);
        return 0;
    }

    /// <summary>Use a hidden fixed argument vector and inherit the validation host's already-created job.</summary>
    private static void StartChild(string role, string root)
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add(typeof(LifecycleFixture).Assembly.Location);
        start.ArgumentList.Add(role);
        start.ArgumentList.Add(root);
        Process.Start(start)?.Dispose();
    }
}
